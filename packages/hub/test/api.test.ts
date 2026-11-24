import { describe, expect, it, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { ulid } from "../../shared/src/ulid.ts";
import { login, makeHub } from "./helpers.ts";
import type { Project, State } from "../../shared/src/types.ts";

type H = Awaited<ReturnType<typeof makeHub>>;
let h: H;
let cookie: string;
const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  h.app.inject({ method, url, payload: payload as object, headers: { cookie } });
const state = async () => (await req("GET", "/api/state")).json() as State;
const project = async (id: string) => (await req("GET", `/api/projects/${id}`)).json() as Project;

beforeEach(async () => { h = await makeHub(); cookie = await login(h.app); });
afterEach(async () => { await h.app.close(); });

describe("projects", () => {
  it("create with client id, patch fields, delete", async () => {
    const id = ulid();
    const c = await req("POST", "/api/projects", { id, name: "Homelab" });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ id, name: "Homelab", status: "active", leftOff: "", links: [], sessions: [], ideas: [] });
    const p = await req("PATCH", `/api/projects/${id}`, { leftOff: "rebooting pve", status: "parked", tags: "infra" });
    expect(p.json()).toMatchObject({ leftOff: "rebooting pve", status: "parked", tags: "infra" });
    expect((await req("DELETE", `/api/projects/${id}`)).statusCode).toBe(204);
    expect((await req("GET", `/api/projects/${id}`)).statusCode).toBe(404);
  });

  it("rejects bad input", async () => {
    expect((await req("POST", "/api/projects", { name: "" })).statusCode).toBe(400);
    expect((await req("POST", "/api/projects", { id: "not-a-ulid", name: "x" })).statusCode).toBe(400);
    const id = (await req("POST", "/api/projects", { name: "x" })).json().id;
    expect((await req("PATCH", `/api/projects/${id}`, { status: "weird" })).statusCode).toBe(400);
    expect((await req("PATCH", `/api/projects/${id}`, { bogus: 1 })).statusCode).toBe(400);
    expect((await req("PATCH", `/api/projects/${ulid()}`, { name: "y" })).statusCode).toBe(404);
  });

  it("duplicate id is a conflict", async () => {
    const id = ulid();
    await req("POST", "/api/projects", { id, name: "a" });
    expect((await req("POST", "/api/projects", { id, name: "b" })).statusCode).toBe(409);
  });

  it("PUT restores a deleted project with children (undo delete)", async () => {
    const id = (await req("POST", "/api/projects", { name: "Restore me" })).json().id;
    await req("POST", `/api/projects/${id}/links`, { links: [{ url: "https://a.io", label: "A" }] });
    await req("POST", `/api/projects/${id}/sessions`, { host: "devbox", cmd: "ssh devbox" });
    await req("POST", "/api/ideas", { text: "idea", projectId: id });
    const snap = await project(id);
    await req("DELETE", `/api/projects/${id}`);
    expect((await req("PUT", `/api/projects/${id}`, snap)).statusCode).toBe(200);
    const back = await project(id);
    expect(back.links).toEqual(snap.links);
    expect(back.sessions).toEqual(snap.sessions);
    expect(back.ideas).toEqual(snap.ideas);
  });
});

describe("links", () => {
  it("bulk add puts new links first, keeps paste order, dedupes within project", async () => {
    const id = (await req("POST", "/api/projects", { name: "P" })).json().id;
    await req("POST", `/api/projects/${id}/links`, { links: [{ url: "https://old.io" }] });
    const r = await req("POST", `/api/projects/${id}/links`, {
      links: [{ url: "https://a.io" }, { url: "https://b.io" }, { url: "https://old.io" }, { url: "https://a.io" }],
    });
    expect(r.json().added.map((l: { url: string }) => l.url)).toEqual(["https://a.io", "https://b.io"]);
    expect((await project(id)).links.map((l) => l.url)).toEqual(["https://a.io", "https://b.io", "https://old.io"]);
  });

  it("delete then re-add with same id/position restores the original order (undo)", async () => {
    const id = (await req("POST", "/api/projects", { name: "P" })).json().id;
    await req("POST", `/api/projects/${id}/links`, { links: [{ url: "https://1" }, { url: "https://2" }, { url: "https://3" }] });
    const before = (await project(id)).links;
    const mid = before[1]!;
    expect((await req("DELETE", `/api/links/${mid.id}`)).statusCode).toBe(204);
    expect((await project(id)).links).toHaveLength(2);
    await req("POST", `/api/projects/${id}/links`, { links: [mid] });
    expect((await project(id)).links).toEqual(before);
  });

  it("adding a link bumps the project's updatedAt", async () => {
    let t = 1000;
    await h.app.close();
    h = await makeHub({ now: () => t });
    cookie = await login(h.app);
    const id = (await req("POST", "/api/projects", { name: "P" })).json().id;
    t = 5000;
    await req("POST", `/api/projects/${id}/links`, { links: [{ url: "https://x" }] });
    expect((await project(id)).updatedAt).toBe(5000);
  });
});

describe("sessions", () => {
  it("appends in order and removes", async () => {
    const id = (await req("POST", "/api/projects", { name: "P" })).json().id;
    await req("POST", `/api/projects/${id}/sessions`, { kind: "tmux", label: "api", host: "devbox-02", network: "lab VPN", cmd: "ssh devbox-02 -t tmux new -A -s api" });
    const s2 = (await req("POST", `/api/projects/${id}/sessions`, { kind: "RDP", host: "win-vm" })).json();
    const p = await project(id);
    expect(p.sessions.map((s) => s.host)).toEqual(["devbox-02", "win-vm"]);
    expect(p.sessions[0]).toMatchObject({ kind: "tmux", label: "api", network: "lab VPN" });
    await req("DELETE", `/api/sessions/${s2.id}`);
    expect((await project(id)).sessions).toHaveLength(1);
  });
});

describe("ideas and inbox", () => {
  it("captures to inbox, files into a project, deletes", async () => {
    const pid = (await req("POST", "/api/projects", { name: "P" })).json().id;
    const i = (await req("POST", "/api/ideas", { text: "try zellij" })).json();
    expect((await state()).inbox.map((x) => x.text)).toEqual(["try zellij"]);
    await req("PATCH", `/api/ideas/${i.id}`, { projectId: pid });
    const s = await state();
    expect(s.inbox).toEqual([]);
    expect(s.projects[0]!.ideas.map((x) => x.text)).toEqual(["try zellij"]);
    expect((await req("DELETE", `/api/ideas/${i.id}`)).statusCode).toBe(204);
    expect((await project(pid)).ideas).toEqual([]);
  });

  it("ideas are newest first", async () => {
    const pid = (await req("POST", "/api/projects", { name: "P" })).json().id;
    await req("POST", "/api/ideas", { text: "old", projectId: pid, at: 1 });
    await req("POST", "/api/ideas", { text: "new", projectId: pid, at: 2 });
    expect((await project(pid)).ideas.map((x) => x.text)).toEqual(["new", "old"]);
  });

  it("deleting a project deletes its ideas", async () => {
    const pid = (await req("POST", "/api/projects", { name: "P" })).json().id;
    await req("POST", "/api/ideas", { text: "x", projectId: pid });
    await req("DELETE", `/api/projects/${pid}`);
    expect(h.db.prepare("SELECT COUNT(*) c FROM ideas").get()).toEqual({ c: 0 });
  });
});

describe("search (FTS5)", () => {
  it("multi-term AND prefix match across entities; ignores FTS syntax in input", async () => {
    const pid = (await req("POST", "/api/projects", { name: "Grafana rollout" })).json().id;
    await req("POST", `/api/projects/${pid}/links`, { links: [{ url: "https://grafana.lan/d/node", label: "Node dashboard" }] });
    await req("POST", `/api/projects/${pid}/sessions`, { host: "monitor-01", cmd: "ssh monitor-01" });
    await req("POST", "/api/ideas", { text: "alert on grafana disk usage" });
    const r = (await req("GET", "/api/search?q=graf")).json();
    expect(r.projects).toHaveLength(1);
    expect(r.links).toHaveLength(1);
    expect(r.ideas).toHaveLength(1);
    expect((await req("GET", "/api/search?q=graf%20disk")).json().ideas).toHaveLength(1);
    expect((await req("GET", "/api/search?q=graf%20disk")).json().links).toHaveLength(0);
    expect((await req("GET", "/api/search?q=monitor")).json().sessions).toHaveLength(1);
    expect((await req("GET", '/api/search?q=%22)%20OR%20*')).statusCode).toBe(200);
  });

  it("stays in sync after updates and deletes", async () => {
    const pid = (await req("POST", "/api/projects", { name: "alpha" })).json().id;
    await req("PATCH", `/api/projects/${pid}`, { name: "bravo" });
    expect((await req("GET", "/api/search?q=alpha")).json().projects).toHaveLength(0);
    expect((await req("GET", "/api/search?q=bravo")).json().projects).toHaveLength(1);
    await req("DELETE", `/api/projects/${pid}`);
    expect((await req("GET", "/api/search?q=bravo")).json().projects).toHaveLength(0);
  });
});

describe("export / import", () => {
  it("round-trips the whole database", async () => {
    const pid = (await req("POST", "/api/projects", { name: "P", status: "parked" })).json().id;
    await req("PATCH", `/api/projects/${pid}`, { leftOff: "note", tags: "a, b" });
    await req("POST", `/api/projects/${pid}/links`, { links: [{ url: "https://a.io", label: "A", where: "Edge · work" }] });
    await req("POST", `/api/projects/${pid}/sessions`, { host: "h", cmd: "ssh h" });
    await req("POST", "/api/ideas", { text: "inbox idea" });
    const ex = await req("GET", "/api/export");
    expect(ex.headers["content-disposition"]).toMatch(/attachment; filename="lbsv-.*\.json"/);
    const data = ex.json();
    expect(data).toMatchObject({ format: "lbsv", version: 1 });

    await h.app.close();
    h = await makeHub();
    cookie = await login(h.app);
    const im = await req("POST", "/api/import", { mode: "replace", data });
    expect(im.json()).toMatchObject({ ok: true, projects: 1, inbox: 1 });
    const s = await state();
    expect(s.projects).toEqual(data.projects);
    expect(s.inbox).toEqual(data.inbox);
  });

  it("merge keeps existing items; replace removes them", async () => {
    await req("POST", "/api/projects", { name: "existing" });
    const data = { format: "lbsv", version: 1, exportedAt: 0, projects: [], inbox: [{ id: ulid(), text: "imported", at: 1 }] };
    await req("POST", "/api/import", { mode: "merge", data });
    let s = await state();
    expect(s.projects).toHaveLength(1);
    expect(s.inbox).toHaveLength(1);
    await req("POST", "/api/import", { mode: "replace", data });
    s = await state();
    expect(s.projects).toHaveLength(0);
    expect(s.inbox).toHaveLength(1);
  });

  it("rejects files that are not LabSave exports", async () => {
    expect((await req("POST", "/api/import", { data: { hello: 1 } })).statusCode).toBe(400);
  });
});

describe("realtime fan-out", () => {
  it("a second client sees a change event within 1 s of a write", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    const msgs: { t: string; entity?: string; ids?: string[] }[] = [];
    await new Promise<void>((res, rej) => { ws.on("message", (d) => { msgs.push(JSON.parse(String(d))); if (msgs.length === 1) res(); }); ws.on("error", rej); });
    expect(msgs[0]!.t).toBe("hello");
    const t0 = Date.now();
    const id = (await req("POST", "/api/projects", { name: "live" })).json().id;
    await new Promise<void>((res) => { const i = setInterval(() => { if (msgs.length > 1) { clearInterval(i); res(); } }, 5); });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(msgs[1]).toEqual({ t: "changed", entity: "project", ids: [id] });
    ws.close();
  });

  it("refuses websocket upgrade without a session", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((res) => ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0)));
    expect(code).toBe(401);
  });
});
