/**
 * Bulk link-paste parser, ported verbatim (behaviour-wise) from the prototype's `parseLinks`.
 *
 * Accepts, one per line:
 *   [Title](url)          markdown link
 *   Title - url           (also –, —, |, :, •, *, > separators)
 *   url Title
 *   bare http(s)://, file://, ftp:// URLs
 *   bare localhost[:port][/path] or IPv4[:port][/path]  -> "http://" is prepended
 * Trailing `),.;` are stripped from URLs (not from markdown-link URLs).
 */
export interface ParsedLink {
  label: string;
  url: string;
}

const MD_LINK = /\[([^\]]*)\]\((\S+?)\)/;
const URL_LIKE = /((?:https?|file|ftp):\/\/\S+|\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/\S*)?)/i;
const HAS_SCHEME = /^[a-z]+:\/\//i;
const EDGE_JUNK = /^[\s\-–—|:•*>\t]+|[\s\-–—|:•*\t]+$/g;

export function parseLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let m = line.match(MD_LINK);
    if (m) {
      out.push({ label: m[1]!.trim(), url: m[2]! });
      continue;
    }
    m = line.match(URL_LIKE);
    if (!m) continue;
    let url = m[1]!.replace(/[),.;]+$/, "");
    if (!HAS_SCHEME.test(url)) url = "http://" + url;
    const label = line.replace(m[1]!, "").replace(EDGE_JUNK, "").trim();
    out.push({ label, url });
  }
  return out;
}
