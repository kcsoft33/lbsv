/**
 * Live terminals (SPEC §6.4): what lbsv-agent reports, what the hub returns, and the reconnect
 * commands the UI copies. Command text is opt-in on the device and always passes redactCommand().
 * Terminal output is never collected.
 */
import { redactUrl } from "./redact.ts";

export type TermKind = "shell" | "tmux" | "screen";
export const TERM_KINDS: TermKind[] = ["shell", "tmux", "screen"];

/** One terminal as the agent sends it. `id` is stable per agent (sh:<pid>, tmux:<name>, screen:<pid.name>). */
export interface WireTerm {
  id: string;
  kind: TermKind;
  /** tmux/screen session name; empty for a plain shell. */
  name: string;
  /** bash | zsh | pwsh | powershell, for shells. */
  shell?: string;
  pid?: number;
  user?: string;
  cwd: string;
  tty?: string;
  /** tmux: clients attached; screen: attached flag. */
  attached?: number;
  windows?: number;
  startedAt?: number;
  lastActivityAt?: number;
  /** Only when LBSV_RECORD_CMDS=1 on the device; already redacted. */
  cmd?: string;
}

export interface AgentInfo { version: string; os: string; hostname: string; user: string }

export type AgentToHubMsg =
  | { t: "hello"; token: string; agent: AgentInfo }
  | { t: "terms"; seq: number; terms: WireTerm[] }
  | { t: "ping" };

export type HubToAgentMsg =
  | { t: "welcome"; agentId: string; device: { id: string; name: string }; heartbeatMs: number }
  | { t: "ack"; seq: number }
  | { t: "pong" }
  | { t: "error"; error: string };

/* ---------- hub -> UI ---------- */
export interface LiveTerm {
  id: string; // `${agentId}|${nativeId}`
  nativeId: string;
  kind: TermKind;
  name: string;
  shell: string;
  pid: number | null;
  user: string;
  cwd: string;
  tty: string;
  attached: number;
  windows: number;
  startedAt: number | null;
  lastActivityAt: number | null;
  firstSeenAt: number;
  cmd: string;
}
export interface LiveAgent {
  id: string;
  version: string;
  os: string;
  hostname: string;
  user: string;
  connected: boolean;
  lastSeenAt: number | null;
  lastSnapshotAt: number | null;
  terms: LiveTerm[];
}

export const MAX_CWD = 4096;
export const MAX_CMD = 2000;
export const MAX_TERMS = 2000;

/* ---------- redaction ---------- */
const SECRET_WORD = "(?:token|key|secret|sig|signature|passw(?:or)?d|pwd|pass|auth|credential|session|jwt|bearer|api[_-]?key|access[_-]?token|id[_-]?token|private)";
const ENV_ASSIGN_RE = new RegExp(`(^|[\\s;&|(])((?:export\\s+|\\$env:)?[A-Za-z_][A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*\\s*=\\s*)("[^"]*"|'[^']*'|\\S+)`, "gi");
const FLAG_RE = new RegExp(`(--?[A-Za-z0-9-]*${SECRET_WORD}[A-Za-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, "gi");
const HEADER_RE = /((?:authorization|x-api-key|x-auth-token|cookie|proxy-authorization)\s*:\s*)(?:(bearer|basic|token)\s+)?([^'"\s]+)/gi;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const MASK = "[redacted]";

/**
 * Strip likely secrets from a recorded command before it leaves the device: URLs go through
 * redactUrl (query secrets, user:pass@), and values of secret-looking env assignments, flags and
 * auth headers are masked. `mysql -pXXXX` style glued passwords are masked too.
 */
export function redactCommand(cmd: string): string {
  let s = cmd.replace(/\r?\n/g, " ⏎ ").slice(0, MAX_CMD * 2);
  s = s.replace(URL_RE, (u) => { try { return redactUrl(u); } catch { return u; } });
  s = s.replace(HEADER_RE, (_m, h: string, scheme: string | undefined) => `${h}${scheme ? scheme + " " : ""}${MASK}`);
  s = s.replace(ENV_ASSIGN_RE, (_m, pre: string, name: string) => `${pre}${name}${MASK}`);
  s = s.replace(FLAG_RE, (_m, flag: string, sep: string) => `${flag}${sep}${MASK}`);
  s = s.replace(/(^|\s)(mysql|mariadb|mysqldump)(\s.*?)?\s-p(?!\s|$)\S+/gi, (m) => m.replace(/-p\S+$/, `-p${MASK}`));
  s = s.replace(/(^|\s)(sshpass\s+-p\s*)\S+/gi, `$1$2${MASK}`);
  return s.slice(0, MAX_CMD);
}

/* ---------- reconnect commands ---------- */
/** POSIX single-quote unless it's plainly safe. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
/** PowerShell single-quoted literal. */
export function psq(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

export interface SshTarget {
  /** user@host or an ~/.ssh/config alias. Empty: the agent's hostname. */
  target: string;
  /** Optional jump host for `ssh -J`. */
  jump: string;
}

export const isWindowsOs = (os: string) => /^win/i.test(os);

/** `ssh -t [-J jump] target` with the target defaulting to the agent's hostname. */
export function sshPrefix(ssh: SshTarget, hostname: string): string {
  const target = (ssh.target || hostname || "HOST").trim();
  return `ssh -t${ssh.jump ? ` -J ${shq(ssh.jump.trim())}` : ""} ${shq(target)}`;
}

/** The remote command that gets you back into this terminal (or a shell in its folder). */
export function attachCommand(t: Pick<LiveTerm, "kind" | "name" | "cwd" | "shell">, os: string): string {
  if (t.kind === "tmux") return `tmux new -A -s ${shq(t.name)}`;
  if (t.kind === "screen") return `screen -xRR ${shq(t.name)}`;
  if (isWindowsOs(os) || t.shell === "pwsh" || t.shell === "powershell") {
    const exe = t.shell === "powershell" ? "powershell" : "pwsh";
    return `${exe} -NoExit -Command "Set-Location -LiteralPath ${psq(t.cwd)}"`;
  }
  return `cd ${shq(t.cwd)} && exec "$SHELL" -l`;
}

/**
 * Reconnect from another machine. The remote part is passed as one argument so the remote
 * shell sees it intact: tmux/screen names and paths with spaces survive.
 */
export function reconnectCommand(t: Pick<LiveTerm, "kind" | "name" | "cwd" | "shell">, agent: Pick<LiveAgent, "os" | "hostname">, ssh: SshTarget): string {
  const remote = attachCommand(t, agent.os);
  return `${sshPrefix(ssh, agent.hostname)} ${isWindowsOs(agent.os) ? remote : shq(remote)}`;
}

/** Same machine: just go to the folder (or attach to the session). */
export function localCommand(t: Pick<LiveTerm, "kind" | "name" | "cwd" | "shell">, os: string): string {
  if (t.kind !== "shell") return attachCommand(t, os);
  return isWindowsOs(os) || t.shell === "pwsh" || t.shell === "powershell" ? `Set-Location -LiteralPath ${psq(t.cwd)}` : `cd ${shq(t.cwd)}`;
}

/** A saved project session for a live terminal (UI "Save to project", MCP save_terminal). */
export function sessionForTerm(t: Pick<LiveTerm, "kind" | "name" | "cwd" | "shell">, agent: Pick<LiveAgent, "os" | "hostname">, ssh: SshTarget):
  { kind: string; label: string; host: string; network: string; cmd: string } {
  return {
    kind: t.kind === "tmux" ? "tmux" : t.kind === "screen" ? "Other" : "Local term",
    label: t.kind === "shell" ? folderName(t.cwd) : t.name, host: agent.hostname, network: "",
    cmd: reconnectCommand(t, agent, ssh),
  };
}

/** Last path segment, for labels ("/home/k/git/lbops" → "lbops"). */
export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/** "~/git/lbops" for display when the cwd is under the user's home. */
export function tildePath(cwd: string, user: string): string {
  if (!user) return cwd;
  const m = cwd.match(new RegExp(`^(/home/${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/Users/${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/root(?=/|$))(?=/|$)`));
  return m ? "~" + cwd.slice(m[1].length) : cwd;
}
