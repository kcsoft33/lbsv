# lbsv

The central service. It owns the SQLite database, serves the web UI and REST API, and pushes `changed` events to every open UI over WebSocket. It also accepts the browser-extension and lbsv-agent connections, and serves the MCP endpoint and the one-line agent installers.

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `LBSV_DATA_DIR` | `%LOCALAPPDATA%\lbsv` (Windows), `$XDG_DATA_HOME/lbsv` or `~/.local/share/lbsv` (macOS/Linux), `/data` (Docker) | Must be **local disk** |
| `LBSV_BACKUP_DIR` | `$LBSV_DATA_DIR/backups` | |
| `LBSV_BACKUP_EVERY_HOURS` | `24` | Automatic backups; `0` = off |
| `LBSV_BACKUP_KEEP` | `14` | Automatic backups to keep (others in the folder are never deleted) |
| `LBSV_PUBLIC_URL` | unset | Hub address baked into the agent installers; default = the address the browser used |
| `LBSV_HOST` | `127.0.0.1` | Bind address. Use your LAN or Tailscale IP. Avoid `0.0.0.0` on an internet-facing box |
| `LBSV_PORT` | `8080` | |
| `LBSV_ADMIN_PASSPHRASE` | unset | Usually leave unset: a fresh hub prints a one-time **setup code** to its log (and `lbsv setup-code`), and you set the passphrase in the browser. When set, it becomes the passphrase on every start; changing it signs out every session |
| `LBSV_COOKIE_SECURE` | `auto` | `auto` = Secure when the request is HTTPS. `1` / `0` force it |
| `LBSV_TRUST_PROXY` | unset | `1` or a proxy IP/CIDR when running behind Caddy or another TLS proxy |
| `LBSV_UI_DIR` | `packages/ui/dist` | Built UI |
| `LBSV_FAVICONS` | `1` | The hub fetches favicons for open tabs from each tab's host (3 s timeout, ≤ 100 KB, images only, cached 7 days) so the UI never hotlinks. `0` = the hub never contacts tab hosts; the UI shows letter tiles |

## Commands

```
lbsv serve                 run the hub (default)
lbsv backup [--out FILE]   online backup → $LBSV_BACKUP_DIR/lbsv-<timestamp>.db
lbsv backups               list the automatic backups
lbsv restore FILE|latest   replace the database with a backup (hub stopped; the old one → pre-restore-*.db)
lbsv setup-code            print the first-run setup code (while no passphrase is set)
lbsv set-passphrase        set/change admin passphrase (stdin)
lbsv migrate               apply pending migrations and exit
```

From a source checkout, use `npm run hub -- <command>`. In Docker, use `docker compose exec hub lbsv <command>`.

## Install

### Docker (recommended: Linux homelab)
See the root README. Data goes in the `lbsv-data` named volume, which survives `docker compose down` and container rebuilds. (`docker compose down -v` deletes it.)

### Linux (systemd, without Docker)
```sh
sudo apt install nodejs   # needs Node >= 22.18; NodeSource or nvm if your distro's is older
git clone <repo> /opt/lbsv && cd /opt/lbsv && npm ci && npm run build
sudo useradd --system --home /var/lib/lbsv lbsv
sudo mkdir -p /var/lib/lbsv && sudo chown lbsv: /var/lib/lbsv
sudo tee /etc/systemd/system/lbsv.service <<'EOF'
[Unit]
Description=LabSave hub
After=network-online.target tailscaled.service
[Service]
User=lbsv
WorkingDirectory=/opt/lbsv
Environment=LBSV_DATA_DIR=/var/lib/lbsv
Environment=LBSV_HOST=100.64.0.10
ExecStart=/usr/bin/node packages/hub/src/cli.ts serve
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now lbsv
journalctl -u lbsv | grep -A3 'First run'    # the setup code for the browser
```
Replace `LBSV_HOST` with the hub's Tailscale or LAN IP.

### macOS
```sh
brew install node
git clone <repo> ~/lbsv && cd ~/lbsv && npm ci && npm run build
npm start      # prints the first-run setup code
```
To keep it running, use a launchd agent (`~/Library/LaunchAgents/lan.lbsv.hub.plist`) that runs `node packages/hub/src/cli.ts serve` with `WorkingDirectory` set to the checkout.

### Windows
```powershell
winget install OpenJS.NodeJS.LTS
git clone <repo> C:\lbsv; cd C:\lbsv; npm ci; npm run build
npm start      # prints the first-run setup code
```
Clone onto a local drive, not a mapped network drive. To start it at logon, create a Task Scheduler task that runs `node packages\hub\src\cli.ts serve` in that folder.

## Backups

The hub backs itself up: every `LBSV_BACKUP_EVERY_HOURS` (24) it writes an online SQLite backup to
`$LBSV_BACKUP_DIR/lbsv-<timestamp>.db` and keeps the newest `LBSV_BACKUP_KEEP` (14). The Devices page shows the
last one and has **Back up now**; a failed backup shows there in red. Backups in the same folder with other names
(`lbsv backup --out`, `pre-restore-*`) are never pruned.

Those backups sit on the same disk. Copy them somewhere else now and then:
`docker compose cp hub:/data/backups ./lbsv-backups` (or rsync `$LBSV_BACKUP_DIR` from cron).

**Restore** (the hub must be stopped; `restore` refuses while it runs):

```sh
docker compose stop hub
docker compose run --rm hub lbsv backups          # list
docker compose run --rm hub lbsv restore latest   # or a path under /data/backups
docker compose start hub
```

Without Docker: `lbsv restore latest` with the same environment as the service. Restore checks the file
(SQLite integrity, an lbsv schema no newer than this version), saves the database it replaces as
`pre-restore-<timestamp>.db` (so a restore can be undone the same way), and migrates an older backup forward.

The UI's **Export JSON** / **Import…** gives you a portable copy as well. Import merges by id.

## Reachability

Devices dial **out** to the hub, so they need no inbound ports.

- **Tailscale / Headscale (default):** install Tailscale on the hub box, set `LBSV_BIND_IP` (Docker) or `LBSV_HOST` to its `100.x` address, and browse to `http://<tailscale-ip>:11444` (Docker; 8080 when run directly) or its MagicDNS name. Use Tailscale ACLs to limit who can reach that port.
- **SSH reverse tunnel (fallback for VMs that can't join the tailnet):** from the isolated VM, `ssh -N -L 8080:127.0.0.1:8080 user@hub-box` exposes the hub on the VM's own `127.0.0.1:8080`. If only the hub can reach the VM, run `ssh -N -R 8080:127.0.0.1:8080 user@vm` from the hub instead. Wrap either in `autossh` or a systemd unit to keep it up.
- Over a tailnet, plain HTTP is fine (WireGuard already encrypts it). For HTTPS, use a reverse proxy with a certificate from your local CA (mkcert, step-ca) or your domain's DNS-01 challenge.
- If you put a reverse proxy in front, it must pass WebSocket upgrades on **both** `/ws` (UI) and `/collect` (browser extensions, later lbsv-agent). See below.

### Behind a TLS reverse proxy

The example uses HAProxy and `lbsv.example.net`; Caddy, nginx and Traefik work the same way (pass WebSocket upgrades, long timeouts).

The hub speaks plain HTTP; HAProxy terminates TLS. Run the container with `LBSV_BIND_IP` = an address HAProxy can
reach and `LBSV_TRUST_PROXY` = HAProxy's IP, so the hub sees the real client IP (login throttling) and marks the
session cookie `Secure` (it reads `X-Forwarded-Proto`).

```haproxy
frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/
    acl host_lbsv hdr(host) -i lbsv.example.net
    # LAN / VPN only: this is your projects, tabs and hostnames. Don't expose it to the internet.
    acl from_inside src 192.168.0.0/16 10.0.0.0/8 100.64.0.0/10
    http-request deny if host_lbsv !from_inside
    use_backend lbsv if host_lbsv

backend lbsv
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    option httpchk GET /api/health
    # Long-lived WebSockets: /ws (UI, pinged every 25 s) and /collect (extensions, ping every 20 s).
    # /mcp (M4) is plain request/response HTTP; nothing extra needed.
    timeout tunnel 1h
    server lbsv1 <docker-host>:11444 check
```

Then pair extensions with `https://lbsv.example.net` (they switch to `wss://` automatically). No HAProxy WebSocket
config is needed beyond `timeout tunnel`; HAProxy passes `Upgrade` through in HTTP mode.

## API

All under `/api`. Everything except `auth`, `login`, `logout` and `health` needs the session cookie.

| Method | Path | |
|---|---|---|
| GET | `/state` | All projects (nested links/sessions/ideas) + inbox |
| GET | `/search?q=` | FTS5 multi-term prefix search |
| POST / PATCH / PUT / DELETE | `/projects[/:id]` | PUT = full restore (undo delete) |
| POST | `/projects/:id/links` | `{links:[…]}` bulk, deduped by URL within project |
| DELETE | `/links/:id` | |
| POST / DELETE | `/projects/:id/sessions`, `/sessions/:id` | |
| POST / PATCH / DELETE | `/ideas[/:id]` | `projectId: null` = inbox. PATCH moves it |
| GET / POST | `/export`, `/import` | `{mode:"merge"\|"replace", data}` |
| GET | `/search?q=` | Also returns `tabs` (live tabs), `terms` (live terminals: session name, folder, recorded command) and `ideaLinks` (ideas matched by an attached URL/title) |
| GET | `/live` | Devices → browsers → windows → tabs, and devices → agents → terminals; plus deny-lists, per-device SSH settings, stale threshold and hub clock |
| PUT | `/live/deny` | `{domains:[…]}` deny-list for every device |
| POST | `/devices` | `{name}` → `{device, code, expiresAt}`: one-time pairing code, 10 minutes |
| PATCH | `/devices/:id` | `{name?, deny?, sshTarget?, sshJump?}`: per-device deny-list; SSH target (`user@host` or ssh-config alias) and jump host used in generated reconnect commands |
| POST / DELETE | `/devices/:id/code` | New pairing code (replaces an unused one) / cancel it |
| POST | `/devices/:id/revoke` | Invalidate every token on the device and drop its live tabs and terminals. It can pair again |
| DELETE | `/devices/:id` | Remove the device and everything it reported |
| POST | `/live/focus` | `{tabId}`: bring the tab to the front on its machine. 409 if its browser is offline |
| POST | `/live/close` | `{tabs:[{id, url?}]}` → `{closed, notClosed:[{id, reason}], reopen}`. A tab closes only if its native id **and** URL (the `url` you saw; default the hub's copy) still match |
| POST | `/live/open` | `{browserId, urls, windowId?}`: open in that window if it still exists, else a new window (http/https/ftp only). Used for undo |
| POST | `/live/park` | `{projectId \| newProject, tabs:[{id, url?}], close}`: save as links (committed first), then close. Links stay if closing fails |
| POST | `/live/attach` | `{ideaId \| newIdea:{text, projectId\|null}, tabs:[{id, url?}], close}`: attach the tabs' URLs to an idea (committed first), then optionally close them |
| POST | `/live/send` | `{tabs:[{id, url?}], toBrowserId}`: open in the target's focused window, then close the originals. 409 if the target is offline (nothing closed) |
| POST | `/ideas/:id/links` | `{links:[{url, title?, where?}]}` attach URLs to an idea (deduped per idea) |
| DELETE | `/idea-links/:id` | Detach |
| POST | `/projects/:id/rules` | `{kind, pattern}`, kind = `domain` \| `url_prefix` \| `title_regex` \| `cwd_prefix` \| `host`. Normalised (a URL given as a domain becomes its host); an identical rule is returned instead of duplicated; unusable patterns (bad regex, prefix without a scheme) → 400. Rules come back in `project.rules` |
| DELETE | `/rules/:id` | Remove a rule |
| GET / POST | `/mcp-clients` | List MCP clients / `{name}` → `{client, token}`. The `lbsvm_…` token is shown once; only its sha256 is stored |
| DELETE | `/mcp-clients/:id` | Revoke an MCP client's token |
| GET | `/install/agent.sh`, `/install/agent.ps1`, `/install/lbsv-agent.mjs` | **No login** (not under `/api`): one-line agent installers with this hub's address baked in, and the agent bundle. The pairing code is the secret, not the agent. Address = the request's origin, or `LBSV_PUBLIC_URL` |
| GET | `/favicon?origin=` | Cached icon for an origin seen in a live tab (404 otherwise). Served with a sandboxing CSP |
| WS | `/ws` | `{t:"changed", entity, ids}`, entity = `project` \| `inbox` \| `all` \| `live` \| `devices` |

### Collector socket: `/collect` (not under `/api`; authenticated by device token, not the cookie)

JSON messages, one per frame. Validated by zod; anything malformed closes the socket (4400).

```jsonc
// pairing (once): code from the Devices page
→ {"t":"enroll","code":"ABCD-EFGH","kind":"ext","label":"edge · Work"}
← {"t":"enrolled","token":"lbsv_…","device":{"id":"…","name":"laptop-2"}}   // or {"t":"error","error":"bad_code"|"throttled"}
// every connection
→ {"t":"hello","token":"lbsv_…","browser":{"family":"edge","profile":"Work"},"ext":"0.1.0"}
← {"t":"welcome","browserId":"…","device":{…},"heartbeatMs":20000,"deny":["bank.com"]}   // bad token: close 4401
→ {"t":"snapshot","seq":1,"windows":[…],"tabs":[…],"denied":0}   // replaces this browser's rows in one transaction
→ {"t":"delta","seq":2,"upserts":{"tabs":[…]},"removes":{"tabs":["123"]}}
← {"t":"ack","seq":2}            // seq ≤ last applied: acked, ignored (replay-safe)
← {"t":"resync"}                 // seq gap: the collector answers with a fresh snapshot
→ {"t":"ping"}  ← {"t":"pong"}   // every 20 s; silent for 40 s = shown stale
← {"t":"config","deny":[…]}      // deny-list changed; collector re-snapshots
← {"t":"cmd","id":"…","op":"close_tabs","args":{"tabs":[{"id":"123","url":"https://…"}]}}
→ {"t":"cmd_result","id":"…","ok":true,"result":{"closed":["123"],"skipped":[{"id":"124","reason":"url_changed"}]}}
// ops: focus_tab {tabId, windowId} · close_tabs {tabs} · open_url {urls, windowId?}; 10 s timeout
```

### Agent socket: `/collect/agent` (lbsv-agent, M3)

Pair through `/collect` with `"kind":"agent"`; a browser token can't open the agent socket (and vice versa).

```jsonc
→ {"t":"hello","token":"lbsv_…","agent":{"version":"0.1.0","os":"linux","hostname":"vm-iso-3","user":"kelly"}}
← {"t":"welcome","agentId":"…","device":{…},"heartbeatMs":20000}
→ {"t":"terms","seq":1,"terms":[{"id":"tmux:work","kind":"tmux","name":"work","cwd":"/home/kelly/git/lbops","attached":1,"windows":3,"lastActivityAt":…},
                                 {"id":"sh:4242","kind":"shell","shell":"bash","pid":4242,"cwd":"/srv","tty":"/dev/pts/2","cmd":"(only if opted in)"}]}
← {"t":"ack","seq":1}
→ {"t":"ping"}  ← {"t":"pong"}
```

Every `terms` message is the agent's **complete** list and replaces its rows in one transaction (terminals are few and
change slowly, so there are no deltas). Sequence numbers restart per connection; an older seq is acked and ignored.
After any outage the first message after reconnecting brings the hub up to date. The hub re-redacts `cmd`.

Close codes: `4401` token rejected or device revoked (the collector stops retrying), `4409` replaced by a newer
connection with the same token, `4400` bad message. The hub re-applies incognito filtering, URL redaction and the
deny-list to everything it receives, so a buggy collector can't store what a correct one wouldn't send.

## MCP server: `/mcp` (M4)

For Claude Code, Claude Desktop or any MCP client. **Streamable HTTP, stateless** (POST only; GET/DELETE answer 405),
authenticated by a per-client bearer token, **not** the cookie: Devices → *AI assistants (MCP)* → *Create token*.
Collector tokens can't use it, and an MCP token can't reach `/api`.

```sh
# Claude Code (any machine that reaches the hub)
claude mcp add --transport http --scope user lbsv https://lbsv.example.net/mcp --header "Authorization: Bearer lbsvm_…"
# Claude Desktop / stdio-only clients: the bridge in lbsv-agent (see packages/agent/README.md)
LBSV_MCP_TOKEN=lbsvm_… node lbsv-agent.mjs mcp --hub https://lbsv.example.net
```

Every tool returns compact JSON. Projects can be named by id **or name** (exact, then a unique partial match).

| Tool | |
|---|---|
| `search(query, scopes?, limit?)` | Saved projects/links/sessions/ideas (FTS5 prefix) **and** live tabs/terminals (substring). "Where is X open?" |
| `list_projects(status?)` · `get_project(project)` | `get_project` includes `openNow`: the tabs/terminals that belong to it right now |
| `create_project` · `update_project` | `update_project` can `append_left_off` (safer than replacing the note) |
| `add_links` · `add_idea` · `list_inbox` · `file_inbox_item` | |
| `add_rule(project, kind, pattern)` | Same rules as the UI |
| `list_live_tabs(device?, browser?, stale_days?, project?, unfiled?, query?)` | Each tab carries its probable project: `how` = `filed` / `rule` / `guess`, plus `why` |
| `list_live_terminals(device?, project?, query?)` | With reconnect commands |
| `suggest_assignments(include_unmatched?)` | Open things not yet saved anywhere, with the best-guess project (the UI's suggester) |
| `park_tabs(tab_ids, project, close?, confirm?)` | Saves links first. **`close: true` without `confirm: true` does nothing** and returns a preview for the user; the confirmed call closes only tabs still on the URL from the preview |
| `save_terminal(term_id, project)` | Saves a live terminal as a project session |
| `open_url(url, device, browser?)` · `focus_tab(tab_id)` | |

Resources: `lbsv://project/{id}` (markdown: left-off note, links, sessions, ideas, rules, open now) and
`lbsv://today` (recently touched projects, their notes and what's open for them; inbox and stale-tab counts).
