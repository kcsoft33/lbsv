# LabSave privacy policy

_Applies to the LabSave collector browser extension, the lbsv-agent terminal collector and the lbsv hub. Last updated 2026-11-22._

**In short: LabSave sends your data only to a LabSave hub that you run yourself, at an address you type in.
The authors never receive any of it. There's no analytics, telemetry, advertising or third-party service.**

## What the browser extension collects

Once you pair it with your hub, the extension sends that hub:

- the **URL, title and favicon address** of each tab in normal (non-private) windows, plus window and tab ids,
  which tab is active, pinned or audible, and when each tab was last used
- the browser family (Chrome, Edge, Firefox) and the profile label you choose

It **never** collects:

- private or incognito windows: the extension refuses to run in them
- page contents, form data, passwords, cookies or browsing history beyond the tabs that are open right now
- secret-looking URL parameters such as `token`, `key`, `code`, `session` and `password`, which are removed on your
  device before anything is sent
- tabs on domains you put on a deny-list, which are counted but never sent

## What the terminal agent collects

The agent sends your hub each terminal's working directory, host and user names, tmux/screen session names and
shell type. It **never** sends command output. Command text is only sent if you turn it on (`--record-cmds`),
and it is redacted the same way as URLs.

## Where it goes

- **Only to your hub**, at the address you enter. The connection uses your hub's TLS if you serve it over `https`.
- The hub stores data in a SQLite file on the machine you run it on. You can export it, back it up and delete it
  at any time.
- The hub may fetch favicons directly from the websites of your open tabs. You can turn that off with `LBSV_FAVICONS=0`.
- **Stores and updates:** if you install the extension from the Chrome Web Store, Chrome checks Google's servers
  for extension updates, as it does for every store extension. That check doesn't include your LabSave data.
  The Firefox build is signed by Mozilla but is downloaded from your own hub, and it doesn't contact Mozilla
  to check for updates.

## Sharing, selling, retention

Nobody but you has the data, so the authors don't share or sell it. You decide how long your hub keeps it.
Revoke a device on the hub's Devices page to cut off its access immediately.

## Contact

Open an issue on the project's repository.
