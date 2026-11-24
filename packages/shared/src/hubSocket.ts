/**
 * The connection half of a collector (browser extension or lbsv-agent): dial out, say hello,
 * wait for welcome, heartbeat, notice half-open sockets, back off and reconnect, and stop
 * hammering the hub when the token is rejected. Subclasses decide what "hello" carries and
 * what to send once welcomed (always a full snapshot: that's what makes reconnects self-healing).
 *
 * Runs unchanged in an MV3 service worker and in Node ≥22 (global WebSocket).
 */
import { CLOSE_UNAUTHORIZED, type Cmd, type CmdResult } from "./live.ts";

export interface WSLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WSCtor = new (url: string) => WSLike;

export type CollectorStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized" | "stopped";

/** How often a collector whose token was rejected tries again (from poke()). */
export const UNAUTHORIZED_RETRY_MS = 10 * 60_000;

export interface HubSocketOptions {
  url: string;
  token: string;
  backoff?: { minMs: number; maxMs: number };
  WebSocket?: WSCtor;
  onStatus?: (s: CollectorStatus, detail?: string) => void;
  /** Execute a hub action. Without it, commands are answered "unsupported". */
  onCommand?: (c: Cmd) => Promise<CmdResult>;
}

/** Messages every collector understands; subclasses get the rest via onHubMessage. */
export interface WelcomeBase { t: "welcome"; device: { id: string; name: string }; heartbeatMs: number }

export abstract class HubSocket {
  status: CollectorStatus = "idle";
  statusDetail = "";
  deviceName = "";
  lastAck = 0;

  protected base: HubSocketOptions;
  protected ws: WSLike | null = null;
  protected welcomed = false;
  protected seq = 0;
  private WS: WSCtor;
  private stopped = false;
  private heartbeatMs = 20_000;
  private retries = 0;
  private lastRx = 0;
  private unauthorizedAt = 0;
  private retryT: ReturnType<typeof setTimeout> | undefined;
  private pingT: ReturnType<typeof setInterval> | undefined;

  constructor(o: HubSocketOptions) {
    this.base = o;
    this.WS = o.WebSocket ?? (globalThis as unknown as { WebSocket: WSCtor }).WebSocket;
  }

  /** The hello message (token included). */
  protected abstract hello(): object;
  /** Called once per connection after the hub's welcome. Send the full state from here. */
  protected abstract onWelcome(m: WelcomeBase & Record<string, unknown>): void;
  /** Anything other than welcome / ack / pong / error / cmd. */
  protected onHubMessage(_m: { t: string } & Record<string, unknown>): void { /* optional */ }
  /** Called when the socket goes away (subclasses drop in-flight state here). */
  protected onDisconnected(): void { /* optional */ }

  get online(): boolean { return this.welcomed && !!this.ws && this.ws.readyState === 1; }

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryT); clearInterval(this.pingT);
    const ws = this.ws; this.ws = null; this.welcomed = false;
    try { ws?.close(1000, "stopped"); } catch { /* already closed */ }
    this.onDisconnected();
    this.setStatus("stopped");
  }

  /**
   * Called from a keep-alive timer: reconnect now if we're down, otherwise check liveness.
   * A rejected token is retried only rarely: it usually means "revoked", but can also be a hub
   * that was briefly running on the wrong or a restored database.
   */
  poke(): void {
    if (this.stopped) return;
    if (this.status === "unauthorized") {
      if (Date.now() - this.unauthorizedAt < UNAUTHORIZED_RETRY_MS) return;
      this.connect();
      return;
    }
    if (!this.ws || this.ws.readyState > 1) { clearTimeout(this.retryT); this.connect(); return; }
    this.checkAlive();
  }

  protected setStatus(s: CollectorStatus, detail = ""): void {
    if (s === this.status && detail === this.statusDetail) return;
    this.status = s; this.statusDetail = detail;
    this.base.onStatus?.(s, detail);
  }

  private connect(): void {
    if (this.stopped || (this.ws && this.ws.readyState <= 1)) return;
    this.setStatus("connecting");
    let ws: WSLike;
    try { ws = new this.WS(this.base.url); } catch (e) { this.scheduleRetry(String(e)); return; }
    this.ws = ws; this.welcomed = false;
    ws.onopen = () => { this.lastRx = Date.now(); ws.send(JSON.stringify(this.hello())); };
    ws.onmessage = (e) => this.onMessage(ws, e.data);
    ws.onclose = (e) => this.onClose(ws, e.code, e.reason);
    ws.onerror = () => { /* a close event follows */ };
  }

  private onMessage(ws: WSLike, data: unknown): void {
    if (ws !== this.ws) return;
    this.lastRx = Date.now();
    let m: { t: string } & Record<string, unknown>;
    try { m = JSON.parse(String(data)); } catch { return; }
    switch (m.t) {
      case "welcome": {
        const w = m as unknown as WelcomeBase & Record<string, unknown>;
        this.welcomed = true; this.retries = 0;
        this.deviceName = w.device?.name ?? "";
        this.heartbeatMs = w.heartbeatMs || this.heartbeatMs;
        this.setStatus("online");
        clearInterval(this.pingT);
        this.pingT = setInterval(() => this.ping(), this.heartbeatMs);
        this.onWelcome(w);
        return;
      }
      case "ack": this.lastAck = Math.max(this.lastAck, Number(m.seq) || 0); return;
      case "pong": return;
      case "error": this.statusDetail = String(m.error ?? ""); return;
      case "cmd": void this.runCmd(m as unknown as { id: string } & Cmd); return;
      default: this.onHubMessage(m);
    }
  }

  private onClose(ws: WSLike, code: number, reason?: string): void {
    if (ws !== this.ws) return;
    this.ws = null; this.welcomed = false;
    clearInterval(this.pingT);
    this.onDisconnected();
    if (this.stopped) return;
    if (code === CLOSE_UNAUTHORIZED) { this.unauthorizedAt = Date.now(); this.setStatus("unauthorized", reason || "device token rejected"); return; }
    this.scheduleRetry(reason || `closed (${code})`);
  }

  private scheduleRetry(detail: string): void {
    this.setStatus("offline", detail);
    const { minMs, maxMs } = this.base.backoff ?? { minMs: 1000, maxMs: 30_000 };
    const delay = Math.min(maxMs, minMs * 2 ** this.retries++);
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => this.connect(), delay);
  }

  private ping(): void {
    if (!this.checkAlive()) return;
    this.send({ t: "ping" });
  }

  /** A half-open socket (cable pulled, hub host asleep) never closes by itself: give up on it. */
  private checkAlive(): boolean {
    const ws = this.ws;
    if (!ws || !this.welcomed) return false;
    if (Date.now() - this.lastRx > this.heartbeatMs * 2.5) {
      this.ws = null; this.welcomed = false; clearInterval(this.pingT);
      try { ws.close(4000, "hub silent"); } catch { /* ignore */ }
      this.onDisconnected();
      this.scheduleRetry("hub stopped answering");
      return false;
    }
    return true;
  }

  private async runCmd(m: { id: string } & Cmd): Promise<void> {
    const { id, op, args } = m;
    try {
      if (!this.base.onCommand) throw new Error("unsupported");
      const result = await this.base.onCommand({ op, args } as Cmd);
      this.send({ t: "cmd_result", id, ok: true, error: null, result });
    } catch (e) {
      this.send({ t: "cmd_result", id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  protected send(m: object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    return true;
  }
}
