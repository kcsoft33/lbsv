# lbsv: LabSave

*Your work has a save file now.* LabSave is a self-hosted, local-only home for your projects. For each one it holds:

- its links, ideas and a "where I left off" note
- the machines and terminals it runs on
- the open tabs of every browser on every device, streamed in live. You can focus or close a tab, or park it into a project.

It's built for one person who works across many computers, VMs, browsers and terminals and keeps losing "the tab that had the thing".

**Nothing leaves your network.** No cloud services, telemetry or runtime CDNs. Collectors talk only to your hub,
and private windows and command output are never collected. See [PRIVACY.md](PRIVACY.md).

**Status:** working and used daily, but early. M0–M4 are done (projects, live tabs, tab actions, live terminals,
MCP for Claude); installation and hardening are still in progress.

## Install

**1. The hub** (any Docker host on your LAN or VPN):

```sh
mkdir lbsv && cd lbsv
curl -fsSLO https://raw.githubusercontent.com/kcsoft33/lbsv/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/kcsoft33/lbsv/main/.env.example -o .env
# edit .env: LBSV_BIND_IP = the LAN or VPN address devices will use
docker compose up -d
docker compose logs hub       # shows a one-time setup code
```

Open `http://<LBSV_BIND_IP>:11444`, enter the setup code and choose your passphrase. For HTTPS, put it behind your
reverse proxy (see the [hub README](packages/hub/README.md#behind-a-tls-reverse-proxy)).

**2. Browsers:** go to Devices → *Add device* to get a pairing code, then install the extension:

- **Chrome / Edge:** from the Chrome Web Store link on that page.
- **Firefox:** the signed build, with one click from the same page.

Open the extension's options, enter the hub address and paste the code.

**3. Terminals:** the pairing card also shows a one-line installer for the machine (needs Node 22.18+ for now):

```sh
curl -fsSL http://<hub>:11444/install/agent.sh | sh -s -- ABCD-EFGH                       # Linux, macOS, WSL
& ([scriptblock]::Create((irm http://<hub>:11444/install/agent.ps1))) ABCD-EFGH           # Windows PowerShell
```

The hub keeps nightly backups in its volume. To restore, run `docker compose stop hub && docker compose run --rm hub lbsv restore latest && docker compose start hub`.
Until the first tagged release is published, build the image yourself:
`git clone … && docker compose -f compose.yaml -f compose.build.yaml up -d --build`.

## Layout

| Path | What |
|---|---|
| `packages/hub` | lbsv: Fastify + SQLite (WAL, FTS5) + WebSocket. Serves the UI, API, MCP endpoint and installers. [README](packages/hub/README.md) |
| `packages/ui` | Web UI (Vite, vanilla TS) |
| `packages/ext` | The browser extension (Chrome, Edge, Firefox) that streams live tabs. [README](packages/ext/README.md) |
| `packages/agent` | lbsv-agent: shell hooks (bash, zsh, PowerShell) + tmux/screen discovery; streams live terminals with reconnect commands; also the stdio MCP bridge for Claude Desktop. [README](packages/agent/README.md) |
| `packages/shared` | Shared by hub, UI and collectors: link parser, URL/command redaction, protocols, rules, types |

## Development (any OS, Node ≥ 22.18)

```sh
npm install
LBSV_ADMIN_PASSPHRASE=devpassphrase npm run dev     # hub on :8080, UI with hot reload on :5173
npm test                                          # vitest
npm run typecheck
npm run build:ext                                 # extension → packages/ext/dist/{chromium,firefox}, plus lbsv-agent (zips for the Devices page)
npm run build:agent                               # lbsv-agent only → packages/agent/dist/lbsv-agent.mjs
npm run build && npm run e2e:m1                   # live-tabs walkthrough in a real Edge (own throwaway hub)
```

On Windows PowerShell, use `$env:LBSV_ADMIN_PASSPHRASE="devpassphrase"; npm run dev`.

To reach the dev setup from other machines or a reverse proxy, you have two options:

- `LBSV_HOST=0.0.0.0`: the hub serves the *built* UI on :8080.
- `LBSV_DEV_HOST=0.0.0.0`: Vite with hot reload on :5173. It only answers for `LBSV_DEV_ALLOWED_HOSTS`
  (comma-separated; `.example.net` matches its subdomains; default `localhost`).

Behind a proxy, also set `LBSV_TRUST_PROXY` to the proxy's IP. The dev database lives on local disk
(`%LOCALAPPDATA%\lbsv`, or `~/.local/share/lbsv`). Don't point `LBSV_DATA_DIR` at a network share: SQLite WAL needs local file locking.

## Use it from Claude (MCP)

Go to Devices → *AI assistants (MCP)* → *Create token*, then run
`claude mcp add --transport http --scope user lbsv https://<your hub>/mcp --header "Authorization: Bearer lbsvm_…"`.
Try "where is the grafana dashboard open?" or "park my stale tabs about infrastructure". Closing tabs always asks first.
Tools and resources are listed in the [hub README](packages/hub/README.md#mcp-server-mcp-m4).

## Backups

- **Automatic:** every 24 h into `backups/` next to the database, keeping 14 (`LBSV_BACKUP_EVERY_HOURS`, `LBSV_BACKUP_KEEP`).
- **Manual:** use *Back up now* on the Devices page, or run `lbsv backup`.
- **Restore:** stop the hub, then run `lbsv restore latest` (or a file listed by `lbsv backups`). The replaced database is kept as `pre-restore-*.db`.
- **Portable copy:** *Export JSON* in the sidebar.

## Keyboard

`/` or `Ctrl+K` focuses search, and `Esc` clears it. Enter in the capture box files the idea into the selected target.

## License

[MIT](LICENSE).
