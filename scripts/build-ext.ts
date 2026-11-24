/**
 * Build lbsv-ext for Chromium (Chrome, Edge) and Firefox.
 *   npm run build:ext   →  packages/ext/dist/chromium  and  packages/ext/dist/firefox
 * Load either folder unpacked (see packages/ext/README.md).
 */
import { build } from "vite";
import { existsSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { zipDir } from "./zip.ts";
import { buildAgent } from "./build-agent.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const extDir = join(root, "packages", "ext");
const dist = join(extDir, "dist");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

await build({ configFile: join(extDir, "vite.config.ts"), logLevel: "warn" });

const common = {
  manifest_version: 3,
  name: "LabSave collector",
  short_name: "LabSave",
  version,
  description: "Streams your open tabs to your own self-hosted LabSave hub. Never collects private/incognito windows.",
  permissions: ["tabs", "storage", "alarms"],
  // Refuse to run in incognito/private windows at all (the collector also filters them).
  incognito: "not_allowed",
  options_ui: { page: "options.html", open_in_tab: true },
  icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  action: { default_title: "LabSave", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
};

const manifests: Record<string, object> = {
  chromium: {
    ...common,
    minimum_chrome_version: "116", // WebSocket activity keeps MV3 service workers alive
    background: { service_worker: "background.js", type: "module" },
  },
  firefox: {
    ...common,
    background: { scripts: ["background.js"], type: "module" },
    // Firefox's MV3 default CSP adds upgrade-insecure-requests, which would turn ws:// into wss://
    // and break hubs served over plain HTTP inside a tailnet. Same policy otherwise.
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    browser_specific_settings: {
      gecko: {
        id: "collector@lbsv.cnlsft",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["browsingActivity"] },
      },
    },
  },
};

for (const [target, manifest] of Object.entries(manifests)) {
  const dir = join(dist, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(dist, "build"), dir, { recursive: true });
  cpSync(join(extDir, "icons"), join(dir, "icons"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`lbsv-ext ${version} → ${dir}`);
}

// Installable packages, served by the hub at /api/downloads (Devices page) so other machines can grab them.
const pkgDir = join(dist, "packages");
mkdirSync(pkgDir, { recursive: true });
for (const f of readdirSync(pkgDir)) if (f.endsWith(".zip")) rmSync(join(pkgDir, f));
for (const target of Object.keys(manifests)) {
  const out = join(pkgDir, `lbsv-ext-${target}-${version}.zip`);
  const n = zipDir(join(dist, target), out);
  console.log(`  package → ${out} (${Math.round(n / 1024)} KB)`);
}
// A Mozilla-signed build for this version (from the release pipeline, or dropped in by hand) is served too:
// Firefox installs it permanently from one click on the Devices page.
for (const f of readdirSync(pkgDir)) if (f.endsWith(".xpi")) rmSync(join(pkgDir, f));
const signedDir = join(extDir, "signed");
const xpi = existsSync(signedDir) ? readdirSync(signedDir).find((f) => f === `lbsv-ext-firefox-${version}.xpi`) : undefined;
if (xpi) { cpSync(join(signedDir, xpi), join(pkgDir, xpi)); console.log(`  signed  → ${join(pkgDir, xpi)}`); }
// The terminal agent is served from the same Downloads card.
await buildAgent(pkgDir);
