/**
 * M3 acceptance: "a shell-hook timing test shows < 5 ms of prompt overhead". Runs each hook in a
 * real interactive shell when that shell is installed (bash, zsh, pwsh, Windows PowerShell) and
 * checks the file it writes. Skipped shells are reported as skipped, not passed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseShellFile } from "../src/shells.ts";

const HOOKS = resolve(import.meta.dirname, "..", "hooks");
// 5 ms per prompt is the M3 acceptance check; shared CI runners (CI=true) get 5× so CI checks correctness, not runner load
const BUDGET_MS = process.env.CI ? 25 : 5;
const N = 200;
const dir = mkdtempSync(join(tmpdir(), "lbsv-hooks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const has = (exe: string, args: string[]) => {
  try { return spawnSync(exe, args, { stdio: "ignore", timeout: 15_000 }).status === 0; } catch { return false; }
};
const env = (sub: string, extra: Record<string, string> = {}) => ({ ...process.env, LBSV_STATE_DIR: join(dir, sub), LBSV_RECORD_CMDS: "", ...extra });
const posix = (p: string) => p.replace(/\\/g, "/");
const onlyFile = (sub: string) => {
  const files = readdirSync(join(dir, sub));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, sub, files[0]), "utf8");
};

// On Windows, `bash` on PATH may be WSL's System32\bash.exe, which can't see C:/ paths: prefer Git Bash.
const GIT_BASH = join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
const BASH = process.platform === "win32" && existsSync(GIT_BASH) ? GIT_BASH : "bash";
const bashHook = posix(join(HOOKS, "lbsv.bash"));

describe.skipIf(!has(BASH, ["-c", `test -r '${bashHook}'`]))("bash hook", () => {
  it(`writes the state file, keeps $?, and costs < ${BUDGET_MS} ms per prompt`, () => {
    const out = execFileSync(BASH, ["--norc", "--noprofile", "-i"], {
      env: env("bash"), encoding: "utf8", timeout: 60_000,
      input: `. '${posix(join(HOOKS, "lbsv.bash"))}'
cd /
false; __lbsv_hook; echo "status=$?"
s=$EPOCHREALTIME; for ((i=0;i<${N};i++)); do __lbsv_hook; done; e=$EPOCHREALTIME
echo "elapsed=$s $e"
`,
    });
    expect(out).toContain("status=1"); // the user's exit status survives the hook
    // bash < 5 (macOS ships 3.2) has no $EPOCHREALTIME: the hook still has to work, but it can't time itself
    const m = out.match(/elapsed=([\d.]+) ([\d.]+)/);
    if (m) {
      const per = ((Number(m[2]) - Number(m[1])) * 1000) / N;
      console.log(`bash hook: ${per.toFixed(3)} ms per prompt`);
      expect(per).toBeLessThan(BUDGET_MS);
    } else console.log("bash hook: timing skipped (no $EPOCHREALTIME in this bash)");
    const st = parseShellFile(onlyFile("bash"), 0)!;
    expect(st.shell).toBe("bash");
    expect(st.cwd).toBe("/");
    expect(st.cmd).toBeUndefined(); // not recorded without opt-in
  });

  it("records the last command only with LBSV_RECORD_CMDS=1", () => {
    execFileSync(BASH, ["--norc", "--noprofile", "-i"], {
      env: env("bash-cmd", { LBSV_RECORD_CMDS: "1", HISTFILE: join(dir, "hist") }), encoding: "utf8", timeout: 30_000,
      input: `. '${posix(join(HOOKS, "lbsv.bash"))}'\nset -o history\necho hello-world\n__lbsv_hook\n`,
    });
    expect(parseShellFile(onlyFile("bash-cmd"), 0)!.cmd).toMatch(/echo hello-world|__lbsv_hook/);
  });

  it("does nothing in non-interactive shells", () => {
    execFileSync(BASH, ["--norc", "-c", `. '${posix(join(HOOKS, "lbsv.bash"))}'; type __lbsv_hook >/dev/null 2>&1 && echo loaded || echo skipped`], { env: env("bash-ni"), encoding: "utf8" });
    expect(() => readdirSync(join(dir, "bash-ni"))).toThrow();
  });
});

describe.skipIf(!has("zsh", ["-c", "true"]))("zsh hook", () => {
  it(`writes the state file and costs < ${BUDGET_MS} ms per prompt`, () => {
    const out = execFileSync("zsh", ["-f", "-i"], {
      env: env("zsh"), encoding: "utf8", timeout: 60_000,
      input: `source '${posix(join(HOOKS, "lbsv.zsh"))}'\ncd /\nzmodload zsh/datetime\ns=$EPOCHREALTIME; for ((i=0;i<${N};i++)); do __lbsv_hook; done; e=$EPOCHREALTIME\necho "elapsed=$s $e"\n`,
    });
    const [, s, e] = out.match(/elapsed=([\d.]+) ([\d.]+)/)!;
    const per = ((Number(e) - Number(s)) * 1000) / N;
    console.log(`zsh hook: ${per.toFixed(3)} ms per prompt`);
    expect(per).toBeLessThan(BUDGET_MS);
    expect(parseShellFile(onlyFile("zsh"), 0)).toMatchObject({ shell: "zsh", cwd: "/" });
  });
});

for (const ps of ["pwsh", "powershell"]) {
  describe.skipIf(!has(ps, ["-NoProfile", "-Command", "exit 0"]))(`${ps} hook`, () => {
    it(`writes the state file, keeps $LASTEXITCODE, and costs < ${BUDGET_MS} ms per prompt (including the default prompt)`, () => {
      const hook = join(HOOKS, "lbsv.ps1").replace(/'/g, "''");
      const out = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command",
        `. '${hook}'; Set-Location ([IO.Path]::GetTempPath()); $global:LASTEXITCODE = 7; $null = prompt; "exit=$LASTEXITCODE"; ` +
        `$t = Measure-Command { for ($i = 0; $i -lt ${N}; $i++) { $null = prompt } }; "per=" + ($t.TotalMilliseconds / ${N}); ` +
        `"loc=" + (Get-Location).ProviderPath; "<<" + [IO.File]::ReadAllText($global:__lbsvFile) + ">>"`,
      ], { env: env(ps), encoding: "utf8", timeout: 60_000 });
      expect(out).toContain("exit=7");
      const per = Number(out.match(/per=([\d.,]+)/)![1].replace(",", "."));
      console.log(`${ps} hook: ${per.toFixed(3)} ms per prompt`);
      expect(per).toBeLessThan(BUDGET_MS);
      const body = out.match(/<<([\s\S]*)>>/)![1];
      // the temp dir differs per OS (C:\…\Temp, /tmp, macOS /var/folders/…/T): compare with what PowerShell itself reports
      const loc = out.match(/^loc=(.*)$/m)![1]!.trim();
      expect(parseShellFile(body, 0)).toMatchObject({ shell: ps === "pwsh" ? "pwsh" : "powershell", cwd: loc });
      expect(readdirSync(join(dir, ps))).toEqual([]); // removed on a clean exit
    });
  });
}
