/**
 * Collector → hub sync protocol (SPEC §6.2), end to end over real sockets: the shared
 * CollectorClient (the same code the extension runs) against a listening hub.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openDb, type DB } from "../src/db.ts";
import { buildApp, type Hub } from "../src/app.ts";
import { CollectorClient, enroll, UNAUTHORIZED_RETRY_MS, type CollectorStatus } from "../../shared/src/collectorClient.ts";
import { CLOSE_BAD_MESSAGE, CLOSE_UNAUTHORIZED, type LiveState, type WireTab, type WireWindow } from "../../shared/src/live.ts";
import { PASS, budget, login } from "./helpers.ts";

interface Running { hub: Hub; port: number; base: string; ws: string; cookie: string }
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function start(db: DB, port = 0): Promise<Running> {
  const hub = await buildApp({ db, adminPassphrase: PASS });
  await hub.app.listen({ host: "127.0.0.1", port });
  const p = (hub.app.server.address() as { port: number }).port;
  const r = { hub, port: p, base: `http://127.0.0.1:${p}`, ws: `ws://127.0.0.1:${p}/collect`, cookie: await login(hub.app) };
  cleanups.push(() => hub.app.close());
  return r;
}

const api = async <T = unknown>(r: Running, method: string, url: string, body?: object): Promise<T> => {
  const res = await r.hub.app.inject({ method: method as "GET", url, payload: body, headers: { cookie: r.cookie } });
  return res.json() as T;
};
const liveState = (r: Running) => api<LiveState>(r, "GET", "/api/live");
const allTabs = async (r: Running) => (await liveState(r)).devices.flatMap((d) => d.browsers.flatMap((b) => b.windows.flatMap((w) => w.tabs)));

async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const until = Date.now() + budget(ms);
  let v: T;
  for (;;) {
    v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

async function pair(r: Running, name = "laptop") {
  const { code, device } = await api<{ code: string; device: { id: string } }>(r, "POST", "/api/devices", { name });
  const { token } = await enroll(r.ws, code, "test");
  return { token, deviceId: device.id };
}

/** A pretend browser: the source of truth the collector snapshots. */
class FakeBrowser {
  windows: WireWindow[] = [{ id: "1", focused: true }];
  tabs: WireTab[] = [];
  add(t: Partial<WireTab> & { url: string }): WireTab {
    const tab: WireTab = { id: String(this.tabs.length + 100), windowId: "1", index: this.tabs.length, title: t.url, ...t };
    this.tabs.push(tab);
    return tab;
  }
  snapshot = async () => ({ windows: structuredClone(this.windows), tabs: structuredClone(this.tabs) });
}

function client(r: Running, token: string, b: FakeBrowser, statuses: CollectorStatus[] = []) {
  const c = new CollectorClient({
    url: r.ws, token, browser: { family: "edge", profile: "Work" }, version: "test", snapshot: b.snapshot,
    debounceMs: 30, backoff: { minMs: 30, maxMs: 200 }, onStatus: (s) => statuses.push(s),
  });
  cleanups.push(() => c.stop());
  c.start();
  return c;
}

/** Raw socket for poking at the protocol directly. */
function raw(url: string) {
  const ws = new WebSocket(url);
  const inbox: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  let closed: { code: number } | null = null;
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  ws.on("close", (code) => { closed = { code }; });
  cleanups.push(() => ws.terminate());
  return {
    open: new Promise<void>((res) => ws.on("open", () => res())),
    send: (m: object) => ws.send(JSON.stringify(m)),
    next: (t: string) => waitFor(() => inbox.find((m) => m.t === t && !seen.has(m)), (m) => !!m)
      .then((m) => { seen.add(m!); return m as Record<string, unknown>; }),
    closed: () => waitFor(() => closed, (c) => !!c) as Promise<{ code: number }>,
  };
}

describe("collector sync protocol", () => {
  it("pairs with a code, then streams a snapshot; incognito never reaches the hub", async () => {
    const db = openDb(":memory:");
    const r = await start(db);
    const { token } = await pair(r);
    const b = new FakeBrowser();
    b.windows.push({ id: "2", incognito: true });
    b.add({ url: "https://docs.rs/tokio", title: "tokio" });
    b.add({ url: "https://secret-incognito.example/a", windowId: "2", title: "private window tab" });
    b.add({ url: "https://also-private.example/", incognito: true, title: "flagged incognito" });
    b.add({ url: "chrome://settings", title: "Settings" });
    b.add({ url: "https://grafana.lan/d/x?orgId=1&auth_token=abc", title: "Grafana" });
    client(r, token, b);

    const tabs = await waitFor(() => allTabs(r), (t) => t.length === 2);
    expect(tabs.map((t) => t.url).sort()).toEqual(["https://docs.rs/tokio", "https://grafana.lan/d/x?orgId=1"]);
    const st = await liveState(r);
    expect(st.devices[0]!.browsers[0]).toMatchObject({ family: "edge", profile: "Work", connected: true });
    expect(st.devices[0]!.browsers[0]!.windows.map((w) => w.id)).toEqual(["1"]);
    // Nothing private anywhere in the database, including FTS and first-seen tables.
    const dump = JSON.stringify(["live_tabs", "live_tabs_fts", "tab_first_seen", "live_windows"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    for (const s of ["secret-incognito", "also-private", "private window", "auth_token", "abc"]) expect(dump).not.toContain(s);
  });

  it("deltas: create, update, remove are visible within 2 s, coalesced", async () => {
    const r = await start(openDb(":memory:"));
    const { token } = await pair(r);
    const b = new FakeBrowser();
    b.add({ url: "https://a.com/" });
    const c = client(r, token, b);
    await waitFor(() => allTabs(r), (t) => t.length === 1);
    const seq0 = c.lastAck;

    const t0 = Date.now();
    const nt = b.add({ url: "https://b.com/", title: "B" });
    c.upsertTab(nt);
    for (let i = 0; i < 20; i++) c.upsertTab({ ...nt, title: `B (${i})` }); // title churn
    await waitFor(() => allTabs(r), (t) => t.some((x) => x.title === "B (19)"));
    expect(Date.now() - t0).toBeLessThan(budget(2000));
    expect(c.lastAck - seq0).toBe(1); // 21 changes → one delta

    c.removeTab("100");
    c.upsertWindow({ id: "1", focused: false });
    const after = await waitFor(() => allTabs(r), (t) => t.length === 1);
    expect(after[0]!.url).toBe("https://b.com/");
  });

  it("cable pull: changes made while the hub is down reconcile on reconnect", async () => {
    const db = openDb(":memory:");
    let r = await start(db);
    const { token } = await pair(r);
    const b = new FakeBrowser();
    b.add({ url: "https://kept.io/" });
    b.add({ url: "https://closed-while-offline.io/" });
    const statuses: CollectorStatus[] = [];
    const c = client(r, token, b, statuses);
    await waitFor(() => allTabs(r), (t) => t.length === 2);

    const port = r.port;
    await r.hub.app.close();
    await waitFor(() => c.status, (s) => s === "offline");

    // While offline: one tab closed, two opened, one retitled. The client queues (coalesces) these.
    b.tabs = b.tabs.filter((t) => t.url !== "https://closed-while-offline.io/");
    c.removeTab("101");
    c.upsertTab(b.add({ url: "https://opened-offline-1.io/" }));
    c.upsertTab(b.add({ url: "https://opened-offline-2.io/" }));
    b.tabs[0]!.title = "Kept (renamed offline)";
    c.upsertTab(b.tabs[0]!);
    expect(c.pending).toBeGreaterThan(0);

    r = await start(db, port);
    const tabs = await waitFor(() => allTabs(r), (t) => t.length === 3 && t.some((x) => x.title === "Kept (renamed offline)"), 5000);
    expect(tabs.map((t) => t.url).sort()).toEqual(["https://kept.io/", "https://opened-offline-1.io/", "https://opened-offline-2.io/"]);
    expect(c.status).toBe("online");
    expect(c.pending).toBe(0);
    expect(statuses).toContain("offline");
    expect((await liveState(r)).devices[0]!.browsers[0]!.connected).toBe(true);
  });

  it("marks the browser disconnected (not deleted) when the collector goes away", async () => {
    const r = await start(openDb(":memory:"));
    const { token } = await pair(r);
    const b = new FakeBrowser();
    b.add({ url: "https://still-here.io/" });
    const c = client(r, token, b);
    await waitFor(() => allTabs(r), (t) => t.length === 1);
    c.stop();
    const st = await waitFor(() => liveState(r), (s) => !s.devices[0]!.browsers[0]!.connected);
    expect(st.devices[0]!.browsers[0]!.windows[0]!.tabs[0]!.url).toBe("https://still-here.io/");
  });

  it("ignores replayed deltas, asks for a resync on a gap, re-filters on the hub", async () => {
    const r = await start(openDb(":memory:"));
    const { token } = await pair(r);
    const s = raw(r.ws);
    await s.open;
    s.send({ t: "hello", token, browser: { family: "chrome", profile: "" }, ext: "raw" });
    await s.next("welcome");
    s.send({ t: "snapshot", seq: 1, windows: [{ id: 1 }], tabs: [
      { id: 1, windowId: 1, index: 0, url: "https://one.io/", title: "one" },
      { id: 2, windowId: 1, index: 1, url: "https://leak.io/", title: "leak", incognito: true }, // buggy collector
      { id: 3, windowId: 1, index: 2, url: "https://x.io/?session=s3cr3t", title: "x" },
    ] });
    expect(await s.next("ack")).toEqual({ t: "ack", seq: 1 });
    s.send({ t: "delta", seq: 2, upserts: { tabs: [{ id: 1, windowId: 1, index: 0, url: "https://one.io/", title: "first" }] } });
    await s.next("ack");
    s.send({ t: "delta", seq: 2, upserts: { tabs: [{ id: 1, windowId: 1, index: 0, url: "https://one.io/", title: "REPLAYED" }] } });
    expect(await s.next("ack")).toEqual({ t: "ack", seq: 2 });
    s.send({ t: "delta", seq: 9, removes: { tabs: ["1"] } });
    await s.next("resync");
    const tabs = await allTabs(r);
    expect(tabs.map((t) => [t.url, t.title])).toEqual([["https://one.io/", "first"], ["https://x.io/", "x"]]);
  });

  it("rejects unknown tokens and malformed messages", async () => {
    const r = await start(openDb(":memory:"));
    const a = raw(r.ws);
    await a.open;
    a.send({ t: "hello", token: "lbsv_nope", browser: { family: "edge", profile: "" }, ext: "" });
    expect((await a.closed()).code).toBe(CLOSE_UNAUTHORIZED);
    const b = raw(r.ws);
    await b.open;
    b.send({ t: "snapshot", seq: 1, windows: "lots", tabs: [] });
    expect((await b.closed()).code).toBe(CLOSE_BAD_MESSAGE);
    const c = raw(r.ws);
    await c.open;
    c.send({ t: "enroll", code: "AAAA-AAAA", kind: "ext" });
    expect(await c.next("error")).toEqual({ t: "error", error: "bad_code" });
    await expect(enroll(r.ws, "BBBB-BBBB", "x")).rejects.toThrow(/pairing code/);
  });

  it("revoking a device disconnects it and the client stops retrying", async () => {
    const r = await start(openDb(":memory:"));
    const { token, deviceId } = await pair(r);
    const b = new FakeBrowser();
    b.add({ url: "https://a.io/" });
    const c = client(r, token, b);
    await waitFor(() => allTabs(r), (t) => t.length === 1);
    await api(r, "POST", `/api/devices/${deviceId}/revoke`);
    await waitFor(() => c.status, (s) => s === "unauthorized");
    expect(await allTabs(r)).toEqual([]);
  });

  it("a rejected token is retried on a later poke (e.g. hub briefly ran on the wrong database)", async () => {
    const real = openDb(":memory:");
    let r = await start(real);
    const { token } = await pair(r);
    const port = r.port;
    await r.hub.app.close();
    r = await start(openDb(":memory:"), port); // wrong/empty database: token unknown
    const b = new FakeBrowser();
    b.add({ url: "https://back.io/" });
    const c = client(r, token, b);
    await waitFor(() => c.status, (s) => s === "unauthorized");
    c.poke(); // too soon: stays put
    expect(c.status).toBe("unauthorized");
    await r.hub.app.close();
    r = await start(real, port); // the right database is back
    (c as unknown as { unauthorizedAt: number }).unauthorizedAt -= UNAUTHORIZED_RETRY_MS + 1;
    c.poke();
    await waitFor(() => allTabs(r), (t) => t.length === 1);
    expect(c.status).toBe("online");
  });

  it("deny-list changes reach the collector, purge stored tabs and are counted", async () => {
    const r = await start(openDb(":memory:"));
    const { token, deviceId } = await pair(r);
    const b = new FakeBrowser();
    b.add({ url: "https://online.bank.com/acct", title: "My account" });
    b.add({ url: "https://news.io/" });
    const c = client(r, token, b);
    await waitFor(() => allTabs(r), (t) => t.length === 2);
    await api(r, "PATCH", `/api/devices/${deviceId}`, { deny: ["bank.com"] });
    const tabs = await waitFor(() => allTabs(r), (t) => t.length === 1);
    expect(tabs[0]!.url).toBe("https://news.io/");
    await waitFor(() => c.lastSnapshot.denied, (n) => n === 1);
    const st = await liveState(r);
    expect(st.devices[0]!.browsers[0]!.denied).toBe(1);
    // A later navigation to a denied site is not stored either.
    c.upsertTab({ ...b.tabs[1]!, url: "https://www.bank.com/" });
    await waitFor(() => allTabs(r), (t) => t.length === 0);
  });

  it("keeps first-seen age across browser restarts (new native ids, same URL)", async () => {
    let t = 1_000_000_000_000;
    const db = openDb(":memory:");
    const hub = await buildApp({ db, adminPassphrase: PASS, now: () => t });
    const { code, device } = hub.devices.create("x");
    const { credentialId } = hub.devices.enroll(code, "ext")!;
    const { id } = hub.live.attach(credentialId, device.id, { family: "firefox", profile: "", ext: "" });
    hub.live.applySnapshot(id, 1, [{ id: "1" }], [{ id: "5", windowId: "1", index: 0, url: "https://old.io/", title: "" }]);
    t += 9 * 86400_000;
    hub.live.applySnapshot(id, 1, [{ id: "1" }], [{ id: "77", windowId: "1", index: 0, url: "https://old.io/", title: "" }]);
    const tab = hub.live.state().devices[0]!.browsers[0]!.windows[0]!.tabs[0]!;
    expect(tab.nativeId).toBe("77");
    expect(tab.firstSeenAt).toBe(1_000_000_000_000);
    expect(hub.live.search("old")).toHaveLength(1);
    await hub.app.close();
  });
});
