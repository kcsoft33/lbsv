-- 005: lbsv-agent connections, live terminals (M3), project rules, per-device SSH reconnect settings.

-- How to reach a device from elsewhere, for generated reconnect commands (SPEC §6.4).
-- ssh_target: user@host or an ~/.ssh/config alias (empty = the agent's hostname); ssh_jump: for `ssh -J`.
ALTER TABLE devices ADD COLUMN ssh_target TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN ssh_jump   TEXT NOT NULL DEFAULT '';

-- One row per agent install (one credential of kind 'agent').
CREATE TABLE agents (
  id                TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_id     TEXT NOT NULL UNIQUE REFERENCES credentials(id) ON DELETE CASCADE,
  version           TEXT NOT NULL DEFAULT '',
  os                TEXT NOT NULL DEFAULT '',
  hostname          TEXT NOT NULL DEFAULT '',
  username          TEXT NOT NULL DEFAULT '',
  connected         INTEGER NOT NULL DEFAULT 0,
  last_seen_at      INTEGER,
  last_snapshot_at  INTEGER,
  last_seq          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agents_device ON agents(device_id);

-- Owned by the agent: every terms message replaces the agent's rows in one transaction.
-- Never holds terminal output. cmd is only filled when the device opted in (LBSV_RECORD_CMDS=1).
CREATE TABLE live_terms (
  id                TEXT PRIMARY KEY,            -- agent_id || '|' || native_id
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  native_id         TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('shell','tmux','screen')),
  session_name      TEXT NOT NULL DEFAULT '',
  shell             TEXT NOT NULL DEFAULT '',
  pid               INTEGER,
  username          TEXT NOT NULL DEFAULT '',
  cwd               TEXT NOT NULL DEFAULT '',
  tty               TEXT NOT NULL DEFAULT '',
  attached          INTEGER NOT NULL DEFAULT 0,
  windows           INTEGER NOT NULL DEFAULT 0,
  cmd               TEXT NOT NULL DEFAULT '',
  started_at        INTEGER,
  last_activity_at  INTEGER,
  first_seen_at     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX live_terms_agent ON live_terms(agent_id);

CREATE VIRTUAL TABLE live_terms_fts USING fts5(id UNINDEXED, session_name, cwd, cmd, tokenize = 'unicode61');
CREATE TRIGGER live_terms_fts_ai AFTER INSERT ON live_terms BEGIN
  INSERT INTO live_terms_fts(id, session_name, cwd, cmd) VALUES (new.id, new.session_name, new.cwd, new.cmd);
END;
CREATE TRIGGER live_terms_fts_ad AFTER DELETE ON live_terms BEGIN
  DELETE FROM live_terms_fts WHERE id = old.id;
END;
CREATE TRIGGER live_terms_fts_au AFTER UPDATE OF session_name, cwd, cmd ON live_terms BEGIN
  DELETE FROM live_terms_fts WHERE id = old.id;
  INSERT INTO live_terms_fts(id, session_name, cwd, cmd) VALUES (new.id, new.session_name, new.cwd, new.cmd);
END;

-- Project rules: "tabs on this site / terminals under this folder belong to project X".
CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('url_prefix','domain','host','cwd_prefix','title_regex')),
  pattern     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, kind, pattern)
);
CREATE INDEX rules_project ON rules(project_id);
