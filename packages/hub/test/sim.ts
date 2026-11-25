/**
 * Shared harness for action tests: a listening hub + simulated browsers that run the real
 * CollectorClient and the extension's command runner (packages/ext/src/commands.ts).
 * Each test file must register: afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
 */
import { openDb, type DB } from "../src/db.ts";
import { buildApp, type Hub } from "../src/app.ts";
import { CollectorClient, enroll } from "../../shared/src/collectorClient.ts";
import type { LiveState, WireTab, WireWindow } from "../../shared/src/live.ts";
import { runCommand, type TabsApi } from "../../ext/src/commands.ts";
import { PASS, budget, login } from "./helpers.ts";

export const cleanups: (() => Promise<void> | void)[] = [];
export async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const until = Date.now() + budget(ms);
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface Running { hub: Hub; ws: string; cookie: string }
export async function start(extra: Partial<Parameters<typeof buildApp>[0]> = {}, db: DB = openDb(":memory:")): Promise<Running> {
  const hub = await buildApp({ db, adminPassphrase: PASS, ...extra });
  await hub.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (hub.app.server.address() as { port: number }).port;
  cleanups.push(() => hub.app.close());
  return { hub, ws: `ws://127.0.0.1:${port}/collect`, cookie: await login(hub.app) };
}
export const call = async <T = any>(r: Running, method: string, url: string, body?: object): Promise<{ status: number; body: T }> => {
  const res = await r.hub.app.inject({ method: method as "GET", url, payload: body, headers: { cookie: r.cookie } });
  return { status: res.statusCode, body: res.body ? res.json() : undefined as T };
};
export const live = async (r: Running) => (await call<LiveState>(r, "GET", "/api/live")).body;
export const tabsOf = (st: LiveState, profile?: string) => st.devices.flatMap((d) => d.browsers.filter((b) => !profile || b.profile === profile).flatMap((b) => b.windows.flatMap((w) => w.tabs)));

/** A simulated browser: state + the TabsApi the command runner drives + a collector reporting changes. */
export class SimBrowser {
  windows: WireWindow[] = [{ id: "1", focused: true }];
  tabs: WireTab[] = [];
  log: string[] = [];
  next = 100;
  client!: CollectorClient;
  add(url: string, title = url, windowId = "1"): WireTab {
    const t: WireTab = { id: String(this.next++), windowId, index: this.tabs.length, url, title };
    this.tabs.push(t);
    this.client?.upsertTab(t);
    return t;
  }
  navigate(id: string, url: string) { const t = this.tabs.find((x) => x.id === id)!; t.url = url; this.client.upsertTab(t); }
  api: TabsApi = {
    getTab: async (id) => { const t = this.tabs.find((x) => x.id === String(id)); return t ? { id, url: t.url, windowId: Number(t.windowId), incognito: false } : null; },
    removeTabs: async (ids) => {
      for (const id of ids) { this.tabs = this.tabs.filter((t) => t.id !== String(id)); this.client.removeTab(String(id)); }
      this.log.push(`closed ${ids.join(",")}`);
    },
    activateTab: async (id) => { this.log.push(`activate ${id}`); },
    focusWindow: async (id) => { this.log.push(`focus window ${id}`); },
    windowExists: async (id) => this.windows.some((w) => w.id === String(id)),
    createTab: async (url, w) => { this.add(url, url, String(w)); this.log.push(`open ${url}`); },
    createWindow: async (urls) => {
      const id = String(this.windows.length + 1);
      this.windows.push({ id }); this.client.upsertWindow({ id });
      for (const u of urls) this.add(u, u, id);
      this.log.push(`new window ${urls.length}`);
    },
  };
}

export async function connect(r: Running, deviceName: string, profile: string, b: SimBrowser, withCommands = true) {
  const { code } = (await call(r, "POST", "/api/devices", { name: deviceName })).body;
  const { token } = await enroll(r.ws, code, profile);
  b.client = new CollectorClient({
    url: r.ws, token, browser: { family: "edge", profile }, version: "test",
    snapshot: async () => ({ windows: structuredClone(b.windows), tabs: structuredClone(b.tabs) }),
    debounceMs: 20, backoff: { minMs: 30, maxMs: 200 },
    onCommand: withCommands ? (c) => runCommand(b.api, c) : undefined,
  });
  cleanups.push(() => b.client.stop());
  b.client.start();
}

export async function project(r: Running, name: string): Promise<string> {
  return (await call(r, "POST", "/api/projects", { name })).body.id;
}
