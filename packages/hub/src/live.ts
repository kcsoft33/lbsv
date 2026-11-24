import type { DB } from "./db.ts";
import { ulid } from "../../shared/src/ulid.ts";
import { prepareTab, type BrowserFamily, type LiveBrowser, type LiveDevice, type LiveState, type LiveTab, type WireTab, type WireWindow } from "../../shared/src/live.ts";
import type { Devices } from "./devices.ts";
import type { Favicons } from "./favicons.ts";
import type { Terms } from "./terms.ts";

/** Collectors ping this often; a browser silent for 2x this is shown as stale (SPEC §6.2). */
export const HEARTBEAT_MS = 20_000;
export const STALE_AFTER_MS = 2 * HEARTBEAT_MS;
export const OLD_TAB_DAYS = 7;
const FIRST_SEEN_RETENTION_MS = 30 * 86400_000;

type DeltaResult = "applied" | "duplicate" | "gap";

interface TabRow {
  id: string; browser_id: string; native_id: string; window_id: string; idx: number; url: string; title: string;
  active: number; pinned: number; audible: number; discarded: number; last_accessed: number | null; first_seen_at: number;
}

/**
 * Live browser state. Each browser's rows are owned by its collector: a snapshot replaces them
 * wholesale in one transaction (idempotent, self-healing); deltas patch them in seq order.
 * The hub re-applies the privacy filters on everything it receives (defence in depth).
 */
export class Live {
  private db: DB;
  private devices: Devices;
  private now: () => number;
  favicons: Favicons | null = null;
  terms: Terms | null = null;
  constructor(db: DB, devices: Devices, now: () => number = Date.now) { this.db = db; this.devices = devices; this.now = now; }

  /** Live rows by live id (`browserId:nativeId`), for actions. */
  lookup(ids: string[]): Map<string, { id: string; browserId: string; nativeId: string; windowId: string; url: string; title: string }> {
    const out = new Map<string, { id: string; browserId: string; nativeId: string; windowId: string; url: string; title: string }>();
    const q = this.db.prepare("SELECT id, browser_id AS browserId, native_id AS nativeId, window_id AS windowId, url, title FROM live_tabs WHERE id = ?");
    for (const id of new Set(ids)) {
      const r = q.get(id) as { id: string; browserId: string; nativeId: string; windowId: string; url: string; title: string } | undefined;
      if (r) out.set(id, r);
    }
    return out;
  }

  removeTabs(ids: string[]): void {
    const del = this.db.prepare("DELETE FROM live_tabs WHERE id = ?");
    this.db.transaction(() => { for (const id of ids) del.run(id); })();
  }

  /** The browser's focused window (else its first), to open sent tabs into. */
  targetWindow(browserId: string): string | undefined {
    const r = this.db.prepare("SELECT native_id FROM live_windows WHERE browser_id = ? ORDER BY focused DESC, CAST(native_id AS INTEGER) LIMIT 1").get(browserId) as { native_id: string } | undefined;
    return r?.native_id;
  }

  /** "Edge · Work on laptop-2": used as a saved link's "where". */
  browserLabel(browserId: string): string {
    const r = this.db.prepare("SELECT b.family, b.profile, d.name FROM browsers b JOIN devices d ON d.id = b.device_id WHERE b.id = ?").get(browserId) as
      { family: string; profile: string; name: string } | undefined;
    if (!r) return "";
    const fam = ({ chrome: "Chrome", edge: "Edge", firefox: "Firefox", chromium: "Chromium" } as Record<string, string>)[r.family] ?? "Browser";
    return `${fam}${r.profile ? " · " + r.profile : ""} on ${r.name}`;
  }

  /** After a hub restart nobody is connected yet. */
  resetConnections(): void { this.db.prepare("UPDATE browsers SET connected = 0").run(); }

  /** Find or create the browser row for a credential, refreshing what the collector says about itself. */
  attach(credentialId: string, deviceId: string, info: { family: BrowserFamily; profile: string; ext: string }): { id: string; lastSeq: number } {
    const now = this.now();
    const row = this.db.prepare("SELECT id, last_seq FROM browsers WHERE credential_id = ?").get(credentialId) as { id: string; last_seq: number } | undefined;
    if (row) {
      this.db.prepare("UPDATE browsers SET family = ?, profile = ?, ext_version = ?, connected = 1, last_seen_at = ? WHERE id = ?")
        .run(info.family, info.profile, info.ext, now, row.id);
      return { id: row.id, lastSeq: row.last_seq };
    }
    const id = ulid();
    this.db.prepare(`INSERT INTO browsers(id, device_id, credential_id, family, profile, ext_version, connected, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(id, deviceId, credentialId, info.family, info.profile, info.ext, now);
    return { id, lastSeq: 0 };
  }

  detach(browserId: string): void {
    this.db.prepare("UPDATE browsers SET connected = 0 WHERE id = ?").run(browserId);
  }

  touch(browserId: string): void {
    this.db.prepare("UPDATE browsers SET last_seen_at = ? WHERE id = ?").run(this.now(), browserId);
  }

  private deviceOf(browserId: string): string {
    return (this.db.prepare("SELECT device_id FROM browsers WHERE id = ?").get(browserId) as { device_id: string }).device_id;
  }

  /** Replace everything we know about this browser. */
  applySnapshot(browserId: string, seq: number, windows: WireWindow[], tabs: WireTab[], clientDenied = 0): { tabs: number; denied: number } {
    const now = this.now();
    const deny = this.devices.effectiveDeny(this.deviceOf(browserId));
    return this.db.transaction(() => {
      const old = new Map((this.db.prepare("SELECT native_id, url, first_seen_at FROM live_tabs WHERE browser_id = ?").all(browserId) as
        { native_id: string; url: string; first_seen_at: number }[]).map((r) => [r.native_id, r]));
      this.db.prepare("DELETE FROM live_windows WHERE browser_id = ?").run(browserId);
      this.db.prepare("DELETE FROM live_tabs WHERE browser_id = ?").run(browserId);
      for (const w of windows) this.putWindow(browserId, w);
      let denied = clientDenied, n = 0;
      for (const t of tabs) {
        const p = prepareTab(t, { deny, includeInternal: true });
        if (p === "denied") { denied++; continue; }
        if (typeof p === "string") continue;
        const prev = old.get(p.id);
        this.insertTab(browserId, p, prev?.first_seen_at, now); // same native tab: keep its age even if it navigated
        n++;
      }
      this.db.prepare("UPDATE browsers SET last_seq = ?, last_seen_at = ?, last_snapshot_at = ?, denied_count = ? WHERE id = ?")
        .run(seq, now, now, denied, browserId);
      this.db.prepare("DELETE FROM tab_first_seen WHERE browser_id = ? AND last_seen_at < ?").run(browserId, now - FIRST_SEEN_RETENTION_MS);
      return { tabs: n, denied };
    })();
  }

  /** Apply one delta. Old/duplicate seqs are ignored; a gap means we missed something → resync. */
  applyDelta(browserId: string, seq: number, d: { upserts?: { windows?: WireWindow[]; tabs?: WireTab[] }; removes?: { windows?: string[]; tabs?: string[] } }): DeltaResult {
    const now = this.now();
    const deny = this.devices.effectiveDeny(this.deviceOf(browserId));
    return this.db.transaction((): DeltaResult => {
      const { last_seq } = this.db.prepare("SELECT last_seq FROM browsers WHERE id = ?").get(browserId) as { last_seq: number };
      if (seq <= last_seq) return "duplicate";
      if (seq !== last_seq + 1) return "gap";
      for (const id of d.removes?.windows ?? []) {
        this.db.prepare("DELETE FROM live_windows WHERE browser_id = ? AND native_id = ?").run(browserId, id);
        this.db.prepare("DELETE FROM live_tabs WHERE browser_id = ? AND window_id = ?").run(browserId, id);
      }
      for (const id of d.removes?.tabs ?? []) this.db.prepare("DELETE FROM live_tabs WHERE id = ?").run(`${browserId}:${id}`);
      for (const w of d.upserts?.windows ?? []) this.putWindow(browserId, w);
      for (const t of d.upserts?.tabs ?? []) {
        const p = prepareTab(t, { deny, includeInternal: true });
        const id = `${browserId}:${t.id}`;
        if (typeof p === "string") { this.db.prepare("DELETE FROM live_tabs WHERE id = ?").run(id); continue; }
        const prev = this.db.prepare("SELECT url, first_seen_at FROM live_tabs WHERE id = ?").get(id) as { url: string; first_seen_at: number } | undefined;
        if (prev) this.db.prepare("DELETE FROM live_tabs WHERE id = ?").run(id);
        this.insertTab(browserId, p, prev?.first_seen_at, now);
      }
      this.db.prepare("UPDATE browsers SET last_seq = ?, last_seen_at = ? WHERE id = ?").run(seq, now, browserId);
      return "applied";
    })();
  }

  private putWindow(browserId: string, w: WireWindow): void {
    if (w.incognito) return;
    this.db.prepare(`INSERT INTO live_windows(browser_id, native_id, focused, state) VALUES (?, ?, ?, ?)
      ON CONFLICT(browser_id, native_id) DO UPDATE SET focused = excluded.focused, state = excluded.state`)
      .run(browserId, String(w.id), w.focused ? 1 : 0, String(w.state ?? "normal").slice(0, 20));
  }

  /**
   * firstSeen: the tab's age when we already track this native tab. Otherwise fall back to when this
   * browser first showed this URL (survives browser restarts, which renumber tabs), else now.
   */
  private insertTab(browserId: string, t: WireTab, firstSeen: number | undefined, now: number): void {
    const fs = this.db.prepare("SELECT first_seen_at FROM tab_first_seen WHERE browser_id = ? AND url = ?").get(browserId, t.url) as { first_seen_at: number } | undefined;
    const first = Math.min(firstSeen ?? Infinity, fs?.first_seen_at ?? Infinity, now);
    this.db.prepare(`INSERT INTO tab_first_seen(browser_id, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(browser_id, url) DO UPDATE SET last_seen_at = excluded.last_seen_at, first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`)
      .run(browserId, t.url, first, now);
    this.favicons?.note(t.url, t.favIconUrl);
    this.db.prepare(`INSERT INTO live_tabs(id, browser_id, native_id, window_id, idx, url, title, active, pinned, audible, discarded, last_accessed, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `${browserId}:${t.id}`, browserId, t.id, t.windowId, t.index, t.url, t.title,
      t.active ? 1 : 0, t.pinned ? 1 : 0, t.audible ? 1 : 0, t.discarded ? 1 : 0, t.lastAccessed ?? null, first, now);
  }

  /** Remove live rows that a (new) deny list now covers, without waiting for the next snapshot. */
  purgeDenied(deviceId?: string): number {
    const browsers = (deviceId
      ? this.db.prepare("SELECT id, device_id FROM browsers WHERE device_id = ?").all(deviceId)
      : this.db.prepare("SELECT id, device_id FROM browsers").all()) as { id: string; device_id: string }[];
    let n = 0;
    for (const b of browsers) {
      const deny = this.devices.effectiveDeny(b.device_id);
      if (!deny.length) continue;
      const rows = this.db.prepare("SELECT id, url FROM live_tabs WHERE browser_id = ?").all(b.id) as { id: string; url: string }[];
      for (const r of rows) {
        if (prepareTab({ id: "x", windowId: "x", index: 0, url: r.url, title: "" }, { deny, includeInternal: true }) === "denied") {
          this.db.prepare("DELETE FROM live_tabs WHERE id = ?").run(r.id);
          this.db.prepare("DELETE FROM tab_first_seen WHERE browser_id = ? AND url = ?").run(b.id, r.url);
          this.db.prepare("UPDATE browsers SET denied_count = denied_count + 1 WHERE id = ?").run(b.id);
          n++;
        }
      }
    }
    return n;
  }

  state(): LiveState {
    const devs = this.devices.list();
    const browsers = this.db.prepare("SELECT * FROM browsers ORDER BY family, profile, id").all() as {
      id: string; device_id: string; family: BrowserFamily; profile: string; ext_version: string; connected: number;
      last_seen_at: number | null; last_snapshot_at: number | null; denied_count: number;
    }[];
    const windows = this.db.prepare("SELECT * FROM live_windows").all() as { browser_id: string; native_id: string; focused: number; state: string }[];
    const tabs = this.db.prepare("SELECT * FROM live_tabs ORDER BY browser_id, window_id, idx").all() as TabRow[];

    const winsBy = new Map<string, Map<string, { id: string; focused: boolean; state: string; tabs: LiveTab[] }>>();
    const winMap = (bid: string) => { let m = winsBy.get(bid); if (!m) winsBy.set(bid, (m = new Map())); return m; };
    for (const w of windows) winMap(w.browser_id).set(w.native_id, { id: w.native_id, focused: !!w.focused, state: w.state, tabs: [] });
    for (const t of tabs) {
      const m = winMap(t.browser_id);
      let w = m.get(t.window_id);
      if (!w) m.set(t.window_id, (w = { id: t.window_id, focused: false, state: "normal", tabs: [] }));
      w.tabs.push({
        id: t.id, nativeId: t.native_id, url: t.url, title: t.title, active: !!t.active, pinned: !!t.pinned, audible: !!t.audible,
        discarded: !!t.discarded, index: t.idx, lastAccessed: t.last_accessed, firstSeenAt: t.first_seen_at,
      });
    }
    const byDevice = new Map<string, LiveBrowser[]>();
    for (const b of browsers) {
      const ws = [...(winsBy.get(b.id)?.values() ?? [])].filter((w) => w.tabs.length)
        .sort((a, c) => Number(c.focused) - Number(a.focused) || Number(a.id) - Number(c.id) || a.id.localeCompare(c.id));
      const lb: LiveBrowser = {
        id: b.id, family: b.family, profile: b.profile, ext: b.ext_version, connected: !!b.connected,
        lastSeenAt: b.last_seen_at, lastSnapshotAt: b.last_snapshot_at, denied: b.denied_count, windows: ws,
      };
      const list = byDevice.get(b.device_id) ?? [];
      list.push(lb); byDevice.set(b.device_id, list);
    }
    const agents = this.terms?.byDevice() ?? new Map();
    const devices: LiveDevice[] = devs.map((d) => {
      let deny: string[] = [];
      try { deny = JSON.parse(d.deny_domains); } catch { /* keep empty */ }
      return { id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, deny, pendingCode: this.devices.pendingCode(d.id), browsers: byDevice.get(d.id) ?? [],
        agents: agents.get(d.id) ?? [], ssh: { target: d.ssh_target, jump: d.ssh_jump } };
    });
    return { now: this.now(), staleAfterMs: STALE_AFTER_MS, oldTabDays: OLD_TAB_DAYS, globalDeny: this.devices.globalDeny(), devices };
  }

  search(q: string, limit = 50): { id: string; browserId: string; title: string; url: string }[] {
    const terms = q.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" AND ");
    return this.db.prepare(`SELECT t.id, t.browser_id AS browserId, t.title, t.url FROM live_tabs_fts f JOIN live_tabs t ON t.id = f.id
      WHERE live_tabs_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as { id: string; browserId: string; title: string; url: string }[];
  }
}
