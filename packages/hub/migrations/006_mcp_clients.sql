-- 006: MCP clients (M4). One bearer token per assistant install (Claude Code on a laptop,
-- Claude Desktop on the hub box, ...). Only sha256(token) is stored. Separate from device
-- credentials on purpose: a collector token can never read or change saved data through MCP.
CREATE TABLE mcp_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
