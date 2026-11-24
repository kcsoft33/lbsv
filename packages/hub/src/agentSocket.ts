import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { CLOSE_BAD_MESSAGE, CLOSE_REPLACED, CLOSE_UNAUTHORIZED } from "../../shared/src/live.ts";
import { MAX_CMD, MAX_CWD, MAX_TERMS, type HubToAgentMsg } from "../../shared/src/terms.ts";
import type { ChangedMsg } from "../../shared/src/types.ts";
import type { Devices } from "./devices.ts";
import { HEARTBEAT_MS } from "./live.ts";
import type { Terms } from "./terms.ts";

const WTerm = z.object({
  id: z.string().min(1).max(300),
  kind: z.enum(["shell", "tmux", "screen"]),
  name: z.string().max(400).default(""),
  shell: z.string().max(40).optional(),
  pid: z.number().int().nonnegative().optional(),
  user: z.string().max(200).optional(),
  cwd: z.string().max(MAX_CWD * 2).default(""),
  tty: z.string().max(200).optional(),
  attached: z.number().int().min(0).max(10_000).optional(),
  windows: z.number().int().min(0).max(100_000).optional(),
  startedAt: z.number().nonnegative().optional(),
  lastActivityAt: z.number().nonnegative().optional(),
  cmd: z.string().max(MAX_CMD * 4).optional(),
});
export const AgentIn = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"), token: z.string().max(200),
    agent: z.object({ version: z.string().max(40).default(""), os: z.string().max(40).default(""), hostname: z.string().max(255).default(""), user: z.string().max(100).default("") }),
  }),
  z.object({ t: z.literal("terms"), seq: z.number().int().positive(), terms: z.array(WTerm).max(MAX_TERMS) }),
  z.object({ t: z.literal("ping") }),
  // Agents don't run hub commands yet; tolerate the generic "unsupported" answer.
  z.object({ t: z.literal("cmd_result"), id: z.string().max(64), ok: z.boolean(), error: z.string().max(500).nullish() }),
]);

/**
 * /collect/agent: lbsv-agent connections (device-token auth with a credential of kind "agent").
 * Same lifecycle as browser collectors: hello → welcome → full state, then full state again on
 * every change. Pairing itself goes through /collect ("enroll" with kind "agent").
 */
export function registerAgentSocket(app: FastifyInstance, deps: {
  devices: Devices; terms: Terms; broadcast: (m: ChangedMsg) => void;
}): { disconnectDevice(deviceId: string): void; connectedCount(): number; isConnected(agentId: string): boolean } {
  const { devices, terms, broadcast } = deps;
  const conns = new Map<string, { socket: WebSocket; deviceId: string }>();
  terms.resetConnections();

  const dirty = new Set<string>();
  let flushT: ReturnType<typeof setTimeout> | undefined;
  const changed = (id: string) => {
    dirty.add(id);
    flushT ??= setTimeout(() => { flushT = undefined; const ids = [...dirty]; dirty.clear(); broadcast({ t: "changed", entity: "live", ids }); }, 50);
  };
  let closing = false;
  app.addHook("onClose", async () => {
    // Close handlers fire after this; the database may already be closed by then.
    closing = true; clearTimeout(flushT);
    const all = [...conns.values()]; conns.clear();
    for (const c of all) c.socket.terminate();
  });

  app.get("/collect/agent", { websocket: true }, (socket, req) => {
    let agentId: string | null = null;
    const send = (m: HubToAgentMsg) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
    const helloT = setTimeout(() => { if (!agentId) socket.close(CLOSE_UNAUTHORIZED, "hello timeout"); }, 15_000);

    socket.on("message", (raw: Buffer) => {
      let m: z.infer<typeof AgentIn>;
      try { m = AgentIn.parse(JSON.parse(raw.toString("utf8"))); } catch {
        send({ t: "error", error: "bad_message" });
        socket.close(CLOSE_BAD_MESSAGE, "bad message");
        return;
      }
      try {
        switch (m.t) {
          case "hello": {
            const a = devices.authenticate(m.token);
            if (!a || a.kind !== "agent") {
              send({ t: "error", error: "unauthorized" });
              socket.close(CLOSE_UNAUTHORIZED, "device token rejected");
              return;
            }
            clearTimeout(helloT);
            const ag = terms.attach(a.credentialId, a.device.id, m.agent);
            const prev = conns.get(ag.id);
            if (prev && prev.socket !== socket) prev.socket.close(CLOSE_REPLACED, "replaced by a newer connection");
            agentId = ag.id;
            conns.set(ag.id, { socket, deviceId: a.device.id });
            send({ t: "welcome", agentId: ag.id, device: a.device, heartbeatMs: HEARTBEAT_MS });
            changed(ag.id);
            return;
          }
          case "terms": {
            if (!agentId) { socket.close(CLOSE_UNAUTHORIZED, "hello first"); return; }
            if (terms.apply(agentId, m.seq, m.terms) === "applied") changed(agentId);
            send({ t: "ack", seq: m.seq });
            return;
          }
          case "ping":
            if (!agentId) return;
            terms.touch(agentId);
            send({ t: "pong" });
            return;
          case "cmd_result": return;
        }
      } catch (e) {
        req.log.warn({ err: e }, "agent message failed");
        socket.close(1011, "hub error");
      }
    });

    socket.on("close", () => {
      clearTimeout(helloT);
      if (closing) return;
      if (agentId && conns.get(agentId)?.socket === socket) {
        conns.delete(agentId);
        terms.detach(agentId);
        changed(agentId);
      }
    });
    socket.on("error", () => socket.terminate());
  });

  return {
    disconnectDevice(deviceId) {
      for (const [id, c] of conns) if (c.deviceId === deviceId) { conns.delete(id); c.socket.close(CLOSE_UNAUTHORIZED, "device revoked"); }
    },
    connectedCount: () => conns.size,
    isConnected: (agentId) => conns.get(agentId)?.socket.readyState === 1,
  };
}
