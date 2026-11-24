import { describe, expect, it } from "vitest";
import { folderName, localCommand, reconnectCommand, redactCommand, shq, tildePath } from "../src/terms.ts";

describe("redactCommand", () => {
  const cases: [string, string][] = [
    ["git status", "git status"],
    ["curl -H 'Authorization: Bearer abc.def.ghi' https://api.x/y", "curl -H 'Authorization: Bearer [redacted]' https://api.x/y"],
    ["curl https://api.x/y?token=s3cret&page=2", "curl https://api.x/y?page=2"],
    ["git clone https://kelly:hunter2@forge.example/x.git", "git clone https://forge.example/x.git"],
    ["GITHUB_TOKEN=ghp_abc gh pr list", "GITHUB_TOKEN=[redacted] gh pr list"],
    ["export API_KEY='abc def'", "export API_KEY=[redacted]"],
    ["$env:OPENAI_API_KEY = \"sk-1\"", "$env:OPENAI_API_KEY = [redacted]"],
    ["mytool --password hunter2 --user k", "mytool --password [redacted] --user k"],
    ["mytool --api-key=xyz", "mytool --api-key=[redacted]"],
    ["mysql -u root -phunter2 db", "mysql -u root -p[redacted] db"],
    ["sshpass -p hunter2 ssh box", "sshpass -p [redacted] ssh box"],
    ["docker login -p hunter2 reg", "docker login -p hunter2 reg"], // short -p is too ambiguous in general (ports, paths)
    ["echo one\necho two", "echo one ⏎ echo two"],
  ];
  for (const [input, want] of cases) it(JSON.stringify(input), () => expect(redactCommand(input)).toBe(want));

  it("keeps innocent words that merely contain secret-ish substrings in values", () => {
    expect(redactCommand("cd ~/git/tokenizer && npm test")).toBe("cd ~/git/tokenizer && npm test");
  });
  it("caps length", () => expect(redactCommand("x".repeat(10_000)).length).toBeLessThanOrEqual(2000));
});

describe("reconnect commands", () => {
  const linux = { os: "linux", hostname: "vm-iso-3" };
  it("tmux reattaches (or creates) the named session", () => {
    expect(reconnectCommand({ kind: "tmux", name: "work", cwd: "/x", shell: "" }, linux, { target: "", jump: "" }))
      .toBe("ssh -t vm-iso-3 'tmux new -A -s work'");
  });
  it("uses the configured target and jump host, and quotes odd names", () => {
    expect(reconnectCommand({ kind: "tmux", name: "my work", cwd: "/x", shell: "" }, linux, { target: "kelly@10.8.0.3", jump: "bastion" }))
      .toBe(`ssh -t -J bastion kelly@10.8.0.3 'tmux new -A -s '\\''my work'\\'''`);
  });
  it("screen attaches multi-display", () => {
    expect(reconnectCommand({ kind: "screen", name: "123.build", cwd: "", shell: "" }, linux, { target: "", jump: "" }))
      .toBe("ssh -t vm-iso-3 'screen -xRR 123.build'");
  });
  it("a plain shell opens a login shell in the same folder", () => {
    expect(reconnectCommand({ kind: "shell", name: "", cwd: "/srv/my app", shell: "bash" }, linux, { target: "", jump: "" }))
      .toBe(`ssh -t vm-iso-3 'cd '\\''/srv/my app'\\'' && exec "$SHELL" -l'`);
    expect(localCommand({ kind: "shell", name: "", cwd: "/srv/my app", shell: "bash" }, "linux")).toBe("cd '/srv/my app'");
  });
  it("Windows hosts get PowerShell", () => {
    const win = { os: "win32", hostname: "windows-box" };
    expect(reconnectCommand({ kind: "shell", name: "", cwd: "C:\\dev\\it's", shell: "pwsh" }, win, { target: "", jump: "" }))
      .toBe(`ssh -t windows-box pwsh -NoExit -Command "Set-Location -LiteralPath 'C:\\dev\\it''s'"`);
    expect(localCommand({ kind: "shell", name: "", cwd: "C:\\dev", shell: "bash" }, "win32")).toBe("Set-Location -LiteralPath 'C:\\dev'");
  });
});

describe("helpers", () => {
  it("shq", () => { expect(shq("a/b-c.d")).toBe("a/b-c.d"); expect(shq("a b")).toBe("'a b'"); expect(shq("it's")).toBe(`'it'\\''s'`); });
  it("folderName", () => { expect(folderName("/home/k/git/lbops/")).toBe("lbops"); expect(folderName("C:\\dev\\switchboard")).toBe("switchboard"); });
  it("tildePath", () => { expect(tildePath("/home/kelly/git", "kelly")).toBe("~/git"); expect(tildePath("/home/kellyx/git", "kelly")).toBe("/home/kellyx/git"); });
});
