/**
 * Reads the per-shell state files the hooks write (one file per shell, named by pid, overwritten
 * at every prompt). The file's mtime is the shell's last activity. Files of shells that are gone
 * are deleted here, so hooks never need an exit trap.
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface ShellState {
  shell: string;
  pid: number;
  /** Windows pid of a Git Bash / MSYS shell (its own pid is an MSYS pid). */
  winpid?: number;
  tty: string;
  user: string;
  host: string;
  startedAt?: number;
  tmux: string;
  tmuxPane: string;
  sty: string;
  cwd: string;
  cmd?: string;
  lastActivityAt: number;
}

const MAX_FILE = 64 * 1024;

/** Parse one state file. `cmd=` is last and may span lines (multi-line commands). */
export function parseShellFile(text: string, mtimeMs: number): ShellState | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kv = new Map<string, string>();
  let cmd: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const eq = l.indexOf("=");
    if (eq < 1) continue;
    const k = l.slice(0, eq);
    if (k === "cmd") { cmd = [l.slice(eq + 1), ...lines.slice(i + 1)].join("\n").replace(/\n+$/, ""); break; }
    if (!kv.has(k)) kv.set(k, l.slice(eq + 1));
  }
  if (kv.get("v") !== "1") return null;
  const pid = Number(kv.get("pid"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const winpid = Number(kv.get("winpid"));
  const started = Number(kv.get("started"));
  // bash `history 1` prints "  123  the command" (and "*" for edited entries).
  if (cmd !== undefined && kv.get("shell") === "bash") cmd = cmd.replace(/^\s*\d+\*?\s+/, "");
  return {
    shell: kv.get("shell") || "sh",
    pid,
    ...(Number.isInteger(winpid) && winpid > 0 ? { winpid } : {}),
    tty: kv.get("tty") ?? "",
    user: kv.get("user") ?? "",
    host: kv.get("host") ?? "",
    ...(started > 0 ? { startedAt: started * 1000 } : {}),
    tmux: kv.get("tmux") ?? "",
    tmuxPane: kv.get("tmux_pane") ?? "",
    sty: kv.get("sty") ?? "",
    cwd: kv.get("cwd") ?? "",
    ...(cmd ? { cmd } : {}),
    lastActivityAt: Math.floor(mtimeMs),
  };
}

const SHELL_COMM = /^(-?)(bash|zsh|sh|pwsh|powershell|dash|ksh|fish)(\.exe)?$/i;

/** Is the process still there? EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number, shell?: string): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  // Linux: guard against pid reuse by a non-shell process.
  if (process.platform === "linux" && shell) {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (comm && !SHELL_COMM.test(comm)) return false;
    } catch { /* no /proc access: trust kill(0) */ }
  }
  return true;
}

export function readShells(dir: string, alive: (s: ShellState) => boolean = defaultAlive): ShellState[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: ShellState[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const f = join(dir, name);
    let s: ShellState | null = null;
    try {
      const st = statSync(f);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      s = parseShellFile(readFileSync(f, "utf8"), st.mtimeMs);
    } catch { continue; } // being rewritten right now; next scan gets it
    if (!s || !alive(s)) { try { unlinkSync(f); } catch { /* raced */ } continue; }
    out.push(s);
  }
  return out;
}

export function defaultAlive(s: ShellState): boolean {
  // A Windows agent checks Git Bash shells by their Windows pid.
  if (process.platform === "win32" && s.winpid) return processAlive(s.winpid);
  return processAlive(s.pid, s.shell);
}
