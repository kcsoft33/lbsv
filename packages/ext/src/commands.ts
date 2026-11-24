/**
 * Executes hub → collector actions (SPEC §6.3). Browser APIs are injected so the safety rules
 * (never close a tab whose URL changed, never open odd schemes) are unit-tested without a browser.
 */
import { OPENABLE_RE, storedUrl, type Cmd, type CmdResult } from "../../shared/src/live.ts";

export interface BrowserTab { id?: number; url?: string; pendingUrl?: string; windowId: number; incognito: boolean }

export interface TabsApi {
  getTab(id: number): Promise<BrowserTab | null>;
  removeTabs(ids: number[]): Promise<void>;
  activateTab(id: number): Promise<void>;
  focusWindow(id: number): Promise<void>;
  windowExists(id: number): Promise<boolean>;
  createTab(url: string, windowId: number): Promise<void>;
  createWindow(urls: string[]): Promise<void>;
}

const MAX_OPEN = 100;
const nativeId = (id: string) => { const n = Number(id); return Number.isSafeInteger(n) && n >= 0 ? n : null; };

export async function runCommand(api: TabsApi, c: Cmd): Promise<CmdResult> {
  switch (c.op) {
    case "focus_tab": {
      const id = nativeId(c.args.tabId);
      const tab = id === null ? null : await api.getTab(id);
      if (!tab || tab.incognito) throw new Error("gone");
      await api.activateTab(id!);
      await api.focusWindow(tab.windowId).catch(() => { /* best effort across OS desktops */ });
      return {};
    }
    case "close_tabs": {
      const closing: number[] = [], closingIds: string[] = [];
      const skipped: NonNullable<CmdResult["skipped"]> = [];
      for (const want of c.args.tabs) {
        const id = nativeId(want.id);
        const tab = id === null ? null : await api.getTab(id);
        if (!tab || tab.incognito) { skipped.push({ id: want.id, reason: "gone" }); continue; }
        // Compare in the hub's stored form: the hub only ever saw the redacted URL.
        if (storedUrl(tab.url || tab.pendingUrl || "") !== want.url) { skipped.push({ id: want.id, reason: "url_changed" }); continue; }
        closing.push(id!); closingIds.push(want.id);
      }
      const closed: string[] = [];
      if (closing.length) {
        try { await api.removeTabs(closing); closed.push(...closingIds); } catch {
          // One bad id fails the batch in Chromium; retry one by one.
          for (let i = 0; i < closing.length; i++) {
            try { await api.removeTabs([closing[i]!]); closed.push(closingIds[i]!); } catch { skipped.push({ id: closingIds[i]!, reason: "failed" }); }
          }
        }
      }
      return { closed, skipped };
    }
    case "open_url": {
      const urls = c.args.urls.filter((u) => OPENABLE_RE.test(u)).slice(0, MAX_OPEN);
      if (!urls.length) return { opened: 0 };
      const win = c.args.windowId !== undefined ? nativeId(c.args.windowId) : null;
      if (win !== null && await api.windowExists(win)) {
        for (const u of urls) await api.createTab(u, win);
      } else {
        await api.createWindow(urls);
      }
      return { opened: urls.length };
    }
  }
}
