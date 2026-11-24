import { randomBytes, randomInt } from "node:crypto";
import type { DB } from "./db.ts";
import { hashToken } from "./auth.ts";
import { ulid } from "../../shared/src/ulid.ts";
import { normalizeDenyEntry } from "../../shared/src/live.ts";
import { NotFound } from "./repo.ts";

/**
 * Devices and their collector credentials (SPEC §6.1).
 * Devices page → "Add device" → one-time code (10 min) → the collector exchanges it for a
 * long-lived token. Only sha256(code) and sha256(token) are stored.
 */
export const ENROLL_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
const GLOBAL_DENY_KEY = "live.deny";
const TOKEN_PREFIX = "lbsv_";
/** "sbd_" tokens were issued before the rename to lbsv; they stay valid. */
const TOKEN_PREFIXES = [TOKEN_PREFIX, "sbd_"];

export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function newCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function cleanDeny(list: readonly string[]): string[] {
  return [...new Set(list.map(normalizeDenyEntry).filter(Boolean))].sort();
}

export interface DeviceRow { id: string; name: string; created_at: number; last_seen_at: number | null; deny_domains: string; ssh_target: string; ssh_jump: string }
export interface Authenticated { credentialId: string; kind: "ext" | "agent"; device: { id: string; name: string } }

export class Devices {
  private db: DB;
  private now: () => number;
  constructor(db: DB, now: () => number = Date.now) { this.db = db; this.now = now; }

  list(): DeviceRow[] {
    return this.db.prepare("SELECT * FROM devices ORDER BY name COLLATE NOCASE, created_at").all() as DeviceRow[];
  }

  get(id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  }

  create(name: string): { device: DeviceRow; code: string; expiresAt: number } {
    const id = ulid();
    this.db.prepare("INSERT INTO devices(id, name, created_at) VALUES (?, ?, ?)").run(id, name.trim(), this.now());
    return { device: this.get(id)!, ...this.issueCode(id) };
  }

  /** A fresh pairing code for an existing device (e.g. its second browser). Replaces any unused one. */
  issueCode(deviceId: string): { code: string; expiresAt: number } {
    if (!this.get(deviceId)) throw new NotFound("device");
    const code = newCode();
    const now = this.now();
    const expiresAt = now + ENROLL_TTL_MS;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM enroll_codes WHERE device_id = ? OR expires_at <= ?").run(deviceId, now);
      this.db.prepare("INSERT INTO enroll_codes(code_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(hashToken(normalizeCode(code)), deviceId, now, expiresAt);
    })();
    return { code, expiresAt };
  }

  pendingCode(deviceId: string): { expiresAt: number } | null {
    const r = this.db.prepare("SELECT expires_at FROM enroll_codes WHERE device_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
      .get(deviceId, this.now()) as { expires_at: number } | undefined;
    return r ? { expiresAt: r.expires_at } : null;
  }

  cancelCode(deviceId: string): void {
    this.db.prepare("DELETE FROM enroll_codes WHERE device_id = ?").run(deviceId);
  }

  /** Redeem a pairing code. One-time: the code is deleted whether or not it had expired. */
  enroll(code: string, kind: "ext" | "agent", label = ""): { token: string; credentialId: string; device: { id: string; name: string } } | null {
    const h = hashToken(normalizeCode(code));
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT device_id, expires_at FROM enroll_codes WHERE code_hash = ?").get(h) as
        | { device_id: string; expires_at: number } | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM enroll_codes WHERE code_hash = ?").run(h);
      if (row.expires_at <= this.now()) return null;
      const dev = this.get(row.device_id);
      if (!dev) return null;
      const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const credentialId = ulid();
      this.db.prepare("INSERT INTO credentials(id, device_id, kind, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(credentialId, dev.id, kind, label.slice(0, 200), hashToken(token), this.now());
      return { token, credentialId, device: { id: dev.id, name: dev.name } };
    })();
  }

  authenticate(token: string | undefined): Authenticated | null {
    if (!token || !TOKEN_PREFIXES.some((p) => token.startsWith(p))) return null;
    const r = this.db.prepare(`SELECT c.id, c.kind, d.id AS device_id, d.name FROM credentials c JOIN devices d ON d.id = c.device_id WHERE c.token_hash = ?`)
      .get(hashToken(token)) as { id: string; kind: "ext" | "agent"; device_id: string; name: string } | undefined;
    if (!r) return null;
    const now = this.now();
    this.db.prepare("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(now, r.id);
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, r.device_id);
    return { credentialId: r.id, kind: r.kind, device: { id: r.device_id, name: r.name } };
  }

  update(id: string, patch: { name?: string; deny?: string[]; sshTarget?: string; sshJump?: string }): DeviceRow {
    if (!this.get(id)) throw new NotFound("device");
    if (patch.name !== undefined) this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(patch.name.trim(), id);
    if (patch.deny !== undefined) this.db.prepare("UPDATE devices SET deny_domains = ? WHERE id = ?").run(JSON.stringify(cleanDeny(patch.deny)), id);
    if (patch.sshTarget !== undefined) this.db.prepare("UPDATE devices SET ssh_target = ? WHERE id = ?").run(patch.sshTarget.trim(), id);
    if (patch.sshJump !== undefined) this.db.prepare("UPDATE devices SET ssh_jump = ? WHERE id = ?").run(patch.sshJump.trim(), id);
    return this.get(id)!;
  }

  /** Revoke every token on the device and drop its live data; the device can be paired again. */
  revoke(id: string): void {
    if (!this.get(id)) throw new NotFound("device");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM credentials WHERE device_id = ?").run(id); // cascades to browsers → live rows
      this.db.prepare("DELETE FROM enroll_codes WHERE device_id = ?").run(id);
    })();
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
  }

  credentialIds(deviceId: string): string[] {
    return (this.db.prepare("SELECT id FROM credentials WHERE device_id = ?").all(deviceId) as { id: string }[]).map((r) => r.id);
  }

  deviceDeny(id: string): string[] {
    const r = this.db.prepare("SELECT deny_domains FROM devices WHERE id = ?").get(id) as { deny_domains: string } | undefined;
    try { return r ? JSON.parse(r.deny_domains) : []; } catch { return []; }
  }

  globalDeny(): string[] {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(GLOBAL_DENY_KEY) as { value: string } | undefined;
    try { return r ? JSON.parse(r.value) : []; } catch { return []; }
  }

  setGlobalDeny(list: string[]): string[] {
    const clean = cleanDeny(list);
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(GLOBAL_DENY_KEY, JSON.stringify(clean));
    return clean;
  }

  /** Global + per-device deny list, as sent to collectors. */
  effectiveDeny(deviceId: string): string[] {
    return cleanDeny([...this.globalDeny(), ...this.deviceDeny(deviceId)]);
  }
}
