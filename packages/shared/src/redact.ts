/**
 * URL redaction (SPEC §7). Runs in the collector before anything leaves the device, and again in
 * the hub as a backstop. Rules:
 *  - drop query parameters whose *name* matches SECRET_PARAM_RE
 *  - drop the fragment when it carries an OAuth/OIDC token (access_token= / id_token=) or, more
 *    generally, when it looks like a query string (`#a=1&b=2`, `#/cb?code=…`) with a secret-named key
 *  - remove `user:pass@` credentials
 * A URL that needs no change is returned byte-for-byte unchanged (no re-serialisation), so
 * redaction is idempotent and comparing URLs across collector and hub stays stable.
 *
 * The parameter pattern is deliberately broad (`key` also matches `keyword`, `auth` matches
 * `author`). Over-redaction only loses a harmless parameter; under-redaction leaks a secret.
 */
export const SECRET_PARAM_RE = /(token|key|secret|sig|signature|password|auth|code|session|jwt|access_token|id_token)/i;
const FRAGMENT_TOKEN_RE = /(?:^|[#&?/])(access_token|id_token)=/i;

function decodeKey(k: string): string {
  try { return decodeURIComponent(k.replace(/\+/g, " ")); } catch { return k; }
}

/** Returns the kept `&`-separated segments, or null when nothing was dropped. */
function filterParams(qs: string): string[] | null {
  const parts = qs.split("&");
  const kept = parts.filter((seg) => !seg || !SECRET_PARAM_RE.test(decodeKey(seg.split("=", 1)[0]!)));
  return kept.length === parts.length ? null : kept.filter(Boolean);
}

function fragmentHasSecret(hash: string): boolean {
  if (FRAGMENT_TOKEN_RE.test(hash)) return true;
  const body = hash.replace(/^#/, "");
  const qs = body.includes("?") ? body.slice(body.indexOf("?") + 1) : body.includes("=") ? body : "";
  if (!qs) return false;
  return qs.split("&").some((seg) => seg.includes("=") && SECRET_PARAM_RE.test(decodeKey(seg.split("=", 1)[0]!)));
}

const USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;

export function redactUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch {
    return raw.replace(USERINFO_RE, "$1");
  }
  // Only hierarchical URLs carry credentials or meaningful query strings worth rewriting.
  if (!u.host && u.protocol !== "file:") return raw;
  let changed = false;
  if (u.username || u.password) { u.username = ""; u.password = ""; changed = true; }
  if (u.search) {
    const kept = filterParams(u.search.slice(1));
    if (kept) { u.search = kept.length ? "?" + kept.join("&") : ""; changed = true; }
  }
  if (u.hash && fragmentHasSecret(u.hash)) { u.hash = ""; changed = true; }
  return changed ? u.toString() : raw;
}
