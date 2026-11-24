# lbsv-ext: LabSave browser extension

Streams the open windows and tabs of one browser profile to **your own** LabSave hub, live. It's one Manifest V3 codebase, built for Chromium (Chrome, Edge) and Firefox.

**What it sends:** for each tab, the URL (with secrets stripped), title, window, position, and whether it's active, pinned, playing audio or discarded. It also sends when the tab was last focused, if the browser reports that.

**What it never sends:**
- Anything from private or incognito windows. The extension refuses to run there (`"incognito": "not_allowed"`) and also filters them out in code.
- Page content, cookies, passwords, form data or screenshots.
- Browser-internal pages, unless you opt in.
- Tabs on deny-listed domains. These are counted but never stored.

Secret-looking query parameters are stripped before anything leaves the browser, and the hub strips them again. That covers `token`, `key`, `secret`, `sig`/`signature`, `password`, `auth`, `code`, `session`, `jwt`, `access_token` and `id_token`, plus OAuth tokens in `#fragments` and `user:pass@`. The rules are in [`packages/shared/src/redact.ts`](../shared/src/redact.ts).

**What the hub can ask it to do** (from the Live tabs page): bring a tab to the front, close tabs, and open http/https/ftp URLs (used for undo). A tab is closed only if both its id and its URL still match what you selected, so a tab that navigated elsewhere, or an id the browser reused, is never closed by mistake. It's reported back instead.

The extension talks only to the hub address you give it. There are no other network requests and no telemetry.

## Get it

**Easiest: from your hub.** Open the hub → **Devices** → *Install the extension on another device*, and download the Chrome/Edge or Firefox zip (log in first). The hub serves whatever `npm run build:ext` produced (`packages/ext/dist/packages/*.zip`; the Docker image includes them).

**Or build it** from the repo root (Node ≥ 22.18, `git clone https://github.com/kcsoft33/lbsv.git`):

```sh
npm install
npm run build:ext
# → packages/ext/dist/chromium   (Chrome, Edge, Brave…)
# → packages/ext/dist/firefox
```

## Install

Each **browser profile** is its own collector and needs its own pairing code. In the hub, go to **Devices**, then **Add device** (or **New code** on an existing device).

### Chrome / Edge (Windows, macOS, Linux)

1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/ext/dist/chromium` (or the folder you unzipped the downloaded package into; keep that folder, the browser runs the extension from it).
3. Click the LabSave toolbar icon (or the extension's **Details → Extension options**).
4. Enter the hub address (e.g. `https://lbsv.example.net`, or `http://<hub-tailscale-ip>:11444`), paste the pairing code, choose a profile label (Work, Personal…), and click **Pair**.

The status should turn to **Connected**, and your tabs will show up under **Live tabs** in the hub within a couple of seconds.

To update after a rebuild, click the reload icon on the extension card. Pairing is kept.

The paths are the same on every OS. On Windows the folder is `C:\…\lbsv\packages\ext\dist\chromium`. On macOS and Linux it's wherever you cloned the repo.

### Firefox (Windows, macOS, Linux)

Release Firefox only installs signed extensions permanently. You have two options:

- **Try it now (temporary):** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `packages/ext/dist/firefox/manifest.json`. It stays until Firefox restarts.
- **Permanent:**
  - Use Firefox **Developer Edition**, **Nightly** or **ESR**, set `xpinstall.signatures.required` to `false` in `about:config`, zip the *contents* of `dist/firefox`, and install the zip from `about:addons` → ⚙ → **Install Add-on From File**.
  - Or sign it yourself through AMO's *unlisted* (self-distribution) channel. That's planned for M5 packaging.

Then open the add-on's **Preferences** and pair it as above.

Firefox needs version 128 or later. The Firefox build overrides the default MV3 security policy, which would otherwise silently upgrade `ws://` to `wss://` and break hubs served over plain HTTP inside a tailnet.

## How it stays live

- **Each connect** sends `hello`, then a full **snapshot**. The hub replaces that browser's rows in one transaction. Anything missed while offline (sleep, wifi drop, hub restart) is corrected by the next snapshot.
- **Changes** go out as **deltas**, debounced to at most one every 500 ms. A flurry of title changes, like unread counters, becomes a single message.
- **Keep-alive.** MV3 backgrounds get unloaded when idle:
  - A 30-second alarm wakes the extension and reconnects it if needed.
  - While connected, a 20-second ping keeps Chromium's worker alive (Chrome/Edge ≥ 116).
  - If the hub stops answering for about 50 seconds, the socket is dropped and redialled.
  - Reconnects back off from 1 s to 30 s.
- **The hub's view of staleness.** A browser silent for 40 s is greyed out in **Live tabs**. Its tabs are kept, not deleted.

The protocol is documented in the [hub README](../hub/README.md#collector-socket-collect-not-under-api-authenticated-by-device-token-not-the-cookie). The connection logic lives in [`packages/shared/src/collectorClient.ts`](../shared/src/collectorClient.ts) and is tested in Node against a real hub (`packages/hub/test/collect.test.ts`).

## Troubleshooting

| Options page says | Meaning |
|---|---|
| Can't reach the hub | Wrong address, hub down, or this machine isn't on the tailnet. Changes are kept and sent when it reconnects |
| The hub rejected this browser's token | The device was revoked or removed in the hub. Pair again with a new code |
| That pairing code is wrong, already used, or expired | Codes are single-use and last 10 minutes. Click **New code** on the device |

To check what the extension is doing in Chrome or Edge, go to `chrome://extensions`, find LabSave collector, and click **service worker** to open its console.
