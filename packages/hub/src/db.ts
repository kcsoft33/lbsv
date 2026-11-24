import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Open (or create) the database with the pragmas LabSave relies on, then migrate. */
export function openDb(file: string, opts: { migrationsDir?: string } = {}): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, opts.migrationsDir ?? MIGRATIONS_DIR);
  return db;
}

/**
 * Plain-SQL migrations: files named NNN_description.sql, applied in order, each in its own
 * transaction, recorded in schema_migrations. Already-applied versions are skipped.
 */
export function migrate(db: DB, dir: string = MIGRATIONS_DIR): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({ version: parseInt(f, 10), name: f }))
    .sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const f of files) {
    if (seen.has(f.version)) throw new Error(`Duplicate migration version ${f.version} (${f.name})`);
    seen.add(f.version);
  }
  const ran: number[] = [];
  for (const f of files) {
    if (applied.has(f.version)) continue;
    const sql = readFileSync(join(dir, f.name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(f.version, f.name, Date.now());
    })();
    ran.push(f.version);
  }
  return ran;
}

/** Online backup to `dest` (safe while the hub is running). */
export async function backupDb(db: DB, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  await db.backup(dest);
  // A single self-contained file: in WAL mode, merely opening a backup (restore checks it) leaves -wal/-shm beside it.
  const b = new Database(dest);
  try { b.pragma("journal_mode = DELETE"); } finally { b.close(); }
}
