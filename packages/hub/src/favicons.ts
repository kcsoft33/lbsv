import type { DB } from "./db.ts";

/**
 * Favicon cache (SPEC §8: "fetched by the hub and cached locally; never hotlinked").
 * Only origins that appeared in a live tab can be fetched (so this isn't a general URL fetcher),
 * only over http(s), with a short timeout, a size cap and an image content-type allow-list.
 * Set LBSV_FAVICONS=0 to stop the hub from contacting tab hosts at all (the UI falls back to a letter).
 */
export const FAVICON_TTL_MS = 7 * 86400_000;
export const FAVICON_RETRY_MS = 86400_000;
export const FAVICON_MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = 3000;
const TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/gif", "image/jpeg", "image/webp", "image/avif"]);

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

type Fetch = typeof fetch;
interface Row { origin: string; icon_url: string | null; mime: string | null; data: Buffer | null; fetched_at: number | null; failed_at: number | null }

export class Favicons {
  private db: DB;
  private now: () => number;
  private enabled: boolean;
  private fetchImpl: Fetch;
  private inflight = new Map<string, Promise<{ mime: string; data: Buffer } | null>>();
  constructor(db: DB, opts: { enabled?: boolean; now?: () => number; fetch?: Fetch } = {}) {
    this.db = db; this.now = opts.now ?? Date.now; this.enabled = opts.enabled ?? true; this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Record that an origin is in use (and the browser's icon URL hint). Cheap; called per tab. */
  note(url: string, iconUrl: string | undefined): void {
    const origin = originOf(url);
    if (!origin) return;
    const hint = iconUrl && originOf(iconUrl) ? iconUrl : null;
    this.db.prepare(`INSERT INTO favicons(origin, icon_url, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(origin) DO UPDATE SET icon_url = COALESCE(excluded.icon_url, icon_url), last_seen_at = excluded.last_seen_at`)
      .run(origin, hint, this.now());
  }

  async get(origin: string): Promise<{ mime: string; data: Buffer } | null> {
    const row = this.db.prepare("SELECT origin, icon_url, mime, data, fetched_at, failed_at FROM favicons WHERE origin = ?").get(origin) as Row | undefined;
    if (!row) return null; // never seen in a tab: refuse
    const now = this.now();
    const cached = row.data && row.mime ? { mime: row.mime, data: row.data } : null;
    if (cached && row.fetched_at && now - row.fetched_at < FAVICON_TTL_MS) return cached;
    if (!this.enabled) return cached;
    if (row.failed_at && now - row.failed_at < FAVICON_RETRY_MS) return cached;
    let p = this.inflight.get(origin);
    if (!p) {
      p = this.refresh(row).finally(() => this.inflight.delete(origin));
      this.inflight.set(origin, p);
    }
    return (await p) ?? cached;
  }

  private async refresh(row: Row): Promise<{ mime: string; data: Buffer } | null> {
    const candidates = [...new Set([row.icon_url, row.origin + "/favicon.ico"].filter((u): u is string => !!u && !!originOf(u)))];
    for (const url of candidates) {
      const got = await this.fetchIcon(url);
      if (got) {
        this.db.prepare("UPDATE favicons SET mime = ?, data = ?, fetched_at = ?, failed_at = NULL WHERE origin = ?").run(got.mime, got.data, this.now(), row.origin);
        return got;
      }
    }
    this.db.prepare("UPDATE favicons SET failed_at = ? WHERE origin = ?").run(this.now(), row.origin);
    return null;
  }

  private async fetchIcon(url: string): Promise<{ mime: string; data: Buffer } | null> {
    try {
      const r = await this.fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "image/*" } });
      if (!r.ok || !originOf(r.url || url)) return null;
      let mime = (r.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
      if ((mime === "application/octet-stream" || !mime) && /\.ico(\?|$)/i.test(url)) mime = "image/x-icon";
      if (!TYPES.has(mime)) return null;
      const len = Number(r.headers.get("content-length") || 0);
      if (len > FAVICON_MAX_BYTES) return null;
      const data = Buffer.from(await r.arrayBuffer());
      if (!data.length || data.length > FAVICON_MAX_BYTES) return null;
      return { mime, data };
    } catch { return null; }
  }
}
