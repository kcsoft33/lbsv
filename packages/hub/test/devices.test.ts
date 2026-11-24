import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { Devices, ENROLL_TTL_MS, normalizeCode } from "../src/devices.ts";
import { login, makeHub } from "./helpers.ts";

const setup = () => {
  let t = 1_000_000;
  const db = openDb(":memory:");
  const d = new Devices(db, () => t);
  return { db, d, advance: (ms: number) => { t += ms; } };
};

describe("device enrollment (SPEC §6.1)", () => {
  it("issues a readable one-time code and stores only hashes", () => {
    const { db, d } = setup();
    const { code, expiresAt, device } = d.create("laptop-2");
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt - 1_000_000).toBe(ENROLL_TTL_MS);
    const r = d.enroll(code.toLowerCase().replace("-", " "), "ext", "Edge")!; // forgiving about case/separators
    expect(r.device).toEqual({ id: device.id, name: "laptop-2" });
    expect(r.token).toMatch(/^lbsv_/);
    const dump = JSON.stringify([db.prepare("SELECT * FROM credentials").all(), db.prepare("SELECT * FROM enroll_codes").all()]);
    expect(dump).not.toContain(r.token);
    expect(dump).not.toContain(normalizeCode(code));
  });

  it("codes are single-use", () => {
    const { d } = setup();
    const { code } = d.create("a");
    expect(d.enroll(code, "ext")).not.toBeNull();
    expect(d.enroll(code, "ext")).toBeNull();
  });

  it("codes expire after 10 minutes", () => {
    const { d, advance } = setup();
    const { code } = d.create("a");
    advance(ENROLL_TTL_MS + 1);
    expect(d.enroll(code, "ext")).toBeNull();
  });

  it("a new code replaces the unused one", () => {
    const { d } = setup();
    const { code, device } = d.create("a");
    const second = d.issueCode(device.id).code;
    expect(d.enroll(code, "ext")).toBeNull();
    expect(d.enroll(second, "ext")).not.toBeNull();
  });

  it("tokens authenticate until the device is revoked; revoked devices can re-pair", () => {
    const { d } = setup();
    const { code, device } = d.create("a");
    const { token } = d.enroll(code, "ext")!;
    expect(d.authenticate(token)?.device.id).toBe(device.id);
    expect(d.authenticate(token + "x")).toBeNull();
    expect(d.authenticate("garbage")).toBeNull();
    d.revoke(device.id);
    expect(d.authenticate(token)).toBeNull();
    const again = d.enroll(d.issueCode(device.id).code, "ext")!;
    expect(d.authenticate(again.token)?.device.id).toBe(device.id);
  });

  it("deny lists are normalised and merged with the global list", () => {
    const { d } = setup();
    const { device } = d.create("a");
    d.update(device.id, { deny: ["https://Bank.com/x", "bank.com", " ", "*.corp.example"] });
    expect(d.deviceDeny(device.id)).toEqual(["bank.com", "corp.example"]);
    d.setGlobalDeny(["mail.example.com"]);
    expect(d.effectiveDeny(device.id)).toEqual(["bank.com", "corp.example", "mail.example.com"]);
  });
});

describe("device API", () => {
  it("requires the admin session", async () => {
    const h = await makeHub();
    for (const [method, url] of [["GET", "/api/live"], ["POST", "/api/devices"], ["PUT", "/api/live/deny"]] as const) {
      expect((await h.app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
    }
    await h.app.close();
  });

  it("create → code, rename, new code, revoke, delete", async () => {
    const h = await makeHub();
    const cookie = await login(h.app);
    const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => h.app.inject({ method, url, payload, headers: { cookie } });
    const c = await req("POST", "/api/devices", { name: "  desk  " });
    expect(c.statusCode).toBe(201);
    const { device, code } = c.json();
    expect(device.name).toBe("desk");
    expect(code).toMatch(/-/);
    let st = (await req("GET", "/api/live")).json();
    expect(st.devices[0]).toMatchObject({ name: "desk", browsers: [], deny: [] });
    expect(st.devices[0].pendingCode.expiresAt).toBeGreaterThan(Date.now());
    expect((await req("PATCH", `/api/devices/${device.id}`, { name: "desk-pc", deny: ["bank.com"] })).json()).toMatchObject({ name: "desk-pc", deny: ["bank.com"] });
    expect((await req("PATCH", `/api/devices/${device.id}`, { bogus: 1 })).statusCode).toBe(400);
    expect((await req("POST", `/api/devices/${device.id}/code`)).json().code).not.toBe(code);
    expect((await req("DELETE", `/api/devices/${device.id}/code`)).statusCode).toBe(204);
    st = (await req("GET", "/api/live")).json();
    expect(st.devices[0].pendingCode).toBeNull();
    expect((await req("POST", `/api/devices/${device.id}/revoke`)).statusCode).toBe(200);
    expect((await req("PUT", "/api/live/deny", { domains: ["Mail.Example.com"] })).json()).toEqual({ domains: ["mail.example.com"] });
    expect((await req("DELETE", `/api/devices/${device.id}`)).statusCode).toBe(204);
    expect((await req("DELETE", `/api/devices/${device.id}`)).statusCode).toBe(404);
    expect((await req("POST", `/api/devices/${device.id}/code`)).statusCode).toBe(404);
    await h.app.close();
  });
});
