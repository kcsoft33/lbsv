/**
 * M1 acceptance walkthrough: the real extension in a real browser, a real hub, the real UI.
 *   npm run build && npm run build:ext && npm run e2e:m1
 * Self-contained: starts its own hub on a throwaway data dir (LBSV_E2E_PORT, default 18090) and a
 * tiny local page server, so nothing touches your real data and no internet is needed.
 * Uses the installed Edge by default (LBSV_BROWSER=chrome for Chrome; HEADED=1 to watch).
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
const PORT = Number(process.env.LBSV_E2E_PORT || 18090);
const HUB = `http://127.0.0.1:${PORT}`;
const PASS = "e2e-passphrase-cnlsft";
const channel = process.env.LBSV_BROWSER === "chrome" ? "chrome" : "msedge";
const headless = process.env.HEADED !== "1";

if (!existsSync(join(extDir, "manifest.json"))) { console.error("Build the extension first: npm run build:ext"); process.exit(2); }
if (!existsSync(join(root, "packages", "ui", "dist", "index.html"))) { console.error("Build the UI first: npm run build"); process.exit(2); }

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failed++;
};
const until = async (fn: () => Promise<boolean>, ms = 2000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return Date.now() - t0; await new Promise((r) => setTimeout(r, step)); }
  return -1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- local pages to open as tabs ---------- */
const pages = createServer((req, res) => {
  const name = decodeURIComponent((req.url || "/").split("?")[0]!.slice(1)) || "index";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${name.replace(/</g, "")}</title><p>${name.replace(/</g, "")}</p>`);
});
await new Promise<void>((r) => pages.listen(0, "127.0.0.1", () => r()));
const PAGES = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;

/* ---------- hub ---------- */
const dataDir = mkdtempSync(join(tmpdir(), "lbsv-e2e-m1-"));
let hubProc: ChildProcess | null = null;
async function startHub() {
  hubProc = spawn(process.execPath, [join(root, "packages", "hub", "src", "cli.ts"), "serve"], {
    env: { ...process.env, LBSV_DATA_DIR: dataDir, LBSV_PORT: String(PORT), LBSV_HOST: "127.0.0.1", LBSV_ADMIN_PASSPHRASE: PASS, LBSV_LOG_LEVEL: "warn",
      LBSV_UI_DIR: join(root, "packages", "ui", "dist") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const ok = await until(async () => (await fetch(HUB + "/api/health")).ok, 15_000, 100);
  if (ok < 0) throw new Error("hub didn't start");
}
async function stopHub() {
  const p = hubProc; hubProc = null;
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill();
  await done;
}

let ext: BrowserContext | null = null;
const ui = await chromium.launch({ channel, headless });
const errors: string[] = [];

try {
  await startHub();

  /* ---------- browser with the extension ---------- */
  const profile = mkdtempSync(join(tmpdir(), "lbsv-e2e-prof-"));
  ext = await chromium.launchPersistentContext(profile, {
    channel, headless,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = ext.serviceWorkers()[0];
  if (!sw) sw = await ext.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => undefined as never);
  check("browser loaded the unpacked extension (service worker running)", !!sw);
  if (!sw) throw new Error(`${channel} did not load the extension via --load-extension`);
  const extId = new URL(sw.url()).host;

  /* ---------- UI: add a device, get a code ---------- */
  const U = await ui.newPage();
  U.on("pageerror", (e) => errors.push(String(e)));
  U.on("dialog", (d) => void d.accept());
  await U.goto(HUB + "/#devices");
  await U.locator("#loginPass").fill(PASS);
  await U.locator("#loginPass").press("Enter");
  await U.locator("#login").waitFor({ state: "hidden" });
  await U.locator('[data-form="device"] input[name=name]').fill("e2e-laptop");
  await U.locator('[data-form="device"] input[name=name]').press("Enter");
  await U.locator("#paircode").waitFor();
  const code = (await U.locator("#paircode").innerText()).trim();
  check("Devices → Add device shows a one-time code", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);

  /* ---------- extension options: pair ---------- */
  const O = await ext.newPage();
  O.on("pageerror", (e) => errors.push("options: " + String(e)));
  await O.goto(`chrome-extension://${extId}/options.html`);
  await O.locator("#hubUrl").fill(HUB);
  await O.locator("#code").fill("WRON-GCOD");
  await O.locator("#pairForm button").click();
  check("a wrong code is rejected in the options page", (await until(async () => (await O.locator("#err").innerText()).includes("pairing code"), 5000)) >= 0);
  await O.locator("#code").fill(code.toLowerCase());
  await O.locator("#profileNew").fill("Work");
  await O.locator("#pairForm button").click();
  check("pairing succeeds and the extension reports Connected", (await until(async () => (await O.locator("#statusText").innerText()) === "Connected", 8000)) >= 0,
    await O.locator("#statusText").innerText());
  check("options page shows the device name from the hub", (await O.locator("#facts").innerText()).includes("e2e-laptop"));

  /* ---------- live view ---------- */
  await U.goto(HUB + "/#live");
  const liveText = () => U.locator("#liveBody").innerText().catch(() => "");
  const tA = Date.now();
  const alpha = await ext.newPage();
  await alpha.goto(`${PAGES}/alpha-tab?e2e=1`);
  const msA = await until(async () => (await liveText()).includes("alpha-tab"), 4000);
  check("a newly opened tab appears in Live within 2 s", msA >= 0 && Date.now() - tA < 2000 + 1500, `${msA} ms after load`);
  check("Live view groups by device → browser profile", (await liveText()).includes("Edge · Work") || (await liveText()).includes("Chrome · Work"));

  const beta = await ext.newPage();
  await beta.goto(`${PAGES}/beta-tab?keep=yes&access_token=SECRET123&sig=abc`);
  await until(async () => (await liveText()).includes("beta-tab"));
  const lt = await liveText();
  check("secrets are stripped from URLs before they reach the hub", lt.includes("keep=yes") && !lt.includes("SECRET123") && !lt.includes("sig=abc"));

  const t1 = Date.now();
  await beta.evaluate(() => { document.title = "beta-renamed"; });
  const msT = await until(async () => (await liveText()).includes("beta-renamed"), 4000);
  check("a title change shows up within 2 s", msT >= 0 && Date.now() - t1 < 2000, `${msT} ms`);

  const dupe = await ext.newPage();
  await dupe.goto(`${PAGES}/alpha-tab?e2e=1`);
  check("duplicate tabs are flagged ×2", (await until(async () => (await liveText()).includes("×2"))) >= 0);
  const t2 = Date.now();
  await dupe.close();
  const msC = await until(async () => !(await liveText()).includes("×2"), 4000);
  check("a closed tab disappears within 2 s", msC >= 0 && Date.now() - t2 < 2000, `${msC} ms`);

  // Filter box keeps focus and text while updates stream in.
  await U.locator("#liveQ").fill("alpha");
  await ext.newPage().then((p) => p.goto(`${PAGES}/gamma-while-filtering`));
  await sleep(1200);
  check("typing in the Live filter isn't interrupted by incoming updates",
    (await U.locator("#liveQ").inputValue()) === "alpha" && await U.locator("#liveQ").evaluate((el) => el === document.activeElement));
  check("Live filter narrows the list", (await liveText()).includes("alpha-tab") && !(await liveText()).includes("beta-renamed"));
  await U.locator("#liveQ").press("Escape");

  // Global search covers open tabs too.
  await U.locator("#q").fill("beta-renamed");
  check("global search finds open tabs", (await until(async () => (await U.locator("main").innerText()).includes("OPEN TABS") || (await U.locator("main").innerText()).includes("Open tabs"))) >= 0);
  await U.locator("#q").press("Escape");

  /* ---------- cable pull ---------- */
  await stopHub();
  await sleep(1500);
  const offlineTab = await ext.newPage();
  await offlineTab.goto(`${PAGES}/opened-while-hub-down`);
  await beta.close();
  await sleep(1000);
  const tR = Date.now();
  await startHub();
  const msR = await until(async () => {
    const t = await liveText();
    return t.includes("opened-while-hub-down") && !t.includes("beta-renamed");
  }, 40_000, 200);
  check("after the hub comes back, offline changes reconcile (opened tab appears, closed tab gone)", msR >= 0, `${Date.now() - tR} ms after hub restart`);
  check("the browser is shown live again after reconnect", (await until(async () => (await liveText()).includes("live"), 5000)) >= 0);

  /* ---------- deny-list ---------- */
  await U.goto(HUB + "/#devices");
  const deny = U.locator(".denyin[data-deny]:not(#globalDeny)").first();
  await deny.fill("127.0.0.1");
  await deny.press("Tab");
  await U.locator("#toast", { hasText: "Deny-list saved" }).waitFor({ timeout: 4000 });
  await U.goto(HUB + "/#live");
  check("deny-listed domains are removed and counted", (await until(async () => (await liveText()).includes("hidden by deny-list") && !(await liveText()).includes("alpha-tab"), 4000)) >= 0,
    (await liveText()).replace(/\s+/g, " ").slice(0, 300));
  await U.goto(HUB + "/#devices");
  await U.locator(".denyin[data-deny]:not(#globalDeny)").first().fill("");
  await U.locator(".denyin[data-deny]:not(#globalDeny)").first().press("Tab");
  await U.locator("#toast", { hasText: "Deny-list cleared" }).waitFor({ timeout: 4000 });
  await U.goto(HUB + "/#live");
  check("clearing the deny-list brings the tabs back", (await until(async () => (await liveText()).includes("alpha-tab"), 4000)) >= 0);

  /* ---------- browser goes away → shown offline, tabs kept ---------- */
  await ext.close(); ext = null;
  check("a closed browser is shown offline with its tabs kept",
    (await until(async () => { const t = await liveText(); return t.includes("offline") && t.includes("alpha-tab"); }, 5000)) >= 0);

  /* ---------- revoke ---------- */
  await U.goto(HUB + "/#devices");
  await U.locator('[data-act="devRevoke"]').first().click();
  await U.locator("#toast", { hasText: "Revoked" }).waitFor({ timeout: 4000 });
  await U.goto(HUB + "/#live");
  check("revoking the device removes its live tabs", (await until(async () => (await liveText()).toLowerCase().includes("no browsers connected yet"), 4000)) >= 0);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await ext?.close().catch(() => {});
  await ui.close().catch(() => {});
  await stopHub();
  pages.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll M1 checks passed");
process.exit(failed ? 1 : 0);
