/**
 * One-line agent installers (M5), served by the hub WITHOUT login: the agent code is not secret,
 * the pairing code is. Everything comes from the hub itself, so isolated VMs never need the internet.
 *   Linux / macOS:  curl -fsSL https://hub/install/agent.sh | sh -s -- ABCD-EFGH
 *   Windows:        & ([scriptblock]::Create((irm https://hub/install/agent.ps1))) ABCD-EFGH
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { newer } from "../../shared/src/version.ts";
import { join } from "node:path";

export const NODE_MIN = "22.18.0";

/** The hub's address as the client reached it (honours X-Forwarded-* only when trustProxy is set). */
export function publicOrigin(req: FastifyRequest, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  return `${req.protocol}://${req.host}`;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function shInstaller(hub: string): string {
  return `#!/bin/sh
# lbsv-agent installer, served by your lbsv hub at ${hub}
# Usage:  curl -fsSL ${hub}/install/agent.sh | sh -s -- <pairing code> [--no-service] [--record-cmds]
# Downloads the agent from this hub (nothing from the internet), then runs: lbsv-agent install.
set -eu
HUB=${shq(hub)}
if [ $# -ge 1 ] && [ "\${1#-}" = "$1" ]; then CODE=$1; shift; else CODE=; fi

if ! command -v node >/dev/null 2>&1; then
  echo "lbsv-agent needs Node.js ${NODE_MIN} or newer, and node isn't on PATH." >&2
  echo "  Debian/Ubuntu: https://github.com/nodesource/distributions  ·  macOS: brew install node  ·  any: https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "lbsv-agent needs Node.js ${NODE_MIN} or newer; this is $(node -v)." >&2
  exit 1
fi

DIR=\${LBSV_DATA_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/lbsv-agent}
mkdir -p "$DIR"
TMP="$DIR/lbsv-agent.mjs.download"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$HUB/install/lbsv-agent.mjs" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then wget -qO "$TMP" "$HUB/install/lbsv-agent.mjs"
else echo "Need curl or wget." >&2; exit 1; fi
mv -f "$TMP" "$DIR/lbsv-agent.mjs"

if [ -n "$CODE" ]; then
  exec node "$DIR/lbsv-agent.mjs" install --hub "$HUB" --code "$CODE" "$@"
else
  exec node "$DIR/lbsv-agent.mjs" install "$@"
fi
`;
}

export function ps1Installer(hub: string): string {
  return `# lbsv-agent installer, served by your lbsv hub at ${hub}
# Usage (PowerShell):  & ([scriptblock]::Create((irm ${hub}/install/agent.ps1))) <pairing code>
# Downloads the agent from this hub (nothing from the internet), then runs: lbsv-agent install.
param([string]$Code = "", [switch]$NoService, [switch]$RecordCmds)
$ErrorActionPreference = 'Stop'
$Hub = ${psq(hub)}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "lbsv-agent needs Node.js ${NODE_MIN}+ and node isn't on PATH. Install it with:  winget install OpenJS.NodeJS.LTS   (then open a new PowerShell)" -ForegroundColor Red; return }
$v = [version]((& node -p "process.versions.node").Trim())
if ($v -lt [version]'${NODE_MIN}') { Write-Host "lbsv-agent needs Node.js ${NODE_MIN}+; this is $v. Update with:  winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Red; return }
$dir = if ($env:LBSV_DATA_DIR) { $env:LBSV_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'lbsv-agent' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path $dir 'lbsv-agent.mjs.download'
Invoke-WebRequest -UseBasicParsing -Uri "$Hub/install/lbsv-agent.mjs" -OutFile $tmp
Move-Item -Force $tmp (Join-Path $dir 'lbsv-agent.mjs')
$a = @('install')
if ($Code) { $a += @('--hub', $Hub, '--code', $Code) }
if ($NoService) { $a += '--no-service' }
if ($RecordCmds) { $a += '--record-cmds' }
& node (Join-Path $dir 'lbsv-agent.mjs') @a
`;
}

/** Version of the agent bundle the hub serves: from lbsv-agent-<version>.zip written by the same build. */
export function agentBundleVersion(dir: string): string | null {
  try { return readdirSync(dir).map((f) => /^lbsv-agent-(\d[\w.+-]*)\.zip$/.exec(f)?.[1]).filter((v): v is string => !!v).reduce<string | null>((m, v) => (!m || newer(v, m) ? v : m), null); } catch { return null; }
}

export function registerInstallers(app: FastifyInstance, opts: { packagesDir?: string; publicUrl?: string }): void {
  const text = (body: string) => body;
  app.get("/install/agent.sh", async (req, reply) =>
    reply.header("content-type", "text/x-shellscript; charset=utf-8").header("cache-control", "no-store").send(text(shInstaller(publicOrigin(req, opts.publicUrl)))));
  app.get("/install/agent.ps1", async (req, reply) =>
    reply.header("content-type", "text/plain; charset=utf-8").header("cache-control", "no-store").send(text(ps1Installer(publicOrigin(req, opts.publicUrl)))));
  app.get("/install/lbsv-agent.mjs", async (_req, reply) => {
    const f = opts.packagesDir ? join(opts.packagesDir, "lbsv-agent.mjs") : "";
    if (!f || !existsSync(f)) return reply.code(404).send({ error: "lbsv-agent isn't built on this hub: run npm run build:agent (the Docker image includes it)" });
    const ver = agentBundleVersion(opts.packagesDir!);
    if (ver) reply.header("x-lbsv-version", ver);
    return reply.header("content-type", "text/javascript; charset=utf-8").header("cache-control", "no-store")
      .header("content-length", statSync(f).size).send(createReadStream(f));
  });
}
