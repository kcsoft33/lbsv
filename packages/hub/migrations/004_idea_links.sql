-- 004: URLs attached to ideas (M2b). URL-based on purpose: an attachment survives the tab being
-- closed and the browser restarting; "is it open right now?" is answered by matching live tabs.

CREATE TABLE idea_links (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  where_hint  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  position    REAL NOT NULL DEFAULT 0,
  UNIQUE (idea_id, url)
);
CREATE INDEX idea_links_idea ON idea_links(idea_id, position);

CREATE VIRTUAL TABLE idea_links_fts USING fts5(id UNINDEXED, title, url, tokenize = 'unicode61');
CREATE TRIGGER idea_links_fts_ai AFTER INSERT ON idea_links BEGIN
  INSERT INTO idea_links_fts(id, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TRIGGER idea_links_fts_ad AFTER DELETE ON idea_links BEGIN
  DELETE FROM idea_links_fts WHERE id = old.id;
END;
CREATE TRIGGER idea_links_fts_au AFTER UPDATE OF title, url ON idea_links BEGIN
  DELETE FROM idea_links_fts WHERE id = old.id;
  INSERT INTO idea_links_fts(id, title, url) VALUES (new.id, new.title, new.url);
END;
