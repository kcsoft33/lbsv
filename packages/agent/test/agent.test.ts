import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseShellFile, readShells } from "../src/shells.ts";
import { parseScreenLs, parseTmuxPanes, parseTmuxSessions } from "../src/mux.ts";
import { composeTerms, msysToWindows } from "../src/agent.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lbsv-agent-")); dirs.push(d); return d; };

const file = (o: Record<string, string>, cmd?: string) =>
  ["v=1", ...Object.entries(o).map(([k, v]) => `${k}=${v}`), ...(cmd !== undefined ? [`cmd=${cmd}`] : [])].join("\n") + "\n";

describe("parseShellFile", () => {
  it("reads the hook format; mtime is the activity time", () => {
    const s = parseShellFile(file({ shell: "bash", pid: "42", tty: "/dev/pts/1", user: "k", host: "vm", started: "1700000000", tmux: "", tmux_pane: "", sty: "", cwd: "/home/k/my dir" }), 1_700_000_500_123.7);
    expect(s).toMatchObject({ shell: "bash", pid: 42, tty: "/dev/pts/1", cwd: "/home/k/my dir", startedAt: 1_700_000_000_000, lastActivityAt: 1_700_000_500_123 });
    expect(s!.cmd).toBeUndefined();
  });
  it("strips bash history numbering and keeps multi-line commands", () => {
    const s = parseShellFile(file({ shell: "bash", pid: "1", cwd: "/" }, "  123  for i in 1 2; do\n  echo $i\ndone"), 0);
    expect(s!.cmd).toBe("for i in 1 2; do\n  echo $i\ndone");
  });
  it("handles CRLF (Windows PowerShell) and rejects unknown versions / bad pids", () => {
    expect(parseShellFile("v=1\r\nshell=pwsh\r\npid=7\r\ncwd=C:\\dev\r\n", 0)).toMatchObject({ shell: "pwsh", pid: 7, cwd: "C:\\dev" });
    expect(parseShellFile("v=2\npid=7\n", 0)).toBeNull();
    expect(parseShellFile("v=1\npid=abc\n", 0)).toBeNull();
  });
});

describe("readShells", () => {
  it("drops (and deletes) files of shells that are gone; ignores non-pid files", () => {
    const d = tmp();
    writeFileSync(join(d, "100"), file({ shell: "bash", pid: "100", cwd: "/a" }));
    writeFileSync(join(d, "200"), file({ shell: "zsh", pid: "200", cwd: "/b" }));
    writeFileSync(join(d, "notes.txt"), "hello");
    utimesSync(join(d, "100"), new Date(5000), new Date(5000));
    const got = readShells(d, (s) => s.pid === 100);
    expect(got.map((s) => s.pid)).toEqual([100]);
    expect(got[0].lastActivityAt).toBe(5000);
    expect(readdirSync(d).sort()).toEqual(["100", "notes.txt"]);
  });
  it("a missing directory is just no shells", () => expect(readShells(join(tmpdir(), "lbsv-nope-" + Date.now()))).toEqual([]));
});

describe("tmux / screen parsers", () => {
  it("tmux list-sessions", () => {
    expect(parseTmuxSessions("work\t1\t3\t1700000000\t1700000100\t/home/k/git\nbg\t0\t1\t1700000000\t0\t/tmp\n\n")).toEqual([
      { name: "work", attached: 1, windows: 3, createdAt: 1_700_000_000_000, activityAt: 1_700_000_100_000, cwd: "/home/k/git" },
      { name: "bg", attached: 0, windows: 1, createdAt: 1_700_000_000_000, activityAt: undefined, cwd: "/tmp" },
    ]);
    expect(parseTmuxPanes("%0\twork\n%3\tbg\n").get("%3")).toBe("bg");
  });
  it("screen -ls with and without the date column; dead sessions skipped", () => {
    const out = `There are screens on:
\t12345.pts-0.vm\t(11/22/26 10:00:00)\t(Detached)
\t678.build\t(Attached)
\t999.gone\t(Dead ???)
3 Sockets in /run/screen/S-k.
`;
    expect(parseScreenLs(out)).toEqual([
      { id: "12345.pts-0.vm", pid: 12345, name: "pts-0.vm", attached: false },
      { id: "678.build", pid: 678, name: "build", attached: true },
    ]);
  });
});

describe("composeTerms", () => {
  const sh = (o: Partial<Parameters<typeof composeTerms>[0][number]>) => ({
    shell: "bash", pid: 1, tty: "", user: "k", host: "vm", tmux: "", tmuxPane: "", sty: "", cwd: "/", lastActivityAt: 1000, ...o,
  });
  it("folds shells into their tmux / screen session and keeps the latest command", () => {
    const terms = composeTerms(
      [
        sh({ pid: 10, tmux: "/tmp/tmux-1/default,99,0", tmuxPane: "%1", lastActivityAt: 5000, cmd: "npm test" }),
        sh({ pid: 11, tmux: "/tmp/tmux-1/default,99,0", tmuxPane: "%2", lastActivityAt: 4000, cmd: "older" }),
        sh({ pid: 12, sty: "678.build", cwd: "/srv/build", lastActivityAt: 3000 }),
        sh({ pid: 13, cwd: "/home/k", cmd: "curl https://x/?token=abc" }),
      ],
      [{ name: "work", attached: 1, windows: 2, cwd: "/home/k/git", activityAt: 2000 }],
      new Map([["%1", "work"], ["%2", "work"]]),
      [{ id: "678.build", pid: 678, name: "build", attached: true }],
      "k",
    );
    expect(terms.map((t) => t.id)).toEqual(["screen:678.build", "sh:13", "tmux:work"]);
    expect(terms.find((t) => t.id === "tmux:work")).toMatchObject({ kind: "tmux", name: "work", cwd: "/home/k/git", lastActivityAt: 5000, cmd: "npm test", attached: 1 });
    expect(terms.find((t) => t.id === "screen:678.build")).toMatchObject({ cwd: "/srv/build", lastActivityAt: 3000, attached: 1 });
    expect(terms.find((t) => t.id === "sh:13")!.cmd).toBe("curl https://x/"); // redacted before it leaves the device
  });
  it("a shell in a tmux the agent can't see stays a shell", () => {
    expect(composeTerms([sh({ pid: 5, tmux: "/x,1,0", tmuxPane: "%9" })], [], new Map(), [], "k")[0].id).toBe("sh:5");
  });
  it("Git Bash on Windows: Windows pid and Windows path", () => {
    const [t] = composeTerms([sh({ pid: 539, winpid: 56104, cwd: "/c/dev/switchboard" })], [], new Map(), [], "k");
    expect(t).toMatchObject({ id: "sh:56104", pid: 56104, cwd: "C:\\dev\\switchboard" });
    expect(msysToWindows("/c")).toBe("C:\\");
    expect(msysToWindows("/home/k")).toBe("/home/k");
  });
});
