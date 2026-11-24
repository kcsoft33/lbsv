/**
 * MCP server (SPEC §9, M4): lets a local assistant (Claude Code, Claude Desktop via the stdio
 * bridge in lbsv-agent) search and organise everything in the hub. Streamable HTTP at /mcp,
 * stateless (one McpServer per request), bearer token per client (mcp_clients).
 *
 * Every tool returns compact JSON as text. Destructive calls are explicit: closing tabs needs
 * `close: true` AND `confirm: true`, and an unconfirmed call returns a preview instead.
 */
import type { FastifyInstance } from "fastify";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Repo } from "./repo.ts";
import type { Live } from "./live.ts";
import type { Actions } from "./actions.ts";
import type { McpClient, McpClients } from "./mcpClients.ts";
import { Suggester, cleanRulePattern, describeRule, RULE_KINDS, type Item, type RuleKind, type Suggestion } from "../../shared/src/rules.ts";
import { dupKey, type LiveBrowser, type LiveDevice, type LiveState, type LiveTab } from "../../shared/src/live.ts";
import { reconnectCommand, sessionForTerm, tildePath, type LiveAgent, type LiveTerm } from "../../shared/src/terms.ts";
import type { Project, State, Status } from "../../shared/src/types.ts";

export const MCP_PATH = "/mcp";
const DAY = 86400_000;

export interface McpDeps {
  repo: Repo;
  live: Live;
  actions: Actions;
  clients: McpClients;
  now: () => number;
  version: string;
  notify: { project(...ids: (string | null | undefined)[]): void; inbox(id: string): void; live(): void };
}

/* ---------------- helpers (exported for tests) ---------------- */

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const out = (v: unknown): Text => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (message: string, extra: object = {}): Text => ({ content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }], isError: true });
const day = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const FAMILY: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", chromium: "Chromium" };
export const browserName = (b: Pick<LiveBrowser, "family" | "profile">) => `${FAMILY[b.family] ?? "Browser"}${b.profile ? ` · ${b.profile}` : ""}`;

/** Find a project by id or name (exact, case-insensitive, then unique partial match). */
export function resolveProject(projects: Project[], ref: string): { project: Project } | { error: string } {
  const r = ref.trim();
  const byId = projects.find((p) => p.id === r);
  if (byId) return { project: byId };
  const exact = projects.filter((p) => p.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return { project: exact[0]! };
  const q = squash(r);
  const partial = q ? projects.filter((p) => squash(p.name).includes(q)) : [];
  if (partial.length === 1) return { project: partial[0]! };
  if (partial.length > 1) return { error: `"${ref}" matches several projects: ${partial.map((p) => p.name).join(", ")}. Use the id or the full name.` };
  return { error: `No project "${ref}". Call list_projects to see them.` };
}

export interface TabView {
  id: string; title: string; url: string; device: string; browser: string; online: boolean;
  idleDays: number; openSince: string | null; pinned?: true; active?: true; copies?: number;
  project?: string; projectId?: string; how?: Suggestion["how"]; why?: string;
}
export interface TermView {
  id: string; kind: string; name: string; cwd: string; host: string; device: string; online: boolean;
  idleDays: number; reconnect: string; cmd?: string;
  project?: string; projectId?: string; how?: Suggestion["how"]; why?: string;
}

interface Flat {
  tabs: { d: LiveDevice; b: LiveBrowser; t: LiveTab }[];
  terms: { d: LiveDevice; a: LiveAgent; t: LiveTerm }[];
}
const flatten = (L: LiveState): Flat => ({
  tabs: L.devices.flatMap((d) => d.browsers.flatMap((b) => b.windows.flatMap((w) => w.tabs.map((t) => ({ d, b, t }))))),
  terms: L.devices.flatMap((d) => d.agents.flatMap((a) => a.terms.map((t) => ({ d, a, t })))),
});

export function tabView(L: LiveState, sg: Suggester, f: Flat["tabs"][number], copies: Map<string, number>): TabView {
  const { d, b, t } = f;
  const s = sg.suggest({ type: "tab", url: t.url, title: t.title });
  const n = copies.get(dupKey(t.url)) ?? 1;
  return {
    id: t.id, title: t.title, url: t.url, device: d.name, browser: browserName(b),
    online: b.connected && !!b.lastSeenAt && L.now - b.lastSeenAt <= L.staleAfterMs,
    idleDays: Math.floor((L.now - (t.lastAccessed ?? t.firstSeenAt)) / DAY), openSince: day(t.firstSeenAt),
    ...(t.pinned ? { pinned: true as const } : {}), ...(t.active ? { active: true as const } : {}), ...(n > 1 ? { copies: n } : {}),
    ...(s ? { project: sg.name(s.projectId), projectId: s.projectId, how: s.how, why: s.reason } : {}),
  };
}

export function termView(L: LiveState, sg: Suggester, f: Flat["terms"][number]): TermView {
  const { d, a, t } = f;
  const s = sg.suggest({ type: "term", cwd: t.cwd, host: a.hostname, name: t.name, device: d.name });
  return {
    id: t.id, kind: t.kind, name: t.name, cwd: tildePath(t.cwd, t.user || a.user), host: a.hostname, device: d.name,
    online: a.connected && !!a.lastSeenAt && L.now - a.lastSeenAt <= L.staleAfterMs,
    idleDays: t.lastActivityAt ? Math.floor((L.now - t.lastActivityAt) / DAY) : 0,
    reconnect: reconnectCommand(t, a, d.ssh ?? { target: "", jump: "" }),
    ...(t.cmd ? { cmd: t.cmd } : {}),
    ...(s ? { project: sg.name(s.projectId), projectId: s.projectId, how: s.how, why: s.reason } : {}),
  };
}

const deviceMatch = (d: LiveDevice, q?: string) => !q || d.id === q || d.name.toLowerCase().includes(q.toLowerCase());
const browserMatch = (b: LiveBrowser, q?: string) => {
  if (!q) return true;
  const s = q.toLowerCase();
  return b.id === q || b.family === s || browserName(b).toLowerCase().includes(s) || (!!b.profile && b.profile.toLowerCase() === s);
};
/** Every word must appear somewhere (case-insensitive substring), like the UI's search box. */
const wordsMatch = (hay: string, q: string) => { const h = hay.toLowerCase(); return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w)); };

const suggesterFor = (st: State) => new Suggester({ projects: st.projects, rules: st.projects.flatMap((p) => p.rules ?? []) });
const copyCounts = (fl: Flat) => { const m = new Map<string, number>(); for (const { t } of fl.tabs) m.set(dupKey(t.url), (m.get(dupKey(t.url)) ?? 0) + 1); return m; };

/** Markdown for lbsv://project/{id}: the "where I left off" view an assistant needs first. */
export function projectMarkdown(p: Project, liveTabs: TabView[], liveTerms: TermView[]): string {
  const L: string[] = [`# ${p.name}`, "", `Status: ${p.status}${p.tags ? ` · Tags: ${p.tags}` : ""} · Updated ${day(p.updatedAt)} · id ${p.id}`, ""];
  L.push("## Where I left off", "", p.leftOff.trim() || "_(empty)_", "");
  if (p.links.length) { L.push("## Links", ""); for (const l of p.links) L.push(`- [${l.label || l.url}](${l.url})${l.where ? ` — ${l.where}` : ""}`); L.push(""); }
  if (p.sessions.length) { L.push("## Sessions", ""); for (const s of p.sessions) L.push(`- ${s.kind} **${s.label || s.host}**${s.host ? ` on ${s.host}` : ""}${s.network ? ` (${s.network})` : ""}${s.cmd ? `: \`${s.cmd}\`` : ""}`); L.push(""); }
  if (p.ideas.length) { L.push("## Ideas", ""); for (const i of p.ideas) { L.push(`- ${i.text.replace(/\n+/g, " ")}`); for (const l of i.links ?? []) L.push(`  - [${l.title || l.url}](${l.url})`); } L.push(""); }
  if (p.rules?.length) { L.push("## Rules", ""); for (const r of p.rules) L.push(`- ${describeRule(r)}`); L.push(""); }
  if (liveTabs.length || liveTerms.length) {
    L.push("## Open now", "");
    for (const t of liveTabs) L.push(`- Tab: [${t.title || t.url}](${t.url}) in ${t.browser} on ${t.device}${t.online ? "" : " (offline)"} — tab_id ${t.id}`);
    for (const t of liveTerms) L.push(`- Terminal: ${t.kind} ${t.name || t.cwd} on ${t.host} — \`${t.reconnect}\``);
    L.push("");
  }
  return L.join("\n");
}

/* ---------------- server ---------------- */

/** Pending "close these tabs" previews, so the confirmed call closes only tabs still on the URL the user saw. */
const previews = new Map<string, { urls: Map<string, string>; at: number }>();
const PREVIEW_TTL = 15 * 60_000;

export function buildMcpServer(deps: McpDeps, client: Pick<McpClient, "id" | "name">): McpServer {
  const { repo, live, actions, notify, now } = deps;
  const server = new McpServer({ name: "lbsv", title: "LabSave (lbsv)", version: deps.version }, {
    instructions: "LabSave is the user's self-hosted home for projects: saved links, machines/sessions, ideas, a 'where I left off' note, " +
      "plus LIVE browser tabs and terminals streamed from their devices. Use `search` to find where something is (saved or open now). " +
      "Projects can be referred to by name or id. Never close tabs without the user's explicit go-ahead: park_tabs with close=true " +
      "first returns a preview; show it to the user and only then call again with confirm=true.",
  });
  const ro = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const ctx = () => { const st = repo.state(); const L = live.state(); return { st, L, fl: flatten(L), sg: suggesterFor(st) }; };
  const projectOr = (st: State, ref: string) => resolveProject(st.projects, ref);

  /* ----- search ----- */
  const SCOPES = ["projects", "links", "sessions", "ideas", "tabs", "terminals"] as const;
  server.registerTool("search", {
    title: "Search everything",
    description: "Search saved projects, links, sessions and ideas, and the live tabs and terminals open on every device. " +
      "Use it to answer 'where is X open?' or 'which project has X?'. Every word must match (prefix match for saved data, substring for live).",
    inputSchema: { query: z.string().min(1).describe("Words to find, e.g. 'grafana dashboard'"), scopes: z.array(z.enum(SCOPES)).optional().describe("Limit to these kinds; default all"), limit: z.number().int().min(1).max(200).optional() },
    annotations: ro,
  }, async ({ query, scopes, limit = 25 }) => {
    const want = new Set(scopes?.length ? scopes : SCOPES);
    const { st, L, fl, sg } = ctx();
    const name = new Map(st.projects.map((p) => [p.id, p.name]));
    const saved = repo.search(query, limit);
    const copies = copyCounts(fl);
    const res: Record<string, unknown> = {};
    if (want.has("projects")) res.projects = saved.projects.map((p) => ({ id: p.id, name: p.name, status: p.status }));
    if (want.has("links")) res.links = [...saved.links.map((l) => ({ project: name.get(l.projectId), projectId: l.projectId, label: l.label, url: l.url, where: l.where || undefined })),
      ...saved.ideaLinks.map((l) => ({ project: l.projectId ? name.get(l.projectId) : "inbox", projectId: l.projectId, idea: l.ideaId, label: l.title, url: l.url }))];
    if (want.has("sessions")) res.sessions = saved.sessions.map((s) => ({ project: name.get(s.projectId), projectId: s.projectId, kind: s.kind, label: s.label, host: s.host, network: s.network || undefined, cmd: s.cmd || undefined }));
    if (want.has("ideas")) res.ideas = saved.ideas.map((i) => ({ id: i.id, project: i.projectId ? name.get(i.projectId) : "inbox", text: i.text }));
    if (want.has("tabs")) res.tabs = fl.tabs.filter(({ t }) => wordsMatch(`${t.title} ${t.url}`, query)).slice(0, limit).map((f) => tabView(L, sg, f, copies));
    if (want.has("terminals")) res.terminals = fl.terms.filter(({ a, t }) => wordsMatch(`${t.name} ${t.cwd} ${t.cmd} ${a.hostname}`, query)).slice(0, limit).map((f) => termView(L, sg, f));
    for (const k of Object.keys(res)) if (!(res[k] as unknown[]).length) delete res[k];
    return out(Object.keys(res).length ? res : { none: `Nothing matches "${query}".` });
  });

  /* ----- projects ----- */
  server.registerTool("list_projects", {
    title: "List projects",
    description: "All projects with status, tags, counts and the first line of their 'where I left off' note, most recently updated first.",
    inputSchema: { status: z.enum(["active", "parked", "done"]).optional() },
    annotations: ro,
  }, async ({ status }) => {
    const { st, fl, sg } = ctx();
    const openTabs = new Map<string, number>();
    for (const { t } of fl.tabs) { const s = sg.suggest({ type: "tab", url: t.url, title: t.title }); if (s) openTabs.set(s.projectId, (openTabs.get(s.projectId) ?? 0) + 1); }
    return out({
      projects: st.projects.filter((p) => !status || p.status === status).sort((a, b) => b.updatedAt - a.updatedAt).map((p) => ({
        id: p.id, name: p.name, status: p.status, tags: p.tags || undefined, updated: day(p.updatedAt),
        leftOff: p.leftOff.trim().split("\n")[0]?.slice(0, 160) || undefined,
        links: p.links.length, sessions: p.sessions.length, ideas: p.ideas.length, openTabs: openTabs.get(p.id) || undefined,
      })),
      inbox: st.inbox.length,
    });
  });

  server.registerTool("get_project", {
    title: "Get a project",
    description: "One project in full: left-off note, links, sessions, ideas, rules, and the tabs/terminals open for it right now.",
    inputSchema: { project: z.string().min(1).describe("Project id or name") },
    annotations: ro,
  }, async ({ project }) => {
    const { st, L, fl, sg } = ctx();
    const r = projectOr(st, project); if ("error" in r) return fail(r.error);
    const p = r.project; const copies = copyCounts(fl);
    return out({
      ...p, createdAt: day(p.createdAt), updatedAt: day(p.updatedAt),
      openNow: {
        tabs: fl.tabs.map((f) => tabView(L, sg, f, copies)).filter((t) => t.projectId === p.id),
        terminals: fl.terms.map((f) => termView(L, sg, f)).filter((t) => t.projectId === p.id),
      },
    });
  });

  server.registerTool("create_project", {
    title: "Create a project",
    description: "Create a project. Fails if one with the same name exists.",
    inputSchema: { name: z.string().min(1).max(500), status: z.enum(["active", "parked", "done"]).optional(), tags: z.string().max(2000).optional(), left_off: z.string().max(100_000).optional() },
    annotations: write,
  }, async ({ name, status, tags, left_off }) => {
    const st = repo.state();
    const dup = st.projects.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    if (dup) return fail(`A project named "${dup.name}" already exists`, { id: dup.id });
    let p = repo.createProject({ name: name.trim(), status: status as Status | undefined });
    if (tags !== undefined || left_off !== undefined) p = repo.updateProject(p.id, { tags, leftOff: left_off });
    notify.project(p.id);
    return out({ created: { id: p.id, name: p.name, status: p.status } });
  });

  server.registerTool("update_project", {
    title: "Update a project",
    description: "Rename, change status, set tags, or replace / append to the 'where I left off' note.",
    inputSchema: {
      project: z.string().min(1).describe("Project id or name"),
      name: z.string().min(1).max(500).optional(), status: z.enum(["active", "parked", "done"]).optional(), tags: z.string().max(2000).optional(),
      left_off: z.string().max(100_000).optional().describe("Replaces the whole note"),
      append_left_off: z.string().max(100_000).optional().describe("Appended to the note on a new line (safer than replacing)"),
    },
    annotations: write,
  }, async ({ project, name, status, tags, left_off, append_left_off }) => {
    const r = projectOr(repo.state(), project); if ("error" in r) return fail(r.error);
    let leftOff = left_off;
    if (append_left_off) leftOff = `${(left_off ?? r.project.leftOff).replace(/\s+$/, "")}${(left_off ?? r.project.leftOff).trim() ? "\n" : ""}${append_left_off}`;
    const p = repo.updateProject(r.project.id, { name: name?.trim(), status: status as Status | undefined, tags, leftOff });
    notify.project(p.id);
    return out({ updated: { id: p.id, name: p.name, status: p.status, tags: p.tags, leftOff: p.leftOff } });
  });

  server.registerTool("add_links", {
    title: "Add links to a project",
    description: "Save URLs in a project. URLs already saved there are skipped.",
    inputSchema: {
      project: z.string().min(1).describe("Project id or name"),
      links: z.array(z.object({ url: z.string().min(1).max(8192), label: z.string().max(2000).optional(), where: z.string().max(500).optional().describe("e.g. 'Edge on laptop'") })).min(1).max(500),
    },
    annotations: write,
  }, async ({ project, links }) => {
    const r = projectOr(repo.state(), project); if ("error" in r) return fail(r.error);
    const have = new Set(r.project.links.map((l) => dupKey(l.url)));
    const fresh = links.filter((l) => !have.has(dupKey(l.url)));
    const added = fresh.length ? repo.addLinks(r.project.id, fresh) : [];
    if (added.length) notify.project(r.project.id);
    return out({ project: r.project.name, added: added.length, skipped: links.length - added.length });
  });

  server.registerTool("add_idea", {
    title: "Add an idea",
    description: "Jot an idea into a project, or into the inbox when no project is given.",
    inputSchema: { text: z.string().min(1).max(100_000), project: z.string().optional().describe("Project id or name; omit for the inbox") },
    annotations: write,
  }, async ({ text, project }) => {
    let projectId: string | null = null;
    if (project) { const r = projectOr(repo.state(), project); if ("error" in r) return fail(r.error); projectId = r.project.id; }
    const i = repo.addIdea({ text, projectId });
    if (projectId) notify.project(projectId); else notify.inbox(i.id);
    return out({ added: { id: i.id, project: projectId ? repo.project(projectId)?.name : "inbox" } });
  });

  server.registerTool("file_inbox_item", {
    title: "File an inbox idea",
    description: "Move an idea from the inbox (or another project) into a project. Idea ids come from list_inbox / search.",
    inputSchema: { idea_id: z.string().min(1), project: z.string().min(1).describe("Project id or name") },
    annotations: write,
  }, async ({ idea_id, project }) => {
    const r = projectOr(repo.state(), project); if ("error" in r) return fail(r.error);
    try {
      const { from, to } = repo.moveIdea(idea_id, r.project.id);
      notify.project(from, to); if (!from) notify.inbox(idea_id);
      return out({ filed: idea_id, project: r.project.name });
    } catch { return fail(`No idea with id ${idea_id}`); }
  });

  server.registerTool("list_inbox", {
    title: "List the inbox",
    description: "Ideas not yet filed into a project.",
    inputSchema: {},
    annotations: ro,
  }, async () => out({ inbox: repo.state().inbox.map((i) => ({ id: i.id, text: i.text, at: day(i.at), links: i.links?.map((l) => l.url) })) }));

  server.registerTool("add_rule", {
    title: "Add a filing rule",
    description: "Teach LabSave which project live tabs/terminals belong to. Kinds: domain (site), url_prefix, title_regex " +
      "(case-insensitive; also matches tmux/screen session names), cwd_prefix (terminal folder), host (terminal machine).",
    inputSchema: { project: z.string().min(1), kind: z.enum(RULE_KINDS as [RuleKind, ...RuleKind[]]), pattern: z.string().min(1).max(2000) },
    annotations: write,
  }, async ({ project, kind, pattern }) => {
    const r = projectOr(repo.state(), project); if ("error" in r) return fail(r.error);
    if (!cleanRulePattern(kind, pattern)) return fail("That pattern can't be used for this kind of rule.");
    const rule = repo.addRule(r.project.id, { kind, pattern });
    if (!rule) return fail("That pattern can't be used for this kind of rule.");
    notify.project(r.project.id);
    return out({ added: { id: rule.id, project: r.project.name, rule: describeRule(rule) } });
  });

  /* ----- live ----- */
  server.registerTool("list_live_tabs", {
    title: "List open tabs",
    description: "Browser tabs open right now on every device, with the project each probably belongs to (how: filed = URL already saved there, " +
      "rule = matched a rule, guess = heuristic). idleDays = days since last used. Use stale_days for 'stale tabs'.",
    inputSchema: {
      device: z.string().optional().describe("Device name (substring) or id"),
      browser: z.string().optional().describe("edge | chrome | firefox, a profile name, or a browser id"),
      stale_days: z.number().int().min(0).optional().describe("Only tabs unused for at least this many days"),
      project: z.string().optional().describe("Only tabs that belong to this project (id or name)"),
      unfiled: z.boolean().optional().describe("Only tabs with no project"),
      query: z.string().optional().describe("Words that must appear in the title or URL"),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: ro,
  }, async ({ device, browser, stale_days, project, unfiled, query, limit = 200 }) => {
    const { st, L, fl, sg } = ctx();
    let pid: string | undefined;
    if (project) { const r = projectOr(st, project); if ("error" in r) return fail(r.error); pid = r.project.id; }
    const copies = copyCounts(fl);
    const all = fl.tabs.filter(({ d, b, t }) => deviceMatch(d, device) && browserMatch(b, browser) && (!query || wordsMatch(`${t.title} ${t.url}`, query)))
      .map((f) => tabView(L, sg, f, copies))
      .filter((t) => (stale_days === undefined || t.idleDays >= stale_days) && (!pid || t.projectId === pid) && (!unfiled || !t.projectId));
    return out({ total: all.length, oldTabDays: L.oldTabDays, tabs: all.slice(0, limit) });
  });

  server.registerTool("list_live_terminals", {
    title: "List open terminals",
    description: "Shells and tmux/screen sessions open right now (from lbsv-agent), each with a reconnect command and its probable project.",
    inputSchema: { device: z.string().optional().describe("Device name (substring), id, or hostname"), project: z.string().optional(), query: z.string().optional() },
    annotations: ro,
  }, async ({ device, project, query }) => {
    const { st, L, fl, sg } = ctx();
    let pid: string | undefined;
    if (project) { const r = projectOr(st, project); if ("error" in r) return fail(r.error); pid = r.project.id; }
    const terms = fl.terms.filter(({ d, a, t }) => (deviceMatch(d, device) || (!!device && a.hostname.toLowerCase().includes(device.toLowerCase())))
      && (!query || wordsMatch(`${t.name} ${t.cwd} ${t.cmd} ${a.hostname}`, query)))
      .map((f) => termView(L, sg, f)).filter((t) => !pid || t.projectId === pid);
    return out({ total: terms.length, terminals: terms });
  });

  server.registerTool("suggest_assignments", {
    title: "Suggest projects for open things",
    description: "Live tabs and terminals not yet saved in any project, with the best-guess project and the reason. " +
      "Accept with park_tabs (close=false keeps the tab open) / save_terminal, or teach a rule with add_rule.",
    inputSchema: { include_unmatched: z.boolean().optional().describe("Also list items with no suggestion (default false)") },
    annotations: ro,
  }, async ({ include_unmatched }) => {
    const { L, fl, sg } = ctx();
    const copies = copyCounts(fl);
    const seen = new Set<string>();
    const tabs = fl.tabs.map((f) => tabView(L, sg, f, copies))
      .filter((t) => t.how !== "filed" && (include_unmatched || t.projectId))
      .filter((t) => { const k = dupKey(t.url); if (seen.has(k)) return false; seen.add(k); return true; });
    const terms = fl.terms.map((f) => termView(L, sg, f)).filter((t) => t.how !== "filed" && (include_unmatched || t.projectId));
    return out({ tabs, terminals: terms });
  });

  server.registerTool("park_tabs", {
    title: "Park tabs into a project",
    description: "Save live tabs as links in a project, optionally closing them. Closing is destructive: with close=true and no confirm, " +
      "nothing happens and you get a preview to show the user; call again with confirm=true only after the user agrees. " +
      "A tab whose URL changed since the preview is not closed and is reported back.",
    inputSchema: {
      tab_ids: z.array(z.string().min(1)).min(1).max(500).describe("ids from list_live_tabs / search"),
      project: z.string().min(1).describe("Project id or name"),
      close: z.boolean().optional().describe("Also close the tabs after saving (default false)"),
      confirm: z.boolean().optional().describe("Required with close=true, after the user approved the preview"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ tab_ids, project, close = false, confirm = false }) => {
    const { st, L, fl } = ctx();
    const r = projectOr(st, project); if ("error" in r) return fail(r.error);
    const byId = new Map(fl.tabs.map((f) => [f.t.id, f]));
    const missing = tab_ids.filter((id) => !byId.has(id));
    const found = tab_ids.filter((id) => byId.has(id));
    if (!found.length) return fail("None of those tabs are open any more. Call list_live_tabs again.", { missing });
    const key = `${client.id}|${r.project.id}|${[...found].sort().join(",")}`;
    for (const [k, v] of previews) if (now() - v.at > PREVIEW_TTL) previews.delete(k);
    if (close && !confirm) {
      previews.set(key, { urls: new Map(found.map((id) => [id, byId.get(id)!.t.url])), at: now() });
      return out({
        needsConfirmation: true,
        message: `This will save ${found.length} tab(s) to "${r.project.name}" and then CLOSE them. Show the user this list and ask; if they agree, call park_tabs again with the same tab_ids, project, close=true and confirm=true.`,
        wouldClose: found.map((id) => { const { d, b, t } = byId.get(id)!; return { id, title: t.title, url: t.url, where: `${browserName(b)} on ${d.name}`, idleDays: Math.floor((L.now - (t.lastAccessed ?? t.firstSeenAt)) / DAY) }; }),
        ...(missing.length ? { missing } : {}),
      });
    }
    const seenUrls = previews.get(key)?.urls; previews.delete(key);
    const refs = found.map((id) => ({ id, url: seenUrls?.get(id) ?? byId.get(id)!.t.url }));
    const res = await actions.park({ projectId: r.project.id, tabs: refs, close });
    notify.project(r.project.id);
    if (res.closed.length) notify.live();
    return out({
      project: r.project.name, saved: res.added.length, alreadySaved: refs.length - res.added.length,
      ...(close ? { closed: res.closed.length, notClosed: res.notClosed } : {}), ...(missing.length ? { missing } : {}),
    });
  });

  server.registerTool("save_terminal", {
    title: "Save a terminal to a project",
    description: "Save a live terminal (shell or tmux/screen session) into a project as a session with its reconnect command.",
    inputSchema: { term_id: z.string().min(1).describe("id from list_live_terminals"), project: z.string().min(1) },
    annotations: write,
  }, async ({ term_id, project }) => {
    const { st, fl } = ctx();
    const r = projectOr(st, project); if ("error" in r) return fail(r.error);
    const f = fl.terms.find((x) => x.t.id === term_id);
    if (!f) return fail("That terminal isn't open any more. Call list_live_terminals again.");
    const s = sessionForTerm(f.t, f.a, f.d.ssh ?? { target: "", jump: "" });
    if (r.project.sessions.some((x) => x.cmd === s.cmd)) return out({ project: r.project.name, alreadySaved: true });
    repo.addSession(r.project.id, s);
    notify.project(r.project.id);
    return out({ project: r.project.name, saved: { label: s.label, host: s.host, cmd: s.cmd } });
  });

  server.registerTool("open_url", {
    title: "Open a URL in a browser",
    description: "Open URLs in a browser on one of the user's devices (it must be online).",
    inputSchema: {
      url: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]),
      device: z.string().min(1).describe("Device name (substring) or id"),
      browser: z.string().optional().describe("edge | chrome | firefox | profile | browser id; default: the device's most recently active browser"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ url, device, browser }) => {
    const urls = Array.isArray(url) ? url : [url];
    if (urls.some((u) => !/^(https?|file|ftp):/i.test(u))) return fail("Only http(s), file and ftp URLs can be opened.");
    const L = live.state();
    const cands = L.devices.filter((d) => deviceMatch(d, device)).flatMap((d) => d.browsers.filter((b) => browserMatch(b, browser)).map((b) => ({ d, b })));
    if (!cands.length) return fail(`No browser matches device "${device}"${browser ? ` / browser "${browser}"` : ""}.`, { devices: L.devices.map((d) => ({ name: d.name, browsers: d.browsers.map(browserName) })) });
    const online = cands.filter(({ b }) => b.connected).sort((x, y) => (y.b.lastSeenAt ?? 0) - (x.b.lastSeenAt ?? 0));
    if (!online.length) return fail("That browser is offline.");
    const devices = new Set(online.map(({ d }) => d.id));
    if (devices.size > 1) return fail(`"${device}" matches several devices; be more specific.`, { matches: [...new Set(online.map(({ d }) => d.name))] });
    const { d, b } = online[0]!;
    const res = await actions.open(b.id, urls, live.targetWindow(b.id));
    if (!res.ok) return fail(res.error === "offline" ? "That browser is offline." : `The browser didn't open it: ${res.error}`);
    notify.live();
    return out({ opened: res.result.opened ?? urls.length, in: `${browserName(b)} on ${d.name}` });
  });

  server.registerTool("focus_tab", {
    title: "Bring a tab to the front",
    description: "Focus a live tab (and its window) on its device, so the user can find it.",
    inputSchema: { tab_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ tab_id }) => {
    const res = await actions.focus(tab_id);
    if (!res) return fail("That tab isn't open any more.");
    if (!res.ok) return fail(res.error === "offline" ? "That browser is offline." : `Focus failed: ${res.error}`);
    return out({ focused: tab_id });
  });

  /* ----- resources ----- */
  server.registerResource("project", new ResourceTemplate("lbsv://project/{id}", {
    list: async () => ({ resources: repo.state().projects.map((p) => ({ uri: `lbsv://project/${p.id}`, name: p.name, mimeType: "text/markdown", description: `${p.status} project` })) }),
  }), { title: "Project summary", description: "A project as markdown, including its 'where I left off' note and what's open now.", mimeType: "text/markdown" },
  async (uri, vars) => {
    const { st, L, fl, sg } = ctx();
    const id = String(vars.id ?? "");
    const r = projectOr(st, decodeURIComponent(id));
    if ("error" in r) throw new Error(r.error);
    const copies = copyCounts(fl);
    const tabs = fl.tabs.map((f) => tabView(L, sg, f, copies)).filter((t) => t.projectId === r.project.id);
    const terms = fl.terms.map((f) => termView(L, sg, f)).filter((t) => t.projectId === r.project.id);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: projectMarkdown(r.project, tabs, terms) }] };
  });

  server.registerResource("today", "lbsv://today", {
    title: "Today", description: "Recently touched projects with their left-off notes and what's open for them, plus the inbox.", mimeType: "text/markdown",
  }, async (uri) => {
    const { st, L, fl, sg } = ctx();
    const copies = copyCounts(fl);
    const tabs = fl.tabs.map((f) => tabView(L, sg, f, copies));
    const terms = fl.terms.map((f) => termView(L, sg, f));
    const recent = st.projects.filter((p) => p.status !== "done").sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((p, i) => i < 5 || L.now - p.updatedAt < 7 * DAY || tabs.some((t) => t.projectId === p.id) || terms.some((t) => t.projectId === p.id)).slice(0, 15);
    const lines = [`# Today — ${day(L.now)}`, ""];
    for (const p of recent) {
      const pt = tabs.filter((t) => t.projectId === p.id), pm = terms.filter((t) => t.projectId === p.id);
      lines.push(`## ${p.name} (${p.status}, updated ${day(p.updatedAt)})`, "");
      lines.push(p.leftOff.trim() ? p.leftOff.trim().split("\n").slice(0, 6).join("\n") : "_No left-off note._", "");
      if (pt.length || pm.length) lines.push(`Open now: ${pt.length} tab(s)${pm.length ? `, ${pm.length} terminal(s): ${pm.map((t) => `${t.name || t.cwd}@${t.host}`).join(", ")}` : ""}`, "");
    }
    const unfiled = tabs.filter((t) => !t.projectId).length;
    lines.push("## Elsewhere", "", `- Inbox: ${st.inbox.length} idea(s)`, `- Open tabs: ${tabs.length} (${unfiled} not in any project, ${tabs.filter((t) => t.idleDays >= L.oldTabDays).length} unused ${L.oldTabDays}+ days)`, `- Terminals: ${terms.length}`);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lines.join("\n") }] };
  });

  return server;
}

/** Mount POST /mcp (stateless streamable HTTP). GET/DELETE answer 405: there are no server-initiated streams. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const unauthorized = (reply: import("fastify").FastifyReply) => reply.code(401)
    .header("www-authenticate", 'Bearer realm="lbsv", error="invalid_token"')
    .send({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: create a token on the hub's Devices page (MCP clients) and send it as 'Authorization: Bearer <token>'." }, id: null });

  app.post(MCP_PATH, async (req, reply) => {
    const client = deps.clients.authenticate(req.headers.authorization);
    if (!client) return unauthorized(reply);
    const server = buildMcpServer(deps, client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      req.log.error(e);
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
    }
  });
  const notAllowed = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!deps.clients.authenticate(req.headers.authorization)) return unauthorized(reply);
    return reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
  };
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
}
