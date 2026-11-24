import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupDb, MIGRATIONS_DIR, type DB } from "./db.ts";

/**
 * M5: scheduled backups. Every `everyHours` the hub writes an online SQLite backup to
 * `dir/lbsv-<ISO stamp>.db` and keeps the newest `keep` of those. Files with other names in the
 * directory (manual `lbsv backup --out`, pre-restore safety copies) are never pruned.
 */
export interface BackupInfo { file: string; name: string; size: number; at: number }
const AUTO = /^lbsv-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;
export const stampName = (t: number, prefix = "lbsv") => `${prefix}-${new Date(t).toISOString().replace(/[:.]/g, "-")}.db`;

export class Backups {
  private db: DB;
  readonly dir: string;
  readonly keep: number;
  readonly everyHours: number;
  private now: () => number;
  private log: (s: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupInfo> | null = null;
  lastError: string | null = null;

  constructor(db: DB, o: { dir: string; keep?: number; everyHours?: number; now?: () => number; log?: (s: string) => void }) {
    this.db = db; this.dir = o.dir;
    this.keep = Math.max(1, o.keep ?? 14);
    this.everyHours = Math.max(0, o.everyHours ?? 24);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  /** The automatic backups, newest first. */
  list(): BackupInfo[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter((n) => AUTO.test(n)); } catch { return []; }
    return names.map((name) => { const file = join(this.dir, name); const s = statSync(file); return { file, name, size: s.size, at: s.mtimeMs }; })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Back up now (concurrent calls share one run), then prune. */
  run(): Promise<BackupInfo> {
    if (this.running) return this.running;
    const go = async () => {
      const t = this.now();
      const file = join(this.dir, stampName(t));
      try {
        await backupDb(this.db, file);
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.log(`backup failed: ${this.lastError}`);
        throw e;
      }
      this.prune();
      this.log(`backup written: ${file}`);
      return { file, name: file.slice(this.dir.length + 1), size: statSync(file).size, at: t };
    };
    this.running = go().finally(() => { this.running = null; });
    return this.running;
  }

  prune(): string[] {
    const gone = this.list().slice(this.keep).map((b) => b.file);
    for (const f of gone) for (const sfx of ["", "-wal", "-shm"]) rmSync(f + sfx, { force: true });
    return gone;
  }

  /** Due when there is no automatic backup younger than everyHours. */
  due(): boolean {
    if (!this.everyHours) return false;
    const last = this.list()[0];
    return !last || this.now() - last.at >= this.everyHours * 3600_000;
  }

  /** Check hourly (and once shortly after start) whether a backup is due. */
  start(checkMs = 3600_000, firstMs = 60_000): void {
    if (!this.everyHours || this.timer) return;
    const tick = () => { if (this.due()) this.run().catch(() => {}); };
    const first = setTimeout(() => { tick(); this.timer = setInterval(tick, checkMs); this.timer.unref(); }, firstMs);
    first.unref();
    this.timer = first;
  }
  stop(): void { if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; } }

  status() {
    const all = this.list();
    return { dir: this.dir, keep: this.keep, everyHours: this.everyHours, count: all.length, last: all[0] ?? null, lastError: this.lastError };
  }
}

/* ---------- running-hub lock, so `lbsv restore` can't swap the file under a live hub ---------- */
export const lockFile = (dbFile: string) => dbFile + ".hub.pid";
export function holdLock(dbFile: string): () => void {
  const f = lockFile(dbFile);
  writeFileSync(f, String(process.pid));
  return () => { try { if (readFileSync(f, "utf8").trim() === String(process.pid)) rmSync(f, { force: true }); } catch { /* gone */ } };
}
/** The pid of a hub that is still using dbFile, or null. (In a fresh container our own pid can equal the stale one: ignore it.) */
export function hubRunning(dbFile: string): number | null {
  let pid: number;
  try { pid = Number(readFileSync(lockFile(dbFile), "utf8").trim()); } catch { return null; }
  if (!pid || pid === process.pid) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" ? pid : null; }
}

/** Check that `file` is an lbsv database this version can open. Returns its schema version. */
export function checkBackup(file: string, migrationsDir = MIGRATIONS_DIR): number {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  let src: Database.Database;
  try { src = new Database(file, { readonly: true, fileMustExist: true }); } catch (e) { throw new Error(`Not a SQLite database: ${(e as Error).message}`); }
  try {
    const ok = (src.pragma("integrity_check", { simple: true }) as string);
    if (ok !== "ok") throw new Error(`Integrity check failed: ${ok}`);
    const has = (t: string) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has("schema_migrations") || !has("projects")) throw new Error("That SQLite file isn't an lbsv database (no projects / schema_migrations tables).");
    const v = (src.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number | null }).v ?? 0;
    const known = Math.max(0, ...readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).map((f) => parseInt(f, 10)));
    if (v > known) throw new Error(`That backup is from a newer lbsv (schema ${v}, this one knows up to ${known}). Upgrade lbsv first.`);
    return v;
  } catch (e) {
    if (/SQLITE_NOTADB|file is not a database/i.test((e as Error).message)) throw new Error("Not an lbsv database (not SQLite).");
    throw e;
  } finally { src.close(); }
}

/**
 * Replace dbFile with a backup. The hub must be stopped. The current database is first saved as
 * `pre-restore-<stamp>.db` in backupDir (not pruned), so a restore can itself be undone.
 */
export async function restoreDb(o: { dbFile: string; from: string; backupDir: string; now?: number; force?: boolean }): Promise<{ safety: string | null; schema: number }> {
  const pid = hubRunning(o.dbFile);
  if (pid && !o.force) throw new Error(`The hub is still running (pid ${pid}). Stop it first (docker compose stop hub, systemctl stop lbsv, or Ctrl+C), then run restore again.`);
  const schema = checkBackup(o.from);
  let safety: string | null = null;
  if (existsSync(o.dbFile)) {
    safety = join(o.backupDir, stampName(o.now ?? Date.now(), "pre-restore"));
    mkdirSync(o.backupDir, { recursive: true });
    const cur = new Database(o.dbFile);
    try { await cur.backup(safety); } finally { cur.close(); }
  }
  for (const sfx of ["-wal", "-shm"]) rmSync(o.dbFile + sfx, { force: true });
  mkdirSync(join(o.dbFile, ".."), { recursive: true });
  copyFileSync(o.from, o.dbFile);
  return { safety, schema };
}
