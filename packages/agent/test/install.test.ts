import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newer } from "../../shared/src/version.ts";
import { BEGIN, END, blockRecordsCmds, hookText, installFiles, installService, launchdPlist, rcBlock, removeBlock, systemdUnit, uninstall, upsertBlock, windowsTaskScript } from "../src/install.ts";

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lbsv-install-")); tmps.push(d); return d; };

describe("rc blocks", () => {
  it("append once, replace in place, remove cleanly (LF and CRLF)", () => {
    const b = rcBlock("bash", "/home/k/.config/lbsv");
    expect(b).toBe(`${BEGIN}\n[ -f "/home/k/.config/lbsv/lbsv.bash" ] && . "/home/k/.config/lbsv/lbsv.bash"\n${END}`);
    const orig = "alias ll='ls -l'\nexport X=1";
    const once = upsertBlock(orig, b);
    expect(once).toBe(`${orig}\n\n${b}\n`);
    expect(upsertBlock(once, b)).toBe(once); // idempotent
    const withCmds = upsertBlock(once, rcBlock("bash", "/home/k/.config/lbsv", true));
    expect(withCmds).toContain("export LBSV_RECORD_CMDS=1");
    expect(withCmds.split(BEGIN)).toHaveLength(2);
    expect(removeBlock(once)).toBe(orig + "\n");
    expect(upsertBlock("", b)).toBe(b + "\n");
    expect(removeBlock(upsertBlock("", b))).toBe("");
    const crlf = "line1\r\nline2\r\n";
    const c1 = upsertBlock(crlf, rcBlock("pwsh", "C:\\Users\\k\\.config\\lbsv"));
    expect(c1).not.toMatch(/[^\r]\n/);
    expect(c1).toContain(". 'C:\\Users\\k\\.config\\lbsv");
    expect(removeBlock(c1)).toBe(crlf);
  });
  it("zsh uses source and [[ ]]", () => {
    expect(rcBlock("zsh", "/u/.config/lbsv")).toContain(`[[ -f "/u/.config/lbsv/lbsv.zsh" ]] && source "/u/.config/lbsv/lbsv.zsh"`);
  });
});

describe("versions and updates", () => {
  it("compares x.y.z numerically", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
    expect(newer("0.1.0", "0.1.1")).toBe(false);
    expect(newer("1.0", "0.99.99")).toBe(true);
    expect(newer("0.2.0-beta", "0.1.9")).toBe(true);
  });
  it("re-running install without a flag keeps each rc block's command-recording choice", () => {
    const on = upsertBlock("# rc\n", rcBlock("bash", "/c", true));
    expect(blockRecordsCmds(on)).toBe(true);
    expect(blockRecordsCmds(upsertBlock("", rcBlock("pwsh", "C:\\x", true)))).toBe(true);
    expect(blockRecordsCmds(upsertBlock("# rc\n", rcBlock("zsh", "/c")))).toBe(false);
    expect(blockRecordsCmds("export LBSV_RECORD_CMDS=1\n")).toBe(false); // outside our block: not ours to judge
    const home = tmp();
    writeFileSync(join(home, ".bashrc"), on);
    const self = join(home, "lbsv-agent.mjs"); writeFileSync(self, "// a");
    const env = { HOME: home, SHELL: "/bin/bash", XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, "s"), XDG_DATA_HOME: join(home, "d") };
    const o = { self, service: false, env, os: "linux" as const, run: () => ({ ok: false, out: "" }), log: () => {} };
    installFiles({ ...o, recordCmds: undefined });
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain("export LBSV_RECORD_CMDS=1");
    installFiles({ ...o, recordCmds: false });
    expect(readFileSync(join(home, ".bashrc"), "utf8")).not.toContain("LBSV_RECORD_CMDS");
  });
});

describe("service definitions", () => {
  it("quote paths with spaces", () => {
    expect(systemdUnit("/opt/node 24/bin/node", "/home/k/.local/share/lbsv-agent/lbsv-agent.mjs")).toContain(`ExecStart="/opt/node 24/bin/node" "/home/k/.local/share/lbsv-agent/lbsv-agent.mjs" run`);
    expect(launchdPlist("/usr/local/bin/node", "/Users/k/a&b/lbsv-agent.mjs", "/tmp/l")).toContain("<string>/Users/k/a&amp;b/lbsv-agent.mjs</string>");
    const ps = windowsTaskScript("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\o'k\\AppData\\Local\\lbsv-agent\\lbsv-agent.mjs");
    expect(ps).toContain(`-Execute 'conhost.exe' -Argument '--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\o''k\\AppData\\Local\\lbsv-agent\\lbsv-agent.mjs" run'`);
    expect(ps).toContain("-Force");
  });
});

describe("install / uninstall (files only, fake commands)", () => {
  it("copies itself + hooks, sets up existing rc files and the login shell's, is idempotent, and uninstall undoes it", () => {
    const home = tmp();
    writeFileSync(join(home, ".bashrc"), "# mine\n");
    const profile = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    const env = { HOME: home, USERPROFILE: home, SHELL: "/usr/bin/zsh", XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(home, ".local", "share"), USER: "k" };
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "pwsh") return { ok: true, out: profile };
      if (cmd === "powershell") return { ok: false, out: "" };
      return { ok: true, out: "" };
    };
    const self = join(home, "Downloads", "lbsv-agent.mjs");
    mkdirSync(join(home, "Downloads")); writeFileSync(self, "// agent bundle");
    const logs: string[] = [];
    const o = { self, service: true, recordCmds: false, env, os: "linux" as const, run, log: (s: string) => logs.push(s) };
    const r = installFiles(o);
    expect(r.script).toBe(join(home, ".local", "share", "lbsv-agent", "lbsv-agent.mjs"));
    expect(readFileSync(r.script, "utf8")).toBe("// agent bundle");
    for (const h of ["lbsv.bash", "lbsv.zsh", "lbsv.ps1"]) expect(readFileSync(join(home, ".config", "lbsv", h), "utf8")).toBe(hookText(h as "lbsv.bash"));
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(BEGIN);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("lbsv.zsh"); // login shell, created
    expect(readFileSync(profile, "utf8")).toContain("lbsv.ps1");
    const snapshot = readFileSync(join(home, ".bashrc"), "utf8");
    installFiles(o);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(snapshot);
    expect(logs.join("\n")).toContain("(already set up)");

    expect(installService({ ...o, script: r.script })).toBe(true);
    const unit = readFileSync(join(home, ".config", "systemd", "user", "lbsv-agent.service"), "utf8");
    expect(unit).toContain(`"${r.script}" run`);
    expect(calls).toContain("systemctl --user enable --now lbsv-agent");
    expect(calls).toContain("loginctl enable-linger k");

    uninstall({ env, os: "linux", run, log: () => {} });
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe("# mine\n");
    expect(readFileSync(profile, "utf8")).not.toContain(BEGIN);
    expect(existsSync(join(home, ".config", "lbsv"))).toBe(false);
    expect(existsSync(join(home, ".local", "share", "lbsv-agent"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "lbsv-agent.service"))).toBe(false);
    expect(calls).toContain("systemctl --user disable --now lbsv-agent");
  });

  it("reports (doesn't throw) when systemd isn't available", () => {
    const home = tmp();
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, "d") };
    const logs: string[] = [];
    const ok = installService({ self: "x", script: "/x/lbsv-agent.mjs", service: true, recordCmds: false, env, os: "linux", log: (s) => logs.push(s),
      run: () => ({ ok: false, out: "System has not been booted with systemd" }) });
    expect(ok).toBe(false);
    expect(logs.join("\n")).toContain("nohup");
  });
});
