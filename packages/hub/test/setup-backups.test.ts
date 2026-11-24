import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { Backups, checkBackup, holdLock, hubRunning, restoreDb, stampName } from "../src/backups.ts";
import { Repo } from "../src/repo.ts";

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lbsv-m5-")); tmps.push(d); return d; };

describe("first-run setup code", () => {
  it("a fresh hub can only be claimed with the code, once, and then signs you in", async () => {
    const dir = tmp();
    const file = join(dir, "setup-code.txt");
    const db = openDb(":memory:");
    const { app, auth } = await buildApp({ db, setupCodeFile: file });
    const code = auth.setupCode()!;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(readFileSync(file, "utf8").trim()).toBe(code);
    expect((await app.inject("/api/auth")).json()).toEqual({ configured: false, authenticated: false });
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "whatever-pass" } })).statusCode).toBe(503);

    const bad = await app.inject({ method: "POST", url: "/api/setup", payload: { code: "AAAA-AAAA-AAAA", passphrase: "long enough pass" } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { code, passphrase: "short" } })).statusCode).toBe(400);

    // case and separators don't matter
    const ok = await app.inject({ method: "POST", url: "/api/setup", payload: { code: code.toLowerCase().replace(/-/g, " "), passphrase: "long enough pass" } });
    expect(ok.statusCode).toBe(200);
    const c = ok.cookies.find((x) => x.name === "lbsv_session")!;
    expect((await app.inject({ url: "/api/state", headers: { cookie: `lbsv_session=${c.value}` } })).statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(auth.setupCode()).toBeNull();

    // the code is spent: no second claim, even with the right code
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { code, passphrase: "attacker pass 1" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "long enough pass" } })).statusCode).toBe(200);
  });

  it("is throttled like login", async () => {
    const { app } = await buildApp({ db: openDb(":memory:") });
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await app.inject({ method: "POST", url: "/api/setup", payload: { code: "WRONG-CODE-XX", passphrase: "long enough pass" } })).statusCode;
    expect(last).toBe(429);
  });

  it("isn't offered when a passphrase exists (env or earlier setup)", async () => {
    const dir = tmp();
    const file = join(dir, "setup-code.txt");
    writeFileSync(file, "STALE\n");
    const { app, auth } = await buildApp({ db: openDb(":memory:"), adminPassphrase: "env passphrase", setupCodeFile: file });
    expect(auth.setupCode()).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { code: "STALE", passphrase: "long enough pass" } })).statusCode).toBe(409);
  });
});

describe("scheduled backups", () => {
  it("writes timestamped backups, prunes to `keep`, never touches other files", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "lbsv.db"));
    new Repo(db).createProject({ name: "Kept project" } as never);
    let t = Date.UTC(2026, 10, 1);
    const b = new Backups(db, { dir: join(dir, "backups"), keep: 3, everyHours: 24, now: () => t });
    expect(b.due()).toBe(true);
    writeFileSync(join(dir, "backups-manual.db"), "x");
    for (let i = 0; i < 5; i++) { await b.run(); t += 3600_000; }
    const names = readdirSync(join(dir, "backups"));
    expect(names).toHaveLength(3);
    expect(b.list()[0]!.name).toBe(stampName(Date.UTC(2026, 10, 1) + 4 * 3600_000));
    writeFileSync(join(dir, "backups", "pre-restore-2026-01-01T00-00-00-000Z.db"), "keep me");
    await b.run();
    expect(existsSync(join(dir, "backups", "pre-restore-2026-01-01T00-00-00-000Z.db"))).toBe(true);
    expect(checkBackup(b.list()[0]!.file)).toBeGreaterThanOrEqual(6);
    // backups are single files: checking one doesn't leave -wal/-shm behind
    expect(readdirSync(join(dir, "backups")).filter((n) => /-(wal|shm)$/.test(n))).toEqual([]);
    db.close();
  });

  it("is due when the newest backup is older than everyHours; 0 = off", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "lbsv.db"));
    let t = Date.now();
    const b = new Backups(db, { dir, everyHours: 24, now: () => t });
    const r = await b.run();
    expect(b.due()).toBe(false);
    const old = (t - 25 * 3600_000) / 1000;
    utimesSync(r.file, old, old);
    expect(b.due()).toBe(true);
    expect(new Backups(db, { dir, everyHours: 0 }).due()).toBe(false);
    db.close();
  });

  it("API: status and back up now", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "lbsv.db"));
    const { app } = await buildApp({ db, adminPassphrase: "correct horse battery", backups: { dir: join(dir, "b"), keep: 2, everyHours: 24 } });
    const lr = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "correct horse battery" } });
    const cookie = `lbsv_session=${lr.cookies.find((c) => c.name === "lbsv_session")!.value}`;
    expect((await app.inject({ url: "/api/backups" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/backups", headers: { cookie } })).json()).toMatchObject({ configured: true, count: 0, keep: 2, last: null });
    const r = (await app.inject({ method: "POST", url: "/api/backups", headers: { cookie } })).json();
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(existsSync(r.backup.file)).toBe(true);
    await app.close(); db.close();
  });
});

describe("restore", () => {
  it("validates, keeps a pre-restore copy, swaps the file, refuses while a hub holds the lock", async () => {
    const dir = tmp();
    const dbFile = join(dir, "lbsv.db");
    let db = openDb(dbFile);
    const repo = new Repo(db);
    repo.createProject({ name: "Before" } as never);
    const b = new Backups(db, { dir: join(dir, "backups") });
    const snap = (await b.run()).file;
    repo.createProject({ name: "After the backup" } as never);

    const release = holdLock(dbFile);
    // a different live pid holds the lock: pretend by writing our parent's pid
    writeFileSync(dbFile + ".hub.pid", String(process.ppid));
    expect(hubRunning(dbFile)).toBe(process.ppid);
    await expect(restoreDb({ dbFile, from: snap, backupDir: join(dir, "backups") })).rejects.toThrow(/still running/);
    writeFileSync(dbFile + ".hub.pid", String(process.pid)); release();
    db.close();

    const r = await restoreDb({ dbFile, from: snap, backupDir: join(dir, "backups") });
    expect(r.safety && existsSync(r.safety)).toBe(true);
    db = openDb(dbFile);
    const names = new Repo(db).state().projects.map((p) => p.name);
    expect(names).toContain("Before");
    expect(names).not.toContain("After the backup");
    db.close();
    const undo = openDb(r.safety!);
    expect(new Repo(undo).state().projects.map((p) => p.name)).toContain("After the backup");
    undo.close();
  });

  it("rejects files that aren't lbsv databases", () => {
    const dir = tmp();
    writeFileSync(join(dir, "junk.db"), "not sqlite at all, definitely not");
    expect(() => checkBackup(join(dir, "junk.db"))).toThrow(/Not an lbsv database|Not a SQLite/);
    expect(() => checkBackup(join(dir, "missing.db"))).toThrow(/No such file/);
    const other = openDb(join(dir, "other.db"), { migrationsDir: mkdtempSync(join(dir, "m-")) });
    other.close();
    expect(() => checkBackup(join(dir, "other.db"))).toThrow(/isn't an lbsv database/);
  });
});
