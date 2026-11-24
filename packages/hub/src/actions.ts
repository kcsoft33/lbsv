import type { IdeaLink, Link } from "../../shared/src/types.ts";
import type { Live } from "./live.ts";
import type { Repo } from "./repo.ts";
import { NotFound } from "./repo.ts";
import type { CmdOutcome, CollectorHub } from "./collect.ts";

/**
 * Tab actions (SPEC §6.3). A tab is referenced by its live id (`browserId:nativeId`) plus,
 * optionally, the URL the user saw when they selected it. If the browser's tab has a different
 * URL by the time the command runs, it is NOT closed and is reported back.
 */
export interface TabRef { id: string; url?: string }
export type NotClosedReason = "url_changed" | "gone" | "offline" | "failed" | "timeout";
export interface CloseReport {
  closed: string[];
  notClosed: { id: string; reason: NotClosedReason }[];
  /** What to open again to undo the close, grouped by browser + original window. */
  reopen: { browserId: string; windowId: string; urls: string[] }[];
}

export class Actions {
  private live: Live;
  private repo: Repo;
  private collectors: CollectorHub;
  constructor(live: Live, repo: Repo, collectors: CollectorHub) { this.live = live; this.repo = repo; this.collectors = collectors; }

  async close(refs: TabRef[]): Promise<CloseReport> {
    const rows = this.live.lookup(refs.map((r) => r.id));
    const report: CloseReport = { closed: [], notClosed: [], reopen: [] };
    const byBrowser = new Map<string, { nativeId: string; liveId: string; url: string; windowId: string }[]>();
    for (const ref of refs) {
      const row = rows.get(ref.id);
      if (!row) { report.notClosed.push({ id: ref.id, reason: "gone" }); continue; }
      const list = byBrowser.get(row.browserId) ?? [];
      list.push({ nativeId: row.nativeId, liveId: row.id, url: ref.url ?? row.url, windowId: row.windowId });
      byBrowser.set(row.browserId, list);
    }
    await Promise.all([...byBrowser].map(async ([browserId, tabs]) => {
      const out = await this.collectors.command(browserId, { op: "close_tabs", args: { tabs: tabs.map((t) => ({ id: t.nativeId, url: t.url })) } });
      const byNative = new Map(tabs.map((t) => [t.nativeId, t]));
      if (!out.ok) {
        const reason: NotClosedReason = out.error === "offline" ? "offline" : out.error === "timeout" ? "timeout" : "failed";
        for (const t of tabs) report.notClosed.push({ id: t.liveId, reason });
        return;
      }
      const closed = (out.result.closed ?? []).map((n) => byNative.get(String(n))).filter((t): t is NonNullable<typeof t> => !!t);
      for (const s of out.result.skipped ?? []) {
        const t = byNative.get(String(s.id));
        if (t) report.notClosed.push({ id: t.liveId, reason: s.reason });
      }
      if (!closed.length) return;
      report.closed.push(...closed.map((t) => t.liveId));
      this.live.removeTabs(closed.map((t) => t.liveId)); // the collector's delta will confirm; update the UI now
      const byWin = new Map<string, string[]>();
      for (const t of closed) byWin.set(t.windowId, [...(byWin.get(t.windowId) ?? []), t.url]);
      for (const [windowId, urls] of byWin) report.reopen.push({ browserId, windowId, urls });
    }));
    return report;
  }

  /**
   * Park & close: save the tabs as links in a project, and only after that commit, close them.
   * If closing fails (browser offline, URL changed…), the links stay saved.
   */
  async park(opts: { projectId?: string; newProject?: string; tabs: TabRef[]; close: boolean }): Promise<{ projectId: string; projectName: string; added: Link[] } & CloseReport> {
    let projectId = opts.projectId;
    if (opts.newProject) projectId = this.repo.createProject({ name: opts.newProject }).id;
    const project = projectId ? this.repo.project(projectId) : undefined;
    if (!project) throw new NotFound("project");
    const rows = this.live.lookup(opts.tabs.map((r) => r.id));
    const links = opts.tabs.flatMap((ref) => {
      const row = rows.get(ref.id);
      const url = ref.url ?? row?.url;
      if (!url) return [];
      return [{ url, label: row?.title ?? "", where: row ? this.live.browserLabel(row.browserId) : "" }];
    });
    const added = this.repo.addLinks(project.id, links); // committed here (synchronous transaction)
    const report = opts.close ? await this.close(opts.tabs) : { closed: [], notClosed: [], reopen: [] };
    return { projectId: project.id, projectName: project.name, added, ...report };
  }

  /**
   * Attach tabs to an idea (existing, or created here in a project or the inbox) as URLs, then
   * optionally close them. Same ordering guarantee as park: links are committed before any close.
   */
  async attach(opts: { ideaId?: string; newIdea?: { text: string; projectId: string | null }; tabs: TabRef[]; close: boolean }):
    Promise<{ ideaId: string; ideaText: string; projectId: string | null; createdIdea: boolean; added: IdeaLink[] } & CloseReport> {
    let ideaId = opts.ideaId;
    if (opts.newIdea) ideaId = this.repo.addIdea({ text: opts.newIdea.text, projectId: opts.newIdea.projectId }).id;
    const owner = this.repo.ideaOwner(ideaId!); // NotFound for an unknown idea
    const rows = this.live.lookup(opts.tabs.map((r) => r.id));
    const links = opts.tabs.flatMap((ref) => {
      const row = rows.get(ref.id);
      const url = ref.url ?? row?.url;
      return url ? [{ url, title: row?.title ?? "", where: row ? this.live.browserLabel(row.browserId) : "" }] : [];
    });
    const added = this.repo.addIdeaLinks(ideaId!, links);
    const text = (this.repo.db.prepare("SELECT text FROM ideas WHERE id = ?").get(ideaId) as { text: string }).text;
    const report = opts.close ? await this.close(opts.tabs) : { closed: [], notClosed: [], reopen: [] };
    return { ideaId: ideaId!, ideaText: text, projectId: owner || null, createdIdea: !!opts.newIdea, added, ...report };
  }

  /**
   * Send tabs to another browser/device: open them there first, and only if that worked, close the
   * originals (same id + URL rule). Tabs already in the target browser are left alone.
   */
  async send(refs: TabRef[], toBrowserId: string, close: boolean): Promise<({ ok: true; opened: number } & CloseReport) | { ok: false; error: string }> {
    const rows = this.live.lookup(refs.map((r) => r.id));
    const moving = refs.filter((r) => rows.get(r.id)?.browserId !== toBrowserId);
    const urls = [...new Set(moving.map((r) => r.url ?? rows.get(r.id)?.url).filter((u): u is string => !!u))];
    if (!urls.length) return { ok: true, opened: 0, closed: [], notClosed: [], reopen: [] };
    const out = await this.open(toBrowserId, urls, this.live.targetWindow(toBrowserId));
    if (!out.ok) return { ok: false, error: out.error };
    const report = close ? await this.close(moving.filter((r) => rows.has(r.id))) : { closed: [], notClosed: [], reopen: [] };
    return { ok: true, opened: out.result.opened ?? 0, ...report };
  }

  async focus(tabId: string): Promise<CmdOutcome | null> {
    const row = this.live.lookup([tabId]).get(tabId);
    if (!row) return null;
    return this.collectors.command(row.browserId, { op: "focus_tab", args: { tabId: row.nativeId, windowId: row.windowId } });
  }

  open(browserId: string, urls: string[], windowId?: string): Promise<CmdOutcome> {
    return this.collectors.command(browserId, { op: "open_url", args: { urls, windowId } });
  }
}
