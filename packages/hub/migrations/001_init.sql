-- 001: core saved data (prototype parity), FTS, auth, settings, events.
-- Ids are ULID text. Timestamps are integer ms since epoch.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','parked','done')),
  left_off    TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL,
  where_hint  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  position    REAL NOT NULL DEFAULT 0
);
CREATE INDEX links_project ON links(project_id, position);

-- Saved / manual terminal, machine and VM entries.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'SSH',
  label       TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',
  network     TEXT NOT NULL DEFAULT '',
  cmd         TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  position    REAL NOT NULL DEFAULT 0
);
CREATE INDEX sessions_project ON sessions(project_id, position);

-- project_id NULL = inbox.
CREATE TABLE ideas (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ideas_project ON ideas(project_id, created_at);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  device_id   TEXT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_at ON events(at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

-- Web UI login sessions (admin passphrase -> httpOnly cookie). Only token hashes are stored.
CREATE TABLE auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Full-text search. These FTS tables keep their own copy of the text, keyed by an UNINDEXED id,
-- rather than using external content (content=…), because the base tables have TEXT primary keys
-- and VACUUM may renumber their implicit rowids.
CREATE VIRTUAL TABLE projects_fts USING fts5(id UNINDEXED, name, left_off, tags, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE links_fts    USING fts5(id UNINDEXED, label, url, where_hint, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE sessions_fts USING fts5(id UNINDEXED, label, host, network, cmd, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE ideas_fts    USING fts5(id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');

CREATE TRIGGER projects_fts_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts(id, name, left_off, tags) VALUES (new.id, new.name, new.left_off, new.tags);
END;
CREATE TRIGGER projects_fts_ad AFTER DELETE ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
END;
CREATE TRIGGER projects_fts_au AFTER UPDATE OF name, left_off, tags ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
  INSERT INTO projects_fts(id, name, left_off, tags) VALUES (new.id, new.name, new.left_off, new.tags);
END;

CREATE TRIGGER links_fts_ai AFTER INSERT ON links BEGIN
  INSERT INTO links_fts(id, label, url, where_hint) VALUES (new.id, new.label, new.url, new.where_hint);
END;
CREATE TRIGGER links_fts_ad AFTER DELETE ON links BEGIN
  DELETE FROM links_fts WHERE id = old.id;
END;
CREATE TRIGGER links_fts_au AFTER UPDATE OF label, url, where_hint ON links BEGIN
  DELETE FROM links_fts WHERE id = old.id;
  INSERT INTO links_fts(id, label, url, where_hint) VALUES (new.id, new.label, new.url, new.where_hint);
END;

CREATE TRIGGER sessions_fts_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(id, label, host, network, cmd) VALUES (new.id, new.label, new.host, new.network, new.cmd);
END;
CREATE TRIGGER sessions_fts_ad AFTER DELETE ON sessions BEGIN
  DELETE FROM sessions_fts WHERE id = old.id;
END;
CREATE TRIGGER sessions_fts_au AFTER UPDATE OF label, host, network, cmd ON sessions BEGIN
  DELETE FROM sessions_fts WHERE id = old.id;
  INSERT INTO sessions_fts(id, label, host, network, cmd) VALUES (new.id, new.label, new.host, new.network, new.cmd);
END;

CREATE TRIGGER ideas_fts_ai AFTER INSERT ON ideas BEGIN
  INSERT INTO ideas_fts(id, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER ideas_fts_ad AFTER DELETE ON ideas BEGIN
  DELETE FROM ideas_fts WHERE id = old.id;
END;
CREATE TRIGGER ideas_fts_au AFTER UPDATE OF text ON ideas BEGIN
  DELETE FROM ideas_fts WHERE id = old.id;
  INSERT INTO ideas_fts(id, text) VALUES (new.id, new.text);
END;
