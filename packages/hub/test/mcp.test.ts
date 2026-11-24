/**
 * MCP server (SPEC §9, M4) over real HTTP with the official SDK client, against a hub with a
 * simulated browser connected: auth, the M4 acceptance questions, and the confirm gate on closing.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SimBrowser, call, cleanups, connect, live, project, start, tabsOf, waitFor, type Running } from "./sim.ts";
import { resolveProject } from "../src/mcp.ts";
import type { Project } from "../../shared/src/types.ts";

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const DAY = 86400_000;

const base = (r: Running) => r.ws.replace(/^ws/, "http").replace(/\/collect$/, "");
async function token(r: Running, name = "Claude Code test"): Promise<string> {
  const res = await call<{ token: string; client: { id: string } }>(r, "POST", "/api/mcp-clients", { name });
  expect(res.status).toBe(201);
  return res.body.token;
}
async function mcp(r: Running, tok: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base(r)}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  cleanups.push(() => c.close());
  return c;
}
async function tool<T = any>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; v: T }> {
  const res = await c.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean };
  return { ok: !res.isError, v: JSON.parse(res.content[0]!.text) as T };
}

describe("MCP auth", () => {
  it("rejects missing, wrong and revoked tokens; the cookie and collector tokens don't work either", async () => {
    const r = await start();
    const post = (headers: Record<string, string>) => fetch(`${base(r)}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer lbsvm_nope" })).status).toBe(401);
    expect((await post({ cookie: r.cookie })).status).toBe(401);
    const b = new SimBrowser(); await connect(r, "laptop", "", b);
    const tok = await token(r);
    // A raw stateless call works without initialize.
    const ok = await post({ authorization: `Bearer ${tok}` });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain("park_tabs");
    // The hub's own UI API is not reachable with an MCP token.
    expect((await fetch(`${base(r)}/api/state`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    // Revoke.
    const id = (await call<{ clients: { id: string; lastUsedAt: number | null }[] }>(r, "GET", "/api/mcp-clients")).body.clients[0]!;
    expect(id.lastUsedAt).not.toBeNull();
    expect((await call(r, "DELETE", `/api/mcp-clients/${id.id}`)).status).toBe(204);
    expect((await post({ authorization: `Bearer ${tok}` })).status).toBe(401);
    expect((await fetch(`${base(r)}/mcp`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
  });

  it("lists the SPEC §9 tools and both resources", async () => {
    const r = await start();
    const c = await mcp(r, await token(r));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    for (const t of ["search", "list_projects", "get_project", "create_project", "update_project", "add_links", "add_idea", "file_inbox_item",
      "list_live_tabs", "list_live_terminals", "park_tabs", "open_url", "focus_tab", "suggest_assignments"]) expect(names).toContain(t);
    const park = (await c.listTools()).tools.find((t) => t.name === "park_tabs")!;
    expect(park.annotations?.destructiveHint).toBe(true);
    expect((await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toContain("lbsv://project/{id}");
    expect((await c.listResources()).resources.map((x) => x.uri)).toContain("lbsv://today");
  });
});

describe("MCP tools (SPEC §11 M4 acceptance)", () => {
  async function setup() {
    const r = await start();
    const work = new SimBrowser(), home = new SimBrowser();
    work.add("https://grafana.lab.example/d/abc/node-exporter", "Node Exporter Full - Dashboards - Grafana");
    const old = Date.now() - 12 * DAY;
    for (let i = 0; i < 3; i++) { const t = work.add(`https://wiki.example/kb/${i}`, `KB page ${i}`); t.lastAccessed = old; }
    const fresh = work.add("https://wiki.example/kb/fresh", "KB fresh page"); fresh.lastAccessed = Date.now();
    home.add("https://news.example/", "News");
    await connect(r, "laptop", "Work", work);
    await connect(r, "desktop", "Personal", home);
    await waitFor(() => live(r), (s) => tabsOf(s).length === 6);
    const kb = await project(r, "Knowledge base");
    await call(r, "POST", `/api/projects/${kb}/rules`, { kind: "domain", pattern: "wiki.example" });
    const c = await mcp(r, await token(r));
    return { r, work, home, kb, c };
  }

  it("answers 'where is the grafana dashboard open?'", async () => {
    const { c } = await setup();
    const { ok, v } = await tool(c, "search", { query: "grafana dashboard" });
    expect(ok).toBe(true);
    expect(v.tabs).toHaveLength(1);
    expect(v.tabs[0]).toMatchObject({ title: "Node Exporter Full - Dashboards - Grafana", device: "laptop", browser: "Edge · Work", online: true });
    // and focus_tab brings it forward
    expect((await tool(c, "focus_tab", { tab_id: v.tabs[0].id })).ok).toBe(true);
  });

  it("'park all stale tabs about project X': lists them, previews, and only closes after confirm", async () => {
    const { r, work, kb, c } = await setup();
    const stale = await tool(c, "list_live_tabs", { project: "knowledge", stale_days: 7 });
    expect(stale.v.tabs.map((t: { url: string }) => t.url).sort()).toEqual(["https://wiki.example/kb/0", "https://wiki.example/kb/1", "https://wiki.example/kb/2"]);
    expect(stale.v.tabs[0]).toMatchObject({ project: "Knowledge base", how: "rule" });
    const ids = stale.v.tabs.map((t: { id: string }) => t.id);

    // Unconfirmed: a preview, nothing saved, nothing closed.
    const pre = await tool(c, "park_tabs", { tab_ids: ids, project: "Knowledge base", close: true });
    expect(pre.v.needsConfirmation).toBe(true);
    expect(pre.v.wouldClose).toHaveLength(3);
    expect(work.tabs).toHaveLength(5);
    expect((await call<Project>(r, "GET", `/api/projects/${kb}`)).body.links).toHaveLength(0);

    // One tab navigates after the preview: it must not be closed.
    const moved = work.tabs.find((t) => t.url.endsWith("/kb/1"))!;
    work.navigate(moved.id, "https://elsewhere.example/");
    await waitFor(() => live(r), (s) => tabsOf(s).some((t) => t.url === "https://elsewhere.example/"));

    const done = await tool(c, "park_tabs", { tab_ids: ids, project: kb, close: true, confirm: true });
    expect(done.ok).toBe(true);
    expect(done.v).toMatchObject({ project: "Knowledge base", saved: 3, closed: 2 });
    expect(done.v.notClosed).toEqual([{ id: ids.find((_: string, i: number) => stale.v.tabs[i].url.endsWith("/kb/1")), reason: "url_changed" }]);
    expect(work.tabs.map((t) => t.url).sort()).toEqual(["https://elsewhere.example/", "https://grafana.lab.example/d/abc/node-exporter", "https://wiki.example/kb/fresh"]);
    expect((await call<Project>(r, "GET", `/api/projects/${kb}`)).body.links.map((l) => l.url).sort()).toEqual(["https://wiki.example/kb/0", "https://wiki.example/kb/1", "https://wiki.example/kb/2"]);
  });

  it("park without close keeps tabs open; suggest_assignments lists rule matches; filed ones drop out", async () => {
    const { work, c } = await setup();
    const sug = await tool(c, "suggest_assignments");
    expect(sug.v.tabs.map((t: { url: string }) => t.url).sort()).toEqual(["https://wiki.example/kb/0", "https://wiki.example/kb/1", "https://wiki.example/kb/2", "https://wiki.example/kb/fresh"]);
    const id = sug.v.tabs.find((t: { url: string }) => t.url.endsWith("/fresh")).id;
    expect((await tool(c, "park_tabs", { tab_ids: [id], project: "Knowledge base" })).v).toMatchObject({ saved: 1 });
    expect(work.tabs).toHaveLength(5);
    const after = await tool(c, "suggest_assignments");
    expect(after.v.tabs).toHaveLength(3);
    const all = await tool(c, "suggest_assignments", { include_unmatched: true });
    expect(all.v.tabs.map((t: { url: string }) => t.url)).toContain("https://news.example/");
  });

  it("projects, links, ideas, inbox and rules round-trip; UIs get change events", async () => {
    const { r, c } = await setup();
    const events: string[] = [];
    const ui = new WebSocket(`${base(r).replace(/^http/, "ws")}/ws`, { headers: { cookie: r.cookie } });
    ui.on("message", (d) => events.push(JSON.parse(String(d)).entity));
    await new Promise((res) => ui.once("open", res));
    cleanups.push(() => ui.close());
    expect((await tool(c, "create_project", { name: "Grafana", tags: "obs", left_off: "Was tuning the node dashboard" })).ok).toBe(true);
    expect((await tool(c, "create_project", { name: "grafana" })).ok).toBe(false);
    expect((await tool(c, "add_links", { project: "grafana", links: [{ url: "https://grafana.lab.example/" }, { url: "https://grafana.lab.example/" }] })).v).toMatchObject({ added: 1, skipped: 1 });
    expect((await tool(c, "update_project", { project: "Grafana", append_left_off: "Next: alert rules" })).v.updated.leftOff).toBe("Was tuning the node dashboard\nNext: alert rules");
    const idea = await tool(c, "add_idea", { text: "Try Loki for logs" });
    expect(idea.v.added.project).toBe("inbox");
    expect((await tool(c, "list_inbox")).v.inbox).toHaveLength(1);
    expect((await tool(c, "file_inbox_item", { idea_id: idea.v.added.id, project: "Grafana" })).v.project).toBe("Grafana");
    expect((await tool(c, "list_inbox")).v.inbox).toHaveLength(0);
    expect((await tool(c, "add_rule", { project: "Grafana", kind: "domain", pattern: "grafana.lab.example" })).ok).toBe(true);
    expect((await tool(c, "add_rule", { project: "Grafana", kind: "title_regex", pattern: "(" })).ok).toBe(false);
    const g = await tool(c, "get_project", { project: "Grafana" });
    expect(g.v).toMatchObject({ name: "Grafana", tags: "obs" });
    expect(g.v.ideas.map((i: { text: string }) => i.text)).toEqual(["Try Loki for logs"]);
    expect(g.v.openNow.tabs.map((t: { url: string }) => t.url)).toEqual(["https://grafana.lab.example/d/abc/node-exporter"]);
    expect((await tool(c, "search", { query: "loki" })).v.ideas[0].project).toBe("Grafana");
    expect((await tool(c, "list_projects", { status: "active" })).v.projects.map((p: { name: string }) => p.name)).toContain("Grafana");
    expect((await tool(c, "get_project", { project: "nope" })).ok).toBe(false);
    await waitFor(() => events, (e) => e.includes("inbox"));
    expect(events).toContain("project");
    expect(events).toContain("inbox");

    const md = await c.readResource({ uri: `lbsv://project/${g.v.id}` });
    const text = (md.contents[0] as { text: string }).text;
    expect(text).toContain("# Grafana");
    expect(text).toContain("Next: alert rules");
    expect(text).toContain("Node Exporter Full");
    const today = (await c.readResource({ uri: "lbsv://today" })).contents[0] as { text: string };
    expect(today.text).toContain("## Grafana");
  });

  it("open_url opens in the named device's browser and refuses odd schemes", async () => {
    const { home, c } = await setup();
    expect((await tool(c, "open_url", { url: "javascript:alert(1)", device: "desktop" })).ok).toBe(false);
    expect((await tool(c, "open_url", { url: "https://x.example/", device: "nowhere" })).ok).toBe(false);
    const res = await tool(c, "open_url", { url: "https://x.example/", device: "desk" });
    expect(res.v).toMatchObject({ opened: 1, in: "Edge · Personal on desktop" });
    expect(home.tabs.map((t) => t.url)).toContain("https://x.example/");
  });
});

describe("resolveProject", () => {
  const P = (id: string, name: string) => ({ id, name } as Project);
  const ps = [P("1", "lbops"), P("2", "Hermes & Paperclip"), P("3", "LabSave"), P("4", "lbstats")];
  it("matches id, exact name, then a unique partial", () => {
    expect(resolveProject(ps, "3")).toEqual({ project: ps[2] });
    expect(resolveProject(ps, "LBOPS")).toEqual({ project: ps[0] });
    expect(resolveProject(ps, "paperclip")).toEqual({ project: ps[1] });
    expect(resolveProject(ps, "lb")).toMatchObject({ error: expect.stringContaining("several") });
    expect(resolveProject(ps, "zzz")).toMatchObject({ error: expect.stringContaining("No project") });
  });
});

describe("lbsv-agent mcp (stdio bridge)", () => {
  it("forwards tools and resources to the hub with the token", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { runBridge, mcpUrl } = await import("../../agent/src/mcpBridge.ts");
    expect(mcpUrl("https://lbsv.example/").href).toBe("https://lbsv.example/mcp");
    expect(mcpUrl("http://hub:11444/lbsv").href).toBe("http://hub:11444/lbsv/mcp");
    const r = await start();
    await project(r, "Bridge test");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const bridge = await runBridge({ hub: base(r), token: await token(r), version: "0", transport: a, log: () => {} });
    cleanups.push(() => bridge.close());
    const c = new Client({ name: "desktop", version: "0" });
    await c.connect(b);
    expect(c.getServerVersion()?.name).toBe("lbsv");
    expect(c.getInstructions()).toContain("LabSave");
    expect((await c.listTools()).tools.length).toBeGreaterThan(10);
    const res = await tool(c, "list_projects");
    expect(res.v.projects.map((p: { name: string }) => p.name)).toEqual(["Bridge test"]);
    expect(((await c.readResource({ uri: "lbsv://today" })).contents[0] as { text: string }).text).toContain("Bridge test");
    await expect(runBridge({ hub: base(r), token: "lbsvm_bad", version: "0", transport: InMemoryTransport.createLinkedPair()[0], log: () => {} })).rejects.toThrow();
  });
});
