# lbsv-agent

Reports a machine's **terminals** to your lbsv (LabSave) hub: plain shells (bash, zsh, PowerShell) with their working folder, and **tmux / screen sessions**. Each one gets a ready-made **reconnect command** in the hub.

**What it never collects:** terminal output, passwords or keys. **Command text is off** unless you opt in per shell with `LBSV_RECORD_CMDS=1`, and even then it is redacted on the device (tokens, passwords, `Authorization:` headers, secret URL parameters) and again on the hub.

## How it works

- **Shell hooks** (`hooks/lbsv.bash`, `lbsv.zsh`, `lbsv.ps1`) overwrite one tiny file per shell at every prompt: `~/.local/state/lbsv/shells/<pid>`. They use only shell builtins, so nothing starts a process or touches the network at your prompt. The overhead is measured in the test suite (budget: < 5 ms; typically ~0.05 ms on Linux, ~1 ms on Windows).
- **The agent** watches that folder, polls `tmux` and `screen` every 15 s, and keeps one outbound WebSocket to the hub (`/collect/agent`). It **always sends its complete list**, so after any outage (hub down, laptop asleep, VPN dropped) the first message after reconnecting brings the hub up to date. Shells that exit are dropped automatically.
- Shells running **inside** a tmux/screen session are folded into that session's row: you reattach to the session, not to a pane.

Needs **Node.js 22.18 or newer** (it ships as one file, `lbsv-agent.mjs`, with no dependencies).

## Install (one line)

In the hub: **Devices → Add device** (or *New code* on an existing one). The pairing card shows the line for each OS
with the code filled in. It downloads the agent **from your hub** (isolated VMs need no internet), pairs, installs
the hooks, adds one marked block to your rc files, and starts the agent as a per-user service:

```sh
# Linux, macOS, WSL (and Git Bash on Windows)
curl -fsSL https://lbsv.example.net/install/agent.sh | sh -s -- ABCD-EFGH
```
```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://lbsv.example.net/install/agent.ps1))) ABCD-EFGH
```

Then **open a new terminal**. Options: `--no-service` / `-NoService`; `--record-cmds` / `-RecordCmds`
(opt in to command text, redacted). Rather read it first? `curl -fsSL …/install/agent.sh -o agent.sh`, read it, then `sh agent.sh ABCD-EFGH`.

| | Service | rc files touched (only ones that exist, plus your login shell's) |
|---|---|---|
| Linux | systemd user unit `lbsv-agent` + `loginctl enable-linger` (keeps tmux on servers visible after logout) | `~/.bashrc`, `~/.zshrc`, pwsh `$PROFILE` |
| macOS | launchd `net.cnlsft.lbsv-agent` | `~/.zshrc`, `~/.bashrc` |
| Windows | Task Scheduler `lbsv-agent`, at logon, hidden (`conhost --headless`) | pwsh and Windows PowerShell `$PROFILE`, Git Bash `~/.bashrc` |

**Needs Node.js 22.18+**; the installer checks and says how to get it (`winget install OpenJS.NodeJS.LTS`,
`brew install node`, NodeSource on Debian/Ubuntu). Standalone binaries are planned.

**Updating:** `lbsv-agent update` (or `node ~/.local/share/lbsv-agent/lbsv-agent.mjs update`) fetches the hub's current agent and reinstalls it in place, keeping the pairing and your `--record-cmds` choice. The Devices page flags agents older than the hub's. Re-running the one-liner without a code does the same. Without systemd (e.g. a
container), the installer says how to start it from a login script instead.

**Offline / manual:** download the zip from the Devices page, unzip, and run
`node lbsv-agent.mjs install --hub https://lbsv.example.net --code ABCD-EFGH`. The lower-level commands
(`enroll`, `hooks`, `service`, `run`) still exist for custom setups. `lbsv-agent scan` prints what would
be sent; `lbsv-agent status` checks pairing and the hub.

## Reaching the hub from isolated VMs

The agent only dials **out**; nothing listens on the VM.

- **Tailscale / Headscale (default):** join the VM to the tailnet and pair with the hub's tailnet URL.
- **SSH reverse tunnel (fallback):** from a machine that can reach both, keep a tunnel open and pair the VM against `localhost`:
  ```sh
  # on the VM: forward local 11444 to the hub through a box that can see it
  ssh -N -L 11444:hub.lan:11444 user@jump-box
  node lbsv-agent.mjs enroll --hub http://127.0.0.1:11444 --code ABCD-EFGH
  ```
  Or `ssh -R` from the hub side if the VM can't open outbound SSH. Run the tunnel under systemd/autossh so it survives reboots.

For **reconnect commands** (the *Copy ssh* button), set each device's **SSH target** (`user@host` or an `~/.ssh/config` alias) and optional **jump host** on the Devices page. Blank target = the agent's hostname.

## MCP bridge for Claude Desktop (M4)

The hub's MCP server speaks HTTP; Claude Code connects to it directly. Clients that only launch local commands
(Claude Desktop) use this bridge instead. It forwards stdio to `<hub>/mcp`, stores nothing, and works on any
machine with Node, paired or not. Create a token in the hub (Devices → *AI assistants (MCP)*), then add to
`claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`):

```json
{ "mcpServers": { "lbsv": {
  "command": "node",
  "args": ["/home/you/.local/share/lbsv-agent/lbsv-agent.mjs", "mcp", "--hub", "https://lbsv.example.net"],
  "env": { "LBSV_MCP_TOKEN": "lbsvm_…" } } } }
```

`--hub` defaults to the URL this machine was paired with. `--token-file <file>` reads the token from a file instead.

## Files

| Path | What |
|---|---|
| `~/.local/share/lbsv-agent/lbsv-agent.mjs` (Windows: `%LOCALAPPDATA%\lbsv-agent`) | the agent itself (hooks are embedded) |
| `~/.config/lbsv/agent.json` | hub URL + device token (owner-only, 0600) |
| `~/.config/lbsv/lbsv.{bash,zsh,ps1}` | the hooks (`lbsv-agent hooks` copies them) |
| `~/.local/state/lbsv/shells/<pid>` | one file per open shell; safe to delete |

Override with `LBSV_CONFIG_DIR`, `LBSV_STATE_DIR` (or `XDG_CONFIG_HOME` / `XDG_STATE_HOME`); set the same `LBSV_STATE_DIR` for the shells and the agent. `LBSV_HUB` overrides the saved hub URL.

## Removing it

`node ~/.local/share/lbsv-agent/lbsv-agent.mjs uninstall` (Windows: `node $env:LOCALAPPDATA\lbsv-agent\lbsv-agent.mjs uninstall`)
stops and removes the service, removes the marked block from your rc files, and deletes the agent, hooks and token.
Then **Revoke** the device in the hub.
