import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, cpSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS_DIR, migrate, openDb, backupDb } from "../src/db.ts";

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("migrations", () => {
  it("apply cleanly to an empty database and record versions", () => {
    const db = new Database(":memory:");
    const ran = migrate(db);
    expect(ran).toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b));
    const t = tables(db);
    for (const name of ["projects", "links", "sessions", "ideas", "events", "settings", "auth_sessions", "schema_migrations",
      "projects_fts", "links_fts", "sessions_fts", "ideas_fts",
      "devices", "enroll_codes", "credentials", "browsers", "live_windows", "live_tabs", "tab_first_seen", "live_tabs_fts", "favicons"]) expect(t).toContain(name);
  });

  it("are idempotent: a second run applies nothing", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });

  it("apply only new files, in numeric order", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbmig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const db = new Database(":memory:");
      migrate(db, dir);
      writeFileSync(join(dir, "910_later.sql"), "CREATE TABLE later(x);");
      writeFileSync(join(dir, "900_sooner.sql"), "CREATE TABLE sooner(x);");
      expect(migrate(db, dir)).toEqual([900, 910]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("roll back a failing migration entirely", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbmig-"));
    try {
      writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a(x);");
      writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE b(x); THIS IS NOT SQL;");
      const db = new Database(":memory:");
      expect(() => migrate(db, dir)).toThrow();
      expect(tables(db)).toContain("a");
      expect(tables(db)).not.toContain("b");
      expect((db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version)).toEqual([1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("enforce the status CHECK constraint and FK cascade", () => {
    const db = openDb(":memory:");
    expect(() => db.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES ('a','x','weird',1,1)").run()).toThrow();
    db.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p','x',1,1)").run();
    db.prepare("INSERT INTO links(id,project_id,url,created_at) VALUES ('l','p','https://a',1)").run();
    db.prepare("DELETE FROM projects WHERE id='p'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM links").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM links_fts").get()).toEqual({ c: 0 });
  });

  it("file database uses WAL and survives reopen; backup produces a usable copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbdb-"));
    try {
      const file = join(dir, "s.db");
      let db = openDb(file);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      db.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p','kept',1,1)").run();
      await backupDb(db, join(dir, "b", "copy.db"));
      db.close();
      db = openDb(file);
      expect(db.prepare("SELECT name FROM projects").get()).toEqual({ name: "kept" });
      db.close();
      const copy = openDb(join(dir, "b", "copy.db"));
      expect(copy.prepare("SELECT name FROM projects").get()).toEqual({ name: "kept" });
      copy.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
