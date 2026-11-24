import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { enroll } from "../../shared/src/collectorClient.ts";
import type { CollectorStatus } from "../../shared/src/hubSocket.ts";
import type { LiveState } from "../../shared/src/live.ts";
import type { WireTerm } from "../../shared/src/terms.ts";
import { Agent, AgentClient } from "../../agent/src/agent.ts";
import { PASS, login } from "./helpers.ts";
import { call, cleanups, live, start, waitFor, type Running } from "./sim.ts";

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const agentUrl = (r: Running) => r.ws.replace(/\/collect$/, "/collect/agent");
const termsOf = (st: LiveState) => st.devices.flatMap((d) => d.agents.flatMap((a) => a.terms));
const INFO = { version: "test", os: "linux", hostname: "vm-iso-3", user: "k" };

async function pair(r: Running, name = "vm-iso-3", kind: "agent" | "ext" = "agent") {
  const { code, device } = (await call(r, "POST", "/api/devices", { name })).body;
  const { token } = await enroll(r.ws, code, "agent", kind);
  return { token, deviceId: device.id as string };
}
function client(url: string, token: string, statuses: CollectorStatus[] = []) {
  const c = new AgentClient({ url, token, info: INFO, backoff: { minMs: 30, maxMs: 150 }, onStatus: (s) => statuses.push(s) });
  cleanups.push(() => c.stop());
  return c;
}
const T = (id: string, o: Partial<WireTerm> = {}): WireTerm => ({ id, kind: "shell", name: "", cwd: "/home/k", ...o });

describe("agent socket", () => {
  it("pairs, reports terminals, and the hub replaces the list on every message", async () => {
    const r = await start();
    const { token } = await pair(r);
    const c = client(agentUrl(r), token);
    c.update([T("tmux:work", { kind: "tmux", name: "work", cwd: "/home/k/git/lbops", attached: 1, windows: 3 }), T("sh:10", { shell: "bash", pid: 10 })]);
    c.start();
    let st = await waitFor(() => live(r), (s) => termsOf(s).length === 2);
    const dev = st.devices.find((d) => d.name === "vm-iso-3")!;
    expect(dev.agents[0]).toMatchObject({ hostname: "vm-iso-3", os: "linux", connected: true });
    expect(termsOf(st).find((t) => t.kind === "tmux")).toMatchObject({ name: "work", cwd: "/home/k/git/lbops", attached: 1, windows: 3 });
    const firstSeen = termsOf(st).find((t) => t.kind === "tmux")!.firstSeenAt;

    c.update([T("tmux:work", { kind: "tmux", name: "work", cwd: "/home/k/git/lbops/src", attached: 0 })]);
    st = await waitFor(() => live(r), (s) => termsOf(s).length === 1 && termsOf(s)[0].cwd.endsWith("/src"));
    expect(termsOf(st)[0].firstSeenAt).toBe(firstSeen); // survives updates

    const search = (await call(r, "GET", "/api/search?q=lbops")).body;
    expect(search.terms.map((t: { name: string }) => t.name)).toEqual(["work"]);
  });

  it("re-redacts commands on the hub (defence in depth)", async () => {
    const r = await start();
    const { token } = await pair(r);
    const c = client(agentUrl(r), token);
    c.update([T("sh:1", { cmd: "curl -H 'Authorization: Bearer abc' https://x/?token=1" })]);
    c.start();
    const st = await waitFor(() => live(r), (s) => termsOf(s).length === 1);
    expect(termsOf(st)[0].cmd).toBe("curl -H 'Authorization: Bearer [redacted]' https://x/");
  });

  it("rejects browser-extension tokens and bad tokens; revoking disconnects and drops terminals", async () => {
    const r = await start();
    const ext = await pair(r, "laptop", "ext");
    const s1: CollectorStatus[] = [];
    client(agentUrl(r), ext.token, s1).start();
    await waitFor(() => s1, (s) => s.includes("unauthorized"));

    const { token, deviceId } = await pair(r);
    const s2: CollectorStatus[] = [];
    const c = client(agentUrl(r), token, s2);
    c.update([T("sh:1")]);
    c.start();
    await waitFor(() => live(r), (s) => termsOf(s).length === 1);
    expect((await call(r, "POST", `/api/devices/${deviceId}/revoke`)).status).toBe(200);
    await waitFor(() => s2, (s) => s.includes("unauthorized"));
    expect(termsOf(await live(r))).toEqual([]);
  });

  it("marks the agent disconnected (terminals kept, greyed) when it goes away", async () => {
    const r = await start();
    const { token } = await pair(r);
    const c = client(agentUrl(r), token);
    c.update([T("sh:1")]); c.start();
    await waitFor(() => live(r), (s) => termsOf(s).length === 1);
    c.stop();
    const st = await waitFor(() => live(r), (s) => s.devices.some((d) => d.agents[0] && !d.agents[0].connected));
    expect(termsOf(st)).toHaveLength(1);
  });

  it("stores per-device SSH settings and validates them", async () => {
    const r = await start();
    const { deviceId } = await pair(r);
    expect((await call(r, "PATCH", `/api/devices/${deviceId}`, { sshTarget: "kelly@10.8.0.3", sshJump: "bastion" })).body.ssh).toEqual({ target: "kelly@10.8.0.3", jump: "bastion" });
    expect((await call(r, "PATCH", `/api/devices/${deviceId}`, { sshTarget: "x; rm -rf ~" })).status).toBe(400);
    expect((await live(r)).devices.find((d) => d.id === deviceId)!.ssh).toEqual({ target: "kelly@10.8.0.3", jump: "bastion" });
  });
});

describe("offline queue: hub down, terminals change, hub back", () => {
  it("a restarted hub (same database) gets the agent's current state on reconnect", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "lbsv-replay-"));
    const stateDir = join(dbDir, "shells");
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }));
    const dbFile = join(dbDir, "lbsv.db");

    // hub #1
    let db = openDb(dbFile);
    let hub = await buildApp({ db, adminPassphrase: PASS });
    await hub.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (hub.app.server.address() as { port: number }).port;
    const r1: Running = { hub, ws: `ws://127.0.0.1:${port}/collect`, cookie: await login(hub.app) };
    const { token } = await pair(r1);

    // a real Agent reading real hook files; the live shell is this test process (its pid is alive)
    const shell = (pid: number, cwd: string) => `v=1\nshell=bash\npid=${pid}\ncwd=${cwd}\n`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, String(process.pid)), shell(process.pid, "/home/k/before"));
    const statuses: CollectorStatus[] = [];
    const c = client(agentUrl(r1), token, statuses);
    let tmux = [{ name: "work", attached: 1, windows: 1, cwd: "/home/k/git" }];
    const agent = new Agent({ stateDir, client: c, pollMs: 60_000, debounceMs: 20, mux: async () => ({ tmux, panes: new Map(), screens: [] }) });
    cleanups.push(() => agent.stop());
    await agent.start();
    await waitFor(() => live(r1), (s) => termsOf(s).length === 2);

    // hub goes away
    await hub.app.close(); db.close();
    await waitFor(() => statuses, (s) => s.at(-1) === "offline");

    // while it's down: the shell moves, the tmux session ends, a new session starts, a dead shell's file is cleaned up
    writeFileSync(join(stateDir, String(process.pid)), shell(process.pid, "/home/k/after"));
    writeFileSync(join(stateDir, "999999"), shell(999999, "/gone"));
    tmux = [{ name: "deploy", attached: 0, windows: 2, cwd: "/srv" }];
    await agent.poll();
    expect(c.current.map((t) => t.id).sort()).toEqual([`sh:${process.pid}`, "tmux:deploy"]);

    // hub #2 on the same port and database
    db = openDb(dbFile);
    hub = await buildApp({ db, adminPassphrase: PASS });
    cleanups.push(async () => { await hub.app.close(); db.close(); });
    await hub.app.listen({ host: "127.0.0.1", port });
    const r2: Running = { hub, ws: r1.ws, cookie: await login(hub.app) };
    const st = await waitFor(() => live(r2), (s) => s.devices.some((d) => d.agents[0]?.connected) && termsOf(s).some((t) => t.name === "deploy"), 8000);
    expect(termsOf(st).map((t) => (t.kind === "tmux" ? t.name : t.cwd)).sort()).toEqual(["/home/k/after", "deploy"]);
    unlinkSync(join(stateDir, String(process.pid)));
  }, 20_000);
});

describe("rules API", () => {
  it("adds, dedupes, validates, deletes; included in the project, the state and export/import", async () => {
    const r = await start();
    const p = (await call(r, "POST", "/api/projects", { name: "lbops" })).body;
    const a = await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "domain", pattern: "https://Forge.example.net/example/lbops" });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ kind: "domain", pattern: "forge.example.net", projectId: p.id });
    expect((await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "domain", pattern: "forge.example.net" })).body.id).toBe(a.body.id);
    expect((await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "title_regex", pattern: "(oops" })).status).toBe(400);
    expect((await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "nope", pattern: "x" })).status).toBe(400);
    await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "cwd_prefix", pattern: "/home/k/git/example/lbops/" });

    const state = (await call(r, "GET", "/api/state")).body;
    expect(state.projects[0].rules.map((x: { pattern: string }) => x.pattern)).toEqual(["forge.example.net", "/home/k/git/example/lbops"]);

    const exp = (await call(r, "GET", "/api/export")).body;
    const r2 = await start();
    expect((await call(r2, "POST", "/api/import", { mode: "replace", data: exp })).status).toBe(200);
    expect((await call(r2, "GET", `/api/projects/${p.id}`)).body.rules).toHaveLength(2);

    expect((await call(r, "DELETE", `/api/rules/${a.body.id}`)).status).toBe(204);
    expect((await call(r, "DELETE", `/api/rules/${a.body.id}`)).status).toBe(404);
    expect((await call(r, "GET", `/api/projects/${p.id}`)).body.rules).toHaveLength(1);
  });

  it("undo of a project delete brings its rules back (PUT full project)", async () => {
    const r = await start();
    const p = (await call(r, "POST", "/api/projects", { name: "x" })).body;
    await call(r, "POST", `/api/projects/${p.id}/rules`, { kind: "host", pattern: "workstation" });
    const full = (await call(r, "GET", `/api/projects/${p.id}`)).body;
    await call(r, "DELETE", `/api/projects/${p.id}`);
    expect((await call(r, "PUT", `/api/projects/${p.id}`, full)).status).toBeLessThan(300);
    expect((await call(r, "GET", `/api/projects/${p.id}`)).body.rules.map((x: { pattern: string }) => x.pattern)).toEqual(["workstation"]);
  });
});
