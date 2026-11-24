-- 003: favicon cache (M2). The hub fetches icons itself and serves them from here; the UI never
-- hotlinks third-party URLs. One row per web origin seen in a live tab.

CREATE TABLE favicons (
  origin        TEXT PRIMARY KEY,   -- https://example.com:8443
  icon_url      TEXT,               -- hint reported by the browser (tab.favIconUrl), if any
  mime          TEXT,
  data          BLOB,
  fetched_at    INTEGER,
  failed_at     INTEGER,
  last_seen_at  INTEGER NOT NULL
);
