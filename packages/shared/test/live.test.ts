import { describe, expect, it } from "vitest";
import { dupKey, isDenied, isInternalUrl, MAX_TITLE, normalizeDenyEntry, prepareTab, type WireTab } from "../src/live.ts";
import { collectorUrl } from "../src/collectorClient.ts";

const tab = (over: Partial<WireTab>): WireTab => ({ id: "1", windowId: "1", index: 0, url: "https://a.com/", title: "A", ...over });

describe("prepareTab privacy filters", () => {
  it("always skips incognito / private tabs, even with internal pages allowed", () => {
    expect(prepareTab(tab({ incognito: true }))).toBe("incognito");
    expect(prepareTab(tab({ incognito: true }), { includeInternal: true })).toBe("incognito");
  });

  it("skips browser-internal and extension pages unless opted in", () => {
    for (const u of ["chrome://settings", "edge://newtab/", "about:blank", "about:newtab", "chrome-extension://abc/options.html",
      "moz-extension://uuid/page.html", "view-source:https://a.com", "devtools://devtools/x", "data:text/html,hi", "javascript:void(0)", ""]) {
      expect(isInternalUrl(u), u).toBe(true);
      expect(prepareTab(tab({ url: u })), u).toBe("internal");
    }
    expect(typeof prepareTab(tab({ url: "edge://settings" }), { includeInternal: true })).toBe("object");
    for (const u of ["https://a.com", "http://10.0.0.5:8080", "file:///C:/x.html", "ftp://files.lan/"]) expect(isInternalUrl(u), u).toBe(false);
  });

  it("deny-list matches the domain and its subdomains only", () => {
    const deny = ["bank.com"];
    expect(isDenied("https://bank.com/login", deny)).toBe(true);
    expect(isDenied("https://www.bank.com/", deny)).toBe(true);
    expect(isDenied("https://mybank.com/", deny)).toBe(false);
    expect(isDenied("https://bank.com.evil.io/", deny)).toBe(false);
    expect(prepareTab(tab({ url: "https://online.bank.com/acct" }), { deny })).toBe("denied");
  });

  it("normalises deny entries typed as URLs or wildcards", () => {
    expect(normalizeDenyEntry(" https://Bank.com/login ")).toBe("bank.com");
    expect(normalizeDenyEntry("*.corp.example")).toBe("corp.example");
    expect(normalizeDenyEntry("mail.example.com/")).toBe("mail.example.com");
  });

  it("redacts URLs, truncates titles, drops unknown fields", () => {
    const p = prepareTab({ ...tab({ url: "https://a.com/?token=1&q=2", title: "x".repeat(5000) }), cookie: "nope" } as WireTab);
    if (typeof p === "string") throw new Error(p);
    expect(p.url).toBe("https://a.com/?q=2");
    expect(p.title.length).toBe(MAX_TITLE);
    expect(p).not.toHaveProperty("cookie");
  });

  it("dupKey ignores fragment, trailing slash and case", () => {
    expect(dupKey("https://A.com/x/#y")).toBe(dupKey("https://a.com/x"));
  });

  it("collectorUrl maps the hub URL to its /collect socket", () => {
    expect(collectorUrl("http://hub.lan:8080")).toBe("ws://hub.lan:8080/collect");
    expect(collectorUrl("https://hub.tail1234.ts.net/some/page?x#y")).toBe("wss://hub.tail1234.ts.net/collect");
    expect(() => collectorUrl("ftp://x")).toThrow();
  });
});
