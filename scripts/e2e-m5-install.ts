/**
 * M5: the one-line agent installer, for real, on Linux (WSL with systemd) against a throwaway hub.
 *   npm run build && npm run build:agent && npm run e2e:install
 * Pairs via `curl …/install/agent.sh | sh -s -- CODE`, checks the systemd user service, the .bashrc
 * block and that the hub sees the agent online; re-runs (idempotent); then uninstalls and checks
 * that .bashrc is byte-for-byte what it was. Backs up ~/.bashrc in WSL first.
 * Env: LBSV_E2E_WSL (default Ubuntu-26.04), LBSV_E2E_HOST_IP (this machine's IP as seen from WSL).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/hub/src/db.ts";
import { buildApp } from "../packages/hub/src/app.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const DISTRO = process.env.LBSV_E2E_WSL || "Ubuntu-26.04";
const PORT = 18097;
const hostIp = process.env.LBSV_E2E_HOST_IP || Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("172."))?.address;
const PASS = "e2e-install-pass";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
/** Run a script in a WSL login shell (stdin, so wsl.exe can't mangle quotes). */
const wsl = (script: string) => new Promise<string>((res) => {
  // async: the hub under test runs in this process and must keep answering while WSL talks to it
  const p = execFile("wsl.exe", ["-d", DISTRO, "--", "bash", "-l", "-s"], { encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) => res(`${stdout}${stderr}${err ? "\n[exit≠0]" : ""}`));
  p.stdin!.end(script);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "lbsv-e2e-install-"));
const db = openDb(join(dataDir, "hub.db"));
const hub = await buildApp({ db, adminPassphrase: PASS, extPackagesDir: join(root, "packages", "ext", "dist", "packages") });
await hub.app.listen({ host: "0.0.0.0", port: PORT });
const base = `http://127.0.0.1:${PORT}`;
const login = await hub.app.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
const cookie = `lbsv_session=${login.cookies.find((c) => c.name === "lbsv_session")!.value}`;
const api = async (method: string, url: string, body?: object) => (await hub.app.inject({ method: method as "GET", url, payload: body, headers: { cookie } })).json();
const HUB = `http://${hostIp}:${PORT}`;

try {
  await wsl(`cp -p ~/.bashrc ~/.bashrc.lbsv-e2e-backup; systemctl --user disable --now lbsv-agent 2>/dev/null; true`);
  const before = (await wsl(`sha256sum ~/.bashrc | cut -d' ' -f1`)).trim();
  const { code } = await api("POST", "/api/devices", { name: "wsl-installer" });

  const out = (await wsl(`curl -fsSL ${HUB}/install/agent.sh | sh -s -- ${code} --record-cmds`));
  console.log(out.trim().split("\n").map((l) => "    " + l).join("\n"));
  check("one-liner pairs", /paired\s+as "wsl-installer"/.test(out));
  check("agent copied to ~/.local/share/lbsv-agent", (await wsl(`test -s ~/.local/share/lbsv-agent/lbsv-agent.mjs && echo yes`)).trim() === "yes");
  check("hooks embedded in the single file were written", (await wsl(`ls ~/.config/lbsv`)).includes("lbsv.bash"));
  check(".bashrc has one lbsv block", (await wsl(`grep -c '>>> lbsv (LabSave) >>>' ~/.bashrc`)).trim() === "1");
  check("a new interactive bash loads the hook", (await wsl(`bash -i -c 'type -t __lbsv_hook' 2>/dev/null`)).trim().endsWith("function"));
  check("systemd user service active", (await wsl(`systemctl --user is-active lbsv-agent`)).trim() === "active");

  let online = false;
  for (let i = 0; i < 40 && !online; i++) {
    const st = await api("GET", "/api/live");
    online = st.devices.some((d: { name: string; agents: { connected: boolean }[] }) => d.name === "wsl-installer" && d.agents.some((a) => a.connected));
    if (!online) await sleep(500);
  }
  check("hub sees the agent online", online);

  const again = (await wsl(`curl -fsSL ${HUB}/install/agent.sh | sh`));
  check("re-running without a code keeps the pairing", /paired\s+already/.test(again));
  check(".bashrc still has exactly one block", (await wsl(`grep -c '>>> lbsv (LabSave) >>>' ~/.bashrc`)).trim() === "1");
  check("re-running keeps the --record-cmds opt-in", (await wsl(`grep -c 'LBSV_RECORD_CMDS=1' ~/.bashrc`)).trim() === "1");

  const upToDate = await wsl(`node ~/.local/share/lbsv-agent/lbsv-agent.mjs update`);
  check("update: already current", /Up to date/.test(upToDate), upToDate.trim().split("\n")[0]);
  const upd = await wsl(`node ~/.local/share/lbsv-agent/lbsv-agent.mjs update --force; echo "exit=$?"`);
  const updOk = /Updating lbsv-agent/.test(upd) && /exit=0/.test(upd);
  check("update --force reinstalls from the hub", updOk, upd.trim().split("\n")[0]);
  if (!updOk) console.log(upd.trim().split("\n").map((l) => "    " + l).join("\n"));
  check("service active after update", (await wsl(`systemctl --user is-active lbsv-agent`)).trim() === "active");
  check("update keeps the --record-cmds opt-in", (await wsl(`grep -c 'LBSV_RECORD_CMDS=1' ~/.bashrc`)).trim() === "1");
  check("no download left behind", (await wsl(`ls ~/.local/share/lbsv-agent`)).trim() === "lbsv-agent.mjs");

  const un = (await wsl(`node ~/.local/share/lbsv-agent/lbsv-agent.mjs uninstall`));
  check("uninstall runs", /service removed/.test(un), un.trim().split("\n")[0]);
  check("service gone", (await wsl(`systemctl --user is-active lbsv-agent`)).trim() !== "active");
  check(".bashrc restored byte-for-byte", (await wsl(`sha256sum ~/.bashrc | cut -d' ' -f1`)).trim() === before);
  check("files and token removed", (await wsl(`ls -d ~/.config/lbsv ~/.local/share/lbsv-agent 2>/dev/null | wc -l`)).trim() === "0");
} finally {
  await wsl(`[ -f ~/.bashrc.lbsv-e2e-backup ] && mv -f ~/.bashrc.lbsv-e2e-backup ~/.bashrc; true`);
  await hub.app.close(); db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
