#!/usr/bin/env node
/**
 * lbsv-agent: reports this machine's terminals to an lbsv hub.
 *
 *   lbsv-agent install --hub https://lbsv.example --code ABCD-EFGH  pair + hooks + rc lines + service, in one go (rerun to update)
 *   lbsv-agent uninstall                                             undo all of that
 *   lbsv-agent update [--force]                                      fetch the hub's agent, reinstall in place, restart the service
 *   lbsv-agent enroll --hub https://lbsv.example --code ABCD-EFGH   pair with the hub (code from Devices → Pair)
 *   lbsv-agent hooks                                                 install the shell hooks and print the rc lines
 *   lbsv-agent run                                                   run in the foreground (what the service runs)
 *   lbsv-agent scan                                                  print what would be sent, then exit
 *   lbsv-agent status                                                config, paths, hook files, hub reachability
 *   lbsv-agent service                                               print a systemd / launchd / Task Scheduler unit
 *   lbsv-agent mcp [--hub <url>]                                     stdio MCP server for Claude Desktop (token in LBSV_MCP_TOKEN)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, platform } from "node:os";
import { collectorUrl, enroll } from "../../shared/src/collectorClient.ts";
import { Agent, AgentClient, agentInfo } from "./agent.ts";
import { runBridge } from "./mcpBridge.ts";
import { newer } from "../../shared/src/version.ts";
import { HOOK_FILES, SERVICE_LABEL, dataDir as dataDirFor, hookText, installFiles, installService, launchdPlist, systemdUnit, uninstall, windowsTaskScript } from "./install.ts";
import { AGENT_VERSION, configDir, configFile, loadConfig, saveConfig, stateDir } from "./config.ts";


function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const die = (s: string): never => { console.error(s); process.exit(1); };

async function cmdEnroll() {
  const hub = arg("hub") ?? die("Usage: lbsv-agent enroll --hub <https://hub> --code <pairing code> [--label <name>]");
  const code = arg("code") ?? die("Missing --code (Devices → Pair in the hub shows one, valid 10 minutes).");
  const label = arg("label") ?? `lbsv-agent on ${hostname()}`;
  let url: string;
  try { url = collectorUrl(hub); } catch (e) { return die(String((e as Error).message)); }
  try {
    const r = await enroll(url, code, label, "agent");
    const f = saveConfig({ hub: hub.replace(/\/+$/, ""), token: r.token, device: r.device.name });
    console.log(`Paired as "${r.device.name}". Token saved to ${f} (owner-only).`);
    console.log(`Next: lbsv-agent hooks   (then open a new terminal), and run lbsv-agent run or install the service (lbsv-agent service).`);
  } catch (e) { die(`Pairing failed: ${(e as Error).message}`); }
}

function cmdHooks() {
  const dest = configDir();
  mkdirSync(dest, { recursive: true });
  for (const f of HOOK_FILES) writeFileSync(join(dest, f), hookText(f));
  const d = dest.replace(/\\/g, "/");
  console.log(`Hooks copied to ${dest}. Add the line for each shell you use:

  bash  (~/.bashrc):   [ -f "${d}/lbsv.bash" ] && . "${d}/lbsv.bash"
  zsh   (~/.zshrc):    [[ -f "${d}/lbsv.zsh" ]] && source "${d}/lbsv.zsh"
  pwsh  ($PROFILE, after oh-my-posh/starship):   . "${join(dest, "lbsv.ps1")}"

Commands are NOT recorded unless you also set LBSV_RECORD_CMDS=1 in that shell's rc file.
Hook files go to ${stateDir()}.`);
}

async function cmdRun() {
  const c = loadConfig() ?? die(`Not paired yet: run lbsv-agent enroll --hub <url> --code <code>. (Looked for ${configFile()}.)`);
  const client = new AgentClient({
    url: collectorUrl(c.hub, "/collect/agent"), token: c.token, info: agentInfo(),
    onStatus: (s, d) => log(`hub ${s}${d ? `: ${d}` : ""}`),
  });
  const agent = new Agent({ stateDir: stateDir(), client, log });
  log(`lbsv-agent ${AGENT_VERSION} → ${c.hub}; watching ${stateDir()}`);
  await agent.start();
  const bye = () => { agent.stop(); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}

async function cmdScan() {
  const client = new AgentClient({ url: "ws://127.0.0.1:9/unused", token: "", info: agentInfo() });
  const agent = new Agent({ stateDir: stateDir(), client });
  await agent.poll();
  console.log(JSON.stringify({ agent: agentInfo(), stateDir: stateDir(), terms: client.current }, null, 2));
}

async function cmdStatus() {
  const c = loadConfig();
  const dir = stateDir();
  let files = 0; try { files = readdirSync(dir).filter((f) => /^\d+$/.test(f)).length; } catch { /* none */ }
  console.log(`lbsv-agent ${AGENT_VERSION} on ${hostname()} (${platform()})
config:  ${configFile()} ${c ? `(paired as "${c.device ?? "?"}", hub ${c.hub})` : "(not paired)"}
hooks:   ${["lbsv.bash", "lbsv.zsh", "lbsv.ps1"].filter((f) => existsSync(join(configDir(), f))).join(", ") || "not installed (lbsv-agent hooks)"}
state:   ${dir} (${files} shell file${files === 1 ? "" : "s"})`);
  if (!c) return;
  const client = new AgentClient({ url: collectorUrl(c.hub, "/collect/agent"), token: c.token, info: agentInfo(), backoff: { minMs: 60_000, maxMs: 60_000 } });
  const r = await new Promise<string>((res) => {
    const t = setTimeout(() => res("no answer within 8 s"), 8000);
    (client as unknown as { base: { onStatus: (s: string, d?: string) => void } }).base.onStatus = (s, d) => {
      if (s === "online" || s === "unauthorized" || s === "offline") { clearTimeout(t); res(s + (d ? `: ${d}` : "")); }
    };
    client.start();
  });
  client.stop();
  console.log(`hub:     ${r}`);
}

function cmdService() {
  const node = process.execPath, script = resolve(process.argv[1]!), os = platform();
  if (os === "linux") console.log(`# systemd user unit: save as ~/.config/systemd/user/lbsv-agent.service, then
#   systemctl --user daemon-reload && systemctl --user enable --now lbsv-agent
#   loginctl enable-linger "$USER"   # keep it running after you log out (tmux on servers/VMs)
# (lbsv-agent install does all of this for you.)
${systemdUnit(node, script)}`);
  else if (os === "darwin") console.log(`<!-- launchd agent: save as ~/Library/LaunchAgents/${SERVICE_LABEL}.plist, then launchctl load -w it.
     (lbsv-agent install does this for you.) -->
${launchdPlist(node, script, "/tmp/lbsv-agent.log")}`);
  else console.log(`# Windows: a Task Scheduler task that starts at logon (hidden) and restarts on failure. Run in PowerShell.
# (lbsv-agent install does this for you.)
${windowsTaskScript(node, script)}`);
}

const flag = (name: string) => process.argv.includes(`--${name}`);

async function cmdInstall() {
  const hub = arg("hub")?.replace(/\/+$/, ""), code = arg("code");
  const have = loadConfig();
  if (code) {
    if (!hub) die("Usage: lbsv-agent install --hub <https://hub> --code <pairing code> [--no-service] [--record-cmds]");
    try {
      const r = await enroll(collectorUrl(hub!), code, arg("label") ?? `lbsv-agent on ${hostname()}`, "agent");
      saveConfig({ hub: hub!, token: r.token, device: r.device.name });
      console.log(`✓ paired  as "${r.device.name}" with ${hub}`);
    } catch (e) { die(`Pairing failed: ${(e as Error).message.replace(/\.$/, "")}. Get a fresh code: Devices → New code (valid 10 minutes, single use).`); }
  } else if (!have) {
    die("Not paired yet. Usage: lbsv-agent install --hub <https://hub> --code <pairing code>   (code from Devices → Add device / New code)");
  } else {
    if (hub && hub !== have.hub) die(`Already paired with ${have.hub}. To switch hubs, pass a --code from the new hub.`);
    console.log(`✓ paired  already, as "${have.device ?? "?"}" with ${have.hub}`);
  }
  const self = fileURLToPath(import.meta.url);
  const recordCmds = flag("record-cmds") ? true : flag("no-record-cmds") ? false : undefined;
  const { script } = installFiles({ self, service: !flag("no-service"), recordCmds });
  if (!flag("no-service")) installService({ self, script, service: true, recordCmds: false });
  else console.log(`- service  skipped (--no-service); run: node "${script}" run`);
  console.log("\nOpen a NEW terminal: existing shells don't have the hook yet.");
  await new Promise((r) => setTimeout(r, 1500));
  await cmdStatus();
}

async function cmdUpdate() {
  const c = loadConfig() ?? die("Not paired yet, so there's no hub to update from. Use the one-line installer from Devices → Add device.");
  const url = `${c.hub}/install/lbsv-agent.mjs`;
  let res: Response;
  try { res = await fetch(url); } catch (e) { return die(`Can't reach ${url}: ${(e as Error).message}`); }
  if (!res.ok) die(`${url}: HTTP ${res.status}${res.status === 404 ? " (the hub has no agent bundle; run npm run build:agent there)" : ""}`);
  const latest = res.headers.get("x-lbsv-version") ?? "?";
  if (!flag("force") && latest !== "?" && !newer(latest, AGENT_VERSION)) {
    console.log(`Up to date: lbsv-agent ${AGENT_VERSION} (the hub has ${latest}). --force reinstalls anyway.`);
    return;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < 10_000 || !body.toString("utf8").includes("lbsv-agent: reports this machine")) die(`${url} didn't return the agent bundle.`);
  const tmp = join(dataDirFor(), "lbsv-agent.update.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, body);
  console.log(`Updating lbsv-agent ${AGENT_VERSION} → ${latest} from ${c.hub}`);
  // Run the new file's own installer: it copies itself into place, refreshes hooks, restarts the service.
  const args = [tmp, "install", ...process.argv.slice(3).filter((a) => a !== "--force")];
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  rmSync(tmp, { force: true });
  process.exit(r.status ?? 1);
}

function cmdUninstall() {
  uninstall({ keepConfig: flag("keep-config") });
}

async function cmdMcp() {
  const hub = arg("hub") ?? process.env.LBSV_HUB ?? loadConfig()?.hub
    ?? die("lbsv-agent mcp: no hub URL. Pass --hub https://lbsv.example (or pair this machine first).");
  let token = process.env.LBSV_MCP_TOKEN?.trim();
  const tf = arg("token-file");
  if (!token && tf) { try { token = readFileSync(tf, "utf8").trim(); } catch (e) { die(`Can't read --token-file: ${(e as Error).message}`); } }
  if (!token) die("lbsv-agent mcp: set LBSV_MCP_TOKEN (create one in the hub: Devices → MCP clients) or pass --token-file <file>.");
  try { await runBridge({ hub, token: token!, version: AGENT_VERSION }); }
  catch (e) { die(`lbsv-agent mcp: can't reach the hub's MCP endpoint: ${(e as Error).message}`); }
}

const cmd = process.argv[2];
const table: Record<string, () => unknown> = { install: cmdInstall, uninstall: cmdUninstall, update: cmdUpdate, enroll: cmdEnroll, hooks: cmdHooks, run: cmdRun, scan: cmdScan, status: cmdStatus, service: cmdService, mcp: cmdMcp };
if (!cmd || !table[cmd]) {
  console.log(`lbsv-agent ${AGENT_VERSION}: reports this machine's terminals to an lbsv hub.
Usage: lbsv-agent <install|update|uninstall|enroll|hooks|run|scan|status|service|mcp>
  install --hub <url> --code <code>  pair, install hooks + rc lines + service, start it (rerun any time)
          [--no-service] [--record-cmds | --no-record-cmds]
  update [--force]                   get the hub's current agent and reinstall it (keeps pairing + settings)
  uninstall [--keep-config]          remove the service, rc lines, hooks, files and token
  enroll --hub <url> --code <code>   pair with the hub (Devices → Pair, valid 10 minutes)
  hooks                              install shell hooks into ${configDir()}
  run                                run in the foreground
  scan                               print the terminals that would be reported
  status                             show config and check the hub
  service                            print a service definition for this OS
  mcp [--hub <url>]                  stdio MCP server for Claude Desktop (LBSV_MCP_TOKEN=lbsvm_...)`);
  process.exit(cmd ? 1 : 0);
}
await table[cmd]!();
