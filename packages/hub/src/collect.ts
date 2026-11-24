import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { BROWSER_FAMILIES, CLOSE_BAD_MESSAGE, CLOSE_REPLACED, CLOSE_UNAUTHORIZED, MAX_TITLE, MAX_URL, type Cmd, type CmdResult, type HubToCollectorMsg } from "../../shared/src/live.ts";
import { ulid } from "../../shared/src/ulid.ts";
import type { ChangedMsg } from "../../shared/src/types.ts";
import type { Devices } from "./devices.ts";
import { HEARTBEAT_MS, type Live } from "./live.ts";
import { LoginThrottle } from "./auth.ts";
import type { Terms } from "./terms.ts";
import { registerAgentSocket } from "./agentSocket.ts";

/* ---------- wire schemas (validated; anything else closes the socket) ---------- */
const nid = z.union([z.string().min(1).max(64), z.number().int()]).transform(String);
const WWindow = z.object({ id: nid, focused: z.boolean().optional(), state: z.string().max(20).optional(), incognito: z.boolean().optional() });
const WTab = z.object({
  id: nid, windowId: nid, index: z.number().int().min(0).max(100_000),
  // Generous caps; prepareTab() truncates to MAX_URL / MAX_TITLE.
  url: z.string().max(MAX_URL * 4), title: z.string().max(MAX_TITLE * 8),
  active: z.boolean().optional(), pinned: z.boolean().optional(), audible: z.boolean().optional(), discarded: z.boolean().optional(),
  lastAccessed: z.number().nonnegative().optional(), incognito: z.boolean().optional(),
  favIconUrl: z.string().max(8192).optional(),
});
const seq = z.number().int().positive();
export const CollectorIn = z.discriminatedUnion("t", [
  z.object({ t: z.literal("enroll"), code: z.string().max(32), kind: z.enum(["ext", "agent"]).default("ext"), label: z.string().max(200).optional() }),
  z.object({
    t: z.literal("hello"), token: z.string().max(200),
    browser: z.object({ family: z.enum(BROWSER_FAMILIES as [string, ...string[]]).catch("other"), profile: z.string().max(100).default("") }),
    ext: z.string().max(40).default(""),
  }),
  z.object({ t: z.literal("snapshot"), seq, windows: z.array(WWindow).max(2000), tabs: z.array(WTab).max(20_000), denied: z.number().int().min(0).optional() }),
  z.object({
    t: z.literal("delta"), seq,
    upserts: z.object({ windows: z.array(WWindow).max(2000).optional(), tabs: z.array(WTab).max(20_000).optional() }).optional(),
    removes: z.object({ windows: z.array(nid).max(2000).optional(), tabs: z.array(nid).max(20_000).optional() }).optional(),
  }),
  z.object({ t: z.literal("ping") }),
  z.object({
    t: z.literal("cmd_result"), id: z.string().max(64), ok: z.boolean(), error: z.string().max(500).nullish(),
    result: z.object({
      closed: z.array(nid).max(20_000).optional(),
      skipped: z.array(z.object({ id: nid, reason: z.enum(["url_changed", "gone", "offline", "failed"]) })).max(20_000).optional(),
      opened: z.number().int().min(0).optional(),
    }).optional(),
  }),
]);

export type CmdOutcome = { ok: true; result: CmdResult } | { ok: false; error: string };
export const CMD_TIMEOUT_MS = 10_000;

interface Conn { socket: WebSocket; deviceId: string; credentialId: string }

export interface CollectorHub {
  /** Close every collector socket of a device (after revoke/remove). */
  disconnectDevice(deviceId: string): void;
  /** Push a new deny list to a device's collectors (or all, when omitted). They answer with a snapshot. */
  pushConfig(deviceId?: string): void;
  connectedCount(): number;
  isConnected(browserId: string): boolean;
  /** Send an action to one browser and wait for its result (never rejects). */
  command(browserId: string, cmd: Cmd, timeoutMs?: number): Promise<CmdOutcome>;
}

export function registerCollector(app: FastifyInstance, deps: {
  devices: Devices; live: Live; terms: Terms; broadcast: (m: ChangedMsg) => void; now: () => number;
}): CollectorHub {
  const { devices, live, broadcast } = deps;
  const agents = registerAgentSocket(app, deps);
  const conns = new Map<string, Conn>(); // browserId → connection
  const enrollThrottle = new LoginThrottle(deps.now);
  const pending = new Map<string, { browserId: string; done: (o: CmdOutcome) => void }>();
  const failPending = (browserId: string, error: string) => {
    for (const [id, p] of pending) if (p.browserId === browserId) { pending.delete(id); p.done({ ok: false, error }); }
  };
  live.resetConnections();

  // Coalesce UI notifications: many collectors can emit deltas at once.
  const dirty = new Set<string>();
  let flushT: ReturnType<typeof setTimeout> | undefined;
  const changed = (browserId: string) => {
    dirty.add(browserId);
    flushT ??= setTimeout(() => { flushT = undefined; const ids = [...dirty]; dirty.clear(); broadcast({ t: "changed", entity: "live", ids }); }, 50);
  };
  let closing = false;
  app.addHook("onClose", async () => {
    // Close handlers fire after this; the database may already be closed by then.
    closing = true; clearTimeout(flushT);
    const all = [...conns.values()]; conns.clear();
    for (const [, p] of pending) p.done({ ok: false, error: "offline" });
    pending.clear();
    for (const c of all) c.socket.terminate();
  });

  app.get("/collect", { websocket: true }, (socket, req) => {
    let browserId: string | null = null;
    const send = (m: HubToCollectorMsg) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
    const helloT = setTimeout(() => { if (!browserId) socket.close(CLOSE_UNAUTHORIZED, "hello timeout"); }, 15_000);

    socket.on("message", (raw: Buffer) => {
      let m: z.infer<typeof CollectorIn>;
      try { m = CollectorIn.parse(JSON.parse(raw.toString("utf8"))); } catch {
        send({ t: "error", error: "bad_message" });
        socket.close(CLOSE_BAD_MESSAGE, "bad message");
        return;
      }
      try { handle(m); } catch (e) {
        // e.g. the device was revoked between hello and this message. Never let one collector take the hub down.
        req.log.warn({ err: e }, "collector message failed");
        socket.close(1011, "hub error");
      }
    });

    const handle = (m: z.infer<typeof CollectorIn>) => {
      switch (m.t) {
        case "enroll": {
          const wait = enrollThrottle.retryAfterMs(req.ip);
          if (wait > 0) { send({ t: "error", error: "throttled" }); return; }
          const r = devices.enroll(m.code, m.kind, m.label ?? "");
          if (!r) { enrollThrottle.fail(req.ip); send({ t: "error", error: "bad_code" }); return; }
          enrollThrottle.ok(req.ip);
          send({ t: "enrolled", token: r.token, device: r.device });
          broadcast({ t: "changed", entity: "devices", ids: [r.device.id] });
          return;
        }
        case "hello": {
          const a = devices.authenticate(m.token);
          if (!a || a.kind !== "ext") {
            send({ t: "error", error: "unauthorized" });
            socket.close(CLOSE_UNAUTHORIZED, "device token rejected");
            return;
          }
          clearTimeout(helloT);
          const b = live.attach(a.credentialId, a.device.id, { family: m.browser.family as never, profile: m.browser.profile, ext: m.ext });
          const prev = conns.get(b.id);
          if (prev && prev.socket !== socket) prev.socket.close(CLOSE_REPLACED, "replaced by a newer connection");
          browserId = b.id;
          conns.set(b.id, { socket, deviceId: a.device.id, credentialId: a.credentialId });
          send({ t: "welcome", browserId: b.id, device: a.device, heartbeatMs: HEARTBEAT_MS, deny: devices.effectiveDeny(a.device.id) });
          changed(b.id);
          return;
        }
        case "cmd_result": {
          const p = pending.get(m.id);
          if (!p || p.browserId !== browserId) return; // late (timed out) or not ours
          pending.delete(m.id);
          p.done(m.ok ? { ok: true, result: (m.result ?? {}) as CmdResult } : { ok: false, error: m.error || "failed" });
          return;
        }
        case "ping":
          if (!browserId) return;
          live.touch(browserId);
          send({ t: "pong" });
          return;
        case "snapshot": {
          if (!browserId) { socket.close(CLOSE_UNAUTHORIZED, "hello first"); return; }
          live.applySnapshot(browserId, m.seq, m.windows, m.tabs, m.denied ?? 0);
          send({ t: "ack", seq: m.seq });
          changed(browserId);
          return;
        }
        case "delta": {
          if (!browserId) { socket.close(CLOSE_UNAUTHORIZED, "hello first"); return; }
          const r = live.applyDelta(browserId, m.seq, m);
          if (r === "gap") { send({ t: "resync" }); return; }
          send({ t: "ack", seq: m.seq });
          if (r === "applied") changed(browserId);
          return;
        }
      }
    };

    socket.on("close", () => {
      clearTimeout(helloT);
      if (closing) return;
      if (browserId && conns.get(browserId)?.socket === socket) {
        conns.delete(browserId);
        failPending(browserId, "offline");
        live.detach(browserId);
        changed(browserId);
      }
    });
    socket.on("error", () => socket.terminate());
  });

  return {
    disconnectDevice(deviceId) {
      agents.disconnectDevice(deviceId);
      for (const [bid, c] of conns) if (c.deviceId === deviceId) { conns.delete(bid); c.socket.close(CLOSE_UNAUTHORIZED, "device revoked"); }
    },
    pushConfig(deviceId) {
      for (const c of conns.values()) {
        if (deviceId && c.deviceId !== deviceId) continue;
        if (c.socket.readyState === 1) c.socket.send(JSON.stringify({ t: "config", deny: devices.effectiveDeny(c.deviceId) } satisfies HubToCollectorMsg));
      }
    },
    connectedCount: () => conns.size + agents.connectedCount(),
    isConnected: (browserId) => conns.get(browserId)?.socket.readyState === 1,
    command(browserId, cmd, timeoutMs = CMD_TIMEOUT_MS) {
      const c = conns.get(browserId);
      if (!c || c.socket.readyState !== 1) return Promise.resolve({ ok: false, error: "offline" });
      const id = ulid();
      return new Promise<CmdOutcome>((resolve) => {
        const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
        pending.set(id, { browserId, done: (o) => { clearTimeout(t); resolve(o); } });
        c.socket.send(JSON.stringify({ t: "cmd", id, ...cmd } satisfies HubToCollectorMsg));
      });
    },
  };
}
