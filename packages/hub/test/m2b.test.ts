/** M2b: URLs attached to ideas, attaching live tabs to ideas, sending tabs to another browser. */
import { afterEach, describe, expect, it } from "vitest";
import type { Idea, Project, State } from "../../shared/src/types.ts";
import { SimBrowser, call, cleanups, connect, live, project, start, tabsOf, waitFor } from "./sim.ts";

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const state = async (r: Awaited<ReturnType<typeof start>>) => (await call<State>(r, "GET", "/api/state")).body;

describe("idea links", () => {
  it("attach URLs to inbox and project ideas, dedupe, remove, cascade with the idea", async () => {
    const r = await start();
    const inbox = (await call<Idea>(r, "POST", "/api/ideas", { text: "Try zigbee2mqtt" })).body;
    expect(inbox.links).toEqual([]);
    const a = await call(r, "POST", `/api/ideas/${inbox.id}/links`, { links: [{ url: "https://z2m.io/", title: "Z2M" }, { url: "https://z2m.io/" }, { url: "https://wiki.io/z" }] });
    expect(a.body.added.map((l: { url: string }) => l.url)).toEqual(["https://z2m.io/", "https://wiki.io/z"]);
    let st = await state(r);
    expect(st.inbox[0]!.links!.map((l) => [l.url, l.title])).toEqual([["https://z2m.io/", "Z2M"], ["https://wiki.io/z", ""]]);

    const pid = await project(r, "Home automation");
    const pi = (await call<Idea>(r, "POST", "/api/ideas", { text: "Dashboards", projectId: pid, links: [{ url: "https://grafana.lan/d/1", title: "Grafana" }] })).body;
    expect(pi.links!.length).toBe(1);
    const p = (await call<Project>(r, "GET", `/api/projects/${pid}`)).body;
    expect(p.ideas[0]!.links![0]).toMatchObject({ url: "https://grafana.lan/d/1", title: "Grafana" });

    // FTS finds an idea by its attached link.
    const s = (await call(r, "GET", "/api/search?q=grafana")).body;
    expect(s.ideaLinks).toEqual([expect.objectContaining({ ideaId: pi.id, projectId: pid, url: "https://grafana.lan/d/1" })]);

    expect((await call(r, "DELETE", `/api/idea-links/${a.body.added[1].id}`)).status).toBe(204);
    expect((await call(r, "DELETE", `/api/idea-links/${a.body.added[1].id}`)).status).toBe(404);
    expect((await call(r, "POST", "/api/ideas/01J00000000000000000000000/links", { links: [{ url: "https://x/" }] })).status).toBe(404);
    // Moving the idea keeps its links; deleting it removes them.
    await call(r, "PATCH", `/api/ideas/${inbox.id}`, { projectId: pid });
    st = await state(r);
    expect(st.projects[0]!.ideas.find((i) => i.id === inbox.id)!.links!.length).toBe(1);
    await call(r, "DELETE", `/api/ideas/${inbox.id}`);
    expect(r.hub.repo.db.prepare("SELECT COUNT(*) n FROM idea_links WHERE idea_id = ?").get(inbox.id)).toEqual({ n: 0 });
  });

  it("survive undo-delete of a project and export → import", async () => {
    const r = await start();
    const pid = await project(r, "P");
    await call(r, "POST", "/api/ideas", { text: "with links", projectId: pid, links: [{ url: "https://a.io/", title: "A" }] });
    await call(r, "POST", "/api/ideas", { text: "inbox one", links: [{ url: "https://b.io/" }] });
    const snap = (await call<Project>(r, "GET", `/api/projects/${pid}`)).body;
    await call(r, "DELETE", `/api/projects/${pid}`);
    await call(r, "PUT", `/api/projects/${pid}`, snap);
    expect((await call<Project>(r, "GET", `/api/projects/${pid}`)).body.ideas[0]!.links).toEqual(snap.ideas[0]!.links);

    const exp = (await call(r, "GET", "/api/export")).body;
    const r2 = await start();
    await call(r2, "POST", "/api/import", { mode: "replace", data: exp });
    const st = await state(r2);
    expect(st.projects[0]!.ideas[0]!.links![0]).toMatchObject({ url: "https://a.io/", title: "A" });
    expect(st.inbox[0]!.links![0]!.url).toBe("https://b.io/");
    // Pre-M2b exports (ideas without links) still import.
    const old = { ...exp, inbox: exp.inbox.map((i: Idea) => ({ id: i.id, text: i.text, at: i.at })) };
    expect((await call(r2, "POST", "/api/import", { mode: "merge", data: old })).status).toBe(200);
  });
});

describe("attach live tabs to an idea", () => {
  it("to a new inbox idea, closing the tabs (links committed first); to an existing project idea, keeping them open", async () => {
    const r = await start();
    const b = new SimBrowser();
    b.add("https://docs.rs/tokio", "tokio docs");
    b.add("https://github.com/tokio-rs/tokio", "tokio repo");
    b.add("https://other.io/", "other");
    await connect(r, "laptop", "Work", b);
    const tabs = tabsOf(await waitFor(() => live(r), (s) => tabsOf(s).length === 3));
    const sel = tabs.filter((t) => t.url.includes("tokio")).map((t) => ({ id: t.id, url: t.url }));

    const res = await call(r, "POST", "/api/live/attach", { newIdea: { text: "Learn async Rust", projectId: null }, tabs: sel, close: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ideaText: "Learn async Rust", projectId: null, createdIdea: true });
    expect(res.body.added.map((l: { title: string; where: string }) => [l.title, l.where])).toEqual([["tokio docs", "Edge · Work on laptop"], ["tokio repo", "Edge · Work on laptop"]]);
    expect(res.body.closed).toHaveLength(2);
    expect(b.tabs.map((t) => t.url)).toEqual(["https://other.io/"]);
    const st = await state(r);
    expect(st.inbox[0]).toMatchObject({ id: res.body.ideaId, text: "Learn async Rust" });
    expect(st.inbox[0]!.links!).toHaveLength(2);

    const pid = await project(r, "P");
    const idea = (await call<Idea>(r, "POST", "/api/ideas", { text: "Compare", projectId: pid })).body;
    const other = tabsOf(await live(r))[0]!;
    const res2 = await call(r, "POST", "/api/live/attach", { ideaId: idea.id, tabs: [{ id: other.id, url: other.url }] });
    expect(res2.body).toMatchObject({ projectId: pid, createdIdea: false, closed: [] });
    expect(b.tabs).toHaveLength(1);
    expect((await call<Project>(r, "GET", `/api/projects/${pid}`)).body.ideas[0]!.links![0]!.url).toBe("https://other.io/");

    expect((await call(r, "POST", "/api/live/attach", { ideaId: idea.id, newIdea: { text: "x" }, tabs: [{ id: "a" }] })).status).toBe(400);
    expect((await call(r, "POST", "/api/live/attach", { ideaId: "01J00000000000000000000000", tabs: [{ id: "a", url: "https://a/" }] })).status).toBe(404);
  });
});

describe("send tabs to another browser", () => {
  it("opens in the target's focused window, then closes the originals; target offline closes nothing", async () => {
    const r = await start();
    const a = new SimBrowser(), b = new SimBrowser();
    a.add("https://read-later.io/1", "one");
    a.add("https://read-later.io/2", "two");
    b.windows = [{ id: "1" }, { id: "7", focused: true }];
    await connect(r, "laptop", "Work", a);
    await connect(r, "desktop", "Home", b);
    const st = await waitFor(() => live(r), (s) => tabsOf(s, "Work").length === 2 && s.devices.every((d) => d.browsers.every((x) => x.connected)));
    const target = st.devices.find((d) => d.name === "desktop")!.browsers[0]!.id;
    const sel = tabsOf(st, "Work").map((t) => ({ id: t.id, url: t.url }));

    const res = await call(r, "POST", "/api/live/send", { tabs: sel, toBrowserId: target });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, opened: 2 });
    expect(res.body.closed).toHaveLength(2);
    expect(a.tabs).toEqual([]);
    expect(b.tabs.map((t) => [t.url, t.windowId])).toEqual([["https://read-later.io/1", "7"], ["https://read-later.io/2", "7"]]);

    b.client.stop();
    await waitFor(() => live(r), (s) => !s.devices.find((d) => d.name === "desktop")!.browsers[0]!.connected);
    a.add("https://stay.io/");
    const st2 = await waitFor(() => live(r), (s) => tabsOf(s, "Work").length === 1);
    const res2 = await call(r, "POST", "/api/live/send", { tabs: tabsOf(st2, "Work").map((t) => ({ id: t.id, url: t.url })), toBrowserId: target });
    expect(res2.status).toBe(409);
    expect(a.tabs).toHaveLength(1);
  });
});
