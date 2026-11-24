import type { DB } from "./db.ts";
import { ulid } from "../../shared/src/ulid.ts";
import { MAX_CMD, MAX_CWD, redactCommand, type AgentInfo, type LiveAgent, type LiveTerm, type WireTerm } from "../../shared/src/terms.ts";

interface TermRow {
  id: string; agent_id: string; native_id: string; kind: LiveTerm["kind"]; session_name: string; shell: string; pid: number | null;
  username: string; cwd: string; tty: string; attached: number; windows: number; cmd: string;
  started_at: number | null; last_activity_at: number | null; first_seen_at: number;
}
interface AgentRow {
  id: string; device_id: string; version: string; os: string; hostname: string; username: string;
  connected: number; last_seen_at: number | null; last_snapshot_at: number | null;
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s : "").slice(0, n);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);

/**
 * Live terminals, owned by each device's lbsv-agent. The agent always sends its complete list
 * (terminals are few and change slowly), so every message replaces that agent's rows in one
 * transaction: idempotent, and a reconnect after any outage converges in one message.
 */
export class Terms {
  private db: DB;
  private now: () => number;
  constructor(db: DB, now: () => number = Date.now) { this.db = db; this.now = now; }

  resetConnections(): void { this.db.prepare("UPDATE agents SET connected = 0").run(); }

  attach(credentialId: string, deviceId: string, info: AgentInfo): { id: string } {
    const now = this.now();
    const v = [clip(info.version, 40), clip(info.os, 40), clip(info.hostname, 255), clip(info.user, 100)];
    const row = this.db.prepare("SELECT id FROM agents WHERE credential_id = ?").get(credentialId) as { id: string } | undefined;
    if (row) {
      this.db.prepare("UPDATE agents SET version = ?, os = ?, hostname = ?, username = ?, connected = 1, last_seen_at = ?, last_seq = 0 WHERE id = ?").run(...v, now, row.id);
      return row;
    }
    const id = ulid();
    this.db.prepare(`INSERT INTO agents(id, device_id, credential_id, version, os, hostname, username, connected, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, deviceId, credentialId, ...v, now);
    return { id };
  }

  detach(agentId: string): void { this.db.prepare("UPDATE agents SET connected = 0 WHERE id = ?").run(agentId); }

  touch(agentId: string): void {
    const now = this.now();
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, agentId);
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = (SELECT device_id FROM agents WHERE id = ?)").run(now, agentId);
  }

  /** Replace the agent's terminals. Out-of-order (older seq) messages are ignored. */
  apply(agentId: string, seq: number, terms: WireTerm[]): "applied" | "stale" {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const a = this.db.prepare("SELECT last_seq, device_id FROM agents WHERE id = ?").get(agentId) as { last_seq: number; device_id: string } | undefined;
      if (!a) throw new Error("unknown agent");
      if (seq <= a.last_seq) return "stale" as const; // seqs restart per connection (attach resets last_seq)
      const first = new Map((this.db.prepare("SELECT native_id, first_seen_at FROM live_terms WHERE agent_id = ?").all(agentId) as { native_id: string; first_seen_at: number }[])
        .map((r) => [r.native_id, r.first_seen_at]));
      this.db.prepare("DELETE FROM live_terms WHERE agent_id = ?").run(agentId);
      const ins = this.db.prepare(`INSERT OR REPLACE INTO live_terms(id, agent_id, native_id, kind, session_name, shell, pid, username, cwd, tty,
        attached, windows, cmd, started_at, last_activity_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of terms) {
        const nid = clip(t.id, 300);
        // The hub re-redacts: never trust that a device ran the same filter version.
        const cmd = t.cmd ? redactCommand(clip(t.cmd, MAX_CMD * 2)) : "";
        ins.run(`${agentId}|${nid}`, agentId, nid, t.kind, clip(t.name, 200), clip(t.shell, 20), num(t.pid), clip(t.user, 100), clip(t.cwd, MAX_CWD), clip(t.tty, 100),
          num(t.attached) ?? 0, num(t.windows) ?? 0, cmd, num(t.startedAt), num(t.lastActivityAt), first.get(nid) ?? now, now);
      }
      this.db.prepare("UPDATE agents SET last_seq = ?, last_snapshot_at = ?, last_seen_at = ? WHERE id = ?").run(seq, now, now, agentId);
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, a.device_id);
      return "applied" as const;
    });
    return tx();
  }

  /** Agents (with their terminals) grouped by device. */
  byDevice(): Map<string, LiveAgent[]> {
    const agents = this.db.prepare("SELECT * FROM agents ORDER BY hostname, id").all() as AgentRow[];
    const rows = this.db.prepare("SELECT * FROM live_terms ORDER BY kind DESC, session_name, cwd").all() as TermRow[];
    const termsBy = new Map<string, LiveTerm[]>();
    for (const r of rows) {
      const l = termsBy.get(r.agent_id) ?? [];
      l.push({
        id: r.id, nativeId: r.native_id, kind: r.kind, name: r.session_name, shell: r.shell, pid: r.pid, user: r.username, cwd: r.cwd, tty: r.tty,
        attached: r.attached, windows: r.windows, startedAt: r.started_at, lastActivityAt: r.last_activity_at, firstSeenAt: r.first_seen_at, cmd: r.cmd,
      });
      termsBy.set(r.agent_id, l);
    }
    const out = new Map<string, LiveAgent[]>();
    for (const a of agents) {
      const l = out.get(a.device_id) ?? [];
      l.push({ id: a.id, version: a.version, os: a.os, hostname: a.hostname, user: a.username, connected: !!a.connected,
        lastSeenAt: a.last_seen_at, lastSnapshotAt: a.last_snapshot_at, terms: termsBy.get(a.id) ?? [] });
      out.set(a.device_id, l);
    }
    return out;
  }

  search(q: string, limit = 50): { id: string; agentId: string; kind: string; name: string; cwd: string; cmd: string }[] {
    const words = q.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
    if (!words.length) return [];
    const match = words.map((t) => `"${t}"*`).join(" AND ");
    return this.db.prepare(`SELECT t.id, t.agent_id AS agentId, t.kind, t.session_name AS name, t.cwd, t.cmd FROM live_terms_fts f JOIN live_terms t ON t.id = f.id
      WHERE live_terms_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as { id: string; agentId: string; kind: string; name: string; cwd: string; cmd: string }[];
  }
}
