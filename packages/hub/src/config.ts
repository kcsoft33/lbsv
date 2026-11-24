import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Default data dir is on LOCAL disk (never a network share: SQLite WAL needs real file locking).
 *   Windows: %LOCALAPPDATA%\lbsv   macOS/Linux: $XDG_DATA_HOME/lbsv or ~/.local/share/lbsv
 * In Docker it is /data (a named volume).
 */
function appDir(name: string): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, name);
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), name);
}

/** Env vars from before the rename to lbsv (SB_*) still work; LBSV_* wins. */
export const legacyEnvUsed: string[] = [];
function envGetter(env: NodeJS.ProcessEnv) {
  return (k: string): string | undefined => {
    const v = env["LBSV_" + k];
    if (v !== undefined && v !== "") return v;
    const old = env["SB_" + k];
    if (old !== undefined && old !== "") { if (!legacyEnvUsed.includes("SB_" + k)) legacyEnvUsed.push("SB_" + k); return old; }
    return undefined;
  };
}

export function loadConfig(env = process.env) {
  const e = envGetter(env);
  const explicitDir = e("DATA_DIR");
  const dataDir = resolve(explicitDir || appDir("lbsv"));
  return {
    dataDir,
    dbFile: join(dataDir, "lbsv.db"),
    // Pre-rename database locations, adopted once by adoptLegacyData().
    legacyDbFiles: [join(dataDir, "switchboard.db"), ...(explicitDir ? [] : [join(appDir("switchboard"), "switchboard.db")])],
    backupDir: resolve(e("BACKUP_DIR") || join(dataDir, "backups")),
    // Scheduled backups: every N hours (0 = off), keeping the newest K automatic ones.
    backupEveryHours: Math.max(0, Number(e("BACKUP_EVERY_HOURS") ?? 24) || 0),
    backupKeep: Math.max(1, Number(e("BACKUP_KEEP") ?? 14) || 14),
    setupCodeFile: join(dataDir, "setup-code.txt"),
    // Loopback by default. Set LBSV_HOST to your LAN/VPN interface address (e.g. the Tailscale IP).
    // Inside Docker the compose file sets 0.0.0.0 and restricts exposure via the published port's host IP.
    host: e("HOST") || "127.0.0.1",
    port: Number(e("PORT") || 8080),
    uiDir: resolve(e("UI_DIR") || join(here, "..", "..", "ui", "dist")),
    // Extension packages offered for download on the Devices page (built by `npm run build:ext`).
    extPackagesDir: resolve(e("EXT_PACKAGES_DIR") || join(here, "..", "..", "ext", "dist", "packages")),
    adminPassphrase: e("ADMIN_PASSPHRASE") || undefined,
    cookieSecure: (e("COOKIE_SECURE") === "1" ? true : e("COOKIE_SECURE") === "0" ? false : "auto") as boolean | "auto",
    /** How collectors and installers should reach the hub, if not the address the request came in on. */
    publicUrl: e("PUBLIC_URL") || undefined,
    trustProxy: e("TRUST_PROXY") ? (e("TRUST_PROXY") === "1" ? true : e("TRUST_PROXY")) : false,
    logLevel: e("LOG_LEVEL") || "info",
    // The hub fetches favicons from the hosts of open tabs (cached; the UI never hotlinks). 0 = never.
    favicons: e("FAVICONS") !== "0",
  };
}
export type Config = ReturnType<typeof loadConfig>;

/**
 * One-time move of a pre-rename (Switchboard) database to lbsv.db, including its WAL/SHM files.
 * Only runs when lbsv.db doesn't exist yet and no hub is using the old file (call before openDb).
 */
export function adoptLegacyData(cfg: Config): string | null {
  if (existsSync(cfg.dbFile)) return null;
  const old = cfg.legacyDbFiles.find((f) => existsSync(f));
  if (!old) return null;
  mkdirSync(cfg.dataDir, { recursive: true });
  for (const sfx of ["", "-wal", "-shm"]) if (existsSync(old + sfx)) renameSync(old + sfx, cfg.dbFile + sfx);
  return old;
}
