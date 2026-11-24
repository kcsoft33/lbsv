import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { Auth, LoginThrottle, SESSION_TTL_MS, hashPassphrase, verifyPassphrase } from "../src/auth.ts";
import { PASS, login, makeHub } from "./helpers.ts";

describe("passphrase hashing", () => {
  it("verifies the right passphrase only", () => {
    const h = hashPassphrase("hunter2hunter2");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassphrase("hunter2hunter2", h)).toBe(true);
    expect(verifyPassphrase("hunter2hunter3", h)).toBe(false);
    expect(verifyPassphrase("x", "garbage")).toBe(false);
  });
});

describe("auth middleware", () => {
  it("rejects API and WS without a session", async () => {
    const { app } = await makeHub();
    for (const [method, url] of [["GET", "/api/state"], ["POST", "/api/projects"], ["GET", "/api/export"], ["GET", "/ws"], ["GET", "/api/search?q=x"]] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("leaves public endpoints open", async () => {
    const { app } = await makeHub();
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/auth")).json()).toEqual({ configured: true, authenticated: false });
  });

  it("issues an httpOnly SameSite=Strict cookie on login, which then grants access", async () => {
    const { app } = await makeHub();
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
    const c = r.cookies.find((c) => c.name === "lbsv_session")!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe("strict");
    const cookie = `lbsv_session=${c.value}`;
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth", headers: { cookie } })).json().authenticated).toBe(true);
  });

  it("does not store raw session tokens", async () => {
    const { app, db } = await makeHub();
    const cookie = await login(app);
    const token = cookie.split("=")[1]!;
    const rows = db.prepare("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it("rejects a wrong passphrase and a forged cookie", async () => {
    const { app } = await makeHub();
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "nope nope" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/state", headers: { cookie: "lbsv_session=forged" } })).statusCode).toBe(401);
  });

  it("logout revokes the session", async () => {
    const { app } = await makeHub();
    const cookie = await login(app);
    await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("expired sessions are rejected", async () => {
    let t = 1_000_000;
    const db = openDb(":memory:");
    const { app } = await buildApp({ db, adminPassphrase: PASS, now: () => t });
    const cookie = await login(app);
    t += SESSION_TTL_MS + 1;
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("changing the passphrase signs out existing sessions", async () => {
    const { app, db } = await makeHub();
    const cookie = await login(app);
    new Auth(db).setPassphrase("a whole new phrase");
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("reports not configured when no passphrase exists", async () => {
    const db = openDb(":memory:");
    const { app } = await buildApp({ db });
    expect((await app.inject("/api/auth")).json()).toEqual({ configured: false, authenticated: false });
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "anything" } })).statusCode).toBe(503);
  });

  it("throttles repeated failed logins", async () => {
    const { app } = await makeHub();
    const bad = () => app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "wrong wrong" } });
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
  });
});

describe("LoginThrottle", () => {
  it("backs off exponentially after the free attempts and resets on success", () => {
    let t = 0;
    const th = new LoginThrottle(() => t, 3);
    th.fail("a"); th.fail("a");
    expect(th.retryAfterMs("a")).toBe(0);
    th.fail("a");
    expect(th.retryAfterMs("a")).toBe(1000);
    th.fail("a");
    expect(th.retryAfterMs("a")).toBe(2000);
    th.ok("a");
    expect(th.retryAfterMs("a")).toBe(0);
  });
});
