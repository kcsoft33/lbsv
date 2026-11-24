/**
 * Bundle lbsv-agent into one dependency-free file and package it for other machines.
 *   npm run build:agent   →  packages/agent/dist/lbsv-agent.mjs (+ hooks/, README.md)
 *                            and packages/ext/dist/packages/lbsv-agent-<version>.zip (served on the Devices page)
 * Runs on any machine with Node ≥ 22.18. (A single native binary is M5.)
 */
import { build } from "vite";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { zipDir } from "./zip.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const agentDir = join(root, "packages", "agent");

export async function buildAgent(pkgDir = join(root, "packages", "ext", "dist", "packages")): Promise<string> {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const out = join(agentDir, "dist");
  rmSync(out, { recursive: true, force: true });
  await build({
    configFile: false, logLevel: "warn", root: agentDir,
    build: {
      ssr: join(agentDir, "src", "cli.ts"), outDir: out, target: "node22", minify: false, emptyOutDir: true,
      rollupOptions: {
        external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        output: { entryFileNames: "lbsv-agent.mjs", format: "es" },
      },
    },
    ssr: { noExternal: true, target: "node" },
    // The hooks travel inside the bundle, so one file is a complete install (served by the hub at /install/lbsv-agent.mjs).
    define: { __LBSV_VERSION__: JSON.stringify(version), __LBSV_HOOKS__: JSON.stringify(Object.fromEntries(["lbsv.bash", "lbsv.zsh", "lbsv.ps1"].map((f) => [f, readFileSync(join(agentDir, "hooks", f), "utf8")]))) },
  });
  cpSync(join(agentDir, "hooks"), join(out, "hooks"), { recursive: true });
  cpSync(join(agentDir, "README.md"), join(out, "README.md"));
  console.log(`lbsv-agent ${version} → ${join(out, "lbsv-agent.mjs")}`);

  mkdirSync(pkgDir, { recursive: true });
  for (const f of readdirSync(pkgDir)) if (/^lbsv-agent-.*\.zip$/.test(f)) rmSync(join(pkgDir, f));
  cpSync(join(out, "lbsv-agent.mjs"), join(pkgDir, "lbsv-agent.mjs")); // for the one-line installers
  const zip = join(pkgDir, `lbsv-agent-${version}.zip`);
  const n = zipDir(out, zip);
  console.log(`  package → ${zip} (${Math.round(n / 1024)} KB)`);
  return zip;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) await buildAgent();
