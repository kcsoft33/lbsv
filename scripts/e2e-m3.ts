/**
 * M3 walkthrough: lbsv-agent on two real machines (this Windows box and a Linux "VM" in WSL),
 * real shells with the real hooks, real tmux + screen, rules and suggestions, offline replay.
 *   npm run build && npm run build:ext && npm run e2e:m3
 * Own throwaway hub on 0.0.0.0:LBSV_E2E_PORT (default 18096) so WSL can reach it over the LAN IP.
 * Env: LBSV_E2E_WSL (distro, default Ubuntu-26.04), LBSV_E2E_HOST_IP (this machine's IP as seen from WSL;
 * default: first non-internal IPv4).
 */
import { chromium, type Page } from "playwright-core";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const agentJs = join(root, "packages", "agent", "dist", "lbsv-agent.mjs");
const hooks = join(root, "packages", "agent", "hooks");
const PORT = Number(process.env.LBSV_E2E_PORT || 18096);
const HUB = `http://127.0.0.1:${PORT}`;
const PASS = "e2e-passphrase-cnlsft";
const DISTRO = process.env.LBSV_E2E_WSL || "Ubuntu-26.04";
const hostIp = process.env.LBSV_E2E_HOST_IP || Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("172."))?.address;
const headless = process.env.HEADED !== "1";
if (!existsSync(agentJs) || !existsSync(join(root, "packages", "ui", "dist", "index.html"))) { console.error("Build first: npm run build && npm run build:agent"); process.exit(2); }

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const until = async (fn: () => Promise<boolean>, ms = 4000, step = 50) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return Date.now() - t0; await new Promise((r) => setTimeout(r, step)); }
  return -1;
};
const wslPath = (p: string) => p.replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
// Scripts go over stdin: wsl.exe mangles quotes in arguments.
const wsl = (script: string, timeout = 30_000) => execFileSync("wsl.exe", ["-d", DISTRO, "--cd", "/", "--", "bash", "-l", "-s"], { input: script, encoding: "utf8", timeout }).replace(/\0/g, "");

const procs: ChildProcess[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "lbsv-e2e-m3-"));
const startHub = () => {
  const p = spawn(process.execPath, [join(root, "packages", "hub", "src", "cli.ts"), "serve"], {
    env: { ...process.env, LBSV_DATA_DIR: dataDir, LBSV_PORT: String(PORT), LBSV_HOST: "0.0.0.0", LBSV_ADMIN_PASSPHRASE: PASS, LBSV_LOG_LEVEL: "warn", LBSV_UI_DIR: join(root, "packages", "ui", "dist"), LBSV_FAVICONS: "0" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return p;
};
let hub = startHub();
if ((await until(async () => (await fetch(HUB + "/api/health")).ok, 15_000, 100)) < 0) throw new Error("hub didn't start");

let cookie = "";
const api = async (method: string, path: string, body?: object) => {
  const r = await fetch(HUB + path, { method, headers: body ? { "content-type": "application/json", cookie } : { cookie }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const login = async () => { const r = await fetch(HUB + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) }); cookie = (r.headers.get("set-cookie") || "").split(";")[0]!; };
await login();
type T = { kind: string; name: string; cwd: string; cmd: string; attached: number; shell: string };
const terms = async (device?: string): Promise<T[]> => ((await api("GET", "/api/live")) as { devices: { name: string; agents: { terms: T[] }[] }[] })
  .devices.filter((d) => !device || d.name === device).flatMap((d) => d.agents.flatMap((a) => a.terms));
const newCode = async (name: string) => (await api("POST", "/api/devices", { name })) as { code: string; device: { id: string } };

const winCfg = mkdtempSync(join(tmpdir(), "lbsv-e2e-wincfg-"));
const winState = join(winCfg, "shells");
const winEnv = { ...process.env, LBSV_CONFIG_DIR: winCfg, LBSV_STATE_DIR: winState };
const W = "/tmp/lbsv-e2e-m3";
let wslAgent: ChildProcess | null = null;

try {
  /* ---------- Windows: agent + PowerShell + Git Bash with the real hooks ---------- */
  const win = await newCode("i9-e2e");
  execFileSync(process.execPath, [agentJs, "enroll", "--hub", HUB, "--code", win.code], { env: winEnv, encoding: "utf8" });
  check("Windows agent pairs with a one-time code", existsSync(join(winCfg, "agent.json")) && JSON.parse(readFileSync(join(winCfg, "agent.json"), "utf8")).token.startsWith("lbsv_"));
  const winAgent = spawn(process.execPath, [agentJs, "run"], { env: winEnv, stdio: ["ignore", "ignore", "inherit"] });
  procs.push(winAgent);
  const pwsh = spawn("pwsh", ["-NoProfile", "-Command", `. '${join(hooks, "lbsv.ps1")}'; Set-Location C:\\Windows; $null = prompt; Start-Sleep 600`], { env: winEnv, stdio: "ignore" });
  procs.push(pwsh);
  const gbash = spawn("bash", ["--norc", "--noprofile", "-i"], { env: winEnv, stdio: ["pipe", "ignore", "ignore"] });
  gbash.stdin!.write(`. '${hooks.replace(/\\/g, "/")}/lbsv.bash'\ncd /c/dev\n__lbsv_hook\nsleep 600\n`);
  procs.push(gbash);
  const tWin = await until(async () => { const t = await terms("i9-e2e"); return t.some((x) => x.shell === "pwsh" && /^C:\\Windows$/i.test(x.cwd)) && t.some((x) => x.shell === "bash" && x.cwd === "C:\\dev"); }, 10_000);
  check("Windows: PowerShell and Git Bash appear with their folders (Git Bash /c/dev → C:\\dev)", tWin >= 0, `${tWin} ms`);

  /* ---------- Linux (WSL): tmux, screen, plain shells, opt-in command recording ---------- */
  const lin = await newCode("wsl-vm");
  const hubFromWsl = `http://${hostIp}:${PORT}`;
  wsl(`rm -rf ${W}; mkdir -p ${W}/proj/sub; tmux kill-session -t e2ework 2>/dev/null; tmux kill-session -t e2edeploy 2>/dev/null; screen -S e2escreen -X quit 2>/dev/null; true`);
  const enrollOut = wsl(`LBSV_CONFIG_DIR=${W}/cfg node '${wslPath(agentJs)}' enroll --hub ${hubFromWsl} --code ${lin.code}`);
  check("Linux agent (WSL, over the LAN IP) pairs", /Paired as "wsl-vm"/.test(enrollOut), enrollOut.trim().split("\n")[0]);
  // Hook timing on real Linux.
  const t = wsl(`export LBSV_STATE_DIR=${W}/timing; bash --norc --noprofile -i <<'EOF' 2>/dev/null | grep per=
. '${wslPath(join(hooks, "lbsv.bash"))}'
s=$EPOCHREALTIME; for ((i=0;i<500;i++)); do __lbsv_hook; done; e=$EPOCHREALTIME
echo "per=$(awk "BEGIN{print ($e-$s)*1000/500}")"
EOF`);
  const perMs = Number(t.match(/per=([\d.]+)/)?.[1]);
  check("bash hook on Linux costs < 5 ms per prompt", perMs < 5, `${perMs.toFixed(3)} ms`);

  const rc = `${W}/rc`;
  wsl(`cat > ${rc} <<'EOF'
export LBSV_STATE_DIR=${W}/shells
. '${wslPath(join(hooks, "lbsv.bash"))}'
EOF
cat > ${W}/rc-rec <<'EOF'
export LBSV_STATE_DIR=${W}/shells LBSV_RECORD_CMDS=1 HISTFILE=${W}/hist
. '${wslPath(join(hooks, "lbsv.bash"))}'
EOF
tmux new-session -d -s e2ework -c ${W}/proj "bash --rcfile ${rc} -i"
screen -dmS e2escreen bash --rcfile ${rc} -i
true`);
  // A plain shell in the project folder, and one with recording on that runs a command with a secret.
  wslAgent = spawn("wsl.exe", ["-d", DISTRO, "--cd", "/", "--", "bash", "-l", "-s"], { stdio: ["pipe", "ignore", "inherit"] });
  wslAgent.stdin!.end(
    `(cd ${W}/proj/sub && script -qfc "bash --rcfile ${rc} -i" /dev/null < <(sleep 900) > /dev/null 2>&1 &)
     (cd ${W} && script -qfc "bash --rcfile ${W}/rc-rec -i" /dev/null < <(sleep 2; echo "curl -s https://api.example/x?token=s3cret >/dev/null"; sleep 900) > /dev/null 2>&1 &)
     exec env LBSV_CONFIG_DIR=${W}/cfg LBSV_STATE_DIR=${W}/shells node '${wslPath(agentJs)}' run\n`);
  procs.push(wslAgent);
  const tLin = await until(async () => {
    const x = await terms("wsl-vm");
    return x.some((t) => t.kind === "tmux" && t.name === "e2ework") && x.some((t) => t.kind === "screen") && x.some((t) => t.kind === "shell" && t.cwd === `${W}/proj/sub`) && x.some((t) => t.cmd.includes("curl"));
  }, 25_000, 200);
  const lt = await terms("wsl-vm");
  check("Linux: tmux session, screen session and plain shells appear", tLin >= 0, `${tLin} ms; ${lt.map((t) => `${t.kind}:${t.name || t.cwd}`).join(", ")}`);
  check("shells inside tmux / screen are folded into the session (no duplicate rows)", lt.filter((t) => t.kind === "shell").length === 2, `${lt.filter((t) => t.kind === "shell").length} plain shells`);
  check("tmux row carries the pane's folder", lt.find((t) => t.name === "e2ework")?.cwd === `${W}/proj`);
  const rec = lt.find((t) => t.cmd.includes("curl"))?.cmd ?? "";
  check("opt-in command recording works and is redacted", rec.includes("https://api.example/x") && !rec.includes("s3cret"), rec);
  check("command text is NOT recorded without the opt-in", lt.filter((t) => t.kind === "shell" && !t.cmd.includes("curl")).every((t) => !t.cmd));

  /* ---------- UI ---------- */
  const ui = await chromium.launch({ channel: "msedge", headless });
  const ctx = await ui.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const U: Page = await ctx.newPage();
  const errors: string[] = [];
  U.on("pageerror", (e) => errors.push(String(e)));
  U.on("dialog", (d) => void d.accept("lbsv e2e project"));
  await U.goto(HUB);
  await U.locator("#loginPass").fill(PASS); await U.locator("#loginPass").press("Enter");
  await U.locator("#login").waitFor({ state: "hidden" });
  await U.goto(HUB + "/#live");
  await U.waitForSelector(".row.lterm");
  const rowsN = await U.locator(".row.lterm").count();
  check("Live view lists the terminals of both machines", rowsN === lt.length + (await terms("i9-e2e")).length, `${rowsN} rows`);
  const tmuxRow = U.locator(".row.lterm", { hasText: "e2ework" });
  const sshCmd = await tmuxRow.locator("[data-act=copy]").first().getAttribute("data-text");
  const hostname = wsl("hostname").trim();
  check("tmux row has a reconnect command", sshCmd === `ssh -t ${hostname} 'tmux new -A -s e2ework'`, sshCmd ?? "");

  // SSH target per device changes the command.
  await U.goto(HUB + "/#devices");
  const devCard = U.locator("section[data-device]", { hasText: "wsl-vm" });
  check("Devices page shows the agent", await devCard.locator("text=Terminals ·").count() > 0);
  await devCard.locator("input[data-ssh=target]").fill("kelly@10.8.0.3");
  await devCard.locator("input[data-ssh=jump]").fill("bastion");
  await devCard.locator("input[data-ssh=jump]").press("Tab");
  await U.waitForTimeout(400);
  await U.goto(HUB + "/#live");
  await U.waitForSelector(".row.lterm");
  const sshCmd2 = await U.locator(".row.lterm", { hasText: "e2ework" }).locator("[data-act=copy]").first().getAttribute("data-text");
  check("device SSH target + jump host flow into the command", sshCmd2 === "ssh -t -J bastion kelly@10.8.0.3 'tmux new -A -s e2ework'", sshCmd2 ?? "");

  // The remote part really reattaches to the existing session (run on the "VM"; no sshd in WSL, so the ssh hop itself isn't exercised).
  const remote = sshCmd!.replace(/^ssh -t \S+ '(.*)'$/, "$1");
  // A long-lived wsl.exe, so the attached client isn't torn down with a short-lived WSL session.
  const attach = spawn("wsl.exe", ["-d", DISTRO, "--cd", "/", "--", "bash", "-l", "-s"], { stdio: ["pipe", "ignore", "ignore"] });
  procs.push(attach);
  attach.stdin!.end(`exec script -qfc "${remote}" /dev/null < <(sleep 60)\n`);
  const clients = await until(async () => wsl(`tmux list-clients -t e2ework 2>/dev/null | wc -l`).trim() === "1", 10_000, 300);
  const att = await until(async () => (await terms("wsl-vm")).find((t) => t.name === "e2ework")?.attached === 1, 25_000, 300); // next tmux poll (15 s)
  const sessions = wsl(`tmux list-sessions -F '#{session_name}' | grep -c e2ework`).trim();
  check("the reconnect command's remote part attaches a client to the session", clients >= 0);
  check("reconnect command attaches to the SAME tmux session (no new one), and the hub sees it attached", att >= 0 && sessions === "1", `${att} ms (next tmux poll)`);
  await U.reload(); await U.waitForSelector(".row.lterm");
  check("UI shows it as attached", await U.locator(".row.lterm", { hasText: "e2ework" }).locator(".chip", { hasText: "attached" }).count() > 0);

  // Rules + suggestions.
  const proj = (await api("POST", "/api/projects", { name: "lbsv e2e project" })) as { id: string };
  await api("POST", `/api/projects/${proj.id}/rules`, { kind: "cwd_prefix", pattern: `${W}/proj` });
  await U.reload(); await U.waitForSelector(".row.lterm");
  const sugg = U.locator(".row.lterm .chip.sugg");
  const nSugg = await sugg.count();
  check("a folder rule suggests the project for matching terminals (tmux + the shell in proj/sub)", nSugg === 2, `${nSugg} suggestions`);
  await U.locator(".row.lterm", { hasText: "e2ework" }).locator(".chip.sugg").click();
  await U.waitForTimeout(500);
  const p1 = (await api("GET", `/api/projects/${proj.id}`)) as { sessions: { kind: string; label: string; cmd: string }[] };
  check("accepting saves the terminal as a session with its reconnect command", p1.sessions.some((s) => s.kind === "tmux" && s.label === "e2ework" && s.cmd.includes("tmux new -A -s e2ework")), JSON.stringify(p1.sessions.map((s) => s.label)));
  await U.reload(); await U.waitForSelector(".row.lterm");
  check("…and it now shows as filed", await U.locator(".row.lterm", { hasText: "e2ework" }).locator(".chip.filed").count() === 1);
  await U.locator("[data-act=liveUnfiled]").click();
  await U.waitForTimeout(200);
  check("Unfiled hides it", await U.locator(".row.lterm", { hasText: "e2ework" }).count() === 0);
  await U.locator("[data-act=liveUnfiled]").click();
  await U.goto(HUB + "/#" + proj.id);
  await U.waitForSelector(".livenow");
  check("project page: Live now lists its terminals (saved session + rule)", await U.locator(".livenow .row.lterm").count() === 2);
  check("project page: Rules card shows the rule and what it matches", (await U.locator(".row.rule").innerText()).includes("2 open now"));

  // Search.
  await U.locator("#q").fill("e2ework");
  await U.waitForTimeout(300);
  check("global search finds live terminals", await U.locator("section", { hasText: "Live terminals" }).locator(".hit").count() >= 1);
  check("no UI errors", errors.length === 0, errors.join(" | "));
  await ui.close();

  /* ---------- offline: hub down, things change, hub back ---------- */
  hub.kill(); await new Promise((r) => hub.once("exit", r));
  wsl(`tmux kill-session -t e2ework; tmux new-session -d -s e2edeploy -c /srv 2>/dev/null || tmux new-session -d -s e2edeploy; screen -S e2escreen -X quit; true`);
  await new Promise((r) => setTimeout(r, 20_000)); // > one tmux poll, so the agent's state has moved on while the hub is down
  hub = startHub();
  await until(async () => (await fetch(HUB + "/api/health")).ok, 15_000, 100);
  await login();
  const back = await until(async () => {
    const x = await terms("wsl-vm");
    return x.some((t) => t.name === "e2edeploy") && !x.some((t) => t.name === "e2ework") && !x.some((t) => t.kind === "screen");
  }, 45_000, 250);
  check("after a hub outage the agent reconnects and replays its current state (ended sessions gone, new one present)", back >= 0, `${back} ms after the hub came back`);
  const wb = await until(async () => (await terms("i9-e2e")).length >= 2, 30_000, 250);
  check("…for the Windows agent too", wb >= 0);

  /* ---------- revoke ---------- */
  await api("POST", `/api/devices/${lin.device.id}/revoke`);
  check("revoking the device drops its terminals", (await terms("wsl-vm")).length === 0);
} finally {
  for (const p of procs) try { p.kill(); } catch { /* gone */ }
  try { hub.kill(); } catch { /* gone */ }
  try { wsl(`tmux kill-session -t e2ework 2>/dev/null; tmux kill-session -t e2edeploy 2>/dev/null; screen -S e2escreen -X quit 2>/dev/null; pkill -f '${W}' 2>/dev/null; rm -rf ${W}; true`); } catch { /* best effort */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(winCfg, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll M3 checks passed.");
process.exit(failed ? 1 : 0);
