-- 002: devices, per-device credentials, enrollment codes, live browser windows and tabs (M1).

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  -- JSON array of domains; matching tabs are counted but never stored (SPEC §7).
  deny_domains  TEXT NOT NULL DEFAULT '[]'
);

-- One-time pairing codes (only the sha256 is stored). Short-lived: 10 minutes.
CREATE TABLE enroll_codes (
  code_hash   TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX enroll_codes_device ON enroll_codes(device_id);

-- A long-lived token held by one collector (an extension install, or an sb-agent in M3).
CREATE TABLE credentials (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('ext','agent')),
  label         TEXT NOT NULL DEFAULT '',
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX credentials_device ON credentials(device_id);

-- One row per extension install (= browser + profile on a device).
CREATE TABLE browsers (
  id                TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_id     TEXT NOT NULL UNIQUE REFERENCES credentials(id) ON DELETE CASCADE,
  family            TEXT NOT NULL,
  profile           TEXT NOT NULL DEFAULT '',
  ext_version       TEXT NOT NULL DEFAULT '',
  connected         INTEGER NOT NULL DEFAULT 0,
  last_seen_at      INTEGER,
  last_snapshot_at  INTEGER,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  denied_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX browsers_device ON browsers(device_id);

CREATE TABLE live_windows (
  browser_id  TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  native_id   TEXT NOT NULL,
  focused     INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'normal',
  PRIMARY KEY (browser_id, native_id)
) WITHOUT ROWID;

CREATE TABLE live_tabs (
  id             TEXT PRIMARY KEY,            -- browser_id || ':' || native_id
  browser_id     TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  native_id      TEXT NOT NULL,
  window_id      TEXT NOT NULL,
  idx            INTEGER NOT NULL DEFAULT 0,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  audible        INTEGER NOT NULL DEFAULT 0,
  discarded      INTEGER NOT NULL DEFAULT 0,
  last_accessed  INTEGER,
  first_seen_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX live_tabs_browser ON live_tabs(browser_id, window_id, idx);

-- Browsers don't report when a tab was opened, and native tab ids change across browser restarts.
-- Remember when we first saw each URL per browser so "open N days" survives restarts.
CREATE TABLE tab_first_seen (
  browser_id     TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (browser_id, url)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE live_tabs_fts USING fts5(id UNINDEXED, title, url, tokenize = 'unicode61');
CREATE TRIGGER live_tabs_fts_ai AFTER INSERT ON live_tabs BEGIN
  INSERT INTO live_tabs_fts(id, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TRIGGER live_tabs_fts_ad AFTER DELETE ON live_tabs BEGIN
  DELETE FROM live_tabs_fts WHERE id = old.id;
END;
CREATE TRIGGER live_tabs_fts_au AFTER UPDATE OF title, url ON live_tabs BEGIN
  DELETE FROM live_tabs_fts WHERE id = old.id;
  INSERT INTO live_tabs_fts(id, title, url) VALUES (new.id, new.title, new.url);
END;
