/**
 * Live-tab wire protocol (SPEC §6.2) and the privacy filters shared by collector and hub (SPEC §7).
 * Native browser ids are numbers; on the wire they are strings so other collectors (lbsv-agent) can
 * use their own id schemes.
 */
import { redactUrl } from "./redact.ts";
import type { LiveAgent, SshTarget } from "./terms.ts";

export type BrowserFamily = "chrome" | "edge" | "firefox" | "chromium" | "other";
export const BROWSER_FAMILIES: BrowserFamily[] = ["chrome", "edge", "firefox", "chromium", "other"];

export interface WireWindow {
  id: string;
  focused?: boolean;
  state?: string; // normal | minimized | maximized | fullscreen
  incognito?: boolean;
}

export interface WireTab {
  id: string;
  windowId: string;
  index: number;
  url: string;
  title: string;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  discarded?: boolean;
  /** Epoch ms the tab was last focused, when the browser reports it. */
  lastAccessed?: number;
  incognito?: boolean;
  /** http(s) favicon URL as reported by the browser; the hub fetches and caches it (never hotlinked). */
  favIconUrl?: string;
}

/* ---------- messages ---------- */
export type CollectorMsg =
  | { t: "enroll"; code: string; kind: "ext" | "agent"; label?: string }
  | { t: "hello"; token: string; browser: { family: BrowserFamily; profile: string }; ext: string }
  | { t: "snapshot"; seq: number; windows: WireWindow[]; tabs: WireTab[]; denied?: number }
  | { t: "delta"; seq: number; upserts?: { windows?: WireWindow[]; tabs?: WireTab[] }; removes?: { windows?: string[]; tabs?: string[] } }
  | { t: "ping" }
  | { t: "cmd_result"; id: string; ok: boolean; error?: string | null; result?: CmdResult };

export type HubToCollectorMsg =
  | { t: "enrolled"; token: string; device: { id: string; name: string } }
  | { t: "welcome"; browserId: string; device: { id: string; name: string }; heartbeatMs: number; deny: string[] }
  | { t: "config"; deny: string[] }
  | { t: "ack"; seq: number }
  | { t: "resync" }
  | { t: "pong" }
  | { t: "error"; error: string }
  | ({ t: "cmd"; id: string } & Cmd);

/* ---------- actions (M2, SPEC §6.3) ---------- */
export type Cmd =
  | { op: "focus_tab"; args: { tabId: string; windowId: string } }
  /** Close only tabs whose native id AND (redacted) URL still match. */
  | { op: "close_tabs"; args: { tabs: { id: string; url: string }[] } }
  /** Open in an existing window when it still exists, else a new window. */
  | { op: "open_url"; args: { urls: string[]; windowId?: string } };

export interface CmdResult {
  closed?: string[];
  skipped?: { id: string; reason: "url_changed" | "gone" | "offline" | "failed" }[];
  opened?: number;
}

/** Schemes the collector will open on the hub's behalf. */
export const OPENABLE_RE = /^(https?|ftp):\/\//i;

/** Close codes on the collector socket. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_BAD_MESSAGE = 4400;

/* ---------- filters ---------- */
export const MAX_URL = 8192;
export const MAX_TITLE = 1024;

/** Browser-internal and non-navigable pages, skipped unless the user opts in. */
const INTERNAL_RE = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|extension|chrome-search|chrome-untrusted|devtools|view-source|javascript|data|blob|resource|wss?):/i;
export const isInternalUrl = (url: string) => !url || INTERNAL_RE.test(url);

/** "example.com" denies example.com and every subdomain. Entries may be written as URLs. */
export function normalizeDenyEntry(s: string): string {
  let d = s.trim().toLowerCase();
  if (!d) return "";
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) d = new URL(d).hostname; } catch { /* keep as typed */ }
  return d.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "").replace(/[/:].*$/, "");
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isDenied(url: string, deny: readonly string[]): boolean {
  if (!deny.length) return false;
  const h = hostOf(url);
  if (!h) return false;
  return deny.some((d) => d && (h === d || h.endsWith("." + d)));
}

export type SkipReason = "incognito" | "internal" | "denied";

/**
 * Decide whether a tab may leave the device and, if so, in what form.
 * Incognito/private tabs are always skipped; there is no option to include them.
 */
export function prepareTab(t: WireTab, opts: { deny?: readonly string[]; includeInternal?: boolean } = {}): WireTab | SkipReason {
  if (t.incognito) return "incognito";
  if (!opts.includeInternal && isInternalUrl(t.url)) return "internal";
  if (isDenied(t.url, opts.deny ?? [])) return "denied";
  const url = storedUrl(t.url);
  const out: WireTab = {
    id: String(t.id), windowId: String(t.windowId), index: t.index | 0, url,
    title: (t.title || "").slice(0, MAX_TITLE),
  };
  if (t.active) out.active = true;
  if (t.pinned) out.pinned = true;
  if (t.audible) out.audible = true;
  if (t.discarded) out.discarded = true;
  if (t.lastAccessed && Number.isFinite(t.lastAccessed)) out.lastAccessed = Math.floor(t.lastAccessed);
  if (t.favIconUrl && /^https?:\/\//i.test(t.favIconUrl) && t.favIconUrl.length <= 2048) out.favIconUrl = redactUrl(t.favIconUrl);
  return out;
}

/** URL identity for duplicate detection: ignore the fragment and a trailing slash. */
/** The URL as the hub stores it; collectors compare against this before closing a tab. */
export const storedUrl = (url: string) => redactUrl(url).slice(0, MAX_URL);

export function dupKey(url: string): string {
  return url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
}

/* ---------- hub -> UI shapes ---------- */
export interface LiveTab {
  id: string; // `${browserId}:${nativeId}`
  nativeId: string;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  index: number;
  lastAccessed: number | null;
  firstSeenAt: number;
}
export interface LiveWindow { id: string; focused: boolean; state: string; tabs: LiveTab[] }
export interface LiveBrowser {
  id: string;
  family: BrowserFamily;
  profile: string;
  ext: string;
  connected: boolean;
  lastSeenAt: number | null;
  lastSnapshotAt: number | null;
  denied: number;
  windows: LiveWindow[];
}
export interface LiveDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  deny: string[];
  pendingCode: { expiresAt: number } | null;
  browsers: LiveBrowser[];
  /** lbsv-agent installs (M3); usually zero or one per device. */
  agents: LiveAgent[];
  /** How to reach this device for reconnect commands. */
  ssh: SshTarget;
}
export interface LiveState {
  now: number;
  /** A browser silent for longer than this is shown as stale (2x heartbeat). */
  staleAfterMs: number;
  /** Tabs open longer than this many days are flagged as old (SPEC §12 default 7). */
  oldTabDays: number;
  globalDeny: string[];
  devices: LiveDevice[];
}
