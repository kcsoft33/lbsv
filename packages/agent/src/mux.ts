/**
 * tmux / screen discovery (SPEC §6.4: polled every 15 s). Missing binaries or "no server running"
 * simply mean no sessions. Parsers are pure for testing.
 */
import { execFile } from "node:child_process";

export interface TmuxSession {
  name: string;
  attached: number;
  windows: number;
  createdAt?: number;
  activityAt?: number;
  /** Current path of the session's active pane. */
  cwd: string;
}
export interface ScreenSession {
  /** "12345.name", what screen -x accepts and what $STY holds. */
  id: string;
  pid: number;
  name: string;
  attached: boolean;
}

export const TMUX_SESSIONS_FMT = "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{pane_current_path}";
export const TMUX_PANES_FMT = "#{pane_id}\t#{session_name}";

export function parseTmuxSessions(out: string): TmuxSession[] {
  const res: TmuxSession[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 6) continue;
    const [name, attached, windows, created, activity] = f;
    const cwd = f.slice(5).join("\t");
    const sec = (s: string) => { const n = Number(s); return n > 0 ? n * 1000 : undefined; };
    res.push({ name, attached: Number(attached) || 0, windows: Number(windows) || 0, createdAt: sec(created), activityAt: sec(activity), cwd });
  }
  return res;
}

/** pane id ("%3") → session name. */
export function parseTmuxPanes(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("\t");
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

/**
 * `screen -ls` lines look like "\t12345.pts-0.host\t(11/22/26 10:00:00)\t(Detached)"; the date
 * column is optional and locale-dependent.
 */
export function parseScreenLs(out: string): ScreenSession[] {
  const res: ScreenSession[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s+(\d+)\.(\S+)\s+(?:\([^)]*\)\s+)?\((Attached|Detached|Multi,\s*attached|Multi,\s*detached|Dead[^)]*)\)\s*$/i);
    if (!m || /^dead/i.test(m[3])) continue;
    res.push({ id: `${m[1]}.${m[2]}`, pid: Number(m[1]), name: m[2], attached: /attached/i.test(m[3]) });
  }
  return res;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      // screen -ls exits non-zero even when it lists sessions; tmux exits 1 with no server.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function pollTmux(): Promise<{ sessions: TmuxSession[]; panes: Map<string, string> }> {
  if (process.platform === "win32") return { sessions: [], panes: new Map() };
  const [s, p] = await Promise.all([
    run("tmux", ["list-sessions", "-F", TMUX_SESSIONS_FMT]),
    run("tmux", ["list-panes", "-a", "-F", TMUX_PANES_FMT]),
  ]);
  return { sessions: s ? parseTmuxSessions(s) : [], panes: p ? parseTmuxPanes(p) : new Map() };
}

export async function pollScreen(): Promise<ScreenSession[]> {
  if (process.platform === "win32") return [];
  const out = await run("screen", ["-ls"]);
  return out ? parseScreenLs(out) : [];
}
