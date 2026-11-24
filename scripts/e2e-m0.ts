/**
 * M0 acceptance walkthrough against a running hub, driving two real browser windows.
 *   LBSV_URL=http://127.0.0.1:8080 LBSV_PASS=... node scripts/e2e-m0.ts
 * Uses an installed Edge (or Chrome via LBSV_BROWSER=chrome); no browser download needed.
 * Run it against a fresh/throwaway data dir: it creates and deletes data.
 */
import { chromium, type Page } from "playwright-core";

const URL0 = process.env.LBSV_URL || "http://127.0.0.1:8080";
const PASS = process.env.LBSV_PASS || "devpassphrase";
const channel = process.env.LBSV_BROWSER === "chrome" ? "chrome" : "msedge";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failed++;
};
const until = async (fn: () => Promise<boolean>, ms = 1000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return Date.now() - t0; await new Promise((r) => setTimeout(r, step)); }
  return -1;
};
const text = (p: Page, sel: string) => p.locator(sel).first().innerText().catch(() => "");

const browser = await chromium.launch({ channel, headless: process.env.HEADED !== "1" });
const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const ctxB = await browser.newContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errors: string[] = [];
for (const p of [A, B]) p.on("pageerror", (e) => errors.push(String(e)));

async function login(p: Page) {
  await p.goto(URL0 + "/#home");
  await p.locator("#loginPass").fill(PASS);
  await p.locator("#loginPass").press("Enter");
  await p.locator("#login").waitFor({ state: "hidden" });
}

try {
  // Login gate
  await A.goto(URL0);
  check("login screen shown when signed out", await A.locator("#login").isVisible());
  await A.locator("#loginPass").fill("wrong-passphrase");
  await A.locator("#loginPass").press("Enter");
  check("wrong passphrase rejected", (await until(async () => (await text(A, "#loginErr")).length > 0)) >= 0);
  await login(A);
  await login(B);
  check("first-run onboarding when no projects", (await text(A, "main")).includes("Welcome to LabSave"));

  // New project
  await A.locator("#newpName").fill("Homelab rebuild");
  await A.locator("#newpName").press("Enter");
  await A.waitForURL(/#[0-9A-Z]{26}$/);
  const pid = A.url().split("#")[1]!;
  check("new project routes to #<projectId>", !!pid);
  check("B sees new project in sidebar within 1s", (await until(async () => (await text(B, "#plist")).includes("Homelab rebuild"))) >= 0);

  // Left off: autosave on blur, B sees it
  await A.locator("textarea.leftoff").fill("Rebuilding pve-02; next: restore VM 104");
  await A.locator("h3").first().click();
  const t1 = await until(async () => { await B.goto(URL0 + "/#" + pid); return (await B.locator("textarea.leftoff").inputValue()) === "Rebuilding pve-02; next: restore VM 104"; }, 1500);
  check("B sees left-off edit (save on blur)", t1 >= 0, `${t1}ms`);

  // Debounced autosave without blur (1.2s)
  await A.locator("textarea.leftoff").click();
  await A.locator("textarea.leftoff").press("End");
  await A.keyboard.type(" (debounced)");
  const t2 = await until(async () => (await B.locator("textarea.leftoff").inputValue()).endsWith("(debounced)"), 2500);
  check("left-off autosaves on 1.2s debounce while still focused", t2 >= 0, `${t2}ms after typing`);
  await A.locator("h3").first().click();

  // Links: add, paste many with dedupe, where chip, copy all, remove+undo
  await A.locator('h3 [data-act=toggle][data-k=link]').click();
  await A.locator('[data-form=link] input[name=url]').fill("pve.lan:8006");
  await A.locator('[data-form=link] input[name=label]').fill("Proxmox");
  await A.locator('[data-form=link] input[name=where]').fill("Edge · work");
  await A.locator('[data-form=link] button.primary').click();
  check("add link prepends https:// and shows where-chip", (await text(A, ".row.link")).includes("Proxmox") && (await A.locator(".row.link .chip").first().innerText()) === "Edge · work"
    && (await text(A, ".row.link .lurl")) === "https://pve.lan:8006");
  await A.locator('h3 [data-act=toggle][data-k=bulk]').click();
  await A.locator('[data-form=bulk] textarea').fill("[Grafana](https://grafana.lan/d/node)\nhttps://pve.lan:8006\nRouter - 192.168.1.1\nhttps://grafana.lan/d/node");
  await A.locator('[data-form=bulk] button.primary').click();
  await until(async () => (await A.locator(".row.link").count()) === 3);
  check("paste many imports 2 new, skips 2 dupes", (await A.locator(".row.link").count()) === 3);
  check("B sees links within 1s", (await until(async () => (await B.locator(".row.link").count()) === 3)) >= 0);
  await A.locator('[data-act=copyUrls]').click();
  const clip = await A.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check("copy all URLs", clip.split("\n").length === 3, JSON.stringify(clip));
  await A.locator(".row.link .x").first().click();
  check("remove link", (await A.locator(".row.link").count()) === 2);
  await A.locator("#undoBtn").click();
  check("undo remove link", (await A.locator(".row.link").count()) === 3);
  await A.waitForTimeout(300);
  await A.reload();
  check("undo persisted server-side (after reload)", (await until(async () => (await A.locator(".row.link").count()) === 3, 3000)) >= 0, `${await A.locator(".row.link").count()} links`);

  // Sessions
  await A.locator('h3 [data-act=toggle][data-k=sess]').click();
  await A.locator('[data-form=sess] select[name=kind]').selectOption("tmux");
  await A.locator('[data-form=sess] input[name=label]').fill("api");
  await A.locator('[data-form=sess] input[name=host]').fill("devbox-02");
  await A.locator('[data-form=sess] input[name=network]').fill("lab VPN");
  await A.locator('[data-form=sess] input[name=cmd]').fill("ssh -J bastion devbox-02 -t tmux new -A -s api");
  await A.locator('[data-form=sess] button.primary').click();
  check("add session", (await text(A, ".row.sess")).includes("devbox-02"));
  await A.locator(".row.sess [data-act=copy]").click();
  check("copy reconnect command", (await A.evaluate(() => navigator.clipboard.readText()).catch(() => "")).startsWith("ssh -J bastion"));

  // Ideas
  await A.locator('[data-form=idea] input').fill("Try ZFS send/recv for VM backups");
  await A.locator('[data-form=idea] input').press("Enter");
  await A.locator('[data-form=idea] input').fill("Second idea");
  await A.locator('[data-form=idea] input').press("Enter");
  const ideas = await A.locator(".row.idea").allInnerTexts();
  check("ideas newest first, input keeps focus", ideas[0]!.startsWith("Second idea") && await A.locator('[data-form=idea] input').evaluate((e) => e === document.activeElement));

  // Tags + status
  await A.locator('.tags input').fill("homelab, infra");
  await A.locator('h3').first().click();
  await A.locator('[data-act=status][data-v=parked]').click();
  check("status parked → sidebar count", (await text(A, "#tabs")).includes("Parked 1"));
  await A.locator('[data-act=status][data-v=active]').click();

  // Capture box → inbox, → project
  await A.locator("#capTo").selectOption("");
  await A.locator("#capText").fill("Look at Headscale for the isolated VMs");
  await A.locator("#capText").press("Enter");
  check("capture to inbox updates count", (await text(A, "#inboxN")) === "1");
  check("B inbox count within 1s", (await until(async () => (await text(B, "#inboxN")) === "1")) >= 0);
  await A.locator("#capTo").selectOption(pid);
  await A.locator("#capText").fill("Captured straight into project");
  await A.locator("#capText").press("Enter");
  check("capture into project", (await text(A, ".row.idea")).includes("Captured straight into project"));

  // Inbox: file into project, new project from this, delete+undo
  await A.locator("#nav-inbox").click();
  await A.locator('select[data-act=file]').selectOption(pid);
  check("file inbox item into project", (await text(A, "#inboxN")) === "" && (await text(A, "main")).includes("Inbox empty"));
  await A.locator("#capTo").selectOption("");
  await A.locator("#capText").fill("Idea that becomes a project");
  await A.locator("#capText").press("Enter");
  await A.locator("#capText").fill("Idea to delete");
  await A.locator("#capText").press("Enter");
  await A.locator("#nav-inbox").click();
  await A.locator('.row:has-text("Idea to delete") .x').click();
  check("delete inbox item", !(await text(A, "main")).includes("Idea to delete"));
  await A.locator("#undoBtn").click();
  check("undo delete inbox item", (await text(A, "main")).includes("Idea to delete"));
  await A.locator('.row:has-text("Idea that becomes a project") select[data-act=file]').selectOption("__new");
  await A.waitForURL(/#[0-9A-Z]{26}$/);
  check("new project from inbox item", (await A.locator(".pname").inputValue()) === "Idea that becomes a project");

  // Machines
  await A.locator("#nav-machines").click();
  check("machines table aggregates host", (await text(A, "main table")).includes("devbox-02") && (await text(A, "main table")).includes("lab VPN") && (await text(A, "#hostN")) === "1");

  // Search: '/', multi-term AND, highlight, grouping, Esc
  await A.locator("body").click();
  await A.keyboard.press("/");
  check("'/' focuses search", await A.locator("#q").evaluate((e) => e === document.activeElement));
  await A.keyboard.type("grafana node");
  const sm = await text(A, "main");
  check("search groups + AND match", sm.toLowerCase().includes("links") && sm.includes("1 match"), JSON.stringify(sm.slice(0, 300)));
  check("search highlights", (await A.locator("main mark").count()) >= 2);
  await A.keyboard.press("Escape");
  check("Esc clears search", (await A.locator("#q").inputValue()) === "" && !(await text(A, "main")).includes("match"));
  await A.keyboard.press("Control+k");
  check("Ctrl+K focuses search", await A.locator("#q").evaluate((e) => e === document.activeElement));
  await A.keyboard.type("devbox");
  { const st = await text(A, "main"); check("search finds terminals with source project", st.toLowerCase().includes("terminals & machines") && st.includes("Homelab rebuild"), JSON.stringify(st.slice(0, 300))); }
  await A.keyboard.press("Escape");

  // Home cards
  await A.locator("#nav-home").click();
  const card = await text(A, `.pcard[data-go="${pid}"]`);
  check("home card shows left-off + counts", card.includes("Rebuilding pve-02") && card.includes("3 links") && card.includes("1 sessions"), card.replace(/\n/g, " | "));

  // Concurrency: A types slowly in left-off while B edits name AND left-off of the same project.
  await A.goto(URL0 + "/#" + pid);
  await B.goto(URL0 + "/#" + pid);
  const ta = A.locator("textarea.leftoff");
  await ta.click();
  await ta.press("End");
  const typed = " ABCDEFGHIJKLMNOP";
  const typing = (async () => { for (const ch of typed) { await A.keyboard.type(ch); await A.waitForTimeout(90); } })();
  await A.waitForTimeout(300);
  await B.locator(".pname").fill("Homelab rebuild (renamed by B)");
  await B.locator("h3").first().click();
  await B.locator("textarea.leftoff").fill("B overwrote left-off");
  await B.locator("h3").first().click();
  await typing;
  const aVal = await ta.inputValue();
  check("no lost keystrokes in A while B edits the same project", aVal.endsWith(typed), JSON.stringify(aVal.slice(-30)));
  await A.locator("h3").first().click(); // blur → save A's text
  check("A picks up B's rename after blur", (await until(async () => (await A.locator(".pname").inputValue()) === "Homelab rebuild (renamed by B)", 1500)) >= 0);
  check("B converges to A's left-off (last writer wins)", (await until(async () => (await B.locator("textarea.leftoff").inputValue()).endsWith(typed), 2000)) >= 0);

  // Delete project: two-click confirm + undo
  await A.locator("[data-act=delProject]").click();
  check("delete needs a second click", (await text(A, "[data-act=delProject]")) === "Click again to delete");
  await A.locator("[data-act=delProject]").click();
  await A.waitForURL(/#home$/);
  check("B drops deleted project within 1s", (await until(async () => !(await text(B, "#plist")).includes("renamed by B"))) >= 0);
  await A.locator("#undoBtn").click();
  await A.waitForURL(new RegExp(pid));
  { const counts = async () => [await A.locator(".row.link").count(), await A.locator(".row.sess").count(), await A.locator(".row.idea").count()]; await until(async () => (await counts())[0] === 3, 1500); const c = await counts(); check("undo delete restores links/sessions/ideas", c[0] === 3 && c[1] === 1 && c[2]! >= 3, JSON.stringify(c)); }
  check("B sees restored project", (await until(async () => (await text(B, "#plist")).includes("renamed by B"))) >= 0);

  // Export available
  const ex = await A.evaluate(async () => (await fetch("/api/export")).json());
  check("export JSON", ex.format === "lbsv" && ex.projects.length === 2);

  check("no page errors", errors.length === 0, errors.join("; "));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
