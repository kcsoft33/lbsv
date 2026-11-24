/*
 * LabSave web UI. A port of the original UI prototype:
 * same information architecture, markup, keyboard shortcuts and render model.
 * The claude.ai storage layer is replaced by the hub's REST API (writes) and
 * WebSocket "changed" events (reads, debounced refetch).
 *
 * Edit-safety guarantee: incoming updates never re-render <main> while an
 * input/textarea/select inside it has focus; the pending render runs on blur. Field saves are
 * per-field PATCHes, so another window's edit to a different field can't clobber this one.
 */
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { parseLinks } from "../../shared/src/parseLinks.ts";
import { ulid } from "../../shared/src/ulid.ts";
import { STATUSES, SESSION_KINDS } from "../../shared/src/types.ts";
import type { ExportFile, Idea, IdeaLink, Link, Project, Session, State, Status } from "../../shared/src/types.ts";
import { api, ApiError, setUnauthorizedHandler } from "./api.ts";
import { newer } from "../../shared/src/version.ts";
import { CHROME_WEB_STORE_URL } from "../../shared/src/stores.ts";
import { dupKey, hostOf, type LiveBrowser, type LiveDevice, type LiveState, type LiveTab } from "../../shared/src/live.ts";
import { folderName, localCommand, reconnectCommand, sessionForTerm, tildePath, type LiveAgent, type LiveTerm } from "../../shared/src/terms.ts";
import { describeRule, ruleScore, RULE_KINDS, RULE_LABELS, Suggester, type Item, type Rule, type RuleKind, type Suggestion } from "../../shared/src/rules.ts";

type Field = "name" | "leftOff" | "tags" | "status";
type Hl = (s: string) => string;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const FIXED_VIEWS = new Set(["home", "inbox", "machines", "live", "devices"]);

const S = {
  projects: new Map<string, Project>(),
  inbox: [] as Idea[],
  filter: "active" as Status | "all",
  q: "",
  view: "home",
  loaded: false,
  authed: false,
  open: {} as Record<string, boolean>,
  confirmDel: null as string | null,
  _force: false,
  // M1: live tabs + devices
  live: null as LiveState | null,
  skew: 0, // hub clock - local clock
  liveQ: "",
  liveDup: false,
  liveUnfiled: false,
  liveOld: false,
  pair: null as { deviceId: string; name: string; code: string; expiresAt: number } | null,
  // M2: selection in the Live view (live tab id → the URL shown when it was selected)
  sel: new Map<string, string>(),
  ideaTo: "",
  sendTo: "",
  mcp: null as import("./api.ts").McpClient[] | null,
  mcpNew: null as { name: string; token: string } | null,
  backups: null as import("./api.ts").BackupStatus | null,
  backupBusy: false,
  downloads: null as { file: string; target: string; version: string; size: number; url: string }[] | null,
  parkTo: "",
};

/* ---------- time ---------- */
function ago(t: number | undefined) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 86400 * 60) return Math.floor(s / 86400) + "d";
  return Math.floor(s / 86400 / 30) + "mo";
}
const fmtDate = (t: number | undefined) => (t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

/* ---------- toast / banner ---------- */
let toastT: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, undo?: () => void) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>` + (undo ? `<button class="btn sm" id="undoBtn">Undo</button>` : "");
  el.classList.remove("hidden");
  if (undo) $("#undoBtn").onclick = () => { undo(); el.classList.add("hidden"); };
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add("hidden"), undo ? 6000 : 2200);
}
function banner(msg?: string) { const b = $("#banner"); b.textContent = msg || ""; b.classList.toggle("hidden", !msg); }

/* ---------- sync with the hub ---------- */
// Writes go out per-entity in order. While any write is in flight we hold off applying refetched
// state, so an optimistic local change never flickers back to the old server value.
const queues: Record<string, Promise<unknown>> = {};
let inflight = 0;
let refetchWanted = false;
let refetchTimer: ReturnType<typeof setTimeout> | undefined;

function send(path: string, fn: () => Promise<unknown>) {
  inflight++;
  const p = (queues[path] || Promise.resolve())
    .then(fn)
    .catch((e) => {
      console.error(e);
      if (e instanceof ApiError && e.status === 401) return;
      toast(e instanceof ApiError && e.status >= 400 && e.status < 500 ? `Couldn't save: ${e.message}` : "Couldn't save — check your connection to the hub.");
      refetchWanted = true; // resync with the truth
    })
    .finally(() => { inflight--; if (!inflight && refetchWanted) scheduleRefetch(); });
  queues[path] = p;
  return p;
}
function scheduleRefetch(delay = 40) {
  refetchWanted = true;
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(refetch, delay);
}
async function refetch() {
  if (inflight) return; // send().finally will reschedule
  refetchWanted = false;
  let st: State;
  try { st = await api.state(); } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) scheduleRefetch(3000);
    return;
  }
  if (inflight || refetchWanted) { scheduleRefetch(); return; }
  applyState(st);
}
function applyState(st: State) {
  S.projects = new Map(st.projects.map((p) => [p.id, norm(p)]));
  S.inbox = st.inbox;
  S.loaded = true;
  if (!FIXED_VIEWS.has(S.view) && !S.projects.has(S.view)) { S.view = "home"; history.replaceState(null, "", "#home"); }
  render();
}

/* Live state has its own fetch loop: it changes far more often than saved data and is read-only. */
let liveT: ReturnType<typeof setTimeout> | undefined;
let liveBusy = false, liveAgain = false;
function scheduleLiveRefetch(delay = 60) { clearTimeout(liveT); liveT = setTimeout(refetchLive, delay); }
async function refetchLive() {
  if (liveBusy) { liveAgain = true; return; }
  liveBusy = true;
  try {
    const st = await api.live();
    S.live = st; S.skew = st.now - Date.now();
    renderSide(); renderLive();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) scheduleLiveRefetch(3000);
  } finally {
    liveBusy = false;
    if (liveAgain) { liveAgain = false; scheduleLiveRefetch(0); }
  }
}

let ws: WebSocket | null = null;
let wsRetry = 0;
let offlineT: ReturnType<typeof setTimeout> | undefined;
function connectWs() {
  if (ws && ws.readyState <= 1) return;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => { wsRetry = 0; clearTimeout(offlineT); banner(""); scheduleRefetch(0); scheduleLiveRefetch(0); };
  sock.onmessage = (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m.t !== "changed") return;
      if (m.entity === "live" || m.entity === "devices") scheduleLiveRefetch();
      if (m.entity === "devices" && !m.ids.length && S.mcp !== null) { S.mcp = null; if (S.view === "devices") { S._force = true; render(); } }
      else { scheduleRefetch(); if (m.entity === "all") scheduleLiveRefetch(); }
    } catch { /* ignore */ }
  };
  sock.onclose = () => {
    if (ws !== sock || !S.authed) return;
    clearTimeout(offlineT);
    offlineT = setTimeout(() => banner("Lost connection to the hub — reconnecting. Edits made now may not be saved."), 2000);
    api.auth().then((a) => { if (!a.authenticated) showLogin(a.configured); }).catch(() => {});
    setTimeout(() => S.authed && connectWs(), Math.min(10_000, 500 * 2 ** wsRetry++));
  };
}

/* ---------- local mutations (optimistic) + persistence ---------- */
const norm = (p: Project) => { p.links ||= []; p.sessions ||= []; p.ideas ||= []; p.status ||= "active"; return p; };
const touch = (p: Project) => { p.updatedAt = Date.now(); };

function saveProject(id: string, patch: Partial<Pick<Project, Field>>, opts: { silent?: boolean } = {}) {
  const p = S.projects.get(id); if (!p) return;
  Object.assign(p, patch); touch(p);
  if (!opts.silent) render();
  send("p:" + id, () => api.patchProject(id, patch));
}
function addLinks(p: Project, links: Partial<Link>[]) {
  p.links = [...(links as Link[]), ...p.links]; touch(p); render();
  send("p:" + p.id, () => api.addLinks(p.id, links));
}
function restoreChild(p: Project, key: "links" | "sessions" | "ideas", before: (Link | Session | Idea)[], item: Link | Session | Idea) {
  (p[key] as unknown[]) = before; touch(p); render();
  if (key === "links") send("p:" + p.id, () => api.addLinks(p.id, [item as Link]));
  else if (key === "sessions") send("p:" + p.id, () => api.addSession(p.id, item as Session));
  else send("p:" + p.id, () => api.addIdea({ ...(item as Idea), projectId: p.id }));
}
function removeChild(p: Project, key: "links" | "sessions" | "ideas", id: string) {
  const before = (p[key] as (Link | Session | Idea)[]).slice();
  const item = before.find((x) => x.id === id); if (!item) return;
  (p[key] as unknown[]) = before.filter((x) => x.id !== id); touch(p); render();
  const del = key === "links" ? api.deleteLink : key === "sessions" ? api.deleteSession : api.deleteIdea;
  send("p:" + p.id, () => del(id));
  toast("Removed", () => restoreChild(p, key, before, item));
}
function addProjectIdea(p: Project, text: string, opts: { silent?: boolean } = {}) {
  const idea = { id: ulid(), text, at: Date.now() };
  p.ideas = [idea, ...p.ideas]; touch(p);
  if (!opts.silent) render();
  send("p:" + p.id, () => api.addIdea({ ...idea, projectId: p.id }));
}
function addInbox(text: string, keep?: Idea) {
  const item = keep ?? { id: ulid(), text, at: Date.now() };
  S.inbox = [item, ...S.inbox].sort((a, b) => b.at - a.at); render();
  send("i:" + item.id, () => api.addIdea({ ...item, projectId: null }));
}
function delInbox(id: string) {
  S.inbox = S.inbox.filter((i) => i.id !== id); render();
  send("i:" + id, () => api.deleteIdea(id));
}
function newProject(name: string) {
  const id = ulid(); const now = Date.now();
  S.projects.set(id, { id, name, status: "active", leftOff: "", tags: "", links: [], sessions: [], ideas: [], createdAt: now, updatedAt: now });
  send("p:" + id, () => api.createProject(id, name));
  go(id);
}
function removeProject(id: string) {
  S.projects.delete(id); render();
  send("p:" + id, () => api.deleteProject(id));
}
function restoreProject(snap: Project) {
  S.projects.set(snap.id, snap); touch(snap);
  send("p:" + snap.id, () => api.putProject(snap));
  go(snap.id);
}

/* ---------- routing ---------- */
function go(v: string) { S.q = ""; $<HTMLInputElement>("#q").value = ""; if (location.hash.slice(1) !== v) location.hash = v; else { S.view = v; render(); } }
// A route change always renders, even if a field of the old view still has focus (Back button,
// typed URL, Tab-then-navigate); otherwise the edit guard would leave the old view on screen.
function readHash() { const h = location.hash.slice(1); S.view = h || "home"; S._force = true; render(); }
window.addEventListener("hashchange", readHash);

/* ---------- render ---------- */
let renderPending = false;
function editingMain() { const a = document.activeElement; return !!a && $("#main").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
function render() { renderSide(); renderCapture(); if (editingMain() && !S._force) { renderPending = true; return; } S._force = false; renderMain(); }
// A deferred render must not run between mousedown and mouseup: replacing the DOM under the
// pointer would swallow the click (e.g. on "Import" right after typing in the paste box).
let pointerDown = false;
function flushPending() {
  if (pointerDown) return;
  if (liveRenderPending) { liveRenderPending = false; renderLive(); }
  if (renderPending && !editingMain()) { renderPending = false; renderMain(); }
}
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
document.addEventListener("pointerup", () => { pointerDown = false; setTimeout(flushPending, 0); }, true);
document.addEventListener("pointercancel", () => { pointerDown = false; setTimeout(flushPending, 0); }, true);
document.addEventListener("focusout", () => setTimeout(flushPending, 0));

const sorted = () => [...S.projects.values()].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || (b.updatedAt || 0) - (a.updatedAt || 0));
function hosts() {
  const m = new Map<string, { host: string; nets: Set<string>; items: { p: Project; s: Session }[] }>();
  for (const p of S.projects.values()) for (const s of p.sessions || []) {
    const h = (s.host || "").trim() || "(no host)";
    if (!m.has(h)) m.set(h, { host: h, nets: new Set(), items: [] });
    const e = m.get(h)!; if (s.network) e.nets.add(s.network); e.items.push({ p, s });
  }
  return [...m.values()].sort((a, b) => a.host.localeCompare(b.host));
}

function renderSide() {
  const all = sorted();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((p) => p.status === s).length])) as Record<Status, number>;
  $("#tabs").innerHTML = ([["active", "Active"], ["parked", "Parked"], ["done", "Done"], ["all", "All"]] as const)
    .map(([k, l]) => `<div class="tab ${S.filter === k ? "on" : ""}" data-filter="${k}">${l}${k !== "all" ? " " + counts[k] : ""}</div>`).join("");
  const list = all.filter((p) => S.filter === "all" || p.status === S.filter);
  $("#plist").innerHTML = list.length ? list.map((p) => `
    <div class="pitem ${S.view === p.id ? "on" : ""}" data-go="${p.id}">
      <span class="dot st-${p.status}"></span><span class="nm">${esc(p.name || "Untitled")}</span><span class="ago">${ago(p.updatedAt)}</span>
    </div>`).join("") : `<div class="empty" style="padding:8px 10px">${S.loaded ? "No " + (S.filter === "all" ? "" : S.filter + " ") + "projects." : ""}</div>`;
  $("#inboxN").textContent = S.inbox.length ? String(S.inbox.length) : "";
  const hn = hosts().filter((h) => h.host !== "(no host)").length;
  $("#hostN").textContent = hn ? String(hn) : "";
  for (const k of ["home", "inbox", "machines", "live", "devices"]) $("#nav-" + k).classList.toggle("on", !S.q && S.view === k);
  const lt = allLiveTabs().length;
  $("#liveN").textContent = lt ? String(lt) : "";
  $("#devN").textContent = S.live?.devices.length ? String(S.live.devices.length) : "";
}
function renderCapture() {
  const sel = $<HTMLSelectElement>("#capTo"); const cur = sel.value;
  const opts = `<option value="">→ Inbox</option>` + sorted().filter((p) => p.status !== "done").map((p) => `<option value="${p.id}">→ ${esc(p.name)}</option>`).join("");
  if (sel.innerHTML !== opts) { sel.innerHTML = opts; sel.value = S.projects.has(cur) ? cur : (S.projects.has(S.view) ? S.view : ""); }
}

function renderMain() {
  let html: string;
  if (S.q) html = viewSearch();
  else if (S.view === "inbox") html = viewInbox();
  else if (S.view === "machines") html = viewMachines();
  else if (S.view === "live") html = viewLive();
  else if (S.view === "devices") html = viewDevices();
  else if (S.projects.has(S.view)) html = viewProject(S.projects.get(S.view)!);
  else html = viewHome();
  // Skip identical renders (e.g. the hub echoing our own write) so open forms, focus, caret and
  // half-typed input values survive.
  if (html === lastMainHtml) return;
  lastMainHtml = html;
  $("#main").innerHTML = `<div class="wrap">${html}</div>`;
  lastLiveBody = S.view === "live" && !S.q ? liveBodyHtml : "";
}
let lastMainHtml = "";

function viewHome() {
  if (!S.loaded) return `<p class="empty">Loading…</p>`;
  const act = sorted().filter((p) => p.status === "active");
  if (!S.projects.size) return `
    <h2>Welcome to LabSave</h2>
    <p class="sub">One page per project: its links, the machines and terminals it lives on, and a note on where you left off.</p>
    <section class="card"><h3>Start here</h3>
      <ol style="margin:10px 0 0;padding-left:20px;line-height:1.8">
        <li>Add a project in the bottom-left box.</li>
        <li>In a browser window full of tabs, copy every URL in it (most browsers have a <i>Copy all tab URLs</i> extension, or bookmark all tabs and copy them from the bookmark folder) and use <b>Paste many</b> on the project's Links. Then close those tabs.</li>
        <li>Add the SSH / tmux / RDP sessions for that project, with the host and the network it's on.</li>
        <li>Before you switch away from something, write one line under <b>Where I left off</b>.</li>
      </ol>
    </section>`;
  return `<h2>Where I left off</h2><p class="sub">${act.length} active project${act.length === 1 ? "" : "s"}, most recently touched first.</p>
    <div class="grid">${act.map((p) => `
      <div class="pcard" data-go="${p.id}">
        <div class="t"><span class="dot st-${p.status}"></span>${esc(p.name)}</div>
        <div class="lo">${p.leftOff ? esc(p.leftOff) : `<span style="color:var(--faint)">No note yet</span>`}</div>
        <div class="stats"><span>${p.links.length} links</span><span>${p.sessions.length} sessions</span><span>${p.ideas.length} ideas</span><span style="margin-left:auto">${ago(p.updatedAt)} ago</span></div>
      </div>`).join("") || `<p class="empty">Nothing active. Check Parked.</p>`}</div>`;
}

function linkRow(p: Project, l: Link, hl: Hl) {
  let host = ""; try { host = new URL(l.url).host; } catch { host = l.url; }
  return `<div class="row link">
    <div style="min-width:0"><a class="ltitle" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${hl(l.label || host)}</a><span class="lurl">${hl(l.url)}</span></div>
    <span class="lacts">${openChip(l.url)}${l.where ? `<span class="chip" title="Usually open in">${hl(l.where)}</span>` : ""}<button class="btn sm ghost" data-act="openIn" data-url="${esc(l.url)}" title="Open in one of your browsers">Open in…</button></span>
    <button class="x" title="Remove" data-act="delLink" data-p="${p.id}" data-id="${l.id}">×</button></div>`;
}
function sessRow(p: Project, s: Session, hl: Hl) {
  return `<div class="row sess">
    <span class="chip kind">${esc(s.kind || "SSH")}</span>
    <div style="min-width:0">
      <div>${hl(s.label || s.host || "Session")}</div>
      <div class="hostline">${hl(s.host || "")}${s.network ? " · " + hl(s.network) : ""}</div>
      ${s.cmd ? `<code class="cmd" title="${esc(s.cmd)}">${hl(s.cmd)}</code>` : ""}
    </div>
    ${s.cmd ? `<button class="btn sm" data-act="copy" data-text="${esc(s.cmd)}">Copy</button>` : "<span></span>"}
    <button class="x" title="Remove" data-act="delSess" data-p="${p.id}" data-id="${s.id}">×</button></div>`;
}
const noHl: Hl = (s) => esc(s);
function datalist(id: string, vals: (string | undefined)[]) { return `<datalist id="${id}">${[...new Set(vals.filter(Boolean))].map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`; }

function viewProject(p: Project) {
  norm(p);
  const all = [...S.projects.values()];
  const wheres = all.flatMap((x) => x.links.map((l) => l.where));
  const hostsL = all.flatMap((x) => x.sessions.map((s) => s.host));
  const nets = all.flatMap((x) => x.sessions.map((s) => s.network));
  const o = S.open;
  return `
  <input class="pname" data-f="name" value="${esc(p.name)}" aria-label="Project name">
  <div class="prow">
    <div class="seg">${STATUSES.map((s) => `<button data-act="status" data-p="${p.id}" data-v="${s}" class="${p.status === s ? "on" : ""}">${p.status === s ? `<span class="dot st-${s}"></span>` : ""}${s[0]!.toUpperCase() + s.slice(1)}</button>`).join("")}</div>
    <span class="meta">touched ${ago(p.updatedAt)} ago · started ${fmtDate(p.createdAt)}</span>
  </div>

  <section class="card">
    <h3>Where I left off</h3>
    <textarea class="leftoff" data-f="leftOff" placeholder="What was I in the middle of? Next step? Open question? Which window had it?">${esc(p.leftOff || "")}</textarea>
  </section>

  ${liveNowStrip(p)}

  <section class="card">
    <h3>Links <span class="count">${p.links.length}</span><span class="sp"></span>
      ${p.links.length ? `<button class="btn sm ghost" data-act="restoreWs" data-p="${p.id}" title="Open all of this project's links in one of your browsers">Restore workspace…</button>` : ""}
      ${p.links.length ? `<button class="btn sm ghost" data-act="copyUrls" data-p="${p.id}">Copy all URLs</button>` : ""}
      <button class="btn sm" data-act="toggle" data-k="link">+ Add</button>
      <button class="btn sm" data-act="toggle" data-k="bulk">Paste many</button></h3>
    <form class="f ${o.link ? "" : "hidden"}" data-form="link" data-p="${p.id}">
      <div class="g"><input name="url" placeholder="https://… or http://10.0.0.5:8080" required>
      <input name="label" placeholder="Label (optional)"><input name="where" list="dl-where" placeholder="Usually in… e.g. Edge · work"></div>
      <div class="acts"><button type="button" class="btn ghost sm" data-act="toggle" data-k="link">Cancel</button><button class="btn primary sm">Add link</button></div>
    </form>
    <form class="f ${o.bulk ? "" : "hidden"}" data-form="bulk" data-p="${p.id}">
      <textarea name="text" placeholder="Paste URLs, one per line. 'Title - https://…', 'https://… Title' and [Title](https://…) all work."></textarea>
      <div class="g"><input name="where" list="dl-where" placeholder="Where these were open (optional) e.g. Firefox · lab VM"></div>
      <div class="acts"><span class="hint">Duplicates already in this project are skipped.</span><button type="button" class="btn ghost sm" data-act="toggle" data-k="bulk">Cancel</button><button class="btn primary sm">Import</button></div>
    </form>
    <div class="rows">${p.links.length ? p.links.map((l) => linkRow(p, l, noHl)).join("") : `<div class="empty">No links yet. Park this project's tabs here, then close them.</div>`}</div>
  </section>

  <section class="card">
    <h3>Terminals, machines &amp; VMs <span class="count">${p.sessions.length}</span><span class="sp"></span>
      <button class="btn sm" data-act="toggle" data-k="sess">+ Add</button></h3>
    <form class="f ${o.sess ? "" : "hidden"}" data-form="sess" data-p="${p.id}">
      <div class="g">
        <select name="kind">${SESSION_KINDS.map((k) => `<option>${k}</option>`).join("")}</select>
        <input name="label" placeholder="Label e.g. build box, tmux 'api'">
        <input name="host" list="dl-host" placeholder="Host / VM e.g. devbox-02">
        <input name="network" list="dl-net" placeholder="Network e.g. lab VPN, home LAN">
      </div>
      <input name="cmd" placeholder="Command to get back in, e.g. ssh -J bastion devbox-02 -t tmux new -A -s api" style="font-family:var(--mono)">
      <div class="acts"><span class="hint">Don't store passwords or keys here.</span><button type="button" class="btn ghost sm" data-act="toggle" data-k="sess">Cancel</button><button class="btn primary sm">Add session</button></div>
    </form>
    <div class="rows">${p.sessions.length ? p.sessions.map((s) => sessRow(p, s, noHl)).join("") : `<div class="empty">Where does this project run? Add the host and the command that gets you back into it.</div>`}</div>
  </section>

  ${rulesCard(p)}

  <section class="card">
    <h3>Ideas &amp; notes <span class="count">${p.ideas.length}</span></h3>
    <form class="f" data-form="idea" data-p="${p.id}" style="border:0;padding:0;grid-template-columns:1fr auto">
      <input name="text" placeholder="Add an idea or note (Enter)" autocomplete="off"><button class="btn sm">Add</button>
    </form>
    <div class="rows">${p.ideas.map((i) => `<div class="row idea"><div style="min-width:0"><div style="white-space:pre-wrap">${esc(i.text)}</div>${ideaLinksHtml(i)}</div><span class="meta">${fmtDate(i.at)}</span><button class="x" data-act="delIdea" data-p="${p.id}" data-id="${i.id}">×</button></div>`).join("")}</div>
  </section>

  <section class="card tags">
    <h3>Tags</h3>
    <input data-f="tags" value="${esc(p.tags || "")}" placeholder="comma separated, e.g. homelab, client-x, rust">
  </section>
  <div class="danger-zone"><span class="meta">Projects you finish: mark Done rather than delete, so the links stay searchable.</span>
    <button class="btn sm danger" data-act="delProject" data-p="${p.id}">${S.confirmDel === p.id ? "Click again to delete" : "Delete project"}</button></div>
  ${datalist("dl-where", wheres)}${datalist("dl-host", hostsL)}${datalist("dl-net", nets)}`;
}

function viewInbox() {
  const opts = sorted().filter((p) => p.status !== "done");
  return `<h2>Idea inbox</h2><p class="sub">Things you captured from the top bar. File each into a project, or delete it.</p>
  <section class="card"><div class="rows">${S.inbox.length ? S.inbox.map((i) => `
    <div class="row" style="grid-template-columns:1fr auto auto auto">
      <div style="min-width:0"><div style="white-space:pre-wrap">${esc(i.text)}</div>${ideaLinksHtml(i)}</div><span class="meta">${ago(i.at)} ago</span>
      <select data-act="file" data-id="${i.id}" style="border-radius:7px;border:1px solid var(--line2);background:var(--panel2);padding:3px 6px">
        <option value="">File into…</option>${opts.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}<option value="__new">+ New project from this</option></select>
      <button class="x" data-act="delInbox" data-id="${i.id}">×</button>
    </div>`).join("") : `<div class="empty">Inbox empty. Type into “Capture an idea” at the top any time.</div>`}</div></section>`;
}

function viewMachines() {
  const hs = hosts();
  return `<h2>Machines &amp; VMs</h2><p class="sub">Every host you've added to a project, which network it's on, and how to get back in.</p>
  <section class="card">${hs.length ? `<table><thead><tr><th>Host</th><th>Network</th><th>Used by</th></tr></thead><tbody>
    ${hs.map((h) => `<tr><td style="font-family:var(--mono)">${esc(h.host)}</td><td>${[...h.nets].map((n) => `<span class="chip">${esc(n)}</span>`).join(" ") || `<span class="meta">—</span>`}</td>
    <td>${h.items.map(({ p, s }) => `<div style="margin-bottom:6px"><span class="plink" data-go="${p.id}">${esc(p.name)}</span> <span class="chip kind">${esc(s.kind || "SSH")}</span> ${esc(s.label || "")}
      ${s.cmd ? `<div><code class="cmd">${esc(s.cmd)}</code> <button class="btn sm" data-act="copy" data-text="${esc(s.cmd)}">Copy</button></div>` : ""}</div>`).join("")}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">No machines yet. Add sessions inside a project and they'll be listed here.</div>`}</section>`;
}

/* ---------- M1: live tabs ---------- */
const hubNow = () => Date.now() + S.skew;
const isStale = (b: LiveBrowser) => !S.live || !b.lastSeenAt || hubNow() - b.lastSeenAt > S.live.staleAfterMs;
function allLiveTabs() {
  const out: { d: LiveDevice; b: LiveBrowser; t: LiveTab }[] = [];
  for (const d of S.live?.devices ?? []) for (const b of d.browsers) for (const w of b.windows) for (const t of w.tabs) out.push({ d, b, t });
  return out;
}
const ageDays = (t: LiveTab) => Math.floor((hubNow() - t.firstSeenAt) / 86400_000);
const FAMILY_NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", chromium: "Chromium", other: "Browser" };
const browserName = (b: LiveBrowser) => (FAMILY_NAMES[b.family] ?? b.family) + (b.profile ? ` · ${b.profile}` : "");
const seenAgo = (t: number | null) => { if (!t) return "never"; const a = ago(t - S.skew); return a === "now" ? "just now" : a + " ago"; };
const browserState = (b: LiveBrowser) => (b.connected && !isStale(b) ? "on" : b.connected ? "warn" : "off");
const STATE_LABEL = { on: "live", warn: "quiet", off: "offline" } as const;

let liveBodyHtml = "";
let lastLiveBody = "";
let liveRenderPending = false;

function liveBody(): string {
  const st = S.live;
  if (!st) return `<p class="empty">Loading…</p>`;
  if (!st.devices.some((d) => d.browsers.length || d.agents?.length)) return `
    <section class="card"><h3>No browsers connected yet</h3>
      <ol style="margin:10px 0 0;padding-left:20px;line-height:1.8">
        <li>Open <span class="plink" data-go="devices" style="cursor:pointer;color:var(--accent)">Devices</span>, add this computer and copy the pairing code.</li>
        <li>Build the extension (<code>npm run build:ext</code>) and load <code>packages/ext/dist/chromium</code> (Chrome, Edge) or <code>packages/ext/dist/firefox</code> unpacked.</li>
        <li>In the extension's options, enter this hub's address and the code. Tabs appear here within a couple of seconds.</li>
        <li>For terminals: install <code>lbsv-agent</code> on the machine and pair it with a code the same way (see Devices).</li>
      </ol></section>`;
  const all = allLiveTabs();
  const dupCount = new Map<string, number>();
  for (const { t } of all) { const k = dupKey(t.url); dupCount.set(k, (dupCount.get(k) ?? 0) + 1); }
  const terms = S.liveQ.toLowerCase().split(/\s+/).filter(Boolean);
  const rx = terms.length ? new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi") : null;
  const hl: Hl = (s) => (rx ? esc(s).replace(rx, "<mark>$1</mark>") : esc(s));
  const filtering = terms.length > 0 || S.liveDup || S.liveOld || S.liveUnfiled;
  const sug = suggester();
  const sugOf = new Map<string, Suggestion | null>();
  for (const { t } of all) sugOf.set(t.id, sug.suggest(tabItem(t)));
  shownSuggestions = [];
  const keep = (d: LiveDevice, b: LiveBrowser, t: LiveTab) => {
    if (S.liveUnfiled && sugOf.get(t.id)?.how === "filed") return false;
    if (S.liveDup && (dupCount.get(dupKey(t.url)) ?? 0) < 2) return false;
    if (S.liveOld && staleDays(t) < st.oldTabDays) return false;
    if (!terms.length) return true;
    const hay = [t.title, t.url, d.name, b.family, b.profile].join(" ").toLowerCase();
    return terms.every((w) => hay.includes(w));
  };
  const dups = [...dupCount.values()].filter((n) => n > 1).length;
  const old = all.filter(({ t }) => staleDays(t) >= st.oldTabDays).length;
  const browsers = st.devices.reduce((n, d) => n + d.browsers.length, 0);
  let shown = 0;
  const present = new Set<string>();
  const tabRow = (t: LiveTab, b: LiveBrowser) => {
    shown++;
    present.add(t.id);
    const sg = sugOf.get(t.id) ?? null;
    if (sg && sg.how !== "filed") shownSuggestions.push({ kind: "tab", id: t.id, url: t.url, projectId: sg.projectId });
    const n = dupCount.get(dupKey(t.url)) ?? 0, age = ageDays(t), host = hostOf(t.url);
    const live = browserState(b) === "on";
    const origin = originOf(t.url);
    const icon = origin && !failedFavicons.has(origin) ? `<img src="/api/favicon?origin=${encodeURIComponent(origin)}" alt="" loading="lazy" data-fav="${esc(origin)}">` : "";
    return `<div class="row ltab ${t.active ? "act" : ""} ${S.sel.has(t.id) ? "sel" : ""}" data-tab="${esc(t.id)}">
      <input type="checkbox" class="tsel" data-act="sel" data-tab="${esc(t.id)}" data-url="${esc(t.url)}" ${S.sel.has(t.id) ? "checked" : ""} aria-label="Select tab">
      <span class="fav" title="${esc(host)}">${esc(host.replace(/^www\./, "")[0] || "•")}${icon}</span>
      <div style="min-width:0"><a class="ltitle" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${hl(t.title || host || t.url)}</a><span class="lurl">${hl(t.url)}</span></div>
      <span class="tags">${t.pinned ? `<span class="chip" title="Pinned">pinned</span>` : ""}${t.audible ? `<span class="chip" title="Playing audio">♪</span>` : ""}${n > 1 ? `<span class="chip dup" title="Open ${n} times across your browsers">×${n}</span>` : ""}${staleChip(t, age, st.oldTabDays)}${sugChip(sg, `data-kind="tab" data-id="${esc(t.id)}" data-url="${esc(t.url)}"`)}</span>
      <span class="tacts">${live ? `<button class="btn sm ghost" data-act="tabFocus" data-tab="${esc(t.id)}" title="Bring this tab to the front on its machine">Focus</button><button class="x" data-act="tabClose" data-tab="${esc(t.id)}" data-url="${esc(t.url)}" title="Close this tab">×</button>` : ""}<button class="btn sm ghost" data-act="tabMenu" data-tab="${esc(t.id)}" data-url="${esc(t.url)}" title="More: attach to an idea, park, send to another browser, copy">⋯</button></span>
    </div>`;
  };
  const allT = allLiveTerms();
  const keepTerm = (d: LiveDevice, a: LiveAgent, t: LiveTerm, sg: Suggestion | null) => {
    if (S.liveDup) return false;
    if (S.liveUnfiled && sg?.how === "filed") return false;
    if (S.liveOld && termIdleDays(t) < st.oldTabDays) return false;
    if (!terms.length) return true;
    const hay = [t.name, t.cwd, t.cmd, t.kind, t.shell, a.hostname, d.name, t.user].join(" ").toLowerCase();
    return terms.every((w) => hay.includes(w));
  };
  const termsHtml = (d: LiveDevice) => (d.agents ?? []).map((a) => {
    const rows = a.terms.map((t) => {
      const sg = sug.suggest(termItem(d, a, t));
      if (!keepTerm(d, a, t, sg)) return "";
      shown++;
      if (sg && sg.how !== "filed") shownSuggestions.push({ kind: "term", id: t.id, url: "", projectId: sg.projectId });
      return termRow(d, a, t, sg, hl);
    }).join("");
    if (!rows && filtering) return "";
    const s = agentState(a);
    const state = s === "on" ? `<span class="dot on"></span><span class="meta">live</span>`
      : `<span class="dot ${s}"></span><span class="meta">${STATE_LABEL[s]} · last seen ${seenAgo(a.lastSeenAt)}</span>`;
    return `<div class="${s === "on" ? "" : "stale"}" data-agent="${a.id}"><div class="lbrow"><span class="chip kind">Terminals · ${esc(a.hostname)}</span>${state}<span class="meta">${a.terms.length} terminal${a.terms.length === 1 ? "" : "s"}</span></div>
      <div class="rows" style="margin-top:2px">${rows || `<div class="empty">No terminals. Shell hooks installed? (<code>lbsv-agent hooks</code>, then open a new terminal)</div>`}</div></div>`;
  }).join("");
  const devHtml = st.devices.filter((d) => d.browsers.length || d.agents?.length).map((d) => {
    const bHtml = d.browsers.map((b) => {
      const wins = b.windows.map((w, wi) => {
        const rows = w.tabs.filter((t) => keep(d, b, t)).map((t) => tabRow(t, b)).join("");
        if (!rows) return "";
        const wn = w.tabs.length;
        return `<div class="lwin"><div class="lwin-h">Window ${wi + 1}${w.focused ? " · focused" : ""}${w.state && w.state !== "normal" ? " · " + esc(w.state) : ""} · ${wn} tab${wn === 1 ? "" : "s"}</div><div class="rows" style="margin-top:2px">${rows}</div></div>`;
      }).join("");
      if (!wins && filtering) return "";
      const tabsN = b.windows.reduce((k, w) => k + w.tabs.length, 0);
      const s = browserState(b);
      const state = s === "on" ? `<span class="dot on"></span><span class="meta">live</span>`
        : `<span class="dot ${s}"></span><span class="meta">${STATE_LABEL[s]} · last seen ${seenAgo(b.lastSeenAt)}</span>`;
      return `<div class="${s === "on" ? "" : "stale"}" data-browser="${b.id}"><div class="lbrow"><span class="chip kind">${esc(browserName(b))}</span>${state}<span class="meta">${tabsN} tab${tabsN === 1 ? "" : "s"}${b.denied ? ` · ${b.denied} hidden by deny-list` : ""}</span></div>
        ${wins || `<div class="empty">No tabs.</div>`}</div>`;
    }).join("");
    const tHtml = termsHtml(d);
    if (!bHtml && !tHtml) return "";
    const n = d.browsers.reduce((k, b) => k + b.windows.reduce((m, w) => m + w.tabs.length, 0), 0) + (d.agents ?? []).reduce((k, a) => k + a.terms.length, 0);
    return `<section class="card"><h3>${esc(d.name)} <span class="count">${n}</span></h3>${bHtml}${tHtml}</section>`;
  }).join("");
  // A selected tab that closed (anywhere) drops out of the selection.
  for (const id of [...S.sel.keys()]) if (!all.some(({ t }) => t.id === id)) S.sel.delete(id);
  void present;
  const agentsN = st.devices.reduce((n, d) => n + (d.agents?.length ?? 0), 0);
  const nSug = shownSuggestions.length;
  return `<p class="sub" style="margin-top:0" id="liveSummary">${all.length} tab${all.length === 1 ? "" : "s"} in ${browsers} browser${browsers === 1 ? "" : "s"}${agentsN ? ` · ${allT.length} terminal${allT.length === 1 ? "" : "s"} on ${agentsN} machine${agentsN === 1 ? "" : "s"}` : ""} · ${dups} duplicated URL${dups === 1 ? "" : "s"} · ${old} stale (unused ${st.oldTabDays}+ days)${filtering ? ` · showing ${shown}` : ""}${S.liveDup && dups ? ` <button class="btn sm" data-act="dedupe" title="In each group of duplicates, keep the active / most recently used tab and close the others">Keep one of each, close ${all.filter(({ t }) => (dupCount.get(dupKey(t.url)) ?? 0) > 1).length - dups}</button>` : ""}${nSug ? ` <button class="btn sm" data-act="acceptAll" title="File every suggestion shown (→ Project?) into its project. Tabs stay open; terminals are saved as sessions.">File ${nSug} suggested</button>` : ""}</p>
    ${devHtml || `<p class="empty">No tabs match.</p>`}`;
}

/* ---------- M2: tab actions ---------- */
const failedFavicons = new Set<string>();
const originOf = (url: string) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch { return ""; } };
// A favicon the hub couldn't get: fall back to the letter tile and don't ask again this session.
document.addEventListener("error", (e) => {
  const img = e.target as HTMLElement;
  if (img instanceof HTMLImageElement && img.dataset.fav) { failedFavicons.add(img.dataset.fav); img.remove(); }
}, true);

const REASONS: Record<string, string> = { url_changed: "its page changed after you selected it", gone: "it was already closed", offline: "its browser is offline", failed: "the browser refused", timeout: "the browser didn't answer" };
function notClosedMsg(nc: { reason: string }[]): string {
  if (!nc.length) return "";
  const by = new Map<string, number>();
  for (const x of nc) by.set(x.reason, (by.get(x.reason) ?? 0) + 1);
  return " · not closed: " + [...by].map(([r, n]) => `${n} (${REASONS[r] ?? r})`).join(", ");
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function reopen(groups: { browserId: string; windowId: string; urls: string[] }[]) {
  let n = 0, failed = 0;
  for (const g of groups) {
    try { n += (await api.openTabs(g.browserId, g.urls, g.windowId)).opened; } catch { failed += g.urls.length; }
  }
  toast(failed ? `Reopened ${n}; ${failed} couldn't be reopened (browser offline?)` : `Reopened ${plural(n, "tab")}`);
}

async function focusTab(id: string) {
  try { await api.focusTab(id); toast("Brought to front on its machine"); }
  catch (e) { toast(`Couldn't focus: ${(e as Error).message}`); }
}

async function closeTabs(tabs: { id: string; url: string }[]) {
  if (!tabs.length) return;
  try {
    const r = await api.closeTabs(tabs);
    for (const id of r.closed) S.sel.delete(id);
    lastLiveBody = ""; scheduleLiveRefetch(0);
    toast(`Closed ${plural(r.closed.length, "tab")}${notClosedMsg(r.notClosed)}`, r.reopen.length ? () => void reopen(r.reopen) : undefined);
  } catch (e) { toast(`Couldn't close: ${(e as Error).message}`); }
}

async function parkSelected(close: boolean) {
  const tabs = [...S.sel].map(([id, url]) => ({ id, url }));
  if (!tabs.length) return;
  let target: { projectId: string } | { newProject: string };
  if (S.parkTo === "__new") {
    const name = prompt("Name for the new project:")?.trim();
    if (!name) return;
    target = { newProject: name };
  } else if (S.parkTo && S.projects.has(S.parkTo)) target = { projectId: S.parkTo };
  else { toast("Pick a project to park into first."); document.getElementById("parkTo")?.focus(); return; }
  try {
    const r = await api.park({ ...target, tabs, close });
    S.sel.clear(); S.parkTo = r.projectId;
    lastLiveBody = ""; scheduleRefetch(0); scheduleLiveRefetch(0);
    const what = `${plural(r.added.length, "link")} into ${r.projectName}`;
    toast(close ? `Parked ${what}, closed ${r.closed.length}${notClosedMsg(r.notClosed)}` : `Saved ${what}`, () => void (async () => {
      // Undo: reopen what was closed, and take back the links this park added.
      if (r.reopen.length) await reopen(r.reopen);
      for (const l of r.added) await api.deleteLink(l.id).catch(() => {});
      scheduleRefetch(0);
    })());
  } catch (e) { toast(`Couldn't park: ${(e as Error).message}`); }
}

/* ---------- M2b: staleness, open-anywhere index, menus, ideas ↔ tabs ---------- */
/** Days since the tab was last used (browser-reported), falling back to when the hub first saw it. */
const staleDays = (t: LiveTab) => Math.floor((hubNow() - (t.lastAccessed ?? t.firstSeenAt)) / 86400_000);
function staleChip(t: LiveTab, age: number, threshold: number) {
  const idle = staleDays(t);
  if (idle < 1 && age < 1) return "";
  const used = t.lastAccessed ? `last used ${fmtDate(t.lastAccessed)}` : "last use unknown";
  return `<span class="chip ${idle >= threshold ? "old" : ""}" title="Open since ${esc(fmtDate(t.firstSeenAt))} · ${esc(used)}">${t.lastAccessed ? `idle ${idle}d` : `${age}d`}</span>`;
}

/** Live tabs by normalised URL, for "open now" chips on links and ideas. */
function openIndex() {
  const m = new Map<string, { d: LiveDevice; b: LiveBrowser; t: LiveTab }[]>();
  for (const x of allLiveTabs()) { const k = dupKey(x.t.url); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); }
  return m;
}
function openChip(url: string) {
  const hits = openIndex().get(dupKey(url));
  if (!hits?.length) return "";
  const best = hits.find((h) => browserState(h.b) === "on") ?? hits[0]!;
  const where = `${browserName(best.b)} on ${best.d.name}${hits.length > 1 ? ` +${hits.length - 1}` : ""}`;
  return browserState(best.b) === "on"
    ? `<button class="chip livechip" data-act="tabFocus" data-tab="${esc(best.t.id)}" title="Open now in ${esc(where)}. Click to bring it to the front">● open · ${esc(where)}</button>`
    : `<span class="chip" title="Was open when ${esc(browserName(best.b))} on ${esc(best.d.name)} was last seen">○ ${esc(where)}</span>`;
}

function liveBrowsers() {
  const out: { d: LiveDevice; b: LiveBrowser; label: string }[] = [];
  for (const d of S.live?.devices ?? []) for (const b of d.browsers) if (browserState(b) === "on") out.push({ d, b, label: `${browserName(b)} on ${d.name}` });
  return out;
}

function findIdea(id: string): { idea: Idea; project: Project | null } | null {
  const inb = S.inbox.find((i) => i.id === id);
  if (inb) return { idea: inb, project: null };
  for (const p of S.projects.values()) { const i = p.ideas.find((x) => x.id === id); if (i) return { idea: i, project: p }; }
  return null;
}
function allIdeas() {
  const out: { idea: Idea; project: Project | null }[] = S.inbox.map((idea) => ({ idea, project: null }));
  for (const p of S.projects.values()) if (p.status !== "done") for (const idea of p.ideas) out.push({ idea, project: p });
  return out.sort((a, b) => b.idea.at - a.idea.at);
}
const ideaLabel = (x: { idea: Idea; project: Project | null }) => `${x.idea.text.split("\n")[0]!.slice(0, 60)}${x.idea.text.length > 60 ? "…" : ""} · ${x.project ? x.project.name : "Inbox"}`;

function ideaOptions() {
  return `<option value="">Attach to idea…</option><option value="__new" ${S.ideaTo === "__new" ? "selected" : ""}>+ New idea (inbox)…</option>`
    + allIdeas().slice(0, 200).map((x) => `<option value="${x.idea.id}" ${S.ideaTo === x.idea.id ? "selected" : ""}>${esc(ideaLabel(x))}</option>`).join("");
}
function sendOptions() {
  return `<option value="">Send to…</option>` + liveBrowsers().map((x) => `<option value="${x.b.id}" ${S.sendTo === x.b.id ? "selected" : ""}>${esc(x.label)}</option>`).join("");
}

function ideaLinksHtml(i: Idea) {
  const links = i.links ?? [];
  if (!links.length) return "";
  return `<div class="ilinks">${links.map((l) => {
    const host = hostOf(l.url);
    return `<div class="ilink"><span class="fav">${esc(host.replace(/^www\./, "")[0] || "•")}</span>
      <div style="min-width:0"><a class="ltitle" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title || host || l.url)}</a><span class="lurl">${esc(l.url)}</span></div>
      <span class="lacts">${openChip(l.url)}</span>
      <button class="x" title="Detach" data-act="delIdeaLink" data-idea="${i.id}" data-id="${l.id}">×</button></div>`;
  }).join("")}
    <div class="ilink-acts"><button class="btn sm ghost" data-act="ideaOpenAll" data-idea="${i.id}">Open ${links.length > 1 ? `all ${links.length}` : ""} in…</button></div></div>`;
}

function liveNowStrip(p: Project) {
  const idx = openIndex();
  const seen = new Set<string>();
  const hits: { d: LiveDevice; b: LiveBrowser; t: LiveTab; via: string }[] = [];
  const add = (url: string, via: string) => {
    for (const h of idx.get(dupKey(url)) ?? []) if (!seen.has(h.t.id)) { seen.add(h.t.id); hits.push({ ...h, via }); }
  };
  for (const l of p.links) add(l.url, "link");
  for (const i of p.ideas) for (const l of i.links ?? []) add(l.url, "idea");
  const sug = suggester();
  for (const h of allLiveTabs()) {
    if (seen.has(h.t.id)) continue;
    const s = sug.suggest(tabItem(h.t));
    if (s && s.projectId === p.id && s.how === "rule") { seen.add(h.t.id); hits.push({ ...h, via: "rule" }); }
  }
  const lterms = liveTermsFor(p, sug);
  if (!hits.length && !lterms.length) return "";
  const termsHtml = lterms.map(({ d, a, t }) => termRow(d, a, t, null, noHl)).join("");
  return `<section class="card livenow"><h3>Live now <span class="count">${hits.length + lterms.length}</span><span class="meta" style="text-transform:none;letter-spacing:0;margin-left:6px">this project's links, ideas, rules and sessions, open right now</span></h3>
    <div class="rows">${hits.map(({ d, b, t, via }) => {
      const on = browserState(b) === "on";
      return `<div class="row ltab ${on ? "" : "stale"}" style="grid-template-columns:20px minmax(0,1fr) auto auto">
        <span class="fav">${esc(hostOf(t.url).replace(/^www\./, "")[0] || "•")}</span>
        <div style="min-width:0"><a class="ltitle" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.title || t.url)}</a><span class="lurl">${esc(t.url)}</span></div>
        <span class="chip" title="Matched a saved ${via}">${esc(browserName(b))} on ${esc(d.name)}</span>
        <span class="tacts" style="opacity:1">${on ? `<button class="btn sm ghost" data-act="tabFocus" data-tab="${esc(t.id)}">Focus</button><button class="x" data-act="tabClose" data-tab="${esc(t.id)}" data-url="${esc(t.url)}" title="Close this tab">×</button>` : ""}</span>
      </div>`;
    }).join("")}${termsHtml}</div></section>`;
}

/* ---------- popover menu ---------- */
type MenuItem = { label: string; act?: () => void; header?: boolean; hint?: string };
let menuEl: HTMLElement | null = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu"; el.id = "menu"; el.setAttribute("role", "menu");
  el.innerHTML = items.map((it, i) => it.header
    ? `<div class="mh">${esc(it.label)}</div>`
    : `<button class="mi" role="menuitem" data-mi="${i}" ${it.act ? "" : "disabled"}>${esc(it.label)}${it.hint ? `<span class="meta">${esc(it.hint)}</span>` : ""}</button>`).join("");
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  el.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mi]"); if (!b) return;
    const it = items[Number(b.dataset.mi)]; closeMenu(); it?.act?.();
  });
  menuEl = el;
  (el.querySelector(".mi:not([disabled])") as HTMLElement | null)?.focus();
}
document.addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-act=tabMenu],[data-act=termMenu],[data-act=openIn],[data-act=restoreWs],[data-act=ideaOpenAll]")) closeMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuEl) { closeMenu(); e.stopPropagation(); } }, true);

function browserMenu(anchor: HTMLElement, title: string, pick: (b: LiveBrowser) => void) {
  const bs = liveBrowsers();
  openMenu(anchor, [{ label: title, header: true }, ...(bs.length ? bs.map((x) => ({ label: x.label, act: () => pick(x.b) })) : [{ label: "No browser is connected right now" }])]);
}

function tabMenu(anchor: HTMLElement, id: string, url: string) {
  const ref = [{ id, url }];
  const ideas = allIdeas().slice(0, 8);
  const projects = sorted().filter((p) => p.status !== "done").slice(0, 8);
  const here = allLiveTabs().find((x) => x.t.id === id)?.b.id;
  const others = liveBrowsers().filter((x) => x.b.id !== here);
  openMenu(anchor, [
    { label: "Attach to idea (keeps the tab open)", header: true },
    { label: "+ New idea from this tab…", act: () => { const text = prompt("The idea:")?.trim(); if (text) void attachTabs(ref, { newIdea: { text, projectId: null } }, false); } },
    ...ideas.map((x) => ({ label: ideaLabel(x), act: () => void attachTabs(ref, { ideaId: x.idea.id }, false) })),
    { label: "Park into project and close", header: true },
    { label: "+ New project…", act: () => { const name = prompt("Name for the new project:")?.trim(); if (name) void parkTabs(ref, { newProject: name }, true); } },
    ...projects.map((p) => ({ label: p.name, act: () => void parkTabs(ref, { projectId: p.id }, true) })),
    { label: "Send to (moves the tab)", header: true },
    ...(others.length ? others.map((x) => ({ label: x.label, act: () => void sendTabs(ref, x.b.id) })) : [{ label: "No other browser is connected" }]),
    { label: "Other", header: true },
    { label: "Copy URL", act: () => { navigator.clipboard.writeText(url).then(() => toast("Copied"), () => toast("Your browser blocked the clipboard.")); } },
    ...(hostOf(url) ? [{ label: `Always suggest a project for ${hostOf(url)}…`, act: () => ruleMenu(anchor, "domain", hostOf(url)) }] : []),
  ]);
}

/* ---------- actions ---------- */
async function attachTabs(tabs: { id: string; url: string }[], target: { ideaId: string } | { newIdea: { text: string; projectId: string | null } }, close: boolean) {
  try {
    const r = await api.attach({ ...target, tabs, close });
    for (const t of tabs) S.sel.delete(t.id);
    S.ideaTo = r.ideaId;
    lastLiveBody = ""; scheduleRefetch(0); scheduleLiveRefetch(0);
    const where = r.projectId ? S.projects.get(r.projectId)?.name ?? "project" : "Inbox";
    toast(`Attached ${plural(r.added.length, "link")} to “${r.ideaText.slice(0, 40)}” (${where})${close ? `, closed ${r.closed.length}${notClosedMsg(r.notClosed)}` : ""}`, () => void (async () => {
      if (r.reopen.length) await reopen(r.reopen);
      if (r.createdIdea) await api.deleteIdea(r.ideaId).catch(() => {});
      else for (const l of r.added) await api.deleteIdeaLink(l.id).catch(() => {});
      scheduleRefetch(0);
    })());
  } catch (e) { toast(`Couldn't attach: ${(e as Error).message}`); }
}

async function attachSelected(close: boolean) {
  const tabs = [...S.sel].map(([id, url]) => ({ id, url }));
  if (!tabs.length) return;
  if (S.ideaTo === "__new") {
    const text = prompt("The idea:")?.trim(); if (!text) return;
    return attachTabs(tabs, { newIdea: { text, projectId: null } }, close);
  }
  if (!S.ideaTo || !findIdea(S.ideaTo)) { toast("Pick an idea to attach to first."); document.getElementById("ideaTo")?.focus(); return; }
  return attachTabs(tabs, { ideaId: S.ideaTo }, close);
}

async function parkTabs(tabs: { id: string; url: string }[], target: { projectId: string } | { newProject: string }, close: boolean) {
  try {
    const r = await api.park({ ...target, tabs, close });
    for (const t of tabs) S.sel.delete(t.id);
    lastLiveBody = ""; scheduleRefetch(0); scheduleLiveRefetch(0);
    toast(`Parked ${plural(r.added.length, "link")} into ${r.projectName}${close ? `, closed ${r.closed.length}${notClosedMsg(r.notClosed)}` : ""}`, () => void (async () => {
      if (r.reopen.length) await reopen(r.reopen);
      for (const l of r.added) await api.deleteLink(l.id).catch(() => {});
      scheduleRefetch(0);
    })());
  } catch (e) { toast(`Couldn't park: ${(e as Error).message}`); }
}

async function sendTabs(tabs: { id: string; url: string }[], toBrowserId: string) {
  const target = liveBrowsers().find((x) => x.b.id === toBrowserId)?.label ?? "that browser";
  try {
    const r = await api.send(tabs, toBrowserId);
    for (const t of tabs) S.sel.delete(t.id);
    lastLiveBody = ""; scheduleLiveRefetch(0);
    toast(`Sent ${plural(r.opened, "tab")} to ${target}, closed ${r.closed.length} here${notClosedMsg(r.notClosed)}`,
      r.reopen.length ? () => void reopen(r.reopen) : undefined);
  } catch (e) { toast(`Couldn't send: ${(e as Error).message}`); }
}
async function sendSelected() {
  const tabs = [...S.sel].map(([id, url]) => ({ id, url }));
  if (!tabs.length) return;
  if (!S.sendTo || !liveBrowsers().some((x) => x.b.id === S.sendTo)) { toast("Pick a connected browser to send to first."); document.getElementById("sendTo")?.focus(); return; }
  return sendTabs(tabs, S.sendTo);
}

async function openUrls(b: LiveBrowser, urls: string[]) {
  try { const r = await api.openTabs(b.id, urls); toast(`Opened ${plural(r.opened, "tab")} in ${browserName(b)}`); }
  catch (e) { toast(`Couldn't open: ${(e as Error).message}`); }
}
/** Open every URL that isn't already open in that browser (100 per command). */
async function restoreWorkspace(b: LiveBrowser, urls: string[]) {
  const already = new Set(b.windows.flatMap((w) => w.tabs.map((t) => dupKey(t.url))));
  const todo = [...new Set(urls)].filter((u) => !already.has(dupKey(u)));
  if (!todo.length) { toast(`Everything is already open in ${browserName(b)}`); return; }
  let opened = 0;
  try {
    for (let i = 0; i < todo.length; i += 100) opened += (await api.openTabs(b.id, todo.slice(i, i + 100))).opened;
    toast(`Opened ${plural(opened, "tab")} in ${browserName(b)}${urls.length > todo.length ? ` (${urls.length - todo.length} were already open)` : ""}`);
  } catch (e) { toast(`Opened ${opened}, then failed: ${(e as Error).message}`); }
}

/** Duplicates: in each group keep the active one, else the most recently used, else the first; close the rest. */
async function dedupe() {
  const groups = new Map<string, { b: LiveBrowser; t: LiveTab }[]>();
  for (const { b, t } of allLiveTabs()) {
    if (browserState(b) !== "on") continue;
    const k = dupKey(t.url); const g = groups.get(k); if (g) g.push({ b, t }); else groups.set(k, [{ b, t }]);
  }
  const close: { id: string; url: string }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.find((x) => x.t.active) ?? [...g].sort((a, z) => (z.t.lastAccessed ?? 0) - (a.t.lastAccessed ?? 0))[0]!;
    for (const x of g) if (x !== keep) close.push({ id: x.t.id, url: x.t.url });
  }
  if (!close.length) { toast("No duplicates in connected browsers."); return; }
  if (!confirm(`Close ${plural(close.length, "duplicate tab")}, keeping one of each? You can undo.`)) return;
  return closeTabs(close);
}

function removeIdeaLink(ideaId: string, linkId: string) {
  const f = findIdea(ideaId); if (!f) return;
  const before = (f.idea.links ?? []).slice();
  const link = before.find((l) => l.id === linkId); if (!link) return;
  f.idea.links = before.filter((l) => l.id !== linkId);
  if (f.project) touch(f.project);
  render();
  send("i:" + ideaId, () => api.deleteIdeaLink(linkId));
  toast("Detached", () => {
    f.idea.links = before; render();
    send("i:" + ideaId, () => api.addIdeaLinks(ideaId, [link]));
  });
}

/* ---------- M3: terminals, rules, suggestions ---------- */
function suggester(): Suggester {
  const projects = [...S.projects.values()];
  return new Suggester({ projects, rules: projects.flatMap((p) => p.rules ?? []) });
}
const agentState = (a: LiveAgent) => (a.connected && a.lastSeenAt && hubNow() - a.lastSeenAt <= (S.live?.staleAfterMs ?? 40_000) ? "on" : a.connected ? "warn" : "off");
function allLiveTerms() {
  const out: { d: LiveDevice; a: LiveAgent; t: LiveTerm }[] = [];
  for (const d of S.live?.devices ?? []) for (const a of d.agents ?? []) for (const t of a.terms) out.push({ d, a, t });
  return out;
}
const termTitle = (t: LiveTerm) => (t.kind === "shell" ? folderName(t.cwd) || "shell" : t.kind === "screen" ? t.name.replace(/^\d+\./, "") : t.name);
const termItem = (d: LiveDevice, a: LiveAgent, t: LiveTerm): Item => ({ type: "term", cwd: t.cwd, host: a.hostname, name: t.name, device: d.name });
const tabItem = (t: LiveTab): Item => ({ type: "tab", url: t.url, title: t.title });
const KIND_LABEL: Record<string, string> = { shell: "shell", tmux: "tmux", screen: "screen" };
const termIdleDays = (t: LiveTerm) => (t.lastActivityAt ? Math.floor((hubNow() - t.lastActivityAt) / 86400_000) : 0);

function sugChip(s: Suggestion | null, data: string): string {
  if (!s) return "";
  const name = esc(S.projects.get(s.projectId)?.name ?? "project");
  if (s.how === "filed") return `<span class="chip filed" data-go="${s.projectId}" title="${esc(s.reason)}">▣ ${name}</span>`;
  return `<button class="chip sugg ${s.how}" data-act="accept" ${data} data-p="${s.projectId}" title="${esc(s.reason)}. Click to file it there.">→ ${name}?</button>`;
}

function termRow(d: LiveDevice, a: LiveAgent, t: LiveTerm, s: Suggestion | null, hl: Hl) {
  const on = agentState(a) === "on";
  const remote = reconnectCommand(t, a, d.ssh ?? { target: "", jump: "" });
  const local = localCommand(t, a.os);
  const idle = termIdleDays(t);
  const where = `${t.user || a.user}@${a.hostname}`;
  return `<div class="row lterm ${on ? "" : "stale"}" data-term="${esc(t.id)}">
    <span class="chip kind" title="${esc(t.kind === "shell" ? t.shell || "shell" : t.kind)}">${KIND_LABEL[t.kind]}${t.kind === "shell" && t.shell ? " · " + esc(t.shell) : ""}</span>
    <div style="min-width:0"><div class="ltitle" title="${esc(t.cwd)}">${hl(termTitle(t))}</div>
      <span class="lurl">${hl(tildePath(t.cwd, t.user || a.user))} · ${hl(where)}</span>
      ${t.cmd ? `<code class="cmd" title="Last command (recording is on for this shell)">${hl(t.cmd)}</code>` : ""}</div>
    <span class="tags">${t.kind !== "shell" ? `<span class="chip" title="${t.attached ? "Someone is attached" : "Detached"}">${t.attached ? "attached" : "detached"}</span>` : ""}${t.windows > 1 ? `<span class="chip" title="tmux windows">${t.windows} win</span>` : ""}${idle >= 1 ? `<span class="chip ${S.live && idle >= S.live.oldTabDays ? "old" : ""}" title="Last activity ${esc(t.lastActivityAt ? fmtDate(t.lastActivityAt) : "?")}">idle ${idle}d</span>` : ""}${sugChip(s, `data-kind="term" data-id="${esc(t.id)}"`)}</span>
    <span class="tacts" style="opacity:1"><button class="btn sm" data-act="copy" data-text="${esc(remote)}" title="${esc(remote)}">Copy ssh</button><button class="btn sm ghost" data-act="copy" data-text="${esc(local)}" title="On ${esc(a.hostname)} itself: ${esc(local)}">${t.kind === "shell" ? "Copy cd" : "Copy attach"}</button><button class="btn sm ghost" data-act="termMenu" data-term="${esc(t.id)}" title="Save to a project, add a rule">⋯</button></span>
  </div>`;
}

function findTerm(id: string) { return allLiveTerms().find((x) => x.t.id === id) ?? null; }

function sessionFromTerm(d: LiveDevice, a: LiveAgent, t: LiveTerm): Session {
  return { id: ulid(), ...sessionForTerm(t, a, d.ssh ?? { target: "", jump: "" }), at: Date.now(), position: 0 };
}

async function saveTerm(termId: string, target: string) {
  const f = findTerm(termId); if (!f) return;
  let p = S.projects.get(target);
  if (target === "__new") {
    const name = prompt("Name for the new project:", termTitle(f.t))?.trim(); if (!name) return;
    try { p = norm(await api.createProject(ulid(), name)); S.projects.set(p.id, p); } catch (e) { toast(`Couldn't create the project: ${(e as Error).message}`); return; }
  }
  if (!p) return;
  const s = sessionFromTerm(f.d, f.a, f.t);
  const proj = p;
  proj.sessions = [...proj.sessions, s]; touch(proj); render();
  send("p:" + proj.id, () => api.addSession(proj.id, s));
  toast(`Saved ${termTitle(f.t)} to ${proj.name}`, () => {
    proj.sessions = proj.sessions.filter((x) => x.id !== s.id); touch(proj); render();
    send("p:" + proj.id, () => api.deleteSession(s.id));
  });
}

async function addRule(projectId: string, kind: RuleKind, pattern: string) {
  try {
    const r = await api.addRule(projectId, { kind, pattern });
    scheduleRefetch(0); lastLiveBody = "";
    toast(`Rule added to ${S.projects.get(projectId)?.name ?? "project"}: ${describeRule(r)}`, () => void api.deleteRule(r.id).then(() => scheduleRefetch(0), () => {}));
  } catch (e) { toast(`Couldn't add the rule: ${(e as Error).message}`); }
}
function delRule(p: Project, id: string) {
  const r = (p.rules ?? []).find((x) => x.id === id); if (!r) return;
  p.rules = (p.rules ?? []).filter((x) => x.id !== id); render();
  void api.deleteRule(id).then(() => scheduleRefetch(0), (e) => toast(`Couldn't remove the rule: ${(e as Error).message}`));
  toast(`Rule removed: ${describeRule(r)}`, () => void api.addRule(p.id, { id: r.id, kind: r.kind, pattern: r.pattern, at: r.at }).then(() => scheduleRefetch(0), () => {}));
}

/** Pick a project for a new rule (second-level menu). */
function ruleMenu(anchor: HTMLElement, kind: RuleKind, pattern: string) {
  const projects = sorted().filter((p) => p.status !== "done");
  openMenu(anchor, [
    { label: `Always suggest: ${describeRule({ kind, pattern })} →`, header: true },
    ...(projects.length ? projects.slice(0, 20).map((p) => ({ label: p.name, act: () => void addRule(p.id, kind, pattern) })) : [{ label: "No active projects" }]),
  ]);
}

function termMenu(anchor: HTMLElement, id: string) {
  const f = findTerm(id); if (!f) return;
  const projects = sorted().filter((p) => p.status !== "done").slice(0, 10);
  openMenu(anchor, [
    { label: "Save to project (as a saved session)", header: true },
    { label: "+ New project…", act: () => void saveTerm(id, "__new") },
    ...projects.map((p) => ({ label: p.name, act: () => void saveTerm(id, p.id) })),
    { label: "Rules", header: true },
    ...(f.t.cwd ? [{ label: `Folder under ${tildePath(f.t.cwd, f.t.user || f.a.user)} → …`, act: () => ruleMenu(anchor, "cwd_prefix", f.t.cwd) }] : []),
    { label: `Everything on ${f.a.hostname} → …`, act: () => ruleMenu(anchor, "host", f.a.hostname) },
  ]);
}

/** Live view: suggestions currently shown, for "File N suggested". */
let shownSuggestions: { kind: "tab" | "term"; id: string; url: string; projectId: string }[] = [];

async function acceptSuggestions(items: { kind: "tab" | "term"; id: string; url: string; projectId: string }[]) {
  const byProject = new Map<string, { id: string; url: string }[]>();
  let terms = 0;
  for (const it of items) {
    if (it.kind === "tab") { const l = byProject.get(it.projectId) ?? []; l.push({ id: it.id, url: it.url }); byProject.set(it.projectId, l); }
    else { terms++; await saveTerm(it.id, it.projectId); }
  }
  let links = 0;
  const undo: string[] = [];
  for (const [projectId, tabs] of byProject) {
    try { const r = await api.park({ projectId, tabs, close: false }); links += r.added.length; undo.push(...r.added.map((l) => l.id)); }
    catch (e) { toast(`Couldn't file some tabs: ${(e as Error).message}`); }
  }
  lastLiveBody = ""; scheduleRefetch(0);
  if (byProject.size) toast(`Filed ${plural(links, "link")} into ${plural(byProject.size, "project")}${terms ? ` and ${plural(terms, "terminal")}` : ""}`,
    () => void Promise.all(undo.map((id) => api.deleteLink(id).catch(() => {}))).then(() => scheduleRefetch(0)));
}

function rulesCard(p: Project) {
  const rules = p.rules ?? [];
  const tabs = allLiveTabs(), terms = allLiveTerms();
  const count = (r: Rule) => tabs.filter(({ t }) => ruleScore(r, tabItem(t)) > 0).length + terms.filter(({ d, a, t }) => ruleScore(r, termItem(d, a, t)) > 0).length;
  return `<section class="card">
    <h3>Rules <span class="count">${rules.length}</span><span class="sp"></span><button class="btn sm" data-act="toggle" data-k="rule">+ Add</button></h3>
    <form class="f ${S.open.rule ? "" : "hidden"}" data-form="rule" data-p="${p.id}">
      <div class="g" style="grid-template-columns:200px 1fr"><select name="kind">${RULE_KINDS.map((k) => `<option value="${k}">${RULE_LABELS[k]}</option>`).join("")}</select>
      <input name="pattern" placeholder="git.example.net · https://chat.example.net/session/ · grafana|prometheus · /home/me/git/myproj · build-vm" required autocomplete="off"></div>
      <div class="acts"><span class="hint">Matching live tabs and terminals get a “→ ${esc(p.name)}?” suggestion; one click files them. Title rules are regular expressions, case-insensitive.</span><button type="button" class="btn ghost sm" data-act="toggle" data-k="rule">Cancel</button><button class="btn primary sm">Add rule</button></div>
    </form>
    <div class="rows">${rules.length ? rules.map((r) => { const n = count(r); return `<div class="row rule"><span class="chip kind">${esc(RULE_LABELS[r.kind])}</span><code class="cmd">${esc(r.pattern)}</code><span class="meta">${n ? `${n} open now` : "nothing open"}</span><button class="x" title="Remove rule" data-act="delRule" data-p="${p.id}" data-id="${r.id}">×</button></div>`; }).join("")
      : `<div class="empty">No rules. Add one to have tabs on a site, or terminals in a folder or on a host, suggested for this project.</div>`}</div>
  </section>`;
}

/** Project page: terminals open anywhere that belong here (saved session or rule). */
function liveTermsFor(p: Project, sug: Suggester) {
  return allLiveTerms().filter(({ d, a, t }) => { const s = sug.suggest(termItem(d, a, t)); return s && s.projectId === p.id && s.how !== "guess"; });
}

function viewLive() {
  liveBodyHtml = liveBody();
  return `<h2>Live tabs &amp; terminals</h2>
    <div class="live-sum">
      <input id="liveQ" placeholder="Filter by title, URL, folder, session, device…   (Esc clears)" value="${esc(S.liveQ)}" autocomplete="off">
      <span class="chip toggle ${S.liveDup ? "on" : ""}" data-act="liveDup" id="tgDup">Duplicates</span>
      <span class="chip toggle ${S.liveOld ? "on" : ""}" data-act="liveOld" id="tgOld" title="Tabs and terminals you haven't used in 7+ days">Stale</span>
      <span class="chip toggle ${S.liveUnfiled ? "on" : ""}" data-act="liveUnfiled" id="tgUnfiled" title="Hide tabs and terminals already saved in a project">Unfiled</span>
      <span class="chip toggle" data-act="selShown" title="Select every tab currently shown">Select shown</span>
    </div>
    <div class="selbar ${S.sel.size ? "" : "hidden"}" id="selbar">
      <b id="selN">${S.sel.size}</b>&nbsp;selected
      <select id="parkTo" aria-label="Park into project">
        <option value="">Park into…</option>
        ${sorted().filter((p) => p.status !== "done").map((p) => `<option value="${p.id}" ${S.parkTo === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        <option value="__new" ${S.parkTo === "__new" ? "selected" : ""}>+ New project…</option>
      </select>
      <button class="btn sm primary" data-act="parkClose">Park &amp; close</button>
      <button class="btn sm" data-act="parkKeep" title="Save as links, leave the tabs open">Park only</button>
      <span class="selsep"></span>
      <select id="ideaTo" aria-label="Attach to idea">${ideaOptions()}</select>
      <button class="btn sm" data-act="attachClose" title="Attach the tabs' URLs to the idea, then close them">Attach &amp; close</button>
      <button class="btn sm" data-act="attachKeep" title="Attach the tabs' URLs to the idea, leave them open">Attach</button>
      <span class="selsep"></span>
      <select id="sendTo" aria-label="Send to browser">${sendOptions()}</select>
      <button class="btn sm" data-act="sendSel" title="Open these tabs in that browser, then close them here">Send</button>
      <span class="selsep"></span>
      <button class="btn sm" data-act="closeSel">Close</button>
      <button class="btn sm ghost" data-act="selClear">Clear</button>
    </div>
    <div id="liveBody">${liveBodyHtml}</div>`;
}
function syncSelbar() {
  const bar = document.getElementById("selbar"); if (!bar) return;
  bar.classList.toggle("hidden", !S.sel.size);
  $("#selN").textContent = String(S.sel.size);
}
function syncLiveToggles() {
  document.getElementById("tgDup")?.classList.toggle("on", S.liveDup);
  document.getElementById("tgOld")?.classList.toggle("on", S.liveOld);
  document.getElementById("tgUnfiled")?.classList.toggle("on", S.liveUnfiled);
}

/**
 * Update the live list in place. It never touches the filter box (so typing there is never
 * interrupted by incoming tabs) and never runs between mousedown and mouseup.
 */
function renderLive() {
  if (S.view === "live" && !S.q && document.getElementById("liveBody")) {
    if (pointerDown) { liveRenderPending = true; return; }
    const h = liveBody();
    liveBodyHtml = h;
    if (h !== lastLiveBody) { $("#liveBody").innerHTML = h; lastLiveBody = h; }
    syncSelbar();
    lastMainHtml = ""; // main's cached html no longer describes the DOM
    return;
  }
  render(); // projects, ideas and search show "open now" chips; identical renders are skipped
}
setInterval(() => { if (S.view === "live" || S.view === "devices") renderLive(); }, 10_000); // staleness + ages tick

/* ---------- M1: devices ---------- */
const splitDomains = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/** One-line agent installers (M5): served by the hub at /install/*, code filled in. */
function agentInstallLines(code: string): string {
  const o = location.origin;
  const sh = `curl -fsSL ${o}/install/agent.sh | sh -s -- ${code}`;
  const ps = `& ([scriptblock]::Create((irm ${o}/install/agent.ps1))) ${code}`;
  const row = (os: string, cmd: string) => `<div style="margin-top:4px"><span class="meta">${os}</span><br><code class="cmd" style="word-break:break-all">${esc(cmd)}</code> <button class="btn sm" data-act="copy" data-text="${esc(cmd)}">Copy</button></div>`;
  return row("Linux / macOS / WSL / Git Bash", sh) + row("Windows PowerShell", ps);
}

function showPair(deviceId: string, name: string, r: { code: string; expiresAt: number }) {
  S.pair = { deviceId, name, code: r.code, expiresAt: r.expiresAt };
  S._force = true; render();
}

function downloadsHtml() {
  if (S.downloads === null) {
    S.downloads = [];
    api.downloads().then((r) => { S.downloads = r.packages; if (S.view === "devices") { S._force = true; render(); } }).catch(() => {});
  }
  const pk = (t: string) => S.downloads?.find((p) => p.target === t);
  const link = (t: string, label: string) => { const p = pk(t); return p ? `<a class="btn sm" href="${esc(p.url)}" download>${label} · v${esc(p.version)} (${Math.max(1, Math.round(p.size / 1024))} KB)</a>` : ""; };
  if (!S.downloads?.length) return `<section class="card"><h3>Install the extension on another device</h3>
    <p class="meta" style="margin:8px 0 0">No packages on this hub yet. Run <code>npm run build:ext</code> on the hub, then reload this page.</p></section>`;
  return `<section class="card" id="downloads"><h3>Install the extension on another device</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${CHROME_WEB_STORE_URL ? `<a class="btn sm primary" href="${esc(CHROME_WEB_STORE_URL)}" target="_blank" rel="noopener">Chrome / Edge: Chrome Web Store</a>` : ""}${pk("firefox-signed") ? `<a class="btn sm primary" href="${esc(pk("firefox-signed")!.url)}">Firefox: install · v${esc(pk("firefox-signed")!.version)}</a>` : ""}${link("chromium", "Chrome / Edge zip")}${pk("firefox-signed") ? "" : link("firefox", "Firefox zip")}${link("agent", "lbsv-agent (terminals)")}</div>
    <ol style="margin:10px 0 0;padding-left:20px;line-height:1.7;font-size:13px">
      <li><b>Chrome / Edge:</b> ${CHROME_WEB_STORE_URL ? "install from the Chrome Web Store link (Edge: allow extensions from other stores when asked); it updates itself. Or, offline: " : ""}unzip the zip to a folder you'll keep, open <code>chrome://extensions</code> or <code>edge://extensions</code>, turn on <i>Developer mode</i>, click <i>Load unpacked</i> and pick that folder.</li>
      <li><b>Firefox:</b> ${pk("firefox-signed") ? "click <i>Firefox: install</i> in Firefox and allow this site to install it (signed by Mozilla, permanent). When Devices shows an update, click it again." : "open <code>about:debugging#/runtime/this-firefox</code> → <i>Load Temporary Add-on…</i> and pick the zip (lasts until Firefox restarts; signed builds come with releases)."}</li>
      <li>Then add the device above (or click <i>New code</i> on it) and pair from the extension's options page with hub address <code>${esc(location.origin)}</code>.</li>
      <li><b>lbsv-agent (terminals):</b> easiest is the one-line installer shown with each pairing code (<i>Add device</i> or <i>New code</i>). The zip is for offline installs: unzip, then <code>node lbsv-agent.mjs install --hub ${esc(location.origin)} --code …</code> (README inside).</li>
    </ol></section>`;
}

function mcpHtml() {
  if (S.mcp === null) {
    S.mcp = [];
    api.mcpClients().then((r) => { S.mcp = r.clients; if (S.view === "devices") { S._force = true; render(); } }).catch(() => {});
  }
  const url = `${location.origin}/mcp`;
  const n = S.mcpNew;
  const cc = n ? `claude mcp add --transport http --scope user lbsv ${url} --header "Authorization: Bearer ${n.token}"` : "";
  const desk = n ? JSON.stringify({ mcpServers: { lbsv: { command: "node", args: ["/path/to/lbsv-agent/lbsv-agent.mjs", "mcp", "--hub", location.origin], env: { LBSV_MCP_TOKEN: n.token } } } }, null, 2) : "";
  const rows = (S.mcp ?? []).map((c) => `<tr><td>${esc(c.name)}</td><td class="meta">${new Date(c.createdAt - S.skew).toLocaleDateString()}</td>
    <td class="meta">${c.lastUsedAt ? seenAgo(c.lastUsedAt) : "never"}</td><td><button class="btn sm danger" data-act="mcpRevoke" data-id="${c.id}">Revoke</button></td></tr>`).join("");
  return `<section class="card" id="mcp"><h3>AI assistants (MCP)</h3>
    <p class="meta" style="margin:6px 0 10px">Let Claude Code or Claude Desktop search and organise LabSave: “where is the grafana dashboard open?”, “park my stale tabs about lbops”. Each assistant gets its own token; it can read and change saved data and act on live tabs (closing tabs always asks first). It can't see this page's passphrase or device tokens.</p>
    <form class="f" data-form="mcp" style="border:0;padding:0;grid-template-columns:1fr auto">
      <input name="name" placeholder="Name, e.g. Claude Code on i9-desktop" required autocomplete="off" maxlength="200"><button class="btn primary sm">Create token</button>
    </form>
    ${n ? `<div class="paircard" id="mcpcard">
      <div class="meta">Token for <b>${esc(n.name)}</b> · shown once, copy it now</div>
      <code class="cmd" style="user-select:all;word-break:break-all">${esc(n.token)}</code> <button class="btn sm" data-act="copy" data-text="${esc(n.token)}">Copy token</button>
      <ol>
        <li><b>Claude Code</b> (any machine that can reach this hub):<br><code class="cmd" style="word-break:break-all">${esc(cc)}</code> <button class="btn sm" data-act="copy" data-text="${esc(cc)}">Copy</button></li>
        <li><b>Claude Desktop</b> (needs lbsv-agent from the downloads above, and Node 22.18+): add to <code>claude_desktop_config.json</code>, fixing the path:<pre class="cmd" style="white-space:pre-wrap">${esc(desk)}</pre><button class="btn sm" data-act="copy" data-text="${esc(desk)}">Copy</button></li>
      </ol>
      <button class="btn sm" data-act="mcpDone">Done, hide the token</button></div>` : ""}
    ${rows ? `<table class="devtable" style="margin-top:12px"><thead><tr><th>Assistant</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  </section>`;
}

function backupsHtml() {
  if (S.backups === null) {
    S.backups = { configured: false };
    api.backups().then((r) => { S.backups = r; if (S.view === "devices") { S._force = true; render(); } }).catch(() => {});
  }
  const b = S.backups;
  if (!b.configured) return "";
  const last = b.last ? `last ${seenAgo(b.last.at)} (${Math.max(1, Math.round(b.last.size / 1024))} KB)` : "none yet";
  const sched = b.everyHours ? `Every ${b.everyHours} h, keeping the newest ${b.keep}` : "Automatic backups are off (LBSV_BACKUP_EVERY_HOURS=0)";
  return `<section class="card" id="backups"><h3>Backups<span class="sp"></span>
      <button class="btn sm" data-act="backupNow" ${S.backupBusy ? "disabled" : ""}>${S.backupBusy ? "Backing up…" : "Back up now"}</button></h3>
    <p class="meta" style="margin:6px 0 0">${esc(sched)}; ${esc(last)}; ${b.count ?? 0} on disk in <code>${esc(b.dir ?? "")}</code>.
      ${b.lastError ? `<br><b style="color:var(--danger)">Last backup failed: ${esc(b.lastError)}</b>` : ""}
      <br>Restore: stop the hub, run <code>lbsv restore latest</code> (or a file from <code>lbsv backups</code>), start it again. Copy that folder off this machine now and then.</p></section>`;
}

/** "update available" badge when the hub has a newer package for this collector (M5). */
function outdated(target: string, have: string | undefined): string {
  const p = (S.downloads ?? []).filter((x) => x.target === target || (target === "firefox" && x.target === "firefox-signed"))
    .reduce<{ version: string } | null>((m, x) => (!m || newer(x.version, m.version) ? x : m), null);
  if (!p || !have || !newer(p.version, have)) return "";
  const how = target === "agent" ? "Run lbsv-agent update on that machine (or re-run the one-line installer)."
    : target === "firefox" ? "Firefox updates itself from this hub once the signed build is installed; otherwise download the new zip below."
    : "Download the new zip below, unzip over the old folder, then click Reload on the extensions page.";
  return ` <span class="chip old" title="${esc(how)}">update → v${esc(p.version)}</span>`;
}

function viewDevices() {
  const st = S.live;
  if (!st) return `<p class="empty">Loading…</p>`;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const pair = S.pair && S.pair.expiresAt > hubNow() ? S.pair : null;
  const pairHtml = pair ? `<div class="paircard" id="paircard">
      <div class="meta">Pairing code for <b>${esc(pair.name)}</b> · single use · expires in ${Math.max(0, Math.ceil((pair.expiresAt - hubNow()) / 60000))} min</div>
      <div class="paircode" id="paircode">${esc(pair.code)}</div>
      <button class="btn sm" data-act="copy" data-text="${esc(pair.code)}">Copy code</button>
      <ol>
        <li>Load the LabSave extension in the browser you want to pair (<code>packages/ext/dist/chromium</code> for Chrome/Edge, <code>packages/ext/dist/firefox</code> for Firefox).</li>
        <li>Open its options page and enter the hub address <code>${esc(location.origin)}</code>${local ? ` <span class="meta">(from another computer, use this hub's tailnet or LAN name instead of localhost)</span>` : ""}.</li>
        <li>Paste the code and pick a profile label (e.g. Work). Each browser profile needs its own code: click <i>New code</i> on the device for the next one.</li>
        <li>For <b>terminals</b>, run one line on that machine instead (needs Node 22.18+; one code per collector). It downloads lbsv-agent from this hub, pairs, installs the shell hooks and starts it at login:${agentInstallLines(pair.code)}</li>
      </ol></div>` : "";
  const devs = st.devices.map((d) => {
    const rows = d.browsers.map((b) => {
      const s = browserState(b);
      const tabsN = b.windows.reduce((k, w) => k + w.tabs.length, 0);
      return `<tr><td>${esc(browserName(b))}</td><td><span class="dot ${s}" style="display:inline-block"></span> ${STATE_LABEL[s]}</td>
        <td class="meta">${seenAgo(b.lastSeenAt)}</td><td class="meta">${tabsN}${b.denied ? ` (+${b.denied} denied)` : ""}</td><td class="meta">${esc(b.ext || "")}${outdated(b.family === "firefox" ? "firefox" : "chromium", b.ext)}</td></tr>`;
    }).join("") + (d.agents ?? []).map((a) => {
      const s = agentState(a);
      return `<tr><td>Terminals · ${esc(a.hostname)} <span class="meta">(${esc(a.os)})</span></td><td><span class="dot ${s}" style="display:inline-block"></span> ${STATE_LABEL[s]}</td>
        <td class="meta">${seenAgo(a.lastSeenAt)}</td><td class="meta">${a.terms.length} term${a.terms.length === 1 ? "" : "s"}</td><td class="meta">agent ${esc(a.version)}${outdated("agent", a.version)}</td></tr>`;
    }).join("");
    const paired = d.browsers.length + (d.agents?.length ?? 0);
    const hostHint = d.agents?.[0]?.hostname || "user@host or ssh alias";
    return `<section class="card" data-device="${d.id}"><h3>${esc(d.name)}<span class="sp"></span>
        <button class="btn sm" data-act="devCode" data-id="${d.id}">New code</button>
        <button class="btn sm" data-act="devRevoke" data-id="${d.id}" ${paired ? "" : "disabled"}>Revoke</button>
        <button class="btn sm danger" data-act="devDelete" data-id="${d.id}">Remove</button></h3>
      ${paired ? `<table class="devtable"><thead><tr><th>Collector</th><th>Status</th><th>Last seen</th><th>Items</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty">Not paired yet${d.pendingCode ? `. A code is waiting (expires ${new Date(d.pendingCode.expiresAt - S.skew).toLocaleTimeString()})` : ". Click New code."}</div>`}
      <label class="lbl" for="deny-${d.id}">Deny-list for this device: tabs on these domains (and their subdomains) are counted but never stored</label>
      <input class="denyin" id="deny-${d.id}" data-deny="${d.id}" value="${esc(d.deny.join(", "))}" placeholder="e.g. bank.com, mail.example.com">
      <div class="g sshg">
        <div><label class="lbl" for="sshT-${d.id}">SSH target for reconnect commands (blank = the agent's hostname)</label>
          <input class="sshin" id="sshT-${d.id}" data-ssh="target" data-dev="${d.id}" value="${esc(d.ssh?.target ?? "")}" placeholder="${esc(hostHint)}"></div>
        <div><label class="lbl" for="sshJ-${d.id}">Jump host (ssh -J), for VMs on isolated networks</label>
          <input class="sshin" id="sshJ-${d.id}" data-ssh="jump" data-dev="${d.id}" value="${esc(d.ssh?.jump ?? "")}" placeholder="e.g. bastion or me@10.8.0.1"></div>
      </div>
    </section>`;
  }).join("");
  return `<h2>Devices</h2><p class="sub">Computers and VMs whose browsers and terminals stream live state. Each browser profile and each lbsv-agent pairs once with a one-time code. Revoke a device to cut it off.</p>
    <section class="card"><h3>Add a device</h3>
      <form class="f" data-form="device" style="border:0;padding:0;grid-template-columns:1fr auto">
        <input name="name" placeholder="Device name, e.g. laptop-2 or lab-vm-03" required autocomplete="off"><button class="btn primary sm">Add &amp; get code</button>
      </form>${pairHtml}
    </section>
    ${downloadsHtml()}
    ${devs}
    ${mcpHtml()}
    ${backupsHtml()}
    <section class="card"><h3>Deny-list for every device</h3>
      <input class="denyin" id="globalDeny" data-deny="*" value="${esc(st.globalDeny.join(", "))}" placeholder="e.g. bank.com, health-portal.example">
      <p class="meta" style="margin:8px 0 0">Private/incognito windows are never collected. Secret-looking URL parameters (token, key, code, session…) are stripped on the device before sending.</p>
    </section>`;
}

function viewSearch() {
  const q = S.q.toLowerCase().trim(); const terms = q.split(/\s+/).filter(Boolean);
  const match = (...f: (string | undefined)[]) => { const t = f.join(" ").toLowerCase(); return terms.every((w) => t.includes(w)); };
  const rx = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  const hl: Hl = (s) => esc(s).replace(rx, "<mark>$1</mark>");
  const L: { p: Project; l: Link }[] = [], Se: { p: Project; s: Session }[] = [], P: Project[] = [], I: { p: Project | null; text: string }[] = [];
  for (const p of sorted()) {
    norm(p);
    if (match(p.name, p.tags, p.leftOff)) P.push(p);
    for (const l of p.links) if (match(l.label, l.url, l.where, p.name, p.tags)) L.push({ p, l });
    for (const s of p.sessions) if (match(s.label, s.host, s.network, s.cmd, s.kind, p.name)) Se.push({ p, s });
    for (const i of p.ideas) if (match(i.text, ...(i.links ?? []).flatMap((l) => [l.title, l.url]))) I.push({ p, text: i.text });
  }
  for (const i of S.inbox) if (match(i.text, ...(i.links ?? []).flatMap((l) => [l.title, l.url]))) I.push({ p: null, text: i.text });
  const T = allLiveTabs().filter(({ d, b, t }) => match(t.title, t.url, d.name, b.family, b.profile));
  const LT = allLiveTerms().filter(({ d, a, t }) => match(t.name, t.cwd, t.cmd, t.kind, a.hostname, d.name));
  const from = (p: Project | null) => p ? `<span class="from" data-go="${p.id}"><span class="dot st-${p.status}" style="display:inline-block"></span> ${esc(p.name)}</span>` : `<span class="from" data-act="inbox">Inbox</span>`;
  const sec = (title: string, n: number, body: string) => n ? `<section class="card"><h3>${title} <span class="count">${n}</span></h3><div class="rows">${body}</div></section>` : "";
  const total = L.length + Se.length + P.length + I.length + T.length + LT.length;
  return `<h2>“${esc(S.q)}”</h2><p class="sub">${total} match${total === 1 ? "" : "es"} · Esc to clear</p>
   ${sec("Projects", P.length, P.map((p) => `<div class="hit" data-go="${p.id}" style="cursor:pointer"><span class="dot st-${p.status}"></span><div>${hl(p.name)}<div class="meta">${hl((p.leftOff || "").slice(0, 140))}</div></div><span class="meta">${ago(p.updatedAt)}</span></div>`).join(""))}
   ${sec("Open tabs", T.length, T.slice(0, 100).map(({ d, b, t }) => `<div class="hit ${isStale(b) ? "stale" : ""}"><span class="chip">${hl(browserName(b))}</span><div style="min-width:0"><a class="ltitle" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${hl(t.title || t.url)}</a><span class="lurl">${hl(t.url)}</span></div><span class="from" data-go="live">${hl(d.name)}</span></div>`).join(""))}
   ${sec("Live terminals", LT.length, LT.slice(0, 100).map(({ d, a, t }) => `<div class="hit ${agentState(a) === "on" ? "" : "stale"}"><span class="chip kind">${KIND_LABEL[t.kind]}</span><div style="min-width:0">${hl(termTitle(t))}<div class="hostline">${hl(tildePath(t.cwd, t.user || a.user))} · ${hl(a.hostname)}</div>${t.cmd ? `<code class="cmd">${hl(t.cmd)}</code>` : ""}</div><span class="from"><button class="btn sm" data-act="copy" data-text="${esc(reconnectCommand(t, a, d.ssh ?? { target: "", jump: "" }))}">Copy ssh</button> <span data-go="live">${hl(d.name)}</span></span></div>`).join(""))}
   ${sec("Links", L.length, L.map(({ p, l }) => `<div class="hit"><span class="chip">${l.where ? hl(l.where) : "link"}</span><div style="min-width:0"><a class="ltitle" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${hl(l.label || l.url)}</a><span class="lurl">${hl(l.url)}</span></div>${from(p)}</div>`).join(""))}
   ${sec("Terminals &amp; machines", Se.length, Se.map(({ p, s }) => `<div class="hit"><span class="chip kind">${esc(s.kind || "SSH")}</span><div style="min-width:0">${hl(s.label || s.host || "")}<div class="hostline">${hl(s.host || "")}${s.network ? " · " + hl(s.network) : ""}</div>${s.cmd ? `<code class="cmd">${hl(s.cmd)}</code> <button class="btn sm" data-act="copy" data-text="${esc(s.cmd)}">Copy</button>` : ""}</div>${from(p)}</div>`).join(""))}
   ${sec("Ideas &amp; notes", I.length, I.map(({ p, text }) => `<div class="hit"><span class="chip">idea</span><div style="white-space:pre-wrap">${hl(text)}</div>${from(p)}</div>`).join(""))}
   ${total ? "" : `<p class="empty">Nothing found. Try a host name, a domain, or part of a command.</p>`}`;
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const t = target.closest<HTMLElement>("[data-act],[data-go],[data-filter]"); if (!t) return;
  if (t.dataset.go && !target.closest("a")) { go(t.dataset.go); return; }
  if (t.dataset.filter) { S.filter = t.dataset.filter as Status | "all"; renderSide(); return; }
  const a = t.dataset.act!, p = S.projects.get(t.dataset.p || "")!;
  if (a === "home" || a === "inbox" || a === "machines" || a === "live" || a === "devices") return go(a);
  if (a === "sel") {
    const box = t as HTMLInputElement;
    if (box.checked) S.sel.set(box.dataset.tab!, box.dataset.url!); else S.sel.delete(box.dataset.tab!);
    box.closest(".ltab")?.classList.toggle("sel", box.checked);
    syncSelbar(); lastLiveBody = ""; return;
  }
  if (a === "selShown") {
    for (const el of document.querySelectorAll<HTMLInputElement>("#liveBody .tsel")) S.sel.set(el.dataset.tab!, el.dataset.url!);
    lastLiveBody = ""; renderLive(); return;
  }
  if (a === "selClear") { S.sel.clear(); lastLiveBody = ""; renderLive(); return; }
  if (a === "tabFocus") { void focusTab(t.dataset.tab!); return; }
  if (a === "tabClose") { void closeTabs([{ id: t.dataset.tab!, url: t.dataset.url! }]); return; }
  if (a === "closeSel") { void closeTabs([...S.sel].map(([id, url]) => ({ id, url }))); return; }
  if (a === "parkClose" || a === "parkKeep") { void parkSelected(a === "parkClose"); return; }
  if (a === "attachClose" || a === "attachKeep") { void attachSelected(a === "attachClose"); return; }
  if (a === "sendSel") { void sendSelected(); return; }
  if (a === "dedupe") { void dedupe(); return; }
  if (a === "tabMenu") { tabMenu(t, t.dataset.tab!, t.dataset.url!); return; }
  if (a === "openIn") { browserMenu(t, "Open in", (b) => void openUrls(b, [t.dataset.url!])); return; }
  if (a === "restoreWs") {
    const urls = p.links.map((l) => l.url);
    browserMenu(t, `Restore ${plural(urls.length, "link")} in`, (b) => void restoreWorkspace(b, urls));
    return;
  }
  if (a === "ideaOpenAll") {
    const f = findIdea(t.dataset.idea!); if (!f) return;
    const urls = (f.idea.links ?? []).map((l) => l.url);
    browserMenu(t, `Open ${plural(urls.length, "link")} in`, (b) => void restoreWorkspace(b, urls));
    return;
  }
  if (a === "delIdeaLink") { removeIdeaLink(t.dataset.idea!, t.dataset.id!); return; }
  if (a === "accept") {
    const pid = t.dataset.p!;
    if (t.dataset.kind === "tab") void parkTabs([{ id: t.dataset.id!, url: t.dataset.url! }], { projectId: pid }, false);
    else void saveTerm(t.dataset.id!, pid);
    return;
  }
  if (a === "acceptAll") { void acceptSuggestions([...shownSuggestions]); return; }
  if (a === "termMenu") { termMenu(t, t.dataset.term!); return; }
  if (a === "delRule") { delRule(p, t.dataset.id!); return; }
  if (a === "liveUnfiled") { S.liveUnfiled = !S.liveUnfiled; renderLive(); syncLiveToggles(); return; }
  if (a === "liveDup" || a === "liveOld") { if (a === "liveDup") S.liveDup = !S.liveDup; else S.liveOld = !S.liveOld; renderLive(); syncLiveToggles(); return; }
  if (a === "devCode") {
    const d = S.live?.devices.find((x) => x.id === t.dataset.id); if (!d) return;
    try { showPair(d.id, d.name, await api.deviceCode(d.id)); } catch (err) { toast(`Couldn't create a code: ${(err as Error).message}`); }
    return;
  }
  if (a === "devRevoke" || a === "devDelete") {
    const d = S.live?.devices.find((x) => x.id === t.dataset.id); if (!d) return;
    const q = a === "devRevoke"
      ? `Revoke “${d.name}”? Its browsers are disconnected and their tokens stop working, and its live tabs are removed. You can pair it again with a new code.`
      : `Remove “${d.name}” and everything it reported? This can't be undone.`;
    if (!confirm(q)) return;
    try {
      if (a === "devRevoke") await api.revokeDevice(d.id); else await api.deleteDevice(d.id);
      if (S.pair?.deviceId === d.id) S.pair = null;
      toast(a === "devRevoke" ? `Revoked ${d.name}` : `Removed ${d.name}`);
      scheduleLiveRefetch(0);
    } catch (err) { toast(`Failed: ${(err as Error).message}`); }
    return;
  }
  if (a === "backupNow") {
    S.backupBusy = true; S._force = true; render();
    try { const r = await api.backupNow(); S.backups = { ...r, configured: true }; toast(`Backed up: ${r.last?.name ?? "done"}`); }
    catch (err) { toast(`Backup failed: ${(err as Error).message}`); S.backups = null; }
    S.backupBusy = false; S._force = true; render();
    return;
  }
  if (a === "mcpDone") { S.mcpNew = null; S._force = true; render(); return; }
  if (a === "mcpRevoke") {
    const c = S.mcp?.find((x) => x.id === t.dataset.id); if (!c) return;
    if (!confirm(`Revoke the MCP token for “${c.name}”? That assistant loses access immediately.`)) return;
    try { await api.deleteMcpClient(c.id); S.mcp = S.mcp!.filter((x) => x.id !== c.id); S._force = true; render(); toast(`Revoked ${c.name}`); }
    catch (err) { toast(`Failed: ${(err as Error).message}`); }
    return;
  }
  if (a === "export") return; // plain download link
  if (a === "import") { e.preventDefault(); $<HTMLInputElement>("#importFile").click(); return; }
  if (a === "logout") { e.preventDefault(); await api.logout().catch(() => {}); stop(); showLogin(true); return; }
  if (a === "toggle") {
    S.open[t.dataset.k!] = !S.open[t.dataset.k!]; S._force = true; renderMain();
    const f = document.querySelector<HTMLElement>(`[data-form="${t.dataset.k}"]:not(.hidden) input, [data-form="${t.dataset.k}"]:not(.hidden) textarea`); f?.focus();
    return;
  }
  if (a === "status") return saveProject(p.id, { status: t.dataset.v as Status });
  if (a === "copy" || a === "copyUrls") {
    const text = a === "copy" ? t.dataset.text! : p.links.map((l) => l.url).join("\n");
    try { await navigator.clipboard.writeText(text); toast(a === "copy" ? "Copied" : `Copied ${p.links.length} URLs`); }
    catch { toast("Your browser blocked the clipboard. Select the text and copy it instead."); }
    return;
  }
  if (a === "delLink" || a === "delSess" || a === "delIdea") {
    const key = ({ delLink: "links", delSess: "sessions", delIdea: "ideas" } as const)[a];
    removeChild(p, key, t.dataset.id!);
    return;
  }
  if (a === "delInbox") { const it = S.inbox.find((i) => i.id === t.dataset.id)!; delInbox(it.id); toast("Deleted", () => addInbox(it.text, it)); return; }
  if (a === "delProject") {
    if (S.confirmDel !== p.id) {
      S.confirmDel = p.id; S._force = true; renderMain();
      setTimeout(() => { if (S.confirmDel === p.id) { S.confirmDel = null; S._force = true; renderMain(); } }, 4000);
      return;
    }
    S.confirmDel = null; const snap = clone(p); removeProject(p.id); go("home");
    toast(`Deleted “${snap.name}”`, () => restoreProject(snap));
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement & { _deb?: ReturnType<typeof setTimeout> };
  if (t.id === "importFile") return importFile(t as HTMLInputElement);
  if (t.id === "parkTo") { S.parkTo = t.value; return; }
  if (t.id === "ideaTo") { S.ideaTo = t.value; return; }
  if (t.id === "sendTo") { S.sendTo = t.value; return; }
  if ((t as HTMLInputElement).dataset.ssh) {
    const el = t as HTMLInputElement, dev = el.dataset.dev!;
    const patch = el.dataset.ssh === "target" ? { sshTarget: el.value.trim() } : { sshJump: el.value.trim() };
    try { await api.patchDevice(dev, patch); toast(el.value.trim() ? "Saved; reconnect commands updated" : "Cleared"); scheduleLiveRefetch(0); }
    catch (err) { toast(`Couldn't save: ${(err as Error).message}`); }
    return;
  }
  if ((t as HTMLInputElement).dataset.deny) {
    const id = (t as HTMLInputElement).dataset.deny!, domains = splitDomains(t.value);
    try {
      const saved = id === "*" ? (await api.setGlobalDeny(domains)).domains : (await api.patchDevice(id, { deny: domains })).deny;
      t.value = saved.join(", ");
      toast(saved.length ? `Deny-list saved (${saved.length} domain${saved.length === 1 ? "" : "s"})` : "Deny-list cleared");
      scheduleLiveRefetch(0);
    } catch (err) { toast(`Couldn't save: ${(err as Error).message}`); }
    return;
  }
  if (t.dataset.act === "file") {
    const it = S.inbox.find((i) => i.id === t.dataset.id); if (!it || !t.value) return;
    if (t.value === "__new") { delInbox(it.id); newProject(it.text.slice(0, 60)); return; }
    const p = S.projects.get(t.value)!;
    p.ideas = [{ id: it.id, text: it.text, at: it.at, links: it.links }, ...p.ideas].sort((a, b) => b.at - a.at); touch(p);
    S.inbox = S.inbox.filter((i) => i.id !== it.id); render();
    send("i:" + it.id, () => api.moveIdea(it.id, p.id));
    toast(`Filed into ${p.name}`);
    return;
  }
  const f = t.dataset.f as Field | undefined;
  if (f && S.projects.has(S.view)) {
    clearTimeout((t as { _deb?: ReturnType<typeof setTimeout> })._deb);
    saveProject(S.view, { [f]: t.value }, { silent: true }); renderSide();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement & { _deb?: ReturnType<typeof setTimeout> };
  if (t.id === "q") { S.q = t.value; S._force = true; renderSide(); renderMain(); return; }
  if (t.id === "liveQ") { S.liveQ = t.value; renderLive(); return; }
  const f = t.dataset.f as Field | undefined;
  if (f && S.projects.has(S.view)) {
    clearTimeout(t._deb); const id = S.view;
    t._deb = setTimeout(() => { saveProject(id, { [f]: t.value }, { silent: true }); renderSide(); }, 1200);
  }
});

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  if (f.id === "loginForm") return doLogin();
  if (f.id === "capture") {
    const v = $<HTMLInputElement>("#capText").value.trim(); if (!v) return;
    const to = $<HTMLSelectElement>("#capTo").value;
    if (to && S.projects.has(to)) { const p = S.projects.get(to)!; addProjectIdea(p, v); toast(`Added to ${p.name}`); }
    else { addInbox(v); toast("Captured to inbox"); }
    $<HTMLInputElement>("#capText").value = ""; return;
  }
  if (f.id === "newp") {
    const v = $<HTMLInputElement>("#newpName").value.trim(); if (!v) return;
    $<HTMLInputElement>("#newpName").value = ""; S.filter = S.filter === "all" ? "all" : "active"; newProject(v); return;
  }
  if (f.dataset.form === "mcp") {
    const input = f.querySelector<HTMLInputElement>("input[name=name]")!;
    const name = input.value.trim(); if (!name) return;
    try {
      const r = await api.createMcpClient(name);
      input.value = "";
      S.mcp = [...(S.mcp ?? []), r.client]; S.mcpNew = { name: r.client.name, token: r.token };
      S._force = true; render();
    } catch (err) { toast(`Couldn't create the token: ${(err as Error).message}`); }
    return;
  }
  if (f.dataset.form === "device") {
    const input = f.querySelector<HTMLInputElement>("input[name=name]")!;
    const name = input.value.trim(); if (!name) return;
    try {
      const r = await api.createDevice(name);
      input.value = "";
      showPair(r.device.id, r.device.name, r);
      scheduleLiveRefetch(0);
    } catch (err) { toast(`Couldn't add the device: ${(err as Error).message}`); }
    return;
  }
  const p = S.projects.get(f.dataset.p || ""); if (!p) return;
  const d = Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim()])) as Record<string, string>;
  if (f.dataset.form === "link") {
    if (!d.url) return; if (!/^[a-z]+:\/\//i.test(d.url)) d.url = "https://" + d.url;
    S.open.link = false; S._force = true;
    addLinks(p, [{ id: ulid(), label: d.label ?? "", url: d.url, where: d.where ?? "", at: Date.now() }]);
  } else if (f.dataset.form === "bulk") {
    const have = new Set(p.links.map((l) => l.url)); const add: Partial<Link>[] = [];
    for (const l of parseLinks(d.text ?? "")) if (!have.has(l.url)) { have.add(l.url); add.push({ id: ulid(), ...l, where: d.where ?? "", at: Date.now() }); }
    if (!add.length) { toast("No new URLs found in that text"); return; }
    S.open.bulk = false; S._force = true;
    addLinks(p, add); toast(`Imported ${add.length} link${add.length === 1 ? "" : "s"}`);
  } else if (f.dataset.form === "sess") {
    if (!d.host && !d.label && !d.cmd) return;
    S.open.sess = false; S._force = true;
    const s = { id: ulid(), kind: d.kind || "SSH", label: d.label ?? "", host: d.host ?? "", network: d.network ?? "", cmd: d.cmd ?? "", at: Date.now() };
    p.sessions = [...p.sessions, s as Session]; touch(p); render();
    send("p:" + p.id, () => api.addSession(p.id, s));
  } else if (f.dataset.form === "rule") {
    if (!d.pattern) return;
    try {
      await api.addRule(p.id, { kind: d.kind as RuleKind, pattern: d.pattern });
      S.open.rule = false; S._force = true; scheduleRefetch(0); lastLiveBody = "";
      toast("Rule added");
    } catch (err) { toast(`Couldn't add the rule: ${(err as Error).message}`); }
  } else if (f.dataset.form === "idea") {
    if (!d.text) return; S._force = true;
    addProjectIdea(p, d.text);
    setTimeout(() => { document.querySelector<HTMLInputElement>('[data-form="idea"] input')?.focus(); }, 0);
  }
});

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  const q = $<HTMLInputElement>("#q");
  if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) { e.preventDefault(); q.focus(); q.select(); }
  else if (e.key === "Escape" && document.activeElement === q) { q.value = ""; S.q = ""; S._force = true; render(); q.blur(); }
  else if (e.key === "Escape" && document.activeElement?.id === "liveQ") { (document.activeElement as HTMLInputElement).value = ""; S.liveQ = ""; renderLive(); }
});

/* ---------- import ---------- */
async function importFile(input: HTMLInputElement) {
  const file = input.files?.[0]; input.value = ""; if (!file) return;
  let data: ExportFile;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't valid JSON."); return; }
  if ((data?.format !== "lbsv" && data?.format !== "switchboard") || !Array.isArray(data.projects)) { toast("That isn't a LabSave export."); return; }
  const n = data.projects.length, m = (data.inbox || []).length;
  if (!confirm(`Import ${n} project${n === 1 ? "" : "s"} and ${m} inbox item${m === 1 ? "" : "s"} from ${file.name}?\n\nThey are merged into your current data. Items with the same id are overwritten by the file's version.`)) return;
  try { const r = await api.importData(data, "merge"); toast(`Imported ${r.projects} projects, ${r.inbox} inbox items`); scheduleRefetch(0); }
  catch (e) { toast(`Import failed: ${e instanceof Error ? e.message : e}`); }
}

/* ---------- login / boot ---------- */
let setupMode = false;
function showLogin(configured: boolean) {
  S.authed = false;
  setupMode = !configured;
  $("#login").classList.remove("hidden");
  const pass = $<HTMLInputElement>("#loginPass"), code = $<HTMLInputElement>("#loginCode");
  $("#loginErr").textContent = "";
  code.classList.toggle("hidden", configured);
  code.required = !configured;
  pass.autocomplete = configured ? "current-password" : "new-password";
  pass.placeholder = configured ? "Passphrase" : "Choose an admin passphrase (8+ characters)";
  pass.minLength = configured ? 0 : 8;
  $("#loginBtn").textContent = configured ? "Unlock" : "Set passphrase";
  if (configured) {
    $("#loginMsg").textContent = "Enter your admin passphrase.";
    setTimeout(() => pass.focus(), 0);
  } else {
    $("#loginMsg").innerHTML = "Welcome. To claim this hub, enter the <b>setup code</b> from the hub's log (<code>docker compose logs hub</code>, or run <code>lbsv setup-code</code>) and choose your admin passphrase.";
    setTimeout(() => code.focus(), 0);
  }
}
async function doLogin() {
  const pass = $<HTMLInputElement>("#loginPass"), code = $<HTMLInputElement>("#loginCode");
  try {
    if (setupMode) await api.setup(code.value, pass.value);
    else await api.login(pass.value);
    pass.value = ""; code.value = "";
    start();
  } catch (e) {
    const st = e instanceof ApiError ? e.status : 0;
    $("#loginErr").textContent = st === 429 ? "Too many attempts. Wait a moment and try again."
      : setupMode ? (st === 401 ? "That setup code isn't right (it changes every time the hub restarts)." : st === 409 ? "This hub was just set up. Reload and sign in." : st === 400 ? "The passphrase needs at least 8 characters." : "Setup failed.")
      : "That passphrase didn't work.";
    (setupMode && st === 401 ? code : pass).select();
  }
}
function start() {
  S.authed = true;
  $("#login").classList.add("hidden");
  banner("");
  connectWs();
  scheduleRefetch(0);
}
function stop() {
  S.authed = false;
  const s = ws; ws = null; s?.close();
}
setUnauthorizedHandler(() => { if (S.authed) { stop(); showLogin(true); } });

async function boot() {
  readHash();
  try {
    const a = await api.auth();
    if (!a.authenticated) return showLogin(a.configured);
    start();
  } catch {
    banner("Can't reach the hub — retrying…");
    setTimeout(boot, 3000);
  }
}
boot();
