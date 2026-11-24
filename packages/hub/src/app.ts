import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DB } from "./db.ts";
import { Repo, NotFound } from "./repo.ts";
import { Auth, LoginThrottle, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.ts";
import * as S from "./schemas.ts";
import { Terms } from "./terms.ts";
import { Devices } from "./devices.ts";
import { Live } from "./live.ts";
import { registerCollector, type CollectorHub } from "./collect.ts";
import { Actions } from "./actions.ts";
import { Favicons } from "./favicons.ts";
import { McpClients } from "./mcpClients.ts";
import { registerMcp, MCP_PATH } from "./mcp.ts";
import { registerInstallers } from "./installers.ts";
import { Backups } from "./backups.ts";
import type { ChangedMsg, ExportFile } from "../../shared/src/types.ts";

export interface AppOptions {
  db: DB;
  /** Directory holding the built UI (index.html). Optional in dev/tests. */
  uiDir?: string;
  logger?: boolean | object;
  /** LBSV_ADMIN_PASSPHRASE: when set, becomes the passphrase. */
  adminPassphrase?: string;
  /** "auto" sets Secure when the request arrived over HTTPS (needs trustProxy behind a TLS proxy). */
  cookieSecure?: boolean | "auto";
  trustProxy?: boolean | string;
  now?: () => number;
  /** Let the hub fetch favicons from tab hosts (LBSV_FAVICONS). Default on. */
  favicons?: boolean;
  /** Directory with lbsv-ext-<target>-<version>.zip files to offer on the Devices page. */
  extPackagesDir?: string;
  /** LBSV_PUBLIC_URL: the hub address to put in install commands (default: the request's own origin). */
  publicUrl?: string;
  /** First run: also write the setup code here (owner-only) so `cat` works when logs are awkward; deleted once used. */
  setupCodeFile?: string;
  /** Scheduled backups (LBSV_BACKUP_DIR / _KEEP / _EVERY_HOURS). Without it the Backups card says "not configured". */
  backups?: { dir: string; keep?: number; everyHours?: number };
  fetch?: typeof fetch;
}

export interface Hub {
  app: FastifyInstance;
  repo: Repo;
  auth: Auth;
  devices: Devices;
  live: Live;
  terms: Terms;
  collectors: CollectorHub;
  actions: Actions;
  mcpClients: McpClients;
  backups: Backups | null;
  broadcast(msg: ChangedMsg): void;
}

const APP_VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "0.0.0"; }
})();

const PUBLIC_API = new Set(["/api/auth", "/api/login", "/api/logout", "/api/health", "/api/setup"]);

export async function buildApp(opts: AppOptions): Promise<Hub> {
  const now = opts.now ?? Date.now;
  const repo = new Repo(opts.db, now);
  const auth = new Auth(opts.db, now);
  auth.syncFromEnv(opts.adminPassphrase);
  auth.pruneExpired();
  const setupFile = opts.setupCodeFile;
  if (setupFile) {
    const code = auth.setupCode();
    try {
      if (code) { mkdirSync(dirname(setupFile), { recursive: true }); writeFileSync(setupFile, code + "\n", { mode: 0o600 }); }
      else rmSync(setupFile, { force: true });
    } catch { /* the log line is the main channel */ }
  }
  const throttle = new LoginThrottle(now);
  const devices = new Devices(opts.db, now);
  const live = new Live(opts.db, devices, now);
  const favicons = new Favicons(opts.db, { enabled: opts.favicons ?? true, now, fetch: opts.fetch });
  live.favicons = favicons;
  const terms = new Terms(opts.db, now);
  live.terms = terms;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 50 * 1024 * 1024, // imports can be large
    trustProxy: opts.trustProxy ?? false,
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 /* big snapshots */ } });

  /* ---------- auth middleware ---------- */
  const isAuthed = (req: FastifyRequest) => auth.validateSession(req.cookies[SESSION_COOKIE]);
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    const guarded = (path.startsWith("/api/") && !PUBLIC_API.has(path)) || path === "/ws";
    if (!guarded) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "unauthorized" });
  });

  /* ---------- realtime fan-out to UIs ---------- */
  const clients = new Set<WebSocket>();
  const broadcast = (msg: ChangedMsg) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  };
  const changedProject = (...ids: (string | null | undefined)[]) => {
    const real = ids.filter((x): x is string => !!x);
    if (real.length) broadcast({ t: "changed", entity: "project", ids: real });
  };
  const changedInbox = (id: string) => broadcast({ t: "changed", entity: "inbox", ids: [id] });

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ t: "hello" }));
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25_000);
    socket.on("close", () => { clients.delete(socket); clearInterval(ping); });
    socket.on("error", () => socket.terminate());
  });

  /* ---------- collectors (extensions, later lbsv-agent): device-token auth, not the cookie ---------- */
  const collectors = registerCollector(app, { devices, live, terms, broadcast, now });
  const changedDevices = (id: string) => broadcast({ t: "changed", entity: "devices", ids: [id] });
  const actions = new Actions(live, repo, collectors);

  /* ---------- MCP (M4): bearer token per client, not the cookie ---------- */
  const mcpClients = new McpClients(opts.db, now);
  registerMcp(app, {
    repo, live, actions, clients: mcpClients, now, version: APP_VERSION,
    notify: { project: (...ids) => changedProject(...ids), inbox: (id) => changedInbox(id), live: () => broadcast({ t: "changed", entity: "live", ids: [] }) },
  });
  const changedMcp = () => broadcast({ t: "changed", entity: "devices", ids: [] });
  app.get("/api/mcp-clients", async () => ({ clients: mcpClients.list() }));
  app.post("/api/mcp-clients", async (req, reply) => {
    const r = mcpClients.create(S.McpClientCreate.parse(req.body).name);
    changedMcp();
    return reply.code(201).send(r);
  });
  app.delete<IdParams>("/api/mcp-clients/:id", async (req, reply) => {
    if (!mcpClients.remove(req.params.id)) return reply.code(404).send({ error: "MCP client not found" });
    changedMcp();
    return noContent(reply);
  });

  /* ---------- backups (M5) ---------- */
  const backups = opts.backups ? new Backups(opts.db, { ...opts.backups, now, log: (s) => app.log.info(s) }) : null;
  app.addHook("onClose", async () => backups?.stop());
  app.get("/api/backups", async () => backups ? { configured: true, ...backups.status() } : { configured: false });
  app.post("/api/backups", async (req, reply) => {
    if (!backups) return reply.code(409).send({ error: "backups aren't configured on this hub" });
    try { const b = await backups.run(); return { ok: true, backup: b, ...backups.status() }; }
    catch (e) { return reply.code(500).send({ error: `backup failed: ${(e as Error).message}` }); }
  });

  /* ---------- errors ---------- */
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid", issues: err.issues });
    if (err instanceof NotFound) return reply.code(404).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || e.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "conflict" });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  /* ---------- auth routes ---------- */
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth", async (req) => ({ configured: auth.isConfigured(), authenticated: isAuthed(req) }));
  app.post("/api/login", async (req, reply) => {
    const wait = throttle.retryAfterMs(req.ip);
    if (wait > 0) return reply.code(429).header("retry-after", Math.ceil(wait / 1000)).send({ error: "too many attempts" });
    if (!auth.isConfigured()) return reply.code(503).send({ error: "not_configured" });
    const { passphrase } = S.Login.parse(req.body);
    if (!auth.checkPassphrase(passphrase)) {
      throttle.fail(req.ip);
      return reply.code(401).send({ error: "wrong passphrase" });
    }
    throttle.ok(req.ip);
    signIn(req, reply);
    return { ok: true };
  });
  const signIn = (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = auth.createSession();
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "strict", path: "/", maxAge: SESSION_TTL_MS / 1000,
      secure: opts.cookieSecure === "auto" ? req.protocol === "https" : !!opts.cookieSecure,
    });
  };
  /** First run: the setup code from the hub's log + a new passphrase → configured and signed in. */
  app.post("/api/setup", async (req, reply) => {
    const wait = throttle.retryAfterMs(req.ip);
    if (wait > 0) return reply.code(429).header("retry-after", Math.ceil(wait / 1000)).send({ error: "too many attempts" });
    if (auth.isConfigured()) return reply.code(409).send({ error: "already set up" });
    const { code, passphrase } = S.Setup.parse(req.body);
    if (!auth.checkSetupCode(code)) {
      throttle.fail(req.ip);
      return reply.code(401).send({ error: "wrong setup code" });
    }
    throttle.ok(req.ip);
    auth.setPassphrase(passphrase);
    auth.setupCode(); // clears it
    if (setupFile) rmSync(setupFile, { force: true });
    req.log.info("first-run setup complete: admin passphrase set");
    signIn(req, reply);
    return { ok: true };
  });
  app.post("/api/logout", async (req, reply) => {
    auth.destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /* ---------- data routes ---------- */
  type IdParams = { Params: { id: string } };
  const noContent = (reply: FastifyReply) => reply.code(204).send();


  app.get("/api/state", async () => repo.state());
  app.get("/api/search", async (req) => {
    const q = String((req.query as { q?: string }).q ?? "");
    return { ...repo.search(q), tabs: live.search(q), terms: terms.search(q) };
  });

  /* ---------- live tabs + devices ---------- */
  app.get("/api/live", async () => live.state());
  app.put("/api/live/deny", async (req) => {
    const domains = devices.setGlobalDeny(S.DenyList.parse(req.body).domains);
    live.purgeDenied();
    collectors.pushConfig();
    broadcast({ t: "changed", entity: "live", ids: [] });
    return { domains };
  });
  /* ---------- tab actions (M2) ---------- */
  const liveChanged = () => broadcast({ t: "changed", entity: "live", ids: [] });
  app.post("/api/live/focus", async (req, reply) => {
    const out = await actions.focus(S.TabFocus.parse(req.body).tabId);
    if (!out) return reply.code(404).send({ error: "tab not found" });
    if (!out.ok) return reply.code(out.error === "offline" ? 409 : 502).send({ error: out.error === "offline" ? "that browser is offline" : out.error });
    return { ok: true };
  });
  app.post("/api/live/close", async (req) => {
    const r = await actions.close(S.TabsClose.parse(req.body).tabs);
    if (r.closed.length) liveChanged();
    return r;
  });
  app.post("/api/live/open", async (req, reply) => {
    const b = S.TabsOpen.parse(req.body);
    const out = await actions.open(b.browserId, b.urls, b.windowId);
    if (!out.ok) return reply.code(out.error === "offline" ? 409 : 502).send({ error: out.error === "offline" ? "that browser is offline" : out.error });
    return { ok: true, opened: out.result.opened ?? 0 };
  });
  app.post("/api/live/park", async (req) => {
    const r = await actions.park(S.TabsPark.parse(req.body));
    changedProject(r.projectId);
    if (r.closed.length) liveChanged();
    return r;
  });
  app.post("/api/live/attach", async (req) => {
    const r = await actions.attach(S.LiveAttach.parse(req.body));
    if (r.projectId) changedProject(r.projectId); else changedInbox(r.ideaId);
    if (r.closed.length) liveChanged();
    return r;
  });
  app.post("/api/live/send", async (req, reply) => {
    const b = S.LiveSend.parse(req.body);
    const r = await actions.send(b.tabs, b.toBrowserId, b.close);
    if (!r.ok) return reply.code(r.error === "offline" ? 409 : 502).send({ error: r.error === "offline" ? "the target browser is offline" : r.error });
    if (r.closed.length) liveChanged();
    return r;
  });

  /* ---------- idea links (M2b) ---------- */
  app.post<IdParams>("/api/ideas/:id/links", async (req) => {
    const added = repo.addIdeaLinks(req.params.id, S.IdeaLinksAdd.parse(req.body).links);
    const owner = repo.ideaOwner(req.params.id);
    if (owner) changedProject(owner); else changedInbox(req.params.id);
    return { added };
  });
  app.delete<IdParams>("/api/idea-links/:id", async (req, reply) => {
    const r = repo.deleteIdeaLink(req.params.id);
    if (!r) return reply.code(404).send({ error: "idea link not found" });
    if (r.projectId) changedProject(r.projectId); else changedInbox(r.ideaId);
    return noContent(reply);
  });

  app.get("/api/favicon", async (req, reply) => {
    const origin = String((req.query as { origin?: string }).origin ?? "");
    let ok = false;
    try { const u = new URL(origin); ok = (u.protocol === "http:" || u.protocol === "https:") && u.origin === origin; } catch { /* bad */ }
    const icon = ok ? await favicons.get(origin) : null;
    reply.header("x-content-type-options", "nosniff");
    if (!icon) return reply.code(404).header("cache-control", "private, max-age=3600").send({ error: "no icon" });
    return reply
      .header("content-type", icon.mime)
      .header("cache-control", "private, max-age=86400")
      // SVG icons must never run script in the hub's origin, even if opened directly.
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(icon.data);
  });

  /* ---------- extension packages for other devices ---------- */
  // .xpi = the Mozilla-signed Firefox build (release pipeline); it installs permanently from a click.
  const PKG_RE = /^lbsv-(?:ext-(chromium|firefox)|(agent))-(\d+\.\d+\.\d+)\.(zip|xpi)$/;
  const packages = () => {
    const dir = opts.extPackagesDir;
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => PKG_RE.test(f)).map((f) => {
      const [, ext, agent, version, type] = PKG_RE.exec(f)!;
      const target = type === "xpi" ? (ext === "firefox" ? "firefox-signed" : "") : (ext ?? agent)!;
      return { file: f, target, version: version!, size: statSync(join(dir, f)).size, url: `/api/downloads/${f}` };
    }).filter((p) => p.target);
  };
  app.get("/api/downloads", async () => ({ packages: packages() }));
  registerInstallers(app, { packagesDir: opts.extPackagesDir, publicUrl: opts.publicUrl }); // public: see installers.ts
  app.get<{ Params: { file: string } }>("/api/downloads/:file", async (req, reply) => {
    const p = packages().find((x) => x.file === req.params.file);
    if (!p) return reply.code(404).send({ error: "no such package" });
    // Firefox offers to install an .xpi served as x-xpinstall when it isn't forced to be a download.
    if (p.target === "firefox-signed") return reply.header("content-type", "application/x-xpinstall")
      .header("content-length", p.size).send(createReadStream(join(opts.extPackagesDir!, p.file)));
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${p.file}"`)
      .header("content-length", p.size)
      .send(createReadStream(join(opts.extPackagesDir!, p.file)));
  });

  app.post("/api/devices", async (req, reply) => {
    const r = devices.create(S.DeviceCreate.parse(req.body).name);
    changedDevices(r.device.id);
    return reply.code(201).send({ device: { id: r.device.id, name: r.device.name }, code: r.code, expiresAt: r.expiresAt });
  });
  app.patch<IdParams>("/api/devices/:id", async (req) => {
    const patch = S.DevicePatch.parse(req.body);
    const d = devices.update(req.params.id, patch);
    if (patch.deny) { live.purgeDenied(d.id); collectors.pushConfig(d.id); }
    changedDevices(d.id);
    return { id: d.id, name: d.name, deny: JSON.parse(d.deny_domains), ssh: { target: d.ssh_target, jump: d.ssh_jump } };
  });
  app.post<IdParams>("/api/devices/:id/code", async (req) => {
    const r = devices.issueCode(req.params.id);
    changedDevices(req.params.id);
    return r;
  });
  app.delete<IdParams>("/api/devices/:id/code", async (req, reply) => {
    devices.cancelCode(req.params.id);
    changedDevices(req.params.id);
    return noContent(reply);
  });
  app.post<IdParams>("/api/devices/:id/revoke", async (req) => {
    devices.revoke(req.params.id);
    collectors.disconnectDevice(req.params.id);
    changedDevices(req.params.id);
    return { ok: true };
  });
  app.delete<IdParams>("/api/devices/:id", async (req, reply) => {
    if (!devices.get(req.params.id)) return reply.code(404).send({ error: "device not found" });
    collectors.disconnectDevice(req.params.id);
    devices.remove(req.params.id);
    changedDevices(req.params.id);
    return noContent(reply);
  });

  app.get<IdParams>("/api/projects/:id", async (req, reply) => repo.project(req.params.id) ?? reply.code(404).send({ error: "project not found" }));
  app.post("/api/projects", async (req, reply) => {
    const p = repo.createProject(S.ProjectCreate.parse(req.body));
    changedProject(p.id);
    return reply.code(201).send(p);
  });
  app.patch<IdParams>("/api/projects/:id", async (req) => {
    const p = repo.updateProject(req.params.id, S.ProjectPatch.parse(req.body));
    changedProject(p.id);
    return p;
  });
  app.put<IdParams>("/api/projects/:id", async (req, reply) => {
    const body = S.ProjectFull.parse(req.body);
    if (body.id !== req.params.id) return reply.code(400).send({ error: "id mismatch" });
    repo.putProject(body, { touch: true });
    changedProject(body.id);
    return repo.project(body.id);
  });
  app.delete<IdParams>("/api/projects/:id", async (req, reply) => {
    if (!repo.deleteProject(req.params.id)) return reply.code(404).send({ error: "project not found" });
    changedProject(req.params.id);
    return noContent(reply);
  });

  app.post<IdParams>("/api/projects/:id/links", async (req) => {
    const added = repo.addLinks(req.params.id, S.LinksAdd.parse(req.body).links);
    changedProject(req.params.id);
    return { added };
  });
  app.delete<IdParams>("/api/links/:id", async (req, reply) => {
    const pid = repo.deleteLink(req.params.id);
    if (pid === null) return reply.code(404).send({ error: "link not found" });
    changedProject(pid);
    return noContent(reply);
  });

  /* ---------- rules (M3) ---------- */
  app.post<IdParams>("/api/projects/:id/rules", async (req, reply) => {
    const r = repo.addRule(req.params.id, S.RuleIn.parse(req.body));
    if (!r) return reply.code(400).send({ error: "invalid", message: "That pattern can't be used for this kind of rule." });
    changedProject(req.params.id);
    return reply.code(201).send(r);
  });
  app.delete<IdParams>("/api/rules/:id", async (req, reply) => {
    const r = repo.deleteRule(req.params.id);
    if (!r) return reply.code(404).send({ error: "rule not found" });
    changedProject(r.projectId);
    return noContent(reply);
  });

  app.post<IdParams>("/api/projects/:id/sessions", async (req, reply) => {
    const s = repo.addSession(req.params.id, S.SessionIn.parse(req.body));
    changedProject(req.params.id);
    return reply.code(201).send(s);
  });
  app.delete<IdParams>("/api/sessions/:id", async (req, reply) => {
    const pid = repo.deleteSession(req.params.id);
    if (pid === null) return reply.code(404).send({ error: "session not found" });
    changedProject(pid);
    return noContent(reply);
  });

  app.post("/api/ideas", async (req, reply) => {
    const i = repo.addIdea(S.IdeaIn.parse(req.body));
    if (i.projectId) changedProject(i.projectId); else changedInbox(i.id);
    return reply.code(201).send(i);
  });
  app.patch<IdParams>("/api/ideas/:id", async (req) => {
    const { from, to } = repo.moveIdea(req.params.id, S.IdeaMove.parse(req.body).projectId);
    changedProject(from, to);
    if (!from || !to) changedInbox(req.params.id);
    return { ok: true };
  });
  app.delete<IdParams>("/api/ideas/:id", async (req, reply) => {
    const pid = repo.deleteIdea(req.params.id);
    if (pid === null) return reply.code(404).send({ error: "idea not found" });
    if (pid) changedProject(pid); else changedInbox(req.params.id);
    return noContent(reply);
  });

  /* ---------- export / import ---------- */
  app.get("/api/export", async (_req, reply) => {
    const body: ExportFile = { format: "lbsv", version: 1, exportedAt: now(), ...repo.state() };
    const stamp = new Date(body.exportedAt).toISOString().replace(/[:.]/g, "-");
    reply.header("content-disposition", `attachment; filename="lbsv-${stamp}.json"`);
    return body;
  });
  app.post("/api/import", async (req) => {
    const { mode, data } = S.ImportBody.parse(req.body);
    const r = repo.importState(data, mode);
    broadcast({ t: "changed", entity: "all", ids: [] });
    return { ok: true, mode, ...r };
  });

  /* ---------- UI ---------- */
  if (opts.uiDir && existsSync(opts.uiDir)) {
    await app.register(fastifyStatic, { root: opts.uiDir, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url === "/ws" || req.url.startsWith("/collect") || req.url.startsWith(MCP_PATH) || req.url.startsWith("/install/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, repo, auth, devices, live, terms, collectors, actions, mcpClients, backups, broadcast };
}
