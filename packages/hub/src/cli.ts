import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { adoptLegacyData, legacyEnvUsed, loadConfig } from "./config.ts";
import { backupDb, openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { existsSync, readFileSync } from "node:fs";
import { Backups, holdLock, restoreDb } from "./backups.ts";

const USAGE = `lbsv <command>

Commands:
  serve                 Run the hub (default)
  backup [--out FILE]   Online SQLite backup to a timestamped file (default: $LBSV_BACKUP_DIR)
  backups               List the automatic backups, newest first
  restore FILE|latest   Replace the database with a backup (stop the hub first; the current one is kept as pre-restore-*.db)
  setup-code            Print the first-run setup code (only while no passphrase is set and the hub is running)
  set-passphrase        Set or change the admin passphrase (reads stdin; signs out all sessions)
  migrate               Apply pending migrations and exit

Environment: LBSV_DATA_DIR, LBSV_BACKUP_DIR, LBSV_HOST, LBSV_PORT, LBSV_ADMIN_PASSPHRASE, LBSV_UI_DIR,
             LBSV_COOKIE_SECURE (auto|1|0), LBSV_TRUST_PROXY, LBSV_LOG_LEVEL, LBSV_FAVICONS (1|0),
             LBSV_PUBLIC_URL, LBSV_BACKUP_EVERY_HOURS (24; 0 = off), LBSV_BACKUP_KEEP (14)`;

async function main(argv: string[]) {
  const [cmd = "serve", ...rest] = argv;
  const cfg = loadConfig();
  if (legacyEnvUsed.length) console.warn(`lbsv: ${legacyEnvUsed.join(", ")} still work but are deprecated; rename them to LBSV_*.`);
  if (cmd !== "help" && cmd !== "-h" && cmd !== "--help") {
    const adopted = adoptLegacyData(cfg);
    if (adopted) console.warn(`lbsv: moved the Switchboard database ${adopted} → ${cfg.dbFile}`);
  }

  switch (cmd) {
    case "serve": {
      const db = openDb(cfg.dbFile);
      const hub = await buildApp({
        db, uiDir: cfg.uiDir, adminPassphrase: cfg.adminPassphrase, cookieSecure: cfg.cookieSecure,
        trustProxy: cfg.trustProxy, logger: { level: cfg.logLevel }, favicons: cfg.favicons, extPackagesDir: cfg.extPackagesDir, publicUrl: cfg.publicUrl,
        setupCodeFile: cfg.setupCodeFile, backups: { dir: cfg.backupDir, keep: cfg.backupKeep, everyHours: cfg.backupEveryHours },
      });
      const { app } = hub;
      const release = holdLock(cfg.dbFile);
      hub.backups?.start();
      const shutdown = async () => { await app.close(); db.close(); release(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await app.listen({ host: cfg.host, port: cfg.port });
      app.log.info(`LabSave hub on http://${cfg.host}:${cfg.port}  data=${cfg.dbFile}`);
      const code = hub.auth.setupCode();
      if (code) {
        // Plain stderr (not JSON log) so it stands out in `docker compose logs`.
        console.error(`
  ==== First run ====
  Open LabSave in a browser and enter this setup code to set your admin passphrase:

      ${code}

  (A new code is made on every restart until a passphrase is set. Also: lbsv setup-code)
`);
      }
      return;
    }
    case "backup": {
      const i = rest.indexOf("--out");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = i >= 0 && rest[i + 1] ? rest[i + 1]! : join(cfg.backupDir, `lbsv-${stamp}.db`);
      const db = openDb(cfg.dbFile);
      await backupDb(db, dest);
      db.close();
      console.log(dest);
      return;
    }
    case "backups": {
      const b = new Backups(null as never, { dir: cfg.backupDir, keep: cfg.backupKeep, everyHours: cfg.backupEveryHours }).list();
      if (!b.length) console.log(`No automatic backups in ${cfg.backupDir}`);
      for (const x of b) console.log(`${new Date(x.at).toISOString()}  ${String(Math.round(x.size / 1024)).padStart(7)} KB  ${x.file}`);
      return;
    }
    case "restore": {
      const which = rest.find((a) => !a.startsWith("--"));
      if (!which) { console.error("Usage: lbsv restore <backup file | latest> [--force]   (lbsv backups lists them)"); process.exit(2); }
      const from = which === "latest" ? new Backups(null as never, { dir: cfg.backupDir }).list()[0]?.file : which;
      if (!from) { console.error(`No automatic backups in ${cfg.backupDir}`); process.exit(1); }
      const r = await restoreDb({ dbFile: cfg.dbFile, from, backupDir: cfg.backupDir, force: rest.includes("--force") });
      const db = openDb(cfg.dbFile); db.close(); // migrate an older backup forward now, not at next start
      console.log(`Restored ${from} → ${cfg.dbFile} (schema ${r.schema}).`);
      if (r.safety) console.log(`The database it replaced was saved as ${r.safety}`);
      console.log("Start the hub again. Devices stay paired (their tokens are in the backup, unless they were added after it).");
      return;
    }
    case "setup-code": {
      if (new Auth(openDb(cfg.dbFile)).isConfigured()) { console.log("Already set up: a passphrase exists. Use lbsv set-passphrase to change it."); return; }
      if (!existsSync(cfg.setupCodeFile)) { console.error("No setup code yet: start the hub (lbsv serve) first; it prints one."); process.exit(1); }
      console.log(readFileSync(cfg.setupCodeFile, "utf8").trim());
      return;
    }
    case "set-passphrase": {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      const pass = (await rl.question("New admin passphrase (min 8 chars): ")).trim();
      rl.close();
      const db = openDb(cfg.dbFile);
      new Auth(db).setPassphrase(pass);
      db.close();
      console.error("Passphrase set. Existing sessions were signed out.");
      return;
    }
    case "migrate": {
      const db = openDb(cfg.dbFile);
      db.close();
      console.log("Migrations up to date:", cfg.dbFile);
      return;
    }
    case "-h": case "--help": case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
