/**
 * Get the Firefox build signed by Mozilla as an *unlisted* add-on (not shown on addons.mozilla.org;
 * the hub serves the signed file). Needs AMO API credentials:
 *   https://addons.mozilla.org/developers/addon/api/key/  →  AMO_JWT_ISSUER, AMO_JWT_SECRET
 *   npm run build:ext && npm run sign:firefox && npm run build:ext   (the 2nd build picks the .xpi up)
 * Output: packages/ext/signed/lbsv-ext-firefox-<version>.xpi. Only the extension code goes to Mozilla.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const { AMO_JWT_ISSUER: key, AMO_JWT_SECRET: secret } = process.env;
if (!key || !secret) { console.error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET (addons.mozilla.org → Developer Hub → API keys)."); process.exit(1); }
const src = join(root, "packages", "ext", "dist", "firefox");
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as { version: string };
if (manifest.version !== version) { console.error(`dist/firefox is ${manifest.version}, package.json is ${version}: run npm run build:ext first.`); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "lbsv-sign-"));
try {
  // Credentials via web-ext's own env vars, so they never show up in a process list.
  execFileSync("npx", ["--yes", "web-ext@8", "sign", "--channel=unlisted", "--source-dir", src, "--artifacts-dir", tmp],
    { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret } });
  const xpi = readdirSync(tmp).find((f) => f.endsWith(".xpi"));
  if (!xpi) throw new Error("web-ext didn't produce an .xpi");
  const outDir = join(root, "packages", "ext", "signed");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `lbsv-ext-firefox-${version}.xpi`);
  renameSync(join(tmp, xpi), out);
  console.log(`signed → ${out}`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
