import type { DB } from "./db.ts";
import type { Idea, IdeaLink, Link, Project, Session, State, Status } from "../../shared/src/types.ts";
import { ulid } from "../../shared/src/ulid.ts";
import { cleanRulePattern, type Rule, type RuleKind } from "../../shared/src/rules.ts";

/* Row shapes as stored. */
interface ProjectRow { id: string; name: string; status: Status; left_off: string; tags: string; created_at: number; updated_at: number }
interface LinkRow { id: string; project_id: string; label: string; url: string; where_hint: string; created_at: number; position: number }
interface SessionRow { id: string; project_id: string; kind: string; label: string; host: string; network: string; cmd: string; created_at: number; position: number }
interface IdeaRow { id: string; project_id: string | null; text: string; created_at: number }
interface RuleRow { id: string; project_id: string; kind: RuleKind; pattern: string; created_at: number }
interface IdeaLinkRow { id: string; idea_id: string; url: string; title: string; where_hint: string; created_at: number; position: number }

export interface LinkInput { id?: string; label?: string; url: string; where?: string; at?: number; position?: number }
export interface SessionInput { id?: string; kind?: string; label?: string; host?: string; network?: string; cmd?: string; at?: number; position?: number }
export interface IdeaLinkInput { id?: string; url: string; title?: string; where?: string; at?: number; position?: number }
export interface IdeaInput { id?: string; text: string; projectId?: string | null; at?: number; links?: IdeaLinkInput[] }
export interface ProjectPatch { name?: string; status?: Status; leftOff?: string; tags?: string }

export class NotFound extends Error {
  constructor(what: string) { super(`${what} not found`); }
}

const toLink = (r: LinkRow): Link => ({ id: r.id, label: r.label, url: r.url, where: r.where_hint, at: r.created_at, position: r.position });
const toSession = (r: SessionRow): Session => ({ id: r.id, kind: r.kind, label: r.label, host: r.host, network: r.network, cmd: r.cmd, at: r.created_at, position: r.position });
const toIdea = (r: IdeaRow): Idea => ({ id: r.id, text: r.text, at: r.created_at, links: [] });
const toRule = (r: RuleRow): Rule => ({ id: r.id, projectId: r.project_id, kind: r.kind, pattern: r.pattern, at: r.created_at });
const toIdeaLink = (r: IdeaLinkRow): IdeaLink => ({ id: r.id, url: r.url, title: r.title, where: r.where_hint, at: r.created_at, position: r.position });

/** All data access for saved (non-live) state. Every mutation that touches a project bumps its updated_at. */
export class Repo {
  readonly db: DB;
  private now: () => number;
  constructor(db: DB, now: () => number = Date.now) { this.db = db; this.now = now; }

  /* ---------------- reads ---------------- */

  state(): State {
    const projects = this.db.prepare("SELECT * FROM projects").all() as ProjectRow[];
    const links = this.db.prepare("SELECT * FROM links ORDER BY position, created_at").all() as LinkRow[];
    const sessions = this.db.prepare("SELECT * FROM sessions ORDER BY position, created_at").all() as SessionRow[];
    const ideas = this.db.prepare("SELECT * FROM ideas ORDER BY created_at DESC, id DESC").all() as IdeaRow[];
    const byId = new Map<string, Project>();
    for (const p of projects) byId.set(p.id, this.toProject(p, [], [], []));
    for (const l of links) byId.get(l.project_id)?.links.push(toLink(l));
    for (const s of sessions) byId.get(s.project_id)?.sessions.push(toSession(s));
    for (const r of this.db.prepare("SELECT * FROM rules ORDER BY created_at, id").all() as RuleRow[]) byId.get(r.project_id)?.rules!.push(toRule(r));
    const inbox: Idea[] = [];
    const ideaById = new Map<string, Idea>();
    for (const i of ideas) {
      const idea = toIdea(i);
      ideaById.set(i.id, idea);
      if (i.project_id == null) inbox.push(idea);
      else byId.get(i.project_id)?.ideas.push(idea);
    }
    for (const l of this.db.prepare("SELECT * FROM idea_links ORDER BY position, created_at").all() as IdeaLinkRow[]) ideaById.get(l.idea_id)?.links!.push(toIdeaLink(l));
    return { projects: [...byId.values()], inbox };
  }

  project(id: string): Project | undefined {
    const p = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!p) return undefined;
    const links = (this.db.prepare("SELECT * FROM links WHERE project_id = ? ORDER BY position, created_at").all(id) as LinkRow[]).map(toLink);
    const sessions = (this.db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY position, created_at").all(id) as SessionRow[]).map(toSession);
    const ideas = (this.db.prepare("SELECT * FROM ideas WHERE project_id = ? ORDER BY created_at DESC, id DESC").all(id) as IdeaRow[]).map(toIdea);
    for (const i of ideas) i.links = this.ideaLinks(i.id);
    const out = this.toProject(p, links, sessions, ideas);
    out.rules = this.rules(id);
    return out;
  }

  private toProject(p: ProjectRow, links: Link[], sessions: Session[], ideas: Idea[]): Project {
    return { id: p.id, name: p.name, status: p.status, leftOff: p.left_off, tags: p.tags, createdAt: p.created_at, updatedAt: p.updated_at, links, sessions, ideas, rules: [] };
  }

  private requireProject(id: string) {
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new NotFound("project");
  }

  private touch(projectId: string) {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(this.now(), projectId);
  }

  /* ---------------- projects ---------------- */

  createProject(input: { id?: string; name: string; status?: Status }): Project {
    const id = input.id ?? ulid();
    const now = this.now();
    this.db.prepare("INSERT INTO projects(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.name, input.status ?? "active", now, now);
    return this.project(id)!;
  }

  updateProject(id: string, patch: ProjectPatch): Project {
    this.requireProject(id);
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<keyof ProjectPatch, string> = { name: "name", status: "status", leftOff: "left_off", tags: "tags" };
    for (const k of Object.keys(map) as (keyof ProjectPatch)[]) {
      if (patch[k] !== undefined) { cols.push(`${map[k]} = ?`); vals.push(patch[k]); }
    }
    cols.push("updated_at = ?");
    vals.push(this.now(), id);
    this.db.prepare(`UPDATE projects SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
    return this.project(id)!;
  }

  deleteProject(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  /** Insert-or-replace a full nested project (used by undo-delete and import). */
  putProject(p: Project, opts: { touch?: boolean } = {}): void {
    this.db.transaction(() => {
      // Delete-then-insert so children that are no longer present go away (cascade).
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
      this.db.prepare("INSERT INTO projects(id, name, status, left_off, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, p.name, p.status, p.leftOff, p.tags, p.createdAt, opts.touch ? this.now() : p.updatedAt);
      const li = this.db.prepare("INSERT OR REPLACE INTO links(id, project_id, label, url, where_hint, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)");
      p.links.forEach((l, i) => li.run(l.id, p.id, l.label, l.url, l.where, l.at, l.position ?? i));
      const si = this.db.prepare("INSERT OR REPLACE INTO sessions(id, project_id, kind, label, host, network, cmd, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      p.sessions.forEach((s, i) => si.run(s.id, p.id, s.kind, s.label, s.host, s.network, s.cmd, s.at, s.position ?? i));
      const ii = this.db.prepare("INSERT OR REPLACE INTO ideas(id, project_id, text, created_at) VALUES (?, ?, ?, ?)");
      for (const i of p.ideas) { ii.run(i.id, p.id, i.text, i.at); this.replaceIdeaLinks(i.id, i.links ?? []); }
      const ri = this.db.prepare("INSERT OR IGNORE INTO rules(id, project_id, kind, pattern, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const r of p.rules ?? []) {
        const pattern = cleanRulePattern(r.kind, r.pattern);
        if (pattern) ri.run(r.id, p.id, r.kind, pattern, r.at ?? this.now());
      }
    })();
  }

  /* ---------------- rules (M3) ---------------- */

  rules(projectId: string): Rule[] {
    return (this.db.prepare("SELECT * FROM rules WHERE project_id = ? ORDER BY created_at, id").all(projectId) as RuleRow[]).map(toRule);
  }

  /** Add a rule; an identical one already on the project is returned instead. Null for an unusable pattern. */
  addRule(projectId: string, input: { id?: string; kind: RuleKind; pattern: string; at?: number }): Rule | null {
    return this.db.transaction(() => {
      this.requireProject(projectId);
      const pattern = cleanRulePattern(input.kind, input.pattern);
      if (!pattern) return null;
      const have = this.db.prepare("SELECT * FROM rules WHERE project_id = ? AND kind = ? AND pattern = ?").get(projectId, input.kind, pattern) as RuleRow | undefined;
      if (have) return toRule(have);
      const r: RuleRow = { id: input.id ?? ulid(), project_id: projectId, kind: input.kind, pattern, created_at: input.at ?? this.now() };
      this.db.prepare("INSERT INTO rules(id, project_id, kind, pattern, created_at) VALUES (?, ?, ?, ?, ?)").run(r.id, r.project_id, r.kind, r.pattern, r.created_at);
      this.touch(projectId);
      return toRule(r);
    })();
  }

  /** Returns the deleted rule (for undo), or null. */
  deleteRule(id: string): Rule | null {
    return this.db.transaction(() => {
      const r = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
      if (!r) return null;
      this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
      this.touch(r.project_id);
      return toRule(r);
    })();
  }

  /* ---------------- links ---------------- */

  /**
   * Add links to the top of a project's list (prototype order: newest first, pasted order kept).
   * URLs already in the project are skipped. Links with an explicit position (undo) keep it.
   */
  addLinks(projectId: string, input: LinkInput[]): Link[] {
    return this.db.transaction(() => {
      this.requireProject(projectId);
      const have = new Set((this.db.prepare("SELECT url FROM links WHERE project_id = ?").all(projectId) as { url: string }[]).map((r) => r.url));
      const min = (this.db.prepare("SELECT COALESCE(MIN(position), 0) AS m FROM links WHERE project_id = ?").get(projectId) as { m: number }).m;
      const fresh = input.filter((l) => {
        if (have.has(l.url)) return false;
        have.add(l.url);
        return true;
      });
      const ins = this.db.prepare("INSERT INTO links(id, project_id, label, url, where_hint, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const now = this.now();
      const out: Link[] = [];
      const withoutPos = fresh.filter((l) => l.position === undefined).length;
      let k = 0;
      for (const l of fresh) {
        const position = l.position ?? min - withoutPos + k++;
        const row: Link = { id: l.id ?? ulid(), label: l.label ?? "", url: l.url, where: l.where ?? "", at: l.at ?? now, position };
        ins.run(row.id, projectId, row.label, row.url, row.where, row.at, row.position);
        out.push(row);
      }
      if (out.length) this.touch(projectId);
      return out;
    })();
  }

  deleteLink(id: string): string | null {
    return this.deleteChild("links", id);
  }

  /* ---------------- sessions ---------------- */

  /** Append a saved session (or restore one at its old position). */
  addSession(projectId: string, s: SessionInput): Session {
    return this.db.transaction(() => {
      this.requireProject(projectId);
      const max = (this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM sessions WHERE project_id = ?").get(projectId) as { m: number }).m;
      const row: Session = {
        id: s.id ?? ulid(), kind: s.kind || "SSH", label: s.label ?? "", host: s.host ?? "", network: s.network ?? "",
        cmd: s.cmd ?? "", at: s.at ?? this.now(), position: s.position ?? max + 1,
      };
      this.db.prepare("INSERT INTO sessions(id, project_id, kind, label, host, network, cmd, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, projectId, row.kind, row.label, row.host, row.network, row.cmd, row.at, row.position);
      this.touch(projectId);
      return row;
    })();
  }

  deleteSession(id: string): string | null {
    return this.deleteChild("sessions", id);
  }

  /* ---------------- ideas / inbox ---------------- */

  addIdea(i: IdeaInput): Idea & { projectId: string | null } {
    return this.db.transaction(() => {
      const projectId = i.projectId ?? null;
      if (projectId) this.requireProject(projectId);
      const row = { id: i.id ?? ulid(), text: i.text, at: i.at ?? this.now(), projectId };
      this.db.prepare("INSERT INTO ideas(id, project_id, text, created_at) VALUES (?, ?, ?, ?)").run(row.id, projectId, row.text, row.at);
      const links = i.links?.length ? this.insertIdeaLinks(row.id, i.links) : [];
      if (projectId) this.touch(projectId);
      return { ...row, links };
    })();
  }

  /* ---------------- idea links (M2b) ---------------- */

  ideaLinks(ideaId: string): IdeaLink[] {
    return (this.db.prepare("SELECT * FROM idea_links WHERE idea_id = ? ORDER BY position, created_at").all(ideaId) as IdeaLinkRow[]).map(toIdeaLink);
  }

  /** The idea's owning project ("" = inbox); throws NotFound. */
  ideaOwner(ideaId: string): string {
    const r = this.db.prepare("SELECT project_id FROM ideas WHERE id = ?").get(ideaId) as { project_id: string | null } | undefined;
    if (!r) throw new NotFound("idea");
    return r.project_id ?? "";
  }

  /** Attach URLs to an idea; URLs it already has are skipped. Appended in the given order. */
  addIdeaLinks(ideaId: string, input: IdeaLinkInput[]): IdeaLink[] {
    return this.db.transaction(() => {
      const owner = this.ideaOwner(ideaId);
      const out = this.insertIdeaLinks(ideaId, input);
      if (out.length && owner) this.touch(owner);
      return out;
    })();
  }

  private insertIdeaLinks(ideaId: string, input: IdeaLinkInput[]): IdeaLink[] {
    const have = new Set((this.db.prepare("SELECT url FROM idea_links WHERE idea_id = ?").all(ideaId) as { url: string }[]).map((r) => r.url));
    let max = (this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM idea_links WHERE idea_id = ?").get(ideaId) as { m: number }).m;
    const ins = this.db.prepare("INSERT INTO idea_links(id, idea_id, url, title, where_hint, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const now = this.now();
    const out: IdeaLink[] = [];
    for (const l of input) {
      if (have.has(l.url)) continue;
      have.add(l.url);
      const row: IdeaLink = { id: l.id ?? ulid(), url: l.url, title: l.title ?? "", where: l.where ?? "", at: l.at ?? now, position: l.position ?? ++max };
      ins.run(row.id, ideaId, row.url, row.title, row.where, row.at, row.position);
      out.push(row);
    }
    return out;
  }

  private replaceIdeaLinks(ideaId: string, links: IdeaLinkInput[]): void {
    this.db.prepare("DELETE FROM idea_links WHERE idea_id = ?").run(ideaId);
    if (links.length) this.insertIdeaLinks(ideaId, links);
  }

  /** Returns { ideaId, projectId ("" = inbox) } or null when not found. */
  deleteIdeaLink(id: string): { ideaId: string; projectId: string } | null {
    return this.db.transaction(() => {
      const r = this.db.prepare("SELECT l.idea_id, i.project_id FROM idea_links l JOIN ideas i ON i.id = l.idea_id WHERE l.id = ?").get(id) as
        { idea_id: string; project_id: string | null } | undefined;
      if (!r) return null;
      this.db.prepare("DELETE FROM idea_links WHERE id = ?").run(id);
      if (r.project_id) this.touch(r.project_id);
      return { ideaId: r.idea_id, projectId: r.project_id ?? "" };
    })();
  }

  /** Move an idea between inbox (null) and projects. Returns {from, to}. */
  moveIdea(id: string, projectId: string | null): { from: string | null; to: string | null } {
    return this.db.transaction(() => {
      const cur = this.db.prepare("SELECT project_id FROM ideas WHERE id = ?").get(id) as { project_id: string | null } | undefined;
      if (!cur) throw new NotFound("idea");
      if (projectId) this.requireProject(projectId);
      this.db.prepare("UPDATE ideas SET project_id = ? WHERE id = ?").run(projectId, id);
      if (cur.project_id) this.touch(cur.project_id);
      if (projectId) this.touch(projectId);
      return { from: cur.project_id, to: projectId };
    })();
  }

  /** Returns the owning project id ("" for inbox) or null when not found. */
  deleteIdea(id: string): string | null {
    return this.db.transaction(() => {
      const cur = this.db.prepare("SELECT project_id FROM ideas WHERE id = ?").get(id) as { project_id: string | null } | undefined;
      if (!cur) return null;
      this.db.prepare("DELETE FROM ideas WHERE id = ?").run(id);
      if (cur.project_id) this.touch(cur.project_id);
      return cur.project_id ?? "";
    })();
  }

  private deleteChild(table: "links" | "sessions", id: string): string | null {
    return this.db.transaction(() => {
      const cur = this.db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: string } | undefined;
      if (!cur) return null;
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      this.touch(cur.project_id);
      return cur.project_id;
    })();
  }

  /* ---------------- import / export ---------------- */

  importState(s: State, mode: "merge" | "replace"): { projects: number; inbox: number } {
    return this.db.transaction(() => {
      if (mode === "replace") {
        this.db.exec("DELETE FROM rules; DELETE FROM idea_links; DELETE FROM ideas; DELETE FROM links; DELETE FROM sessions; DELETE FROM projects;");
      }
      for (const p of s.projects) this.putProject(p);
      const ii = this.db.prepare("INSERT OR REPLACE INTO ideas(id, project_id, text, created_at) VALUES (?, NULL, ?, ?)");
      for (const i of s.inbox) { ii.run(i.id, i.text, i.at); this.replaceIdeaLinks(i.id, i.links ?? []); }
      return { projects: s.projects.length, inbox: s.inbox.length };
    })();
  }

  /* ---------------- search (FTS5) ---------------- */

  /**
   * Multi-term AND prefix search over saved data. Each whitespace-separated term becomes a quoted
   * FTS prefix query, so user input can never inject FTS syntax.
   */
  search(q: string, limit = 50) {
    const terms = q.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
    if (!terms.length) return { projects: [], links: [], sessions: [], ideas: [], ideaLinks: [] };
    const match = terms.map((t) => `"${t}"*`).join(" AND ");
    const run = <T>(sql: string) => this.db.prepare(sql).all(match, limit) as T[];
    return {
      projects: run<{ id: string; name: string; status: Status }>(
        `SELECT p.id, p.name, p.status FROM projects_fts f JOIN projects p ON p.id = f.id WHERE projects_fts MATCH ? ORDER BY rank LIMIT ?`),
      links: run<{ id: string; projectId: string; label: string; url: string; where: string }>(
        `SELECT l.id, l.project_id AS projectId, l.label, l.url, l.where_hint AS "where" FROM links_fts f JOIN links l ON l.id = f.id WHERE links_fts MATCH ? ORDER BY rank LIMIT ?`),
      sessions: run<{ id: string; projectId: string; kind: string; label: string; host: string; network: string; cmd: string }>(
        `SELECT s.id, s.project_id AS projectId, s.kind, s.label, s.host, s.network, s.cmd FROM sessions_fts f JOIN sessions s ON s.id = f.id WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?`),
      ideas: run<{ id: string; projectId: string | null; text: string }>(
        `SELECT i.id, i.project_id AS projectId, i.text FROM ideas_fts f JOIN ideas i ON i.id = f.id WHERE ideas_fts MATCH ? ORDER BY rank LIMIT ?`),
      ideaLinks: run<{ id: string; ideaId: string; projectId: string | null; title: string; url: string }>(
        `SELECT l.id, l.idea_id AS ideaId, i.project_id AS projectId, l.title, l.url FROM idea_links_fts f JOIN idea_links l ON l.id = f.id JOIN ideas i ON i.id = l.idea_id WHERE idea_links_fts MATCH ? ORDER BY rank LIMIT ?`),
    };
  }
}
