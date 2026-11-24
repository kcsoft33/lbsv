import { watch, mkdirSync, realpathSync, type FSWatcher } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
import { HubSocket, type HubSocketOptions, type WelcomeBase } from "../../shared/src/hubSocket.ts";
import { redactCommand, MAX_CWD, type AgentInfo, type WireTerm } from "../../shared/src/terms.ts";
import { readShells, type ShellState } from "./shells.ts";
import { pollScreen, pollTmux, type ScreenSession, type TmuxSession } from "./mux.ts";
import { AGENT_VERSION } from "./config.ts";

export function agentInfo(): AgentInfo {
  let user = "";
  try { user = userInfo().username; } catch { user = process.env.USER || process.env.USERNAME || ""; }
  return { version: AGENT_VERSION, os: platform(), hostname: hostname(), user };
}

/**
 * Merge plain shells with tmux/screen sessions. A shell running inside a session the agent can
 * see is folded into that session (one row per session, like you'd reattach to it); its last
 * command and activity are carried over. Commands are redacted here, before they leave the device.
 */
export function composeTerms(shells: ShellState[], tmux: TmuxSession[], panes: Map<string, string>, screens: ScreenSession[], defaultUser = ""): WireTerm[] {
  const out: WireTerm[] = [];
  const tmuxBy = new Map(tmux.map((s) => [s.name, { s, last: s.activityAt ?? 0, cmd: undefined as string | undefined, cmdAt: 0 }]));
  const screenBy = new Map(screens.map((s) => [s.id, { s, last: 0, cwd: "", cmd: undefined as string | undefined, user: "" }]));
  const cleanCmd = (c?: string) => (c ? redactCommand(c) : undefined);

  for (const sh of shells) {
    const tSess = sh.tmux && sh.tmuxPane ? panes.get(sh.tmuxPane) : undefined;
    const t = tSess ? tmuxBy.get(tSess) : undefined;
    if (t) {
      t.last = Math.max(t.last, sh.lastActivityAt);
      if (sh.cmd && sh.lastActivityAt >= t.cmdAt) { t.cmd = sh.cmd; t.cmdAt = sh.lastActivityAt; }
      continue;
    }
    const sc = sh.sty ? screenBy.get(sh.sty) : undefined;
    if (sc) {
      if (sh.lastActivityAt >= sc.last) { sc.last = sh.lastActivityAt; sc.cwd = sh.cwd; sc.cmd = sh.cmd ?? sc.cmd; sc.user = sh.user; }
      continue;
    }
    out.push({
      id: `sh:${sh.winpid ?? sh.pid}`, kind: "shell", name: "", shell: sh.shell, pid: sh.winpid ?? sh.pid,
      user: sh.user || defaultUser, cwd: (sh.winpid ? msysToWindows(sh.cwd) : sh.cwd).slice(0, MAX_CWD), tty: sh.tty,
      ...(sh.startedAt ? { startedAt: sh.startedAt } : {}), lastActivityAt: sh.lastActivityAt,
      ...(sh.cmd ? { cmd: cleanCmd(sh.cmd) } : {}),
    });
  }
  for (const { s, last, cmd } of tmuxBy.values()) {
    out.push({
      id: `tmux:${s.name}`, kind: "tmux", name: s.name, user: defaultUser, cwd: s.cwd.slice(0, MAX_CWD), attached: s.attached, windows: s.windows,
      ...(s.createdAt ? { startedAt: s.createdAt } : {}), ...(last ? { lastActivityAt: last } : {}), ...(cmd ? { cmd: cleanCmd(cmd) } : {}),
    });
  }
  for (const { s, last, cwd, cmd, user } of screenBy.values()) {
    out.push({
      id: `screen:${s.id}`, kind: "screen", name: s.id, pid: s.pid, user: user || defaultUser, cwd: cwd.slice(0, MAX_CWD), attached: s.attached ? 1 : 0,
      ...(last ? { lastActivityAt: last } : {}), ...(cmd ? { cmd: cleanCmd(cmd) } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Git Bash / MSYS report "/c/dev/x"; store "C:\dev\x" so rules and PowerShell agree on Windows paths. */
export function msysToWindows(p: string): string {
  const m = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}` : p;
}

/** The agent's hub connection: hello carries the agent info; every change sends the complete list. */
export class AgentClient extends HubSocket {
  agentId = "";
  sent = 0;
  private info: AgentInfo;
  private terms: WireTerm[] = [];
  private lastSentJson = "";

  constructor(o: HubSocketOptions & { info: AgentInfo }) { super(o); this.info = o.info; }

  protected hello(): object { return { t: "hello", token: this.base.token, agent: this.info }; }

  protected onWelcome(m: WelcomeBase & Record<string, unknown>): void {
    this.agentId = String(m.agentId ?? "");
    this.lastSentJson = "";
    this.flush();
  }

  protected override onDisconnected(): void { this.lastSentJson = ""; }

  /** Offline, this just remembers the latest state: the welcome after reconnecting sends it. */
  update(terms: WireTerm[]): void { this.terms = terms; this.flush(); }

  get current(): WireTerm[] { return this.terms; }

  private flush(): void {
    if (!this.online) return;
    const json = JSON.stringify(this.terms);
    if (json === this.lastSentJson) return;
    if (this.send({ t: "terms", seq: ++this.seq, terms: this.terms })) { this.lastSentJson = json; this.sent++; }
  }
}

export interface AgentOptions {
  stateDir: string;
  client: AgentClient;
  /** tmux/screen poll interval (SPEC: 15 s). */
  pollMs?: number;
  /** Coalesce bursts of prompt writes. */
  debounceMs?: number;
  log?: (s: string) => void;
  /** Overridable for tests. */
  mux?: () => Promise<{ tmux: TmuxSession[]; panes: Map<string, string>; screens: ScreenSession[] }>;
}

/** Watches the hook files, polls tmux/screen, and keeps the client's terminal list current. */
export class Agent {
  private o: AgentOptions;
  private watcher: FSWatcher | null = null;
  private pollT: ReturnType<typeof setInterval> | undefined;
  private debT: ReturnType<typeof setTimeout> | undefined;
  private mux = { tmux: [] as TmuxSession[], panes: new Map<string, string>(), screens: [] as ScreenSession[] };
  private user = agentInfo().user;

  constructor(o: AgentOptions) { this.o = o; }

  async start(): Promise<void> {
    mkdirSync(this.o.stateDir, { recursive: true });
    this.o.client.start();
    await this.poll();
    try {
      // The long path: libuv on Windows asserts (crashes the process) when watching an 8.3 short path (C:\Users\KELLY~1.CNL\...).
      let dir = this.o.stateDir;
      try { dir = realpathSync.native(dir); } catch { /* keep */ }
      this.watcher = watch(dir, () => this.soon());
      this.watcher.on("error", () => { /* fall back to polling */ });
    } catch { /* polling only */ }
    this.pollT = setInterval(() => { void this.poll(); this.o.client.poke(); }, this.o.pollMs ?? 15_000);
  }

  stop(): void {
    clearInterval(this.pollT); clearTimeout(this.debT);
    this.watcher?.close(); this.watcher = null;
    this.o.client.stop();
  }

  private soon(): void {
    clearTimeout(this.debT);
    this.debT = setTimeout(() => this.rescan(), this.o.debounceMs ?? 300);
  }

  async poll(): Promise<void> {
    try {
      if (this.o.mux) this.mux = await this.o.mux();
      else {
        const [t, screens] = await Promise.all([pollTmux(), pollScreen()]);
        this.mux = { tmux: t.sessions, panes: t.panes, screens };
      }
    } catch (e) { this.o.log?.(`tmux/screen poll failed: ${String(e)}`); }
    this.rescan();
  }

  rescan(): WireTerm[] {
    const terms = composeTerms(readShells(this.o.stateDir), this.mux.tmux, this.mux.panes, this.mux.screens, this.user);
    this.o.client.update(terms);
    return terms;
  }
}
