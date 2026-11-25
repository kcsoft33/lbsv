import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // shared CI runners get 5× wall-clock budgets (see packages/hub/test/helpers.ts `budget`), so the per-test cap too
    testTimeout: process.env.CI ? 60_000 : 5_000,
  },
});
