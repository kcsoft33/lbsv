import { describe, expect, it } from "vitest";
import { cleanRulePattern, ruleScore, Suggester, type Rule } from "../src/rules.ts";
import type { Project } from "../src/types.ts";

const P = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id, name, status: "active", leftOff: "", tags: "", createdAt: 0, updatedAt: 0, links: [], sessions: [], ideas: [], rules: [], ...extra,
});
const rule = (projectId: string, kind: Rule["kind"], pattern: string, id = `${projectId}-${kind}`): Rule => ({ id, projectId, kind, pattern, at: 0 });
const tab = (url: string, title = "") => ({ type: "tab" as const, url, title });
const term = (cwd: string, name = "", host = "vm1", device = "vm1") => ({ type: "term" as const, cwd, name, host, device });

describe("cleanRulePattern", () => {
  it("domain accepts URLs and wildcards", () => {
    expect(cleanRulePattern("domain", "https://Forge.Example.net/example/lbsv")).toBe("forge.example.net");
    expect(cleanRulePattern("domain", "*.example.org")).toBe("example.org");
  });
  it("rejects bad regexes and non-URL prefixes", () => {
    expect(cleanRulePattern("title_regex", "(unclosed")).toBeNull();
    expect(cleanRulePattern("url_prefix", "forge.example.net/x")).toBeNull();
    expect(cleanRulePattern("cwd_prefix", "/home/k/git/")).toBe("/home/k/git");
  });
});

describe("ruleScore", () => {
  it("domain matches subdomains only on a dot boundary", () => {
    expect(ruleScore(rule("a", "domain", "example.net"), tab("https://forge.example.net/x"))).toBeGreaterThan(0);
    expect(ruleScore(rule("a", "domain", "example.net"), tab("https://notexample.net/x"))).toBe(0);
  });
  it("cwd_prefix matches folder boundaries, either slash, any case", () => {
    expect(ruleScore(rule("a", "cwd_prefix", "C:\\dev\\switchboard"), term("c:/dev/switchboard/packages"))).toBeGreaterThan(0);
    expect(ruleScore(rule("a", "cwd_prefix", "/home/k/git/lb"), term("/home/k/git/lbops"))).toBe(0);
  });
  it("title_regex is case-insensitive; host ignores the domain part", () => {
    expect(ruleScore(rule("a", "title_regex", "paperclip|ppc"), tab("https://service.example.net/session/1", "PPC Service Outage Check"))).toBeGreaterThan(0);
    expect(ruleScore(rule("a", "host", "workstation"), term("/x", "", "workstation.example.net"))).toBeGreaterThan(0);
  });
  it("tab rules don't match terminals and vice versa", () => {
    expect(ruleScore(rule("a", "domain", "x.com"), term("/x"))).toBe(0);
    expect(ruleScore(rule("a", "cwd_prefix", "/x"), tab("https://x.com"))).toBe(0);
  });
});

describe("Suggester", () => {
  const lbops = P("lbops", "lbops", { links: [{ id: "l1", label: "", url: "https://forge.example.net/example/lbops/pulls/34", where: "", at: 0, position: 0 }] });
  const hermes = P("hermes", "Hermes & Paperclip", { rules: [rule("hermes", "title_regex", "paperclip|ppc")] });
  const infra = P("infra", "Homelab infra", { rules: [rule("infra", "domain", "example.org")] });
  const jst = P("jst", "Job Search Tracker", {
    sessions: [{ id: "s1", kind: "tmux", label: "jobs", host: "vm1", network: "", cmd: "ssh -t vm1 'tmux new -A -s jobs'", at: 0, position: 0 }],
  });
  const done = P("old", "Old thing", { status: "done", rules: [rule("old", "domain", "example.net")] });
  const projects = [lbops, hermes, infra, jst, done];
  const s = new Suggester({ projects, rules: projects.flatMap((p) => p.rules ?? []) });

  it("an already-saved URL is 'filed', ignoring fragment and trailing slash", () => {
    expect(s.suggest(tab("https://forge.example.net/example/lbops/pulls/34/#x"))).toMatchObject({ projectId: "lbops", how: "filed" });
  });
  it("rules beat guesses; the most specific rule wins; done projects are skipped", () => {
    const r = s.suggest(tab("https://service.example.net/session/9", "Paperclip Auth, Blog Redirect Loop"));
    expect(r).toMatchObject({ projectId: "hermes", how: "rule" });
    expect(s.suggest(tab("https://hub.example.org/x"))).toMatchObject({ projectId: "infra", how: "rule" });
    expect(s.suggest(tab("https://service.example.net/session/9", "Unrelated"))).toBeNull(); // "old" is done
  });
  it("guesses a project from other saved pages on the same host", () => {
    expect(s.suggest(tab("https://forge.example.net/example/lbops/issues"))).toMatchObject({ projectId: "lbops", how: "guess" });
  });
  it("terminals: saved session is filed; folder or session named like a project is a guess", () => {
    expect(s.suggest(term("/home/k", "jobs"))).toMatchObject({ projectId: "jst", how: "filed" });
    expect(s.suggest(term("/home/k/git/example/lbops/src"))).toMatchObject({ projectId: "lbops", how: "guess" });
    expect(s.suggest(term("/home/k", "job-search-tracker", "other"))).toMatchObject({ projectId: "jst", how: "guess" });
    expect(s.suggest(term("/tmp"))).toBeNull();
  });
});

describe("cleanRulePattern rejects control characters", () => {
  it("e.g. a regex whose \b became a backspace on the way in", () => {
    expect(cleanRulePattern("title_regex", "Paperclip|\bPPC\b")).toBeNull();
    expect(cleanRulePattern("title_regex", String.raw`Paperclip|\bPPC\b`)).toBe(String.raw`Paperclip|\bPPC\b`);
    expect(cleanRulePattern("cwd_prefix", "C:\tdev")).toBeNull();
  });
});
