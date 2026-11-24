/**
 * Tab actions (SPEC §6.3) end to end: hub REST → collector socket → the extension's command runner
 * (packages/ext/src/commands.ts) on a simulated browser → results back to the caller.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../../shared/src/types.ts";
import { SimBrowser, call, cleanups, connect, live, project, start, tabsOf, waitFor } from "./sim.ts";

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
describe("park & close (SPEC §11 M2 acceptance)", () => {
  it("parks 20 tabs across two browsers: 20 links saved, exactly those 20 closed; a tab whose URL changed is not closed and is reported", async () => {
    const r = await start();
    const work = new SimBrowser(), home = new SimBrowser();
    for (let i = 0; i < 12; i++) work.add(`https://docs.example/work/${i}`, `Work doc ${i}`);
    for (let i = 0; i < 10; i++) home.add(`https://wiki.example/home/${i}`, `Home page ${i}`);
    work.add("https://keep.example/not-selected", "Not selected");
    await connect(r, "laptop", "Work", work);
    await connect(r, "desktop", "Personal", home);
    let st = await waitFor(() => live(r), (s) => tabsOf(s).length === 23);

    // Select 10 from each browser (20), as the UI would: id + the URL it showed.
    const sel = [
      ...tabsOf(st, "Work").filter((t) => t.url.includes("/work/")).slice(0, 10),
      ...tabsOf(st, "Personal").slice(0, 10),
    ].map((t) => ({ id: t.id, url: t.url }));
    expect(sel).toHaveLength(20);
    // After selection, one selected tab navigates away.
    const moved = work.tabs.find((t) => t.url.endsWith("/work/3"))!;
    work.navigate(moved.id, "https://elsewhere.example/");

    const pid = await project(r, "Reading pile");
    const res = await call(r, "POST", "/api/live/park", { projectId: pid, tabs: sel, close: true });
    expect(res.status).toBe(200);
    expect(res.body.added).toHaveLength(20);
    expect(res.body.closed).toHaveLength(19);
    expect(res.body.notClosed).toEqual([{ id: sel.find((s) => s.url.endsWith("/work/3"))!.id, reason: "url_changed" }]);

    // Links: 20, with titles and "where" naming browser profile + device, saved with the URL the user saw.
    const p = (await call<Project>(r, "GET", `/api/projects/${pid}`)).body;
    expect(p.links).toHaveLength(20);
    expect(p.links.map((l) => l.url).sort()).toEqual(sel.map((s) => s.url).sort());
    expect(p.links.find((l) => l.url.endsWith("/work/0"))).toMatchObject({ label: "Work doc 0", where: "Edge · Work on laptop" });

    // Browsers: exactly the 19 matching tabs are gone; the moved tab and the unselected tabs remain.
    expect(work.tabs.map((t) => t.url).sort()).toEqual(["https://docs.example/work/10", "https://docs.example/work/11", "https://elsewhere.example/", "https://keep.example/not-selected"]);
    expect(home.tabs).toEqual([]);
    st = await waitFor(() => live(r), (s) => tabsOf(s).length === 4);

    // Undo = reopen what was closed, into the original windows.
    for (const g of res.body.reopen) expect((await call(r, "POST", "/api/live/open", g)).status).toBe(200);
    expect(home.tabs).toHaveLength(10);
    expect(work.tabs).toHaveLength(4 + 9);
  });

  it("park into a new project, keep tabs open", async () => {
    const r = await start();
    const b = new SimBrowser();
    b.add("https://a.example/", "A");
    await connect(r, "laptop", "", b);
    const st = await waitFor(() => live(r), (s) => tabsOf(s).length === 1);
    const res = await call(r, "POST", "/api/live/park", { newProject: "From tabs", tabs: [{ id: tabsOf(st)[0]!.id }], close: false });
    expect(res.body).toMatchObject({ projectName: "From tabs", closed: [], notClosed: [] });
    expect(b.tabs).toHaveLength(1);
    expect((await call<Project>(r, "GET", `/api/projects/${res.body.projectId}`)).body.links[0]).toMatchObject({ url: "https://a.example/", label: "A" });
  });

  it("if the browser is offline the links are still saved and the close is reported", async () => {
    const r = await start();
    const b = new SimBrowser();
    b.add("https://a.example/", "A");
    await connect(r, "laptop", "", b);
    const st = await waitFor(() => live(r), (s) => tabsOf(s).length === 1);
    b.client.stop();
    await waitFor(() => live(r), (s) => !s.devices[0]!.browsers[0]!.connected);
    const pid = await project(r, "P");
    const t = tabsOf(st)[0]!;
    const res = await call(r, "POST", "/api/live/park", { projectId: pid, tabs: [{ id: t.id, url: t.url }], close: true });
    expect(res.body.added).toHaveLength(1);
    expect(res.body.notClosed).toEqual([{ id: t.id, reason: "offline" }]);
    expect(b.tabs).toHaveLength(1);
  });

  it("validates input", async () => {
    const r = await start();
    expect((await call(r, "POST", "/api/live/park", { tabs: [{ id: "x" }] })).status).toBe(400);
    expect((await call(r, "POST", "/api/live/park", { projectId: "01J00000000000000000000000", tabs: [{ id: "x", url: "https://a/" }] })).status).toBe(404);
    expect((await call(r, "POST", "/api/live/close", { tabs: [] })).status).toBe(400);
    expect((await call(r, "POST", "/api/live/close", { tabs: [{ id: "nope" }] })).body).toEqual({ closed: [], notClosed: [{ id: "nope", reason: "gone" }], reopen: [] });
  });
});

describe("focus / close / open", () => {
  it("focus reaches the right browser; offline and unknown tabs are reported", async () => {
    const r = await start();
    const b = new SimBrowser();
    b.add("https://a.example/");
    await connect(r, "laptop", "", b);
    const t = tabsOf(await waitFor(() => live(r), (s) => tabsOf(s).length === 1))[0]!;
    expect((await call(r, "POST", "/api/live/focus", { tabId: t.id })).status).toBe(200);
    expect(b.log).toEqual([`activate ${t.nativeId}`, "focus window 1"]);
    expect((await call(r, "POST", "/api/live/focus", { tabId: "missing" })).status).toBe(404);
    b.client.stop();
    await waitFor(() => live(r), (s) => !s.devices[0]!.browsers[0]!.connected);
    expect((await call(r, "POST", "/api/live/focus", { tabId: t.id })).status).toBe(409);
  });

  it("close removes the tab from the live view immediately; a collector without command support reports failure", async () => {
    const r = await start();
    const b = new SimBrowser(), old = new SimBrowser();
    b.add("https://a.example/");
    old.add("https://legacy.example/");
    await connect(r, "laptop", "new", b);
    await connect(r, "desktop", "old", old, false);
    const st = await waitFor(() => live(r), (s) => tabsOf(s).length === 2);
    const res = await call(r, "POST", "/api/live/close", { tabs: tabsOf(st).map((t) => ({ id: t.id, url: t.url })) });
    expect(res.body.closed).toEqual([tabsOf(st, "new")[0]!.id]);
    expect(res.body.notClosed).toEqual([{ id: tabsOf(st, "old")[0]!.id, reason: "failed" }]);
    expect(tabsOf(await live(r)).map((t) => t.url)).toEqual(["https://legacy.example/"]);
  });

  it("open refuses non-web URLs on the device side and opens the rest", async () => {
    const r = await start();
    const b = new SimBrowser();
    await connect(r, "laptop", "", b);
    const st = await waitFor(() => live(r), (s) => s.devices[0]?.browsers[0]?.connected === true);
    const res = await call(r, "POST", "/api/live/open", { browserId: st.devices[0]!.browsers[0]!.id, urls: ["https://x.example/", "javascript:alert(1)"], windowId: "1" });
    expect(res.body).toEqual({ ok: true, opened: 1 });
    expect(b.tabs.map((t) => t.url)).toEqual(["https://x.example/"]);
  });
});

describe("favicons", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const fakeFetch = (routes: Record<string, { type: string; body: Buffer; status?: number }>, calls: string[]) =>
    (async (url: string | URL) => {
      calls.push(String(url));
      const r = routes[String(url)];
      if (!r) return new Response("nope", { status: 404 });
      return new Response(new Uint8Array(r.body), { status: r.status ?? 200, headers: { "content-type": r.type } });
    }) as typeof fetch;

  it("fetches once for an origin seen in a tab, caches, and serves with a sandboxing CSP", async () => {
    const calls: string[] = [];
    const r = await start({ fetch: fakeFetch({
      "https://a.example/icon.png": { type: "image/png", body: png },
      "https://svg.example/favicon.ico": { type: "image/svg+xml", body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") },
      "https://big.example/favicon.ico": { type: "image/x-icon", body: Buffer.alloc(200 * 1024) },
      "https://html.example/favicon.ico": { type: "text/html", body: Buffer.from("<b>hi</b>") },
    }, calls) });
    const b = new SimBrowser();
    b.add("https://a.example/page"); b.tabs[0]!.favIconUrl = "https://a.example/icon.png";
    b.add("https://svg.example/"); b.add("https://big.example/"); b.add("https://html.example/");
    await connect(r, "laptop", "", b);
    await waitFor(() => live(r), (s) => tabsOf(s).length === 4);

    const get = (o: string) => r.hub.app.inject({ method: "GET", url: `/api/favicon?origin=${encodeURIComponent(o)}`, headers: { cookie: r.cookie } });
    const a1 = await get("https://a.example");
    expect(a1.statusCode).toBe(200);
    expect(a1.headers["content-type"]).toBe("image/png");
    expect(a1.rawPayload.equals(png)).toBe(true);
    await get("https://a.example");
    expect(calls.filter((c) => c.includes("a.example"))).toEqual(["https://a.example/icon.png"]); // cached

    const svg = await get("https://svg.example");
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    expect((await get("https://big.example")).statusCode).toBe(404);   // over the size cap
    expect((await get("https://html.example")).statusCode).toBe(404);  // not an image
    expect((await get("https://never-seen.example")).statusCode).toBe(404);
    expect(calls.some((c) => c.includes("never-seen"))).toBe(false);   // not a general fetcher
    expect((await get("javascript:alert(1)")).statusCode).toBe(404);
    const unauth = await r.hub.app.inject({ method: "GET", url: "/api/favicon?origin=https%3A%2F%2Fa.example" });
    expect(unauth.statusCode).toBe(401);
  });

  it("LBSV_FAVICONS=0: the hub never contacts tab hosts", async () => {
    const calls: string[] = [];
    const r = await start({ favicons: false, fetch: fakeFetch({}, calls) });
    const b = new SimBrowser();
    b.add("https://a.example/");
    await connect(r, "laptop", "", b);
    await waitFor(() => live(r), (s) => tabsOf(s).length === 1);
    const res = await r.hub.app.inject({ method: "GET", url: "/api/favicon?origin=https%3A%2F%2Fa.example", headers: { cookie: r.cookie } });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
