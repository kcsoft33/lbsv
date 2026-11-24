/**
 * One-off: render the LabSave mark (same as the UI favicon) to the PNG sizes browsers and the
 * Chrome Web Store want. Output is committed (packages/ext/icons), so builds don't need a browser.
 *   node scripts/make-icons.ts   (needs Edge or Chrome installed; uses playwright-core)
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../packages/ext/icons/", import.meta.url));
mkdirSync(out, { recursive: true });
const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='#7cc4ff'/><path d='M4 5h8M4 8h5M4 11h7' stroke='#06121e' stroke-width='1.6' stroke-linecap='round'/></svg>`;
const browser = await chromium.launch({ channel: process.env.LBSV_E2E_CHANNEL || "msedge" });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width='${size}' height='${size}' `)}</body></html>`);
  await page.locator("svg").screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
