/**
 * M2b walkthrough: tab action menu, tabs → ideas (URL-based, live-aware), send to another browser,
 * duplicates "keep one", project "Live now" strip and Restore workspace, link "Open in…".
 *   npm run build && npm run build:ext && npm run e2e:m2b
 * Own throwaway hub (SB_E2E_PORT, default 18095) + local page server; two real Edge profiles.
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extDir = join(root, "packages", "ext", "dist", "chromium");
const PORT = Number(process.env.LBSV_E2E_PORT || 18095);
const HUB = `http://127.0.0.1:${PORT}`;
const PASS = "e2e-passphrase-cnlsft";
const channel = process.env.LBSV_BROWSER === "chrome" ? "chrome" : "msedge";
const headless = process.env.HEADED !== "1";
if (!existsSync(join(extDir, "manifest.json")) || !existsSync(join(root, "packages", "ui", "dist", "index.html"))) {
  console.error("Build first: npm run build && npm run build:ext"); process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const until = async (fn: () => Promise<boolean>, ms = 4000, step = 30) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return Date.now() - t0; await new Promise((r) => setTimeout(r, step)); }
  return -1;
};

const pages = createServer((req, res) => {
  const name = decodeURIComponent((req.url || "/").split("?")[0]!.slice(1)).replace(/</g, "") || "index";
  if (name === "favicon.ico") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
});
await new Promise<void>((r) => pages.listen(0, "127.0.0.1", () => r()));
const PAGES = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;

const dataDir = mkdtempSync(join(tmpdir(), "lbsv-e2e-m2b-"));
let hubProc: ChildProcess | null = spawn(process.execPath, [join(root, "packages", "hub", "src", "cli.ts"), "serve"], {
  env: { ...process.env, LBSV_DATA_DIR: dataDir, LBSV_PORT: String(PORT), LBSV_HOST: "127.0.0.1", LBSV_ADMIN_PASSPHRASE: PASS, LBSV_LOG_LEVEL: "warn", LBSV_UI_DIR: join(root, "packages", "ui", "dist"), LBSV_FAVICONS: "0" },
  stdio: ["ignore", "inherit", "inherit"],
});
if ((await until(async () => (await fetch(HUB + "/api/health")).ok, 15_000, 100)) < 0) throw new Error("hub didn't start");

const ui = await chromium.launch({ channel, headless });
const contexts: BrowserContext[] = [];
const errors: string[] = [];
let promptAnswer = "";

async function browserWithExtension() {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "lbsv-e2e-prof-")), {
    channel, headless, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  contexts.push(ctx);
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  return { ctx, extId: new URL(sw.url()).host };
}
async function pair(ctx: BrowserContext, extId: string, code: string, profile: string) {
  const O = await ctx.newPage();
  await O.goto(`chrome-extension://${extId}/options.html`);
  await O.locator("#hubUrl").fill(HUB);
  await O.locator("#code").fill(code);
  await O.locator("#profileNew").fill(profile);
  await O.locator("#pairForm button").click();
  const ok = (await until(async () => (await O.locator("#statusText").innerText()) === "Connected", 8000)) >= 0;
  await O.close();
  return ok;
}
const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(`${PAGES}/${path}`); return p; };
const count = (ctx: BrowserContext, needle: string) => ctx.pages().filter((p) => !p.isClosed() && p.url().includes(needle)).length;

try {
  const U: Page = await ui.newPage();
  U.on("pageerror", (e) => errors.push(String(e)));
  U.on("dialog", (d) => void (d.type() === "prompt" ? d.accept(promptAnswer) : d.accept()));
  await U.goto(HUB + "/#devices");
  await U.locator("#loginPass").fill(PASS);
  await U.locator("#loginPass").press("Enter");
  await U.locator("#login").waitFor({ state: "hidden" });
  await U.locator('[data-form="device"] input[name=name]').fill("e2e-pc");
  await U.locator('[data-form="device"] input[name=name]').press("Enter");
  await U.locator("#paircode").waitFor();
  const code1 = (await U.locator("#paircode").innerText()).trim();
  const A = await browserWithExtension();
  check("Work profile pairs", await pair(A.ctx, A.extId, code1, "Work"));
  await U.locator('[data-act="devCode"]').first().click();
  await until(async () => (await U.locator("#paircode").innerText()).trim() !== code1);
  const B = await browserWithExtension();
  check("Home profile pairs", await pair(B.ctx, B.extId, (await U.locator("#paircode").innerText()).trim(), "Home"));

  await open(A.ctx, "rust-async-a");
  await open(A.ctx, "rust-async-b");
  await open(A.ctx, "send-me");
  await open(A.ctx, "dup-page");
  await open(B.ctx, "dup-page");
  await open(B.ctx, "dup-page");
  await U.goto(HUB + "/#live");
  const liveText = () => U.locator("#liveBody").innerText().catch(() => "");
  check("tabs from both profiles are live", (await until(async () => { const t = await liveText(); return t.includes("send-me") && t.includes("×3"); }, 6000)) >= 0);
  const toast = U.locator("#toast");
  const menuOn = async (title: string) => {
    const row = U.locator(".ltab", { hasText: title }).first();
    await row.hover();
    await row.locator('[data-act="tabMenu"]').click();
    await U.locator("#menu").waitFor();
  };

  /* ---------- tab menu → new idea ---------- */
  promptAnswer = "Learn async Rust";
  await menuOn("rust-async-a");
  await U.locator("#menu .mi", { hasText: "New idea from this tab" }).click();
  await toast.filter({ hasText: "Attached 1 link" }).waitFor({ timeout: 5000 });
  check("⋯ → New idea from this tab creates an inbox idea with the tab attached (tab stays open)", count(A.ctx, "rust-async-a") === 1);

  /* ---------- selection bar → attach & close to that idea ---------- */
  await U.locator(".ltab", { hasText: "rust-async-b" }).locator(".tsel").check();
  const ideaVal = await U.locator("#ideaTo option", { hasText: "Learn async Rust" }).getAttribute("value");
  await U.locator("#ideaTo").selectOption(ideaVal!);
  await U.locator('[data-act="attachClose"]').click();
  await toast.filter({ hasText: "closed 1" }).waitFor({ timeout: 5000 });
  check("Attach & close adds the URL to the idea and closes the tab", (await until(async () => count(A.ctx, "rust-async-b") === 0)) >= 0);

  /* ---------- the idea is live-aware ---------- */
  await U.goto(HUB + "/#inbox");
  const idea = U.locator(".row", { hasText: "Learn async Rust" }).first();
  check("the inbox idea lists both attached URLs", (await until(async () => (await idea.locator(".ilink").count()) === 2)) >= 0);
  check("the still-open one shows ● open, the closed one doesn't", (await until(async () => (await idea.locator(".livechip").count()) === 1)) >= 0
    && (await idea.locator(".ilink", { hasText: "rust-async-a" }).locator(".livechip").count()) === 1);
  await idea.locator(".livechip").first().click();
  check("clicking ● open focuses that tab", (await toast.filter({ hasText: "Brought to front" }).waitFor({ timeout: 5000 }).then(() => true, () => false)));

  /* ---------- idea "Open all in…" another browser ---------- */
  await idea.locator('[data-act="ideaOpenAll"]').click();
  await U.locator("#menu .mi", { hasText: "Home on e2e-pc" }).click();
  check("Open all in… opens the idea's links in the chosen browser", (await until(async () => count(B.ctx, "rust-async-") === 2, 6000)) >= 0, `home has ${count(B.ctx, "rust-async-")}`);

  /* ---------- send a tab to another browser ---------- */
  await U.goto(HUB + "/#live");
  await U.locator("#liveBody .ltab", { hasText: "send-me" }).first().waitFor();
  await menuOn("send-me");
  await U.locator("#menu .mi", { hasText: "Home on e2e-pc" }).click();
  await toast.filter({ hasText: "Sent 1 tab" }).waitFor({ timeout: 6000 });
  check("⋯ → Send to moves the tab: open in Home, closed in Work", (await until(async () => count(B.ctx, "send-me") === 1 && count(A.ctx, "send-me") === 0, 6000)) >= 0);

  /* ---------- duplicates: keep one of each ---------- */
  await U.locator('[data-act="liveDup"]').click();
  await U.locator('[data-act="dedupe"]').click();
  await toast.filter({ hasText: "Closed" }).waitFor({ timeout: 6000 });
  check("Keep one of each closes the extra duplicates", (await until(async () => count(A.ctx, "dup-page") + count(B.ctx, "dup-page") === 1, 6000)) >= 0,
    `${count(A.ctx, "dup-page") + count(B.ctx, "dup-page")} left`);
  await U.locator('[data-act="liveDup"]').click();

  /* ---------- project: Live now + Restore workspace + Open in ---------- */
  const pid = await U.evaluate(async (pages) => {
    const p = await (await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Workspace" }) })).json();
    await fetch(`/api/projects/${p.id}/links`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ links: [{ url: `${pages}/rust-async-a`, label: "A" }, { url: `${pages}/ws-extra`, label: "Extra" }] }) });
    return p.id as string;
  }, PAGES);
  await U.goto(`${HUB}/#${pid}`);
  check("project shows a Live now strip with its open link", (await until(async () => (await U.locator(".livenow .ltab", { hasText: "rust-async-a" }).count()) >= 1, 5000)) >= 0);
  // Which copy of a duplicate "Keep one of each" kept depends on browser timing, so work out
  // what Work already has instead of assuming: Restore must open exactly the missing ones.
  const missing = ["rust-async-a", "ws-extra"].filter((n) => count(A.ctx, n) === 0).length;
  await U.locator('[data-act="restoreWs"]').click();
  await U.locator("#menu .mi", { hasText: "Work on e2e-pc" }).click();
  await toast.filter({ hasText: `Opened ${missing} tab` }).waitFor({ timeout: 6000 });
  check("Restore workspace opens only what isn't already open there",
    (await until(async () => count(A.ctx, "ws-extra") === 1 && count(A.ctx, "rust-async-a") === 1, 5000)) >= 0,
    `ws-extra=${count(A.ctx, "ws-extra")} rust-async-a=${count(A.ctx, "rust-async-a")}`);
  const extraRow = U.locator(".row.link", { hasText: "Extra" });
  await extraRow.hover();
  await extraRow.locator('[data-act="openIn"]').click();
  await U.locator("#menu .mi", { hasText: "Home on e2e-pc" }).click();
  check("link → Open in… opens it in the chosen browser", (await until(async () => count(B.ctx, "ws-extra") === 1, 6000)) >= 0);

  /* ---------- undo an attach & close ---------- */
  await U.goto(HUB + "/#live");
  await U.locator("#liveBody .ltab", { hasText: "ws-extra" }).first().waitFor();
  await U.locator(".ltab", { hasText: "ws-extra" }).first().locator(".tsel").check();
  await U.locator("#ideaTo").selectOption(ideaVal!);
  await U.locator('[data-act="attachClose"]').click();
  await toast.filter({ hasText: "closed 1" }).waitFor({ timeout: 6000 });
  await toast.locator("#undoBtn").click();
  const ideaLinks = async () => ((await U.evaluate(async () => (await fetch("/api/state")).json())) as { inbox: { text: string; links: unknown[] }[] }).inbox.find((i) => i.text === "Learn async Rust")!.links.length;
  check("Undo of attach & close reopens the tab and detaches the URL",
    (await until(async () => count(A.ctx, "ws-extra") + count(B.ctx, "ws-extra") === 2 && (await ideaLinks()) === 2, 6000)) >= 0);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  console.error(e); failed++;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await ui.close().catch(() => {});
  if (hubProc) { const p = hubProc; hubProc = null; const done = new Promise((r) => p.once("exit", r)); p.kill(); await done; }
  pages.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll M2b checks passed");
process.exit(failed ? 1 : 0);
