import type { Rule, RuleKind } from "../../shared/src/rules.ts";
import type { ExportFile, Idea, IdeaLink, Link, Project, Session, State, Status } from "../../shared/src/types.ts";
import type { LiveState } from "../../shared/src/live.ts";

export interface CloseReport {
  closed: string[];
  notClosed: { id: string; reason: string }[];
  reopen: { browserId: string; windowId: string; urls: string[] }[];
}

export interface McpClient { id: string; name: string; createdAt: number; lastUsedAt: number | null }

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface BackupStatus {
  configured: boolean; dir?: string; keep?: number; everyHours?: number; count?: number;
  last?: { name: string; size: number; at: number } | null; lastError?: string | null;
}

/** Fired on any 401 so the app can show the login screen. */
export let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !url.startsWith("/api/login")) onUnauthorized();
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error ?? msg; } catch { /* not json */ }
    throw new ApiError(r.status, msg);
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}

export const api = {
  auth: () => call<{ configured: boolean; authenticated: boolean }>("GET", "/api/auth"),
  login: (passphrase: string) => call<{ ok: true }>("POST", "/api/login", { passphrase }),
  setup: (code: string, passphrase: string) => call<{ ok: true }>("POST", "/api/setup", { code, passphrase }),
  backups: () => call<BackupStatus>("GET", "/api/backups"),
  backupNow: () => call<BackupStatus & { ok: true }>("POST", "/api/backups"),
  logout: () => call<{ ok: true }>("POST", "/api/logout"),

  state: () => call<State>("GET", "/api/state"),
  createProject: (id: string, name: string) => call<Project>("POST", "/api/projects", { id, name }),
  patchProject: (id: string, patch: Partial<{ name: string; status: Status; leftOff: string; tags: string }>) =>
    call<Project>("PATCH", `/api/projects/${id}`, patch),
  putProject: (p: Project) => call<Project>("PUT", `/api/projects/${p.id}`, p),
  deleteProject: (id: string) => call<void>("DELETE", `/api/projects/${id}`),

  addLinks: (pid: string, links: Partial<Link>[]) => call<{ added: Link[] }>("POST", `/api/projects/${pid}/links`, { links }),
  deleteLink: (id: string) => call<void>("DELETE", `/api/links/${id}`),
  addSession: (pid: string, s: Partial<Session>) => call<Session>("POST", `/api/projects/${pid}/sessions`, s),
  deleteSession: (id: string) => call<void>("DELETE", `/api/sessions/${id}`),

  addIdea: (i: { id: string; text: string; projectId: string | null; at: number; links?: IdeaLink[] }) => call<Idea>("POST", "/api/ideas", i),
  addIdeaLinks: (ideaId: string, links: Partial<IdeaLink>[]) => call<{ added: IdeaLink[] }>("POST", `/api/ideas/${ideaId}/links`, { links }),
  deleteIdeaLink: (id: string) => call<void>("DELETE", `/api/idea-links/${id}`),
  moveIdea: (id: string, projectId: string | null) => call<{ ok: true }>("PATCH", `/api/ideas/${id}`, { projectId }),
  deleteIdea: (id: string) => call<void>("DELETE", `/api/ideas/${id}`),

  live: () => call<LiveState>("GET", "/api/live"),
  setGlobalDeny: (domains: string[]) => call<{ domains: string[] }>("PUT", "/api/live/deny", { domains }),
  createDevice: (name: string) => call<{ device: { id: string; name: string }; code: string; expiresAt: number }>("POST", "/api/devices", { name }),
  patchDevice: (id: string, patch: { name?: string; deny?: string[]; sshTarget?: string; sshJump?: string }) =>
    call<{ id: string; name: string; deny: string[]; ssh: { target: string; jump: string } }>("PATCH", `/api/devices/${id}`, patch),
  addRule: (projectId: string, r: { id?: string; kind: RuleKind; pattern: string; at?: number }) => call<Rule>("POST", `/api/projects/${projectId}/rules`, r),
  deleteRule: (id: string) => call<void>("DELETE", `/api/rules/${id}`),
  deviceCode: (id: string) => call<{ code: string; expiresAt: number }>("POST", `/api/devices/${id}/code`),
  cancelDeviceCode: (id: string) => call<void>("DELETE", `/api/devices/${id}/code`),
  revokeDevice: (id: string) => call<{ ok: true }>("POST", `/api/devices/${id}/revoke`),
  deleteDevice: (id: string) => call<void>("DELETE", `/api/devices/${id}`),

  mcpClients: () => call<{ clients: McpClient[] }>("GET", "/api/mcp-clients"),
  createMcpClient: (name: string) => call<{ client: McpClient; token: string }>("POST", "/api/mcp-clients", { name }),
  deleteMcpClient: (id: string) => call<void>("DELETE", `/api/mcp-clients/${id}`),

  downloads: () => call<{ packages: { file: string; target: string; version: string; size: number; url: string }[] }>("GET", "/api/downloads"),
  attach: (b: ({ ideaId: string } | { newIdea: { text: string; projectId: string | null } }) & { tabs: { id: string; url?: string }[]; close: boolean }) =>
    call<CloseReport & { ideaId: string; ideaText: string; projectId: string | null; createdIdea: boolean; added: IdeaLink[] }>("POST", "/api/live/attach", b),
  send: (tabs: { id: string; url?: string }[], toBrowserId: string) =>
    call<CloseReport & { ok: true; opened: number }>("POST", "/api/live/send", { tabs, toBrowserId, close: true }),
  focusTab: (tabId: string) => call<{ ok: true }>("POST", "/api/live/focus", { tabId }),
  closeTabs: (tabs: { id: string; url?: string }[]) => call<CloseReport>("POST", "/api/live/close", { tabs }),
  openTabs: (browserId: string, urls: string[], windowId?: string) => call<{ ok: true; opened: number }>("POST", "/api/live/open", { browserId, urls, windowId }),
  park: (b: ({ projectId: string } | { newProject: string }) & { tabs: { id: string; url?: string }[]; close: boolean }) =>
    call<CloseReport & { projectId: string; projectName: string; added: Link[] }>("POST", "/api/live/park", b),

  importData: (data: ExportFile, mode: "merge" | "replace") =>
    call<{ ok: true; projects: number; inbox: number }>("POST", "/api/import", { data, mode }),
};
