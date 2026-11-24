/// <reference types="chrome" />
/**
 * lbsv-ext background (Chromium MV3 service worker / Firefox MV3 event page).
 *
 * MV3 backgrounds are killed when idle, so nothing here assumes a persistent socket:
 *  - every listener is registered synchronously at top level, so events wake us up;
 *  - a 30 s alarm wakes us if we were unloaded, and the client reconnects and sends a snapshot;
 *  - while connected, the client's 20 s ping keeps a Chromium worker alive (Chrome ≥116 extends
 *    the worker's lifetime on WebSocket activity).
 * Events that arrive before the client is ready are not lost: every connect starts with a snapshot.
 */
import { ext, detectFamily, readAll, wireTab, wireWindow } from "./browserApi.ts";
import { CollectorClient, collectorUrl, enroll, type CollectorStatus } from "../../shared/src/collectorClient.ts";
import type { BgRequest, BgStatus } from "./messages.ts";
import { runCommand, type TabsApi } from "./commands.ts";

/** Real browser APIs behind the tested command runner (focus / close / open). */
const tabsApi: TabsApi = {
  getTab: (id) => ext.tabs.get(id).then((t) => t as never, () => null),
  removeTabs: (ids) => ext.tabs.remove(ids),
  activateTab: async (id) => { await ext.tabs.update(id, { active: true }); },
  focusWindow: async (id) => { await ext.windows.update(id, { focused: true }); },
  windowExists: (id) => ext.windows.get(id).then(() => true, () => false),
  createTab: async (url, windowId) => { await ext.tabs.create({ url, windowId, active: false }); },
  createWindow: async (urls) => { await ext.windows.create({ url: urls, focused: false }); },
};

interface Config { hubUrl: string; token: string; deviceName: string; profile: string; includeInternal: boolean }
const KEYS = ["hubUrl", "token", "deviceName", "profile", "includeInternal"] as const;
const ALARM = "lbsv-keepalive";
const VERSION = ext.runtime.getManifest().version;
const FAMILY = detectFamily();

let client: CollectorClient | null = null;
let lastError = "";

async function loadCfg(): Promise<Config> {
  const v = await ext.storage.local.get([...KEYS]) as Partial<Config>;
  return { hubUrl: v.hubUrl ?? "", token: v.token ?? "", deviceName: v.deviceName ?? "", profile: v.profile ?? "", includeInternal: !!v.includeInternal };
}

function badge(s: CollectorStatus | "unpaired") {
  const [text, color] = s === "online" ? ["", "#2e7d32"] : s === "unpaired" ? ["off", "#666"] : s === "unauthorized" ? ["!", "#c62828"] : ["…", "#f9a825"];
  void ext.action.setBadgeText({ text }).catch(() => {});
  void ext.action.setBadgeBackgroundColor({ color }).catch(() => {});
  void ext.action.setTitle({ title: `LabSave: ${s}` }).catch(() => {});
}

let starting: Promise<void> = Promise.resolve();
function restart(): Promise<void> {
  starting = starting.then(async () => {
    client?.stop();
    client = null;
    const cfg = await loadCfg();
    if (!cfg.token || !cfg.hubUrl) { badge("unpaired"); return; }
    client = new CollectorClient({
      url: collectorUrl(cfg.hubUrl), token: cfg.token, version: VERSION,
      browser: { family: FAMILY, profile: cfg.profile },
      includeInternal: cfg.includeInternal,
      snapshot: readAll,
      onStatus: (s, detail) => { badge(s); if (detail) lastError = detail; if (s === "online") lastError = ""; },
      onCommand: (c) => runCommand(tabsApi, c),
    });
    client.start();
  }).catch((e) => { lastError = String((e as Error)?.message ?? e); });
  return starting;
}

/* ---------- browser events → deltas ---------- */
const up = (t: chrome.tabs.Tab) => { const w = wireTab(t); if (w) client?.upsertTab(w); };
/** Index/active changes ripple through a whole window; re-read it (cheap, and coalesced by the debounce). */
const refreshWindow = (windowId: number) => {
  if (!client || windowId < 0) return;
  ext.tabs.query({ windowId }).then((ts) => ts.forEach(up), () => {});
};
const refreshWindows = () => {
  if (!client) return;
  ext.windows.getAll({}).then((ws) => ws.forEach((w) => { const ww = wireWindow(w); if (ww) client?.upsertWindow(ww); }), () => {});
};

ext.tabs.onCreated.addListener(up);
ext.tabs.onUpdated.addListener((_id, _change, t) => up(t));
ext.tabs.onRemoved.addListener((id, info) => { client?.removeTab(String(id)); if (!info.isWindowClosing) refreshWindow(info.windowId); });
ext.tabs.onMoved.addListener((_id, info) => refreshWindow(info.windowId));
ext.tabs.onAttached.addListener((_id, info) => refreshWindow(info.newWindowId));
ext.tabs.onDetached.addListener((_id, info) => refreshWindow(info.oldWindowId));
ext.tabs.onActivated.addListener((info) => refreshWindow(info.windowId));
ext.tabs.onReplaced.addListener((added, removed) => { client?.removeTab(String(removed)); ext.tabs.get(added).then(up, () => {}); });
ext.windows.onCreated.addListener((w) => { const ww = wireWindow(w); if (ww) client?.upsertWindow(ww); });
ext.windows.onRemoved.addListener((id) => client?.removeWindow(String(id)));
ext.windows.onFocusChanged.addListener(refreshWindows);

/* ---------- keep-alive ---------- */
ext.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void starting.then(() => client?.poke()); });
void ext.alarms.get(ALARM).then((a) => { if (!a) void ext.alarms.create(ALARM, { periodInMinutes: 0.5 }); });

ext.action.onClicked.addListener(() => { void ext.runtime.openOptionsPage(); });

/* ---------- options page ---------- */
async function status(): Promise<BgStatus> {
  await starting;
  const cfg = await loadCfg();
  return {
    paired: !!cfg.token, hubUrl: cfg.hubUrl, deviceName: cfg.deviceName, profile: cfg.profile, includeInternal: cfg.includeInternal,
    family: FAMILY, version: VERSION, status: client?.status ?? (cfg.token ? "idle" : "unpaired"),
    detail: lastError, lastSnapshot: client?.lastSnapshot ?? null,
  };
}

async function handle(m: BgRequest): Promise<BgStatus> {
  switch (m.type) {
    case "status": return status();
    case "pair": {
      const url = collectorUrl(m.hubUrl); // throws on a bad URL
      const r = await enroll(url, m.code, `${FAMILY}${m.profile ? " · " + m.profile : ""}`);
      const origin = new URL(m.hubUrl.trim()).origin;
      await ext.storage.local.set({ hubUrl: origin, token: r.token, deviceName: r.device.name, profile: m.profile.trim() });
      await restart();
      return status();
    }
    case "unpair":
      client?.stop(); client = null;
      await ext.storage.local.remove(["token", "deviceName"]);
      await restart();
      return status();
    case "settings":
      await ext.storage.local.set({ profile: m.profile.trim(), includeInternal: m.includeInternal });
      await restart();
      return status();
    case "reconnect":
      await restart();
      return status();
  }
}

ext.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false;
  handle(msg).then((s) => sendResponse({ ok: true, status: s }), (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
  return true; // async response
});

void restart();
