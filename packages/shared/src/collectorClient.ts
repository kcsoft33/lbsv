/**
 * Collector side of the live protocol (SPEC §6.2), independent of any browser API so it runs in
 * the MV3 extension and, unchanged, in Node tests (Node ≥22 has a global WebSocket).
 *
 * Lifecycle: connect → hello → (hub) welcome → snapshot → debounced deltas … → socket drops →
 * back-off reconnect → hello → snapshot again. The snapshot on every (re)connect is what makes the
 * protocol self-healing: anything that changed while offline (and any delta lost in flight) is
 * superseded by the fresh full state, so the local queue never needs to be replayed verbatim.
 * Changes noted while offline are still coalesced locally (bounded by the number of tabs) and are
 * dropped once the reconnect snapshot has been taken.
 */
import { prepareTab, type BrowserFamily, type HubToCollectorMsg, type WireTab, type WireWindow } from "./live.ts";
import { HubSocket, type HubSocketOptions, type WelcomeBase, type WSCtor } from "./hubSocket.ts";

export { UNAUTHORIZED_RETRY_MS, type CollectorStatus, type WSCtor, type WSLike } from "./hubSocket.ts";

export interface CollectorOptions extends HubSocketOptions {
  browser: { family: BrowserFamily; profile: string };
  version: string;
  /** Read the complete current state from the browser (incognito included; it's filtered here). */
  snapshot: () => Promise<{ windows: WireWindow[]; tabs: WireTab[] }>;
  includeInternal?: boolean;
  debounceMs?: number;
}

export const DEFAULT_DEBOUNCE_MS = 500;

/** Turn a hub base URL the user typed (http://hub:8080) into a collector socket URL. */
export function collectorUrl(hubUrl: string, path = "/collect"): string {
  const u = new URL(hubUrl.trim());
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error("Hub URL must start with http:// or https://");
  u.pathname = path; u.search = ""; u.hash = "";
  return u.toString();
}

export class CollectorClient extends HubSocket {
  browserId = "";
  lastSnapshot = { tabs: 0, denied: 0, at: 0 };

  private o: CollectorOptions;
  private deny: string[] = [];
  private flushT: ReturnType<typeof setTimeout> | undefined;
  private snapshotting: Promise<void> | null = null;
  private snapAgain = false;
  private upTabs = new Map<string, WireTab>();
  private rmTabs = new Set<string>();
  private upWins = new Map<string, WireWindow>();
  private rmWins = new Set<string>();

  constructor(o: CollectorOptions) { super(o); this.o = o; }

  override stop(): void {
    clearTimeout(this.flushT); this.flushT = undefined;
    super.stop();
  }

  protected hello(): object {
    return { t: "hello", token: this.o.token, browser: this.o.browser, ext: this.o.version };
  }

  protected onWelcome(m: WelcomeBase & Record<string, unknown>): void {
    const w = m as unknown as Extract<HubToCollectorMsg, { t: "welcome" }>;
    this.browserId = w.browserId;
    this.deny = w.deny ?? [];
    void this.sendSnapshot();
  }

  protected override onHubMessage(m: { t: string } & Record<string, unknown>): void {
    if (m.t === "config") { this.deny = (m.deny as string[]) ?? []; void this.sendSnapshot(); }
    else if (m.t === "resync") void this.sendSnapshot();
  }

  get pending(): number { return this.upTabs.size + this.rmTabs.size + this.upWins.size + this.rmWins.size; }

  /* ---------- change notifications from the browser ---------- */
  upsertTab(t: WireTab): void {
    const p = prepareTab(t, { deny: this.deny, includeInternal: this.o.includeInternal });
    if (p === "incognito") return; // never mentioned to the hub, not even as a removal
    if (typeof p === "string") { this.removeTab(String(t.id)); return; } // navigated to an internal/denied page
    this.rmTabs.delete(p.id); this.upTabs.set(p.id, p); this.schedule();
  }
  removeTab(id: string): void { this.upTabs.delete(id); this.rmTabs.add(id); this.schedule(); }
  upsertWindow(w: WireWindow): void {
    if (w.incognito) return;
    const id = String(w.id);
    this.rmWins.delete(id); this.upWins.set(id, { id, focused: !!w.focused, state: w.state ?? "normal" }); this.schedule();
  }
  removeWindow(id: string): void { this.upWins.delete(id); this.rmWins.add(id); this.schedule(); }

  /** Re-send everything (e.g. after the user changed collector options). */
  resync(): void { void this.sendSnapshot(); }

  /* ---------- snapshot / delta ---------- */
  private async sendSnapshot(): Promise<void> {
    if (this.snapshotting) { this.snapAgain = true; return this.snapshotting; }
    this.snapshotting = (async () => {
      do {
        this.snapAgain = false;
        const ws = this.ws;
        if (!ws || !this.welcomed) return;
        // Clear first: anything that changes while we read the browser is re-queued and goes out
        // as a delta after the snapshot (flush() waits while a snapshot is in progress).
        this.upTabs.clear(); this.rmTabs.clear(); this.upWins.clear(); this.rmWins.clear();
        const raw = await this.o.snapshot();
        if (ws !== this.ws || !this.welcomed) return;
        const winIncog = new Set(raw.windows.filter((w) => w.incognito).map((w) => String(w.id)));
        const windows = raw.windows.filter((w) => !w.incognito).map((w) => ({ id: String(w.id), focused: !!w.focused, state: w.state ?? "normal" }));
        const tabs: WireTab[] = [];
        let denied = 0;
        for (const t of raw.tabs) {
          if (winIncog.has(String(t.windowId))) continue;
          const p = prepareTab(t, { deny: this.deny, includeInternal: this.o.includeInternal });
          if (p === "denied") denied++;
          else if (typeof p !== "string") tabs.push(p);
        }
        this.send({ t: "snapshot", seq: ++this.seq, windows, tabs, denied });
        this.lastSnapshot = { tabs: tabs.length, denied, at: Date.now() };
      } while (this.snapAgain);
    })().finally(() => { this.snapshotting = null; });
    return this.snapshotting;
  }

  private schedule(): void {
    if (!this.flushT) this.flushT = setTimeout(() => this.flush(), this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private flush(): void {
    this.flushT = undefined;
    if (this.snapshotting) { this.schedule(); return; }
    if (!this.welcomed || !this.pending) return; // offline: the reconnect snapshot covers it
    const d: { t: "delta"; seq: number; upserts: { windows?: WireWindow[]; tabs?: WireTab[] }; removes: { windows?: string[]; tabs?: string[] } } =
      { t: "delta", seq: this.seq + 1, upserts: {}, removes: {} };
    if (this.upWins.size) d.upserts.windows = [...this.upWins.values()];
    if (this.upTabs.size) d.upserts.tabs = [...this.upTabs.values()];
    if (this.rmWins.size) d.removes.windows = [...this.rmWins];
    if (this.rmTabs.size) d.removes.tabs = [...this.rmTabs];
    if (!this.send(d)) return;
    this.seq++;
    this.upTabs.clear(); this.rmTabs.clear(); this.upWins.clear(); this.rmWins.clear();
  }
}

/** Exchange a one-time pairing code for a device token over the collector socket. */
export function enroll(url: string, code: string, label: string, kind: "ext" | "agent" = "ext",
  WS: WSCtor = (globalThis as unknown as { WebSocket: WSCtor }).WebSocket, timeoutMs = 10_000,
): Promise<{ token: string; device: { id: string; name: string } }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WS(url);
    const finish = (err: Error | null, v?: { token: string; device: { id: string; name: string } }) => {
      if (done) return; done = true; clearTimeout(t);
      try { ws.close(1000); } catch { /* ignore */ }
      if (err) reject(err); else resolve(v!);
    };
    const t = setTimeout(() => finish(new Error("The hub didn't answer in time.")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ t: "enroll", code, kind, label }));
    ws.onmessage = (e) => {
      let m: HubToCollectorMsg;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === "enrolled") finish(null, { token: m.token, device: m.device });
      else if (m.t === "error") finish(new Error(
        m.error === "bad_code" ? "That pairing code is wrong, already used, or expired." :
        m.error === "throttled" ? "Too many attempts. Wait a minute and try again." : m.error));
    };
    ws.onerror = () => finish(new Error("Couldn't reach the hub at that address."));
    ws.onclose = () => finish(new Error("The hub closed the connection."));
  });
}
