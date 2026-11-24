import { describe, expect, it } from "vitest";
import { parseLinks } from "../src/parseLinks.ts";

const one = (s: string) => parseLinks(s);

describe("parseLinks", () => {
  it("parses markdown links", () => {
    expect(one("[Grafana](https://grafana.lan/d/abc)")).toEqual([{ label: "Grafana", url: "https://grafana.lan/d/abc" }]);
  });

  it("trims markdown label and allows empty label", () => {
    expect(one("[  Docs  ](https://x.io)")).toEqual([{ label: "Docs", url: "https://x.io" }]);
    expect(one("[](https://x.io)")).toEqual([{ label: "", url: "https://x.io" }]);
  });

  it("markdown link wins even with other text on the line", () => {
    expect(one("- see [Runbook](https://wiki/rb) for details")).toEqual([{ label: "Runbook", url: "https://wiki/rb" }]);
  });

  it("parses 'Title - url' with various separators", () => {
    expect(one("Proxmox - https://pve.lan:8006")).toEqual([{ label: "Proxmox", url: "https://pve.lan:8006" }]);
    expect(one("Proxmox – https://pve.lan:8006")).toEqual([{ label: "Proxmox", url: "https://pve.lan:8006" }]);
    expect(one("Proxmox — https://pve.lan:8006")).toEqual([{ label: "Proxmox", url: "https://pve.lan:8006" }]);
    expect(one("Proxmox | https://pve.lan:8006")).toEqual([{ label: "Proxmox", url: "https://pve.lan:8006" }]);
    expect(one("Proxmox: https://pve.lan:8006")).toEqual([{ label: "Proxmox", url: "https://pve.lan:8006" }]);
  });

  it("parses 'url Title'", () => {
    expect(one("https://github.com/me/repo My repo")).toEqual([{ label: "My repo", url: "https://github.com/me/repo" }]);
  });

  it("parses bare http/https/file/ftp URLs with empty label", () => {
    expect(one("https://example.com/a?b=1")).toEqual([{ label: "", url: "https://example.com/a?b=1" }]);
    expect(one("http://example.com")).toEqual([{ label: "", url: "http://example.com" }]);
    expect(one("file:///C:/notes/todo.md")).toEqual([{ label: "", url: "file:///C:/notes/todo.md" }]);
    expect(one("ftp://files.lan/pub")).toEqual([{ label: "", url: "ftp://files.lan/pub" }]);
  });

  it("is case-insensitive on scheme", () => {
    expect(one("HTTPS://EXAMPLE.COM")).toEqual([{ label: "", url: "HTTPS://EXAMPLE.COM" }]);
  });

  it("prepends http:// to bare localhost and IPv4, with optional port and path", () => {
    expect(one("localhost")).toEqual([{ label: "", url: "http://localhost" }]);
    expect(one("localhost:3000")).toEqual([{ label: "", url: "http://localhost:3000" }]);
    expect(one("localhost:3000/admin")).toEqual([{ label: "", url: "http://localhost:3000/admin" }]);
    expect(one("10.0.0.5")).toEqual([{ label: "", url: "http://10.0.0.5" }]);
    expect(one("10.0.0.5:8080")).toEqual([{ label: "", url: "http://10.0.0.5:8080" }]);
    expect(one("Router 192.168.1.1")).toEqual([{ label: "Router", url: "http://192.168.1.1" }]);
  });

  it("strips trailing ),.; from URLs", () => {
    expect(one("see https://a.io/x).")).toEqual([{ label: "see", url: "https://a.io/x" }]);
    expect(one("https://a.io/x;")).toEqual([{ label: "", url: "https://a.io/x" }]);
    expect(one("https://a.io/x,")).toEqual([{ label: "", url: "https://a.io/x" }]);
    expect(one("(https://a.io/x)")).toEqual([{ label: "(", url: "https://a.io/x" }]);
  });

  it("strips bullets and leading/trailing separators from label", () => {
    expect(one("• Jira board — https://jira/x")).toEqual([{ label: "Jira board", url: "https://jira/x" }]);
    expect(one("* Item: https://a.io")).toEqual([{ label: "Item", url: "https://a.io" }]);
    expect(one("> quoted https://a.io")).toEqual([{ label: "quoted", url: "https://a.io" }]);
    expect(one("\t- tabbed\thttps://a.io")).toEqual([{ label: "tabbed", url: "https://a.io" }]);
  });

  it("skips blank lines and lines without URLs", () => {
    expect(parseLinks("\n\n   \njust some text\nnot a url: example.com\n")).toEqual([]);
  });

  it("handles CRLF and multiple lines in order", () => {
    const r = parseLinks("A - https://a.io\r\n\r\nhttps://b.io B\r\n[C](https://c.io)");
    expect(r).toEqual([
      { label: "A", url: "https://a.io" },
      { label: "B", url: "https://b.io" },
      { label: "C", url: "https://c.io" },
    ]);
  });

  it("only takes the first URL on a line; the rest stays in the label", () => {
    expect(one("https://a.io https://b.io")).toEqual([{ label: "https://b.io", url: "https://a.io" }]);
  });

  it("does not dedupe (the caller does)", () => {
    expect(parseLinks("https://a.io\nhttps://a.io")).toHaveLength(2);
  });
});
