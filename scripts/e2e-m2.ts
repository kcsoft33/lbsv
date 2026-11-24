/**
 * M2 acceptance walkthrough: tab actions from the hub UI into two real browser profiles.
 *   npm run build && npm run build:ext && npm run e2e:m2
 * Starts its own hub on a throwaway data dir (LBSV_E2E_PORT, default 18093) plus a local page server.
 * Uses the installed Edge (HEADED=1 to watch).
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
const PORT = Number(process.env.LBSV_E2E_PORT || 18093);
const HUB = `http://127.0.0.1:${PORT}`;
const PASS = "e2e-passphrase-cnlsft";
const channel = process.env.LBSV_BROWSER === "chrome" ? "chrome" : "msedge";
const headless = process.env.HEADED !== "1";
if (!existsSync(join(extDir, "manifest.json")) || !existsSync(join(root, "packages", "ui", "dist", "index.html"))) {
  console.error("Build first: npm run build && npm run build:ext"); process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const until = async (fn: () => Promise<boolean>, ms = 3000, step = 30) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return Date.now() - t0; await new Promise((r) => setTimeout(r, step)); }
  return -1;
};

// 1x1 PNG for the favicon check.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const pages = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0]!;
  if (path === "/favicon.ico") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
  const name = decodeURIComponent(path.slice(1)).replace(/</g, "") || "index";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
});
await new Promise<void>((r) => pages.listen(0, "127.0.0.1", () => r()));
const PAGES = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;

const dataDir = mkdtempSync(join(tmpdir(), "lbsv-e2e-m2-"));
let hubProc: ChildProcess | null = spawn(process.execPath, [join(root, "packages", "hub", "src", "cli.ts"), "serve"], {
  env: { ...process.env, LBSV_DATA_DIR: dataDir, LBSV_PORT: String(PORT), LBSV_HOST: "127.0.0.1", LBSV_ADMIN_PASSPHRASE: PASS, LBSV_LOG_LEVEL: "warn", LBSV_UI_DIR: join(root, "packages", "ui", "dist") },
  stdio: ["ignore", "inherit", "inherit"],
});
if ((await until(async () => (await fetch(HUB + "/api/health")).ok, 15_000, 100)) < 0) throw new Error("hub didn't start");

const ui = await chromium.launch({ channel, headless });
const contexts: BrowserContext[] = [];
const errors: string[] = [];

async function browserWithExtension(): Promise<{ ctx: BrowserContext; extId: string }> {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "lbsv-e2e-prof-")), {
    channel, headless, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  contexts.push(ctx);
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  return { ctx, extId: new URL(sw.url()).host };
}
async function pair(ctx: BrowserContext, extId: string, code: string, profile: string) {
  const O = await ctx.newPage();
  O.on("pageerror", (e) => errors.push("options: " + String(e)));
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
const urlsIn = (ctx: BrowserContext, needle: string) => ctx.pages().filter((p) => !p.isClosed() && p.url().includes(needle)).length;

try {
  /* ---------- UI + two browser profiles paired to one device ---------- */
  const U: Page = await ui.newPage();
  U.on("pageerror", (e) => errors.push(String(e)));
  U.on("dialog", (d) => void (d.type() === "prompt" ? d.accept("Parked from e2e") : d.accept()));
  await U.goto(HUB + "/#devices");
  await U.locator("#loginPass").fill(PASS);
  await U.locator("#loginPass").press("Enter");
  await U.locator("#login").waitFor({ state: "hidden" });
  await U.locator('[data-form="device"] input[name=name]').fill("e2e-pc");
  await U.locator('[data-form="device"] input[name=name]').press("Enter");
  await U.locator("#paircode").waitFor();
  const code1 = (await U.locator("#paircode").innerText()).trim();
  const A = await browserWithExtension();
  check("profile Work pairs", await pair(A.ctx, A.extId, code1, "Work"));
  await U.locator('[data-act="devCode"]').first().click();
  await until(async () => (await U.locator("#paircode").innerText()).trim() !== code1);
  const code2 = (await U.locator("#paircode").innerText()).trim();
  const B = await browserWithExtension();
  check("profile Personal pairs with a second code for the same device", await pair(B.ctx, B.extId, code2, "Personal"));

  // A project to park into.
  await U.locator("#newpName").fill("Reading pile");
  await U.locator("#newpName").press("Enter");
  await U.waitForURL(/#[0-9A-Z]{26}$/);
  const pid = U.url().split("#")[1]!;

  /* ---------- 10 tabs in each profile ---------- */
  const aTabs: Page[] = [], bTabs: Page[] = [];
  for (let i = 0; i < 10; i++) aTabs.push(await open(A.ctx, `park-work-${i}`));
  for (let i = 0; i < 10; i++) bTabs.push(await open(B.ctx, `park-home-${i}`));
  await open(A.ctx, "keep-me-open");
  await U.goto(HUB + "/#live");
  const liveText = () => U.locator("#liveBody").innerText().catch(() => "");
  check("both profiles' tabs are live", (await until(async () => { const t = await liveText(); return t.includes("park-work-9") && t.includes("park-home-9"); }, 5000)) >= 0);
  check("favicons are served from the hub cache", (await until(async () =>
    U.locator("img[data-fav]").first().evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), 5000)) >= 0);

  /* ---------- focus ---------- */
  const firstRow = U.locator(".ltab", { hasText: "park-work-0" });
  await firstRow.hover();
  await firstRow.locator('[data-act="tabFocus"]').click();
  check("Focus makes that tab the active one in its browser", (await until(async () => (await U.locator(".ltab.act", { hasText: "park-work-0" }).count()) === 1, 4000)) >= 0);

  /* ---------- select 20, one changes after selection, park & close ---------- */
  await U.locator("#liveQ").fill("park-");
  await until(async () => (await U.locator("#liveBody .tsel").count()) === 20);
  await U.locator('[data-act="selShown"]').click();
  check("Select shown selects the 20 filtered tabs", (await U.locator("#selN").innerText()) === "20");
  await aTabs[3]!.goto(`${PAGES}/navigated-away`);
  await until(async () => (await liveText()).includes("navigated-away"));
  await U.locator("#parkTo").selectOption(pid);
  const t0 = Date.now();
  await U.locator('[data-act="parkClose"]').click();
  const toast = U.locator("#toast");
  await toast.filter({ hasText: "Parked" }).waitFor({ timeout: 8000 });
  const msg = await toast.innerText();
  check("Park & close reports 20 links and 19 closed", msg.includes("20 links") && msg.includes("closed 19"), `${Date.now() - t0} ms · ${msg.replace(/\s+/g, " ")}`);
  check("the tab whose page changed is reported, not closed", msg.includes("page changed") && urlsIn(A.ctx, "navigated-away") === 1);
  check("exactly the matching 19 tabs closed across both browsers", urlsIn(A.ctx, "park-work-") === 0 && urlsIn(B.ctx, "park-home-") === 0 && urlsIn(A.ctx, "keep-me-open") === 1);
  const proj = await U.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).json(), pid) as { links: { url: string; where: string }[] };
  check("the project has the 20 links with where = browser profile on device",
    proj.links.length === 20 && proj.links.some((l) => l.where === "Edge · Work on e2e-pc") && proj.links.some((l) => l.where === "Edge · Personal on e2e-pc"));

  /* ---------- undo reopens and removes the links ---------- */
  await toast.locator("#undoBtn").click();
  check("Undo reopens the closed tabs in their browsers", (await until(async () => urlsIn(A.ctx, "park-work-") === 9 && urlsIn(B.ctx, "park-home-") === 10, 8000)) >= 0,
    `work=${urlsIn(A.ctx, "park-work-")} home=${urlsIn(B.ctx, "park-home-")}`);
  check("Undo takes the 20 links back out of the project", (await until(async () =>
    ((await U.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).json(), pid)) as { links: unknown[] }).links.length === 0, 4000)) >= 0);

  /* ---------- single close from the row ---------- */
  await U.locator("#liveQ").fill("park-home-5");
  const row = U.locator(".ltab", { hasText: "park-home-5" }).first();
  await row.waitFor();
  await row.hover();
  await row.locator('[data-act="tabClose"]').click();
  check("× on a row closes that tab", (await until(async () => urlsIn(B.ctx, "park-home-5") === 0, 4000)) >= 0);

  /* ---------- park into a new project, keep open ---------- */
  await U.locator("#liveQ").fill("keep-me-open");
  await until(async () => (await U.locator("#liveBody .tsel").count()) === 1);
  await U.locator("#liveBody .tsel").first().check();
  await U.locator("#parkTo").selectOption("__new");
  await U.locator('[data-act="parkKeep"]').click();
  await toast.filter({ hasText: "Saved" }).waitFor({ timeout: 5000 });
  check("Park only into a new project keeps the tab open", urlsIn(A.ctx, "keep-me-open") === 1 && (await U.locator("#plist").innerText()).includes("Parked from e2e"));

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
console.log(failed ? `\n${failed} check(s) failed` : "\nAll M2 checks passed");
process.exit(failed ? 1 : 0);
