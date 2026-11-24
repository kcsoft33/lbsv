import { describe, expect, it } from "vitest";
import { runCommand, type BrowserTab, type TabsApi } from "../src/commands.ts";

function fake(tabs: BrowserTab[], windows = [1]) {
  const log: string[] = [];
  const state = { tabs: [...tabs], windows: [...windows] };
  const api: TabsApi = {
    getTab: async (id) => state.tabs.find((t) => t.id === id) ?? null,
    removeTabs: async (ids) => {
      if (ids.some((id) => !state.tabs.some((t) => t.id === id))) throw new Error("No tab with id");
      state.tabs = state.tabs.filter((t) => !ids.includes(t.id!)); log.push(`remove ${ids.join(",")}`);
    },
    activateTab: async (id) => { log.push(`activate ${id}`); },
    focusWindow: async (id) => { log.push(`focus ${id}`); },
    windowExists: async (id) => state.windows.includes(id),
    createTab: async (url, w) => { log.push(`tab ${w} ${url}`); },
    createWindow: async (urls) => { log.push(`window ${urls.join(" ")}`); },
  };
  return { api, log, state };
}

describe("close_tabs", () => {
  it("closes only tabs whose id and URL still match; reports the rest", async () => {
    const { api, state } = fake([
      { id: 1, windowId: 1, incognito: false, url: "https://a.io/" },
      { id: 2, windowId: 1, incognito: false, url: "https://b.io/now-somewhere-else" },
      { id: 4, windowId: 1, incognito: true, url: "https://private.io/" },
    ]);
    const r = await runCommand(api, { op: "close_tabs", args: { tabs: [
      { id: "1", url: "https://a.io/" }, { id: "2", url: "https://b.io/" }, { id: "3", url: "https://c.io/" }, { id: "4", url: "https://private.io/" },
    ] } });
    expect(r.closed).toEqual(["1"]);
    expect(r.skipped).toEqual([{ id: "2", reason: "url_changed" }, { id: "3", reason: "gone" }, { id: "4", reason: "gone" }]);
    expect(state.tabs.map((t) => t.id)).toEqual([2, 4]);
  });

  it("matches against the redacted URL the hub stored", async () => {
    const { api } = fake([{ id: 7, windowId: 1, incognito: false, url: "https://a.io/x?token=SECRET&q=1" }]);
    const r = await runCommand(api, { op: "close_tabs", args: { tabs: [{ id: "7", url: "https://a.io/x?q=1" }] } });
    expect(r.closed).toEqual(["7"]);
  });

  it("falls back to one-by-one when a batch close fails", async () => {
    const { api, state } = fake([{ id: 1, windowId: 1, incognito: false, url: "https://a.io/" }, { id: 2, windowId: 1, incognito: false, url: "https://b.io/" }]);
    const orig = api.removeTabs;
    let calls = 0;
    api.removeTabs = async (ids) => { if (calls++ === 0) throw new Error("boom"); return orig(ids); };
    const r = await runCommand(api, { op: "close_tabs", args: { tabs: [{ id: "1", url: "https://a.io/" }, { id: "2", url: "https://b.io/" }] } });
    expect(r.closed).toEqual(["1", "2"]);
    expect(state.tabs).toEqual([]);
  });
});

describe("focus_tab / open_url", () => {
  it("focuses the tab and its window; refuses unknown tabs", async () => {
    const { api, log } = fake([{ id: 5, windowId: 9, incognito: false, url: "https://a.io/" }]);
    await runCommand(api, { op: "focus_tab", args: { tabId: "5", windowId: "9" } });
    expect(log).toEqual(["activate 5", "focus 9"]);
    await expect(runCommand(api, { op: "focus_tab", args: { tabId: "6", windowId: "9" } })).rejects.toThrow("gone");
    await expect(runCommand(api, { op: "focus_tab", args: { tabId: "x", windowId: "9" } })).rejects.toThrow("gone");
  });

  it("opens into the original window if it exists, otherwise a new window; only web schemes", async () => {
    const { api, log } = fake([], [3]);
    const urls = ["https://a.io/", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "http://10.0.0.5:8080/"];
    expect(await runCommand(api, { op: "open_url", args: { urls, windowId: "3" } })).toEqual({ opened: 2 });
    expect(await runCommand(api, { op: "open_url", args: { urls: ["https://b.io/"], windowId: "99" } })).toEqual({ opened: 1 });
    expect(log).toEqual(["tab 3 https://a.io/", "tab 3 http://10.0.0.5:8080/", "window https://b.io/"]);
  });
});
