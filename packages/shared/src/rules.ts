/**
 * Rules and suggestions (SPEC §5 `rules`, §8 "Live now", §9 suggest_assignments): which project a
 * live tab or terminal probably belongs to, and why. Pure functions so the UI, the hub and (M4)
 * the MCP server agree.
 */
import { dupKey, hostOf } from "./live.ts";
import type { Project } from "./types.ts";

export type RuleKind = "url_prefix" | "domain" | "host" | "cwd_prefix" | "title_regex";
export const RULE_KINDS: RuleKind[] = ["domain", "url_prefix", "title_regex", "cwd_prefix", "host"];
export const RULE_LABELS: Record<RuleKind, string> = {
  domain: "Site (domain)",
  url_prefix: "URL starts with",
  title_regex: "Tab title matches",
  cwd_prefix: "Terminal folder under",
  host: "Terminal on host",
};

export interface Rule { id: string; projectId: string; kind: RuleKind; pattern: string; at: number }

export type Item =
  | { type: "tab"; url: string; title: string }
  | { type: "term"; cwd: string; host: string; name: string; device: string };

export interface Suggestion {
  projectId: string;
  /** "filed": the item is already saved in the project (link URL / saved session); "rule"/"guess": a suggestion. */
  how: "filed" | "rule" | "guess";
  reason: string;
  ruleId?: string;
}

const MAX_REGEX = 300;
const reCache = new Map<string, RegExp | null>();
/** Case-insensitive; invalid or oversized patterns never match (and are rejected by the API). */
export function compileTitleRegex(p: string): RegExp | null {
  if (reCache.has(p)) return reCache.get(p)!;
  let re: RegExp | null = null;
  if (p.length <= MAX_REGEX) { try { re = new RegExp(p, "i"); } catch { re = null; } }
  reCache.set(p, re);
  return re;
}

/** Normalise what the user typed for a rule; returns null if it can't be used. */
export function cleanRulePattern(kind: RuleKind, raw: string): string | null {
  const p = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!p || /[\x00-\x1f\x7f]/.test(p)) return null; // e.g. a "\b" that lost its backslash on the way in
  if (p.length > 2000) return null;
  switch (kind) {
    case "domain": {
      let d = p.toLowerCase();
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) d = hostOf(d);
      d = d.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "").replace(/[/:].*$/, "");
      return d || null;
    }
    case "host": return p.toLowerCase();
    case "url_prefix": return /^[a-z][a-z0-9+.-]*:/i.test(p) ? p : null;
    case "cwd_prefix": return p.replace(/[\\/]+$/, "") || p;
    case "title_regex": return compileTitleRegex(p) ? p : null;
  }
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const underPath = (cwd: string, prefix: string) => {
  const c = normPath(cwd), p = normPath(prefix);
  return !!p && (c === p || c.startsWith(p + "/"));
};
const normHost = (h: string) => h.toLowerCase().replace(/\..*$/, "");

/** Does this rule match the item? Returns the strength (longer = more specific) or 0. */
export function ruleScore(r: Pick<Rule, "kind" | "pattern">, it: Item): number {
  if (it.type === "tab") {
    switch (r.kind) {
      case "domain": {
        const h = hostOf(it.url); const d = r.pattern.toLowerCase();
        return h && (h === d || h.endsWith("." + d)) ? 100 + d.length : 0;
      }
      case "url_prefix": return it.url.toLowerCase().startsWith(r.pattern.toLowerCase()) ? 200 + r.pattern.length : 0;
      case "title_regex": return compileTitleRegex(r.pattern)?.test(it.title) ? 300 + r.pattern.length : 0;
      default: return 0;
    }
  }
  switch (r.kind) {
    case "cwd_prefix": return underPath(it.cwd, r.pattern) ? 200 + r.pattern.length : 0;
    case "host": {
      const p = r.pattern.toLowerCase();
      return it.host.toLowerCase() === p || normHost(it.host) === normHost(p) || it.device.toLowerCase() === p ? 100 + p.length : 0;
    }
    case "title_regex": return it.name && compileTitleRegex(r.pattern)?.test(it.name) ? 300 + r.pattern.length : 0;
    default: return 0;
  }
}

/** Letters and digits only, lowercase: "Job Search Tracker" → "jobsearchtracker". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface SuggestContext {
  projects: Project[];
  rules: Rule[];
}

/** Precomputed indexes; build once per render. */
export class Suggester {
  private byUrl = new Map<string, string>();
  private hostProjects = new Map<string, Set<string>>();
  private sessions: { projectId: string; host: string; label: string; cmd: string }[] = [];
  private names: { projectId: string; key: string }[] = [];
  private rules: Rule[];
  private live = new Set<string>();
  private projectName = new Map<string, string>();

  constructor(ctx: SuggestContext) {
    this.rules = ctx.rules;
    for (const p of ctx.projects) {
      this.projectName.set(p.id, p.name);
      if (p.status !== "done") this.live.add(p.id);
      for (const l of p.links) {
        if (!this.byUrl.has(dupKey(l.url))) this.byUrl.set(dupKey(l.url), p.id);
        const h = hostOf(l.url);
        if (h) { const s = this.hostProjects.get(h) ?? new Set(); s.add(p.id); this.hostProjects.set(h, s); }
      }
      for (const i of p.ideas) for (const l of i.links ?? []) if (!this.byUrl.has(dupKey(l.url))) this.byUrl.set(dupKey(l.url), p.id);
      for (const s of p.sessions) this.sessions.push({ projectId: p.id, host: s.host.toLowerCase(), label: s.label, cmd: s.cmd });
      const key = squash(p.name);
      if (key.length >= 3) this.names.push({ projectId: p.id, key });
    }
  }

  name(projectId: string): string { return this.projectName.get(projectId) ?? ""; }

  /** Best project for the item, or null. Filed beats rules beats guesses; done projects only when filed. */
  suggest(it: Item): Suggestion | null {
    if (it.type === "tab") {
      const filed = this.byUrl.get(dupKey(it.url));
      if (filed) return { projectId: filed, how: "filed", reason: `Saved in ${this.name(filed)}` };
    } else {
      const s = this.sessions.find((s) => (s.host === it.host.toLowerCase() || s.host === it.device.toLowerCase() || normHost(s.host) === normHost(it.host))
        && ((it.name && (s.label === it.name || s.cmd.includes(` -s ${it.name}`) || s.cmd.includes(`-xRR ${it.name}`))) || (!it.name && !!it.cwd && s.cmd.includes(it.cwd))));
      if (s) return { projectId: s.projectId, how: "filed", reason: `Saved session in ${this.name(s.projectId)}` };
    }
    let best: { r: Rule; score: number } | null = null;
    for (const r of this.rules) {
      if (!this.live.has(r.projectId)) continue;
      const score = ruleScore(r, it);
      if (score && (!best || score > best.score)) best = { r, score };
    }
    if (best) return { projectId: best.r.projectId, how: "rule", ruleId: best.r.id, reason: `Rule: ${describeRule(best.r)}` };

    if (it.type === "tab") {
      const h = hostOf(it.url);
      const ps = h ? [...(this.hostProjects.get(h) ?? [])].filter((id) => this.live.has(id)) : [];
      if (ps.length === 1) return { projectId: ps[0], how: "guess", reason: `Other pages from ${h} are saved in ${this.name(ps[0])}` };
      return null;
    }
    // Terminals: a folder (or tmux/screen session) named like a project.
    const segs = it.cwd.replace(/\\/g, "/").split("/").map(squash).filter(Boolean).reverse();
    const nm = squash(it.name.replace(/^\d+\./, "")); // screen: "12345.build" → "build"
    for (const n of this.names) {
      if (!this.live.has(n.projectId)) continue;
      if (nm && nm === n.key) return { projectId: n.projectId, how: "guess", reason: `Session is named like ${this.name(n.projectId)}` };
    }
    for (const seg of segs) {
      const n = this.names.find((n) => this.live.has(n.projectId) && n.key === seg);
      if (n) return { projectId: n.projectId, how: "guess", reason: `Folder is named like ${this.name(n.projectId)}` };
    }
    return null;
  }
}

export function describeRule(r: Pick<Rule, "kind" | "pattern">): string {
  switch (r.kind) {
    case "domain": return `site ${r.pattern}`;
    case "url_prefix": return `URL starts with ${r.pattern}`;
    case "title_regex": return `title matches /${r.pattern}/`;
    case "cwd_prefix": return `folder under ${r.pattern}`;
    case "host": return `on host ${r.pattern}`;
  }
}
