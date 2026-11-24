import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyData, legacyEnvUsed, loadConfig } from "../src/config.ts";

describe("rename to lbsv: compatibility", () => {
  it("LBSV_* wins; pre-rename SB_* still works and is reported", () => {
    const c = loadConfig({ LBSV_PORT: "9001", SB_PORT: "9002", SB_ADMIN_PASSPHRASE: "old-name-pass", SB_DATA_DIR: "/tmp/x" });
    expect(c.port).toBe(9001);
    expect(c.adminPassphrase).toBe("old-name-pass");
    expect(legacyEnvUsed).toContain("SB_ADMIN_PASSPHRASE");
    expect(legacyEnvUsed).not.toContain("SB_PORT");
  });

  it("adopts a Switchboard database (and its WAL/SHM) once, never overwriting lbsv.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "lbsv-cfg-"));
    try {
      writeFileSync(join(dir, "switchboard.db"), "old");
      writeFileSync(join(dir, "switchboard.db-wal"), "wal");
      const cfg = loadConfig({ LBSV_DATA_DIR: dir });
      expect(adoptLegacyData(cfg)).toBe(join(dir, "switchboard.db"));
      expect(readFileSync(join(dir, "lbsv.db"), "utf8")).toBe("old");
      expect(readFileSync(join(dir, "lbsv.db-wal"), "utf8")).toBe("wal");
      expect(existsSync(join(dir, "switchboard.db"))).toBe(false);
      writeFileSync(join(dir, "switchboard.db"), "stray");
      expect(adoptLegacyData(cfg)).toBeNull(); // lbsv.db exists: leave everything alone
      expect(readFileSync(join(dir, "lbsv.db"), "utf8")).toBe("old");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
