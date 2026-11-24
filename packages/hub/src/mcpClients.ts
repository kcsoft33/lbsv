import { randomBytes } from "node:crypto";
import type { DB } from "./db.ts";
import { hashToken } from "./auth.ts";
import { ulid } from "../../shared/src/ulid.ts";

/** "lbsvm_": distinguishable from collector tokens ("lbsv_") at a glance and in logs. */
export const MCP_TOKEN_PREFIX = "lbsvm_";

export interface McpClient { id: string; name: string; createdAt: number; lastUsedAt: number | null }

/** Bearer tokens for MCP clients (SPEC §9 "a token per client"). */
export class McpClients {
  private db: DB;
  private now: () => number;
  constructor(db: DB, now: () => number = Date.now) { this.db = db; this.now = now; }

  list(): McpClient[] {
    return this.db.prepare("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM mcp_clients ORDER BY created_at").all() as McpClient[];
  }

  /** The token is returned once and never stored. */
  create(name: string): { client: McpClient; token: string } {
    const id = ulid();
    const token = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO mcp_clients(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(id, name.trim().slice(0, 200), hashToken(token), this.now());
    return { client: this.list().find((c) => c.id === id)!, token };
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM mcp_clients WHERE id = ?").run(id).changes > 0;
  }

  /** From an `Authorization: Bearer …` header value (or a bare token). */
  authenticate(header: string | undefined): McpClient | null {
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
    const r = this.db.prepare("SELECT id, name, created_at AS createdAt FROM mcp_clients WHERE token_hash = ?").get(hashToken(token)) as Omit<McpClient, "lastUsedAt"> | undefined;
    if (!r) return null;
    const now = this.now();
    this.db.prepare("UPDATE mcp_clients SET last_used_at = ? WHERE id = ?").run(now, r.id);
    return { ...r, lastUsedAt: now };
  }
}
