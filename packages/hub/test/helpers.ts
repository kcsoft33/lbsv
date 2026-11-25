import { openDb } from "../src/db.ts";
import { buildApp, type AppOptions } from "../src/app.ts";

export const PASS = "correct horse battery";

/**
 * A wall-clock budget. The spec's latency checks (1 s fan-out, 2 s deltas) hold on a real machine, but shared CI
 * runners (GitHub sets CI=true) stall unpredictably, so there they get 5× the time: CI checks correctness, local
 * runs check speed.
 */
export const budget = (ms: number) => (process.env.CI ? ms * 5 : ms);

export async function makeHub(extra: Partial<AppOptions> = {}) {
  const db = openDb(":memory:");
  const hub = await buildApp({ db, adminPassphrase: PASS, ...extra });
  return { db, ...hub };
}

/** Log in and return a Cookie header value. */
export async function login(app: Awaited<ReturnType<typeof makeHub>>["app"], pass = PASS): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: pass } });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((c) => c.name === "lbsv_session");
  if (!c) throw new Error("no session cookie");
  return `lbsv_session=${c.value}`;
}
