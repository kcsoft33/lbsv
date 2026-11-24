import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";

/**
 * Single-user admin auth for the web UI: one passphrase, exchanged for an opaque session token
 * set as an httpOnly cookie. Only scrypt(passphrase) and sha256(token) are stored.
 * (Per-device tokens for agents/extensions arrive in M1 and reuse hashToken.)
 */
export const SESSION_COOKIE = "lbsv_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT_N = 16384;
const PASS_KEY = "admin_passphrase";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function hashPassphrase(pass: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pass.normalize("NFKC"), salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassphrase(pass: string, stored: string): boolean {
  const [alg, n, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = scryptSync(pass.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, { N: Number(n) });
  return timingSafeEqual(expected, got);
}

export class Auth {
  private db: DB;
  private now: () => number;
  constructor(db: DB, now: () => number = Date.now) { this.db = db; this.now = now; }

  isConfigured(): boolean {
    return !!this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(PASS_KEY);
  }

  /** Set (or change) the passphrase. Changing it signs out every existing session. */
  setPassphrase(pass: string): void {
    if (pass.length < 8) throw new Error("Passphrase must be at least 8 characters.");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(PASS_KEY, hashPassphrase(pass));
      this.db.prepare("DELETE FROM auth_sessions").run();
    })();
  }

  /** Apply LBSV_ADMIN_PASSPHRASE: the env var is the source of truth when present. */
  syncFromEnv(pass: string | undefined): void {
    if (!pass) return;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(PASS_KEY) as { value: string } | undefined;
    if (!row || !verifyPassphrase(pass, row.value)) this.setPassphrase(pass);
  }

  /**
   * First-run setup (M5): while no passphrase is set, the hub holds a one-time setup code in memory
   * (new on every start, printed to its log) and whoever presents it may set the passphrase. So a
   * fresh hub reachable on the LAN can't be claimed by the first visitor, and nobody has to edit .env.
   */
  private setup: string | null = null;
  setupCode(): string | null {
    if (this.isConfigured()) { this.setup = null; return null; }
    if (!this.setup) {
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
      const s = Array.from(randomBytes(12), (x) => A[x % A.length]).join("");
      this.setup = `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
    }
    return this.setup;
  }
  checkSetupCode(code: string): boolean {
    const want = this.setupCode();
    if (!want) return false;
    const norm = (s: string) => createHash("sha256").update(s.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest();
    return timingSafeEqual(norm(code), norm(want));
  }

  checkPassphrase(pass: string): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(PASS_KEY) as { value: string } | undefined;
    return !!row && verifyPassphrase(pass, row.value);
  }

  createSession(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare("INSERT INTO auth_sessions(token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), now, expiresAt, now);
    return { token, expiresAt };
  }

  /** True when the token maps to an unexpired session. Slides last_used_at (at most once a minute). */
  validateSession(token: string | undefined): boolean {
    if (!token) return false;
    const h = hashToken(token);
    const row = this.db.prepare("SELECT expires_at, last_used_at FROM auth_sessions WHERE token_hash = ?").get(h) as
      | { expires_at: number; last_used_at: number } | undefined;
    const now = this.now();
    if (!row) return false;
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(h);
      return false;
    }
    if (now - row.last_used_at > 60_000) this.db.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?").run(now, h);
    return true;
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  pruneExpired(): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(this.now());
  }
}

/** Simple in-memory brute-force brake for the login endpoint, keyed by client IP. */
export class LoginThrottle {
  private m = new Map<string, { fails: number; until: number }>();
  private now: () => number;
  private free: number;
  constructor(now: () => number = Date.now, free = 5) { this.now = now; this.free = free; }
  retryAfterMs(ip: string): number {
    const e = this.m.get(ip);
    return e ? Math.max(0, e.until - this.now()) : 0;
  }
  fail(ip: string): void {
    const e = this.m.get(ip) ?? { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= this.free) e.until = this.now() + Math.min(1000 * 2 ** (e.fails - this.free), 5 * 60_000);
    this.m.set(ip, e);
  }
  ok(ip: string): void {
    this.m.delete(ip);
  }
}
