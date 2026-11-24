import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/redact.ts";

describe("redactUrl (SPEC §7)", () => {
  const cases: [string, string, string][] = [
    ["drops token, keeps the rest", "https://a.com/x?token=abc&q=1", "https://a.com/x?q=1"],
    ["drops every secret-looking param", "https://a.com/?api_key=1&sig=2&Password=3&code=4&session_id=5&jwt=6&id_token=7&keep=8", "https://a.com/?keep=8"],
    ["AWS presigned URL", "https://b.s3.amazonaws.com/f.zip?X-Amz-Credential=c&X-Amz-Signature=deadbeef&X-Amz-Expires=60", "https://b.s3.amazonaws.com/f.zip?X-Amz-Credential=c&X-Amz-Expires=60"],
    ["case-insensitive", "https://a.com/?AccessToken=1&x=2", "https://a.com/?x=2"],
    ["percent-encoded key", "https://a.com/?acc%65ss_token=1&x=2", "https://a.com/?x=2"],
    ["removing the only param removes the ?", "https://a.com/x?token=1", "https://a.com/x"],
    ["keeps a normal fragment when the query goes", "https://a.com/x?secret=1#top", "https://a.com/x#top"],
    ["strips user:pass@", "https://user:hunter2@a.com/x", "https://a.com/x"],
    ["strips user@", "ftp://bob@files.lan/pub", "ftp://files.lan/pub"],
    ["OAuth implicit fragment", "https://app.io/cb#access_token=xyz&state=1", "https://app.io/cb"],
    ["OIDC id_token fragment", "https://app.io/cb#state=1&id_token=xyz", "https://app.io/cb"],
    ["SPA router fragment with code", "https://app.io/#/callback?code=123&state=x", "https://app.io/"],
    ["localhost with session", "http://127.0.0.1:8080/?session=abc&tab=2", "http://127.0.0.1:8080/?tab=2"],
    ["file URL", "file:///C:/notes/x.html?token=1", "file:///C:/notes/x.html"],
  ];
  for (const [name, input, out] of cases) it(name, () => expect(redactUrl(input)).toBe(out));

  it("returns clean URLs byte-for-byte unchanged", () => {
    for (const u of [
      "https://a.com/x?q=a%20b&page=2",
      "https://a.com/docs#section-2",
      "https://a.com/search?q=what?#why?",
      "http://10.0.0.5:8080",
      "https://example.com/path/",
      "about:blank",
      "chrome://settings",
      "not a url at all",
    ]) expect(redactUrl(u)).toBe(u);
  });

  it("is idempotent", () => {
    for (const [, input] of cases) expect(redactUrl(redactUrl(input))).toBe(redactUrl(input));
  });

  it("strips credentials even from URLs it can't parse", () => {
    expect(redactUrl("https://u:p@exa mple.com/x")).toBe("https://exa mple.com/x");
  });

  it("is broad on purpose (over-redaction is the safe failure)", () => {
    expect(redactUrl("https://shop.io/?keyword=rust&author=me&q=1")).toBe("https://shop.io/?q=1");
  });
});
