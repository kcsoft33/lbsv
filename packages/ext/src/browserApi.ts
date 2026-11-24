/// <reference types="chrome" />
/**
 * The few WebExtension APIs lbsv-ext uses, behind one name. Firefox exposes promise-based `browser.*`
 * (and a `chrome.*` alias); Chromium MV3 returns promises from `chrome.*`. The shapes we touch
 * (tabs, windows, storage, alarms, runtime, action) are the same in both.
 */
import type { BrowserFamily, WireTab, WireWindow } from "../../shared/src/live.ts";

export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

export function detectFamily(): BrowserFamily {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  const brands = ((navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand);
  if (brands.some((b) => /Edge/i.test(b)) || /Edg\//.test(ua)) return "edge";
  if (brands.some((b) => /Google Chrome/i.test(b))) return "chrome";
  if (/Chrome\//.test(ua)) return "chromium";
  return "other";
}

export function wireTab(t: chrome.tabs.Tab): WireTab | null {
  if (t.id == null || t.id < 0) return null; // TAB_ID_NONE: devtools and friends
  return {
    id: String(t.id),
    windowId: String(t.windowId),
    index: t.index,
    url: t.url || t.pendingUrl || "",
    title: t.title || "",
    active: t.active,
    pinned: t.pinned,
    audible: !!t.audible,
    discarded: !!t.discarded,
    lastAccessed: (t as { lastAccessed?: number }).lastAccessed,
    incognito: t.incognito,
    favIconUrl: t.favIconUrl,
  };
}

export function wireWindow(w: chrome.windows.Window): WireWindow | null {
  if (w.id == null || w.id < 0) return null;
  return { id: String(w.id), focused: w.focused, state: w.state ?? "normal", incognito: w.incognito };
}

const WINDOW_TYPES = ["normal", "popup"] as chrome.windows.WindowType[];

export async function readAll(): Promise<{ windows: WireWindow[]; tabs: WireTab[] }> {
  const wins = await ext.windows.getAll({ populate: true, windowTypes: WINDOW_TYPES });
  const windows: WireWindow[] = [];
  const tabs: WireTab[] = [];
  for (const w of wins) {
    const ww = wireWindow(w);
    if (!ww) continue;
    windows.push(ww);
    for (const t of w.tabs ?? []) { const wt = wireTab(t); if (wt) tabs.push(wt); }
  }
  return { windows, tabs };
}
