import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, makeHub } from "./helpers.ts";

describe("extension downloads", () => {
  it("lists and serves only lbsv-ext packages, behind login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lbsv-pkg-"));
    try {
      writeFileSync(join(dir, "lbsv-ext-chromium-0.1.0.zip"), "PK-chromium");
      writeFileSync(join(dir, "lbsv-ext-firefox-0.1.0.zip"), "PK-firefox");
      writeFileSync(join(dir, "secrets.txt"), "nope");
      const h = await makeHub({ extPackagesDir: dir });
      const cookie = await login(h.app);
      const get = (url: string, c = cookie) => h.app.inject({ method: "GET", url, headers: c ? { cookie: c } : {} });
      expect((await get("/api/downloads", "")).statusCode).toBe(401);
      expect((await get("/api/downloads")).json().packages.map((p: { file: string }) => p.file).sort())
        .toEqual(["lbsv-ext-chromium-0.1.0.zip", "lbsv-ext-firefox-0.1.0.zip"]);
      const dl = await get("/api/downloads/lbsv-ext-chromium-0.1.0.zip");
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-type"]).toBe("application/zip");
      expect(dl.body).toBe("PK-chromium");
      expect((await get("/api/downloads/secrets.txt")).statusCode).toBe(404);
      expect((await get("/api/downloads/..%2Fsecrets.txt")).statusCode).toBe(404);
      expect((await get("/api/downloads/lbsv-ext-chromium-0.1.0.zip", "")).statusCode).toBe(401);
      await h.app.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("one-line agent installers (M5)", () => {
  it("are public, name the hub the client reached (or LBSV_PUBLIC_URL), and serve the agent bundle", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeHub } = await import("./helpers.ts");
    const dir = mkdtempSync(join(tmpdir(), "lbsv-pk-"));
    const hub = await makeHub({ extPackagesDir: dir });
    const sh = await hub.app.inject({ method: "GET", url: "/install/agent.sh", headers: { host: "hub.lan:11444" } });
    expect(sh.statusCode).toBe(200);
    expect(sh.body).toContain("HUB='http://hub.lan:11444'");
    expect(sh.body).toContain('install --hub "$HUB" --code "$CODE"');
    const ps = await hub.app.inject({ method: "GET", url: "/install/agent.ps1", headers: { host: "hub.lan:11444" } });
    expect(ps.body).toContain("$Hub = 'http://hub.lan:11444'");
    expect((await hub.app.inject({ method: "GET", url: "/install/lbsv-agent.mjs" })).statusCode).toBe(404);
    writeFileSync(join(dir, "lbsv-agent.mjs"), "#!/usr/bin/env node\n// bundle");
    const mjs = await hub.app.inject({ method: "GET", url: "/install/lbsv-agent.mjs" });
    expect(mjs.statusCode).toBe(200);
    expect(mjs.body).toContain("// bundle");
    expect(mjs.headers["x-lbsv-version"]).toBeUndefined();
    writeFileSync(join(dir, "lbsv-agent-0.9.0.zip"), "z"); writeFileSync(join(dir, "lbsv-agent-0.10.0.zip"), "z");
    expect((await hub.app.inject({ method: "GET", url: "/install/lbsv-agent.mjs" })).headers["x-lbsv-version"]).toBe("0.10.0");
    const pub = await makeHub({ extPackagesDir: dir, publicUrl: "https://lbsv.example.net/" });
    expect((await pub.app.inject({ method: "GET", url: "/install/agent.sh" })).body).toContain("HUB='https://lbsv.example.net'");
    // A hostile Host header can't break out of the quoted string.
    const evil = await hub.app.inject({ method: "GET", url: "/install/agent.sh", headers: { host: "x';rm -rf ~;'" } });
    expect(evil.body).not.toMatch(/HUB='http:\/\/x';rm/);
  });
});
