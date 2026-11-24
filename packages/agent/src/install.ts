/**
 * `lbsv-agent install` / `uninstall` (M5): everything the README used to list as five manual steps.
 * Pair → put the agent + hooks in fixed places → add one marked block to each shell's rc file →
 * install and start the per-user service. Idempotent: run it again to update or re-pair.
 * The pure parts (paths, rc blocks, unit files) are exported for tests.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configDir, stateDir } from "./config.ts";

export const HOOK_FILES = ["lbsv.bash", "lbsv.zsh", "lbsv.ps1"] as const;
export type HookFile = (typeof HOOK_FILES)[number];
export const BEGIN = "# >>> lbsv (LabSave) >>>";
export const END = "# <<< lbsv (LabSave) <<<";
export const SERVICE_LABEL = "net.cnlsft.lbsv-agent";
export const TASK_NAME = "lbsv-agent";

/* Hooks: embedded in the bundle by scripts/build-agent.ts, read from ../hooks in a source checkout. */
declare const __LBSV_HOOKS__: Record<string, string> | undefined;
export function hookText(name: HookFile): string {
  if (typeof __LBSV_HOOKS__ !== "undefined" && __LBSV_HOOKS__[name]) return __LBSV_HOOKS__[name]!;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, "hooks"), join(here, "..", "hooks")]) if (existsSync(join(d, name))) return readFileSync(join(d, name), "utf8");
  throw new Error(`hook ${name} not found next to the agent`);
}

/** Where the agent installs itself (the service runs it from here). */
export function dataDir(env = process.env, os = platform()): string {
  if (env.LBSV_DATA_DIR) return env.LBSV_DATA_DIR;
  if (os === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "lbsv-agent");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "lbsv-agent");
}

const posix = (p: string) => p.replace(/\\/g, "/");
/** The rc line(s) for one shell, inside markers so we can update or remove them later. */
export function rcBlock(shell: "bash" | "zsh" | "pwsh", cfgDir: string, recordCmds = false): string {
  const lines: string[] = [BEGIN];
  if (shell === "pwsh") {
    if (recordCmds) lines.push(`$env:LBSV_RECORD_CMDS = "1"`);
    lines.push(`if (Test-Path '${join(cfgDir, "lbsv.ps1").replace(/'/g, "''")}') { . '${join(cfgDir, "lbsv.ps1").replace(/'/g, "''")}' }`);
  } else {
    if (recordCmds) lines.push("export LBSV_RECORD_CMDS=1");
    const f = `${posix(cfgDir)}/lbsv.${shell}`;
    lines.push(shell === "zsh" ? `[[ -f "${f}" ]] && source "${f}"` : `[ -f "${f}" ] && . "${f}"`);
  }
  lines.push(END);
  return lines.join("\n");
}

/** Does the existing lbsv block in this rc file opt in to command recording? */
export function blockRecordsCmds(rc: string): boolean {
  const i = rc.indexOf(BEGIN), j = rc.indexOf(END, i);
  return i >= 0 && j > i && /LBSV_RECORD_CMDS\s*=\s*"?1/.test(rc.slice(i, j));
}

/** Replace our block if present, else append it (keeping the file's line endings). */
export function upsertBlock(content: string, block: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const b = block.replace(/\n/g, eol);
  const i = content.indexOf(BEGIN), j = content.indexOf(END);
  if (i >= 0 && j > i) return content.slice(0, i) + b + content.slice(j + END.length);
  const sep = content === "" || content.endsWith("\n") ? "" : eol;
  return content + sep + (content ? eol : "") + b + eol;
}
export function removeBlock(content: string): string {
  const i = content.indexOf(BEGIN), j = content.indexOf(END);
  if (i < 0 || j < i) return content;
  let start = i, end = j + END.length;
  if (content.slice(end, end + 2) === "\r\n") end += 2; else if (content[end] === "\n") end += 1;
  // also drop the blank line we added before the block
  if (content.slice(Math.max(0, start - 2), start) === "\n\n") start -= 1;
  else if (content.slice(Math.max(0, start - 4), start) === "\r\n\r\n") start -= 2;
  return content.slice(0, start) + content.slice(end);
}

export function systemdUnit(node: string, script: string): string {
  return `[Unit]
Description=lbsv-agent (LabSave terminal collector)
After=network-online.target

[Service]
ExecStart="${node}" "${script}" run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}
export function launchdPlist(node: string, script: string, logFile: string): string {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(script)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
  <key>StandardOutPath</key><string>${x(logFile)}</string>
</dict></plist>
`;
}
/** Task Scheduler at logon. conhost --headless keeps a console window from popping up. */
export function windowsTaskScript(node: string, script: string): string {
  const q = (s: string) => s.replace(/'/g, "''");
  return `$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless "${q(node)}" "${q(script)}" run'
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Description 'LabSave terminal collector' -Force | Out-Null
Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName '${TASK_NAME}'
`;
}

/* ---------------- side effects ---------------- */

export interface InstallOptions {
  /** Path of the running agent file (copied into dataDir unless it already is there). */
  self: string;
  service: boolean;
  /** true/false sets it; undefined keeps whatever each rc block already says (so updates don't flip it). */
  recordCmds: boolean | undefined;
  env?: NodeJS.ProcessEnv;
  os?: NodeJS.Platform;
  log?: (s: string) => void;
  run?: (cmd: string, args: string[]) => { ok: boolean; out: string };
}

const defaultRun = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error ? String(r.error.message) : "") };
};

/** rc files to touch: those that exist, plus the login shell's even if missing. */
export function rcTargets(env: NodeJS.ProcessEnv, os: NodeJS.Platform, run: NonNullable<InstallOptions["run"]>): { shell: "bash" | "zsh" | "pwsh"; file: string }[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const login = (env.SHELL ?? "").split("/").pop();
  const out: { shell: "bash" | "zsh" | "pwsh"; file: string }[] = [];
  for (const sh of ["bash", "zsh"] as const) {
    const f = join(home, sh === "bash" ? ".bashrc" : ".zshrc");
    if (existsSync(f) || login === sh || (os === "win32" && sh === "bash" && existsSync(join(home, ".bash_profile")))) out.push({ shell: sh, file: f });
  }
  // PowerShell: ask each installed edition for its real $PROFILE (Documents may be redirected to OneDrive).
  for (const exe of os === "win32" ? ["pwsh", "powershell"] : ["pwsh"]) {
    const r = run(exe, ["-NoProfile", "-NoLogo", "-Command", "$PROFILE.CurrentUserCurrentHost"]);
    const f = r.ok ? r.out.split(/\r?\n/).pop()!.trim() : "";
    if (f && !out.some((o) => o.file.toLowerCase() === f.toLowerCase())) out.push({ shell: "pwsh", file: f });
  }
  return out;
}

export function installFiles(o: InstallOptions): { script: string; rc: string[]; hooksDir: string } {
  const env = o.env ?? process.env, os = o.os ?? platform(), log = o.log ?? console.log, run = o.run ?? defaultRun;
  const dir = dataDir(env, os);
  mkdirSync(dir, { recursive: true });
  // A source checkout (cli.ts) runs in place; the bundle copies itself to a fixed spot for the service.
  let script = join(dir, "lbsv-agent.mjs");
  if (o.self.endsWith(".ts")) script = o.self;
  else if (resolve(o.self).toLowerCase() !== resolve(script).toLowerCase()) copyFileSync(o.self, script);
  const cfg = configDir(env);
  mkdirSync(cfg, { recursive: true });
  for (const h of HOOK_FILES) writeFileSync(join(cfg, h), hookText(h));
  mkdirSync(stateDir(env), { recursive: true });
  log(`✓ agent  ${script}\n✓ hooks  ${cfg}`);
  const rc: string[] = [];
  for (const t of rcTargets(env, os, run)) {
    const before = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
    const after = upsertBlock(before, rcBlock(t.shell, cfg, o.recordCmds ?? blockRecordsCmds(before)));
    if (after !== before) { mkdirSync(dirname(t.file), { recursive: true }); writeFileSync(t.file, after); }
    rc.push(t.file);
    log(`✓ ${t.shell.padEnd(5)}  ${t.file}${after === before ? " (already set up)" : ""}`);
  }
  if (!rc.length) log("! no bash/zsh/PowerShell profile found; see `lbsv-agent hooks` for the lines to add");
  return { script, rc, hooksDir: cfg };
}

export function installService(o: InstallOptions & { script: string }): boolean {
  const env = o.env ?? process.env, os = o.os ?? platform(), log = o.log ?? console.log, run = o.run ?? defaultRun;
  const node = process.execPath;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (os === "linux") {
    const unitDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "lbsv-agent.service"), systemdUnit(node, o.script));
    const r1 = run("systemctl", ["--user", "daemon-reload"]);
    const r2 = r1.ok ? run("systemctl", ["--user", "enable", "--now", "lbsv-agent"]) : r1;
    const r3 = r2.ok ? run("systemctl", ["--user", "restart", "lbsv-agent"]) : r2;
    if (!r3.ok) {
      log(`! couldn't start the systemd user service (${r3.out.split("\n")[0] || "no systemd?"}).\n  Unit written to ${unitDir}/lbsv-agent.service.\n  Without systemd, start it from a login script instead: nohup "${node}" "${o.script}" run >/dev/null 2>&1 &`);
      return false;
    }
    const linger = run("loginctl", ["enable-linger", env.USER || env.LOGNAME || ""]);
    log(`✓ service  systemd user unit lbsv-agent (running)${linger.ok ? "; lingering on, so it keeps running after logout" : "\n  ! couldn't enable lingering: run `sudo loginctl enable-linger $USER` to keep it running after you log out"}`);
    return true;
  }
  if (os === "darwin") {
    const f = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, launchdPlist(node, o.script, join(dataDir(env, os), "agent.log")));
    run("launchctl", ["unload", f]);
    const r = run("launchctl", ["load", "-w", f]);
    log(r.ok ? `✓ service  launchd ${SERVICE_LABEL} (running)` : `! launchctl load failed: ${r.out}`);
    return r.ok;
  }
  if (os === "win32") {
    const r = run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsTaskScript(node, o.script)]);
    log(r.ok ? `✓ service  scheduled task '${TASK_NAME}' (starts at logon; running now)` : `! couldn't register the scheduled task: ${r.out}`);
    return r.ok;
  }
  log(`! no service support for ${os}; run: "${node}" "${o.script}" run`);
  return false;
}

export function uninstall(o: { env?: NodeJS.ProcessEnv; os?: NodeJS.Platform; log?: (s: string) => void; run?: InstallOptions["run"]; keepConfig?: boolean }): void {
  const env = o.env ?? process.env, os = o.os ?? platform(), log = o.log ?? console.log, run = o.run ?? defaultRun;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (os === "linux") {
    run("systemctl", ["--user", "disable", "--now", "lbsv-agent"]);
    rmSync(join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", "lbsv-agent.service"), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  } else if (os === "darwin") {
    const f = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    run("launchctl", ["unload", f]); rmSync(f, { force: true });
  } else if (os === "win32") {
    run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`]);
  }
  log("✓ service removed");
  for (const t of rcTargets(env, os, run)) {
    if (!existsSync(t.file)) continue;
    const before = readFileSync(t.file, "utf8"), after = removeBlock(before);
    if (after !== before) { writeFileSync(t.file, after); log(`✓ removed the hook block from ${t.file}`); }
  }
  rmSync(stateDir(env), { recursive: true, force: true });
  if (!o.keepConfig) { rmSync(configDir(env), { recursive: true, force: true }); log(`✓ removed ${configDir(env)} (token deleted)`); }
  rmSync(dataDir(env, os), { recursive: true, force: true });
  log(`✓ removed ${dataDir(env, os)}\nOpen shells keep the hook until they exit. Revoke the device in the hub (Devices → Revoke) to invalidate its token there too.`);
}

