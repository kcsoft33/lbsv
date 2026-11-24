import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const hub = process.env.LBSV_DEV_HUB || "http://127.0.0.1:8080";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5173,
    // LBSV_DEV_HOST=0.0.0.0 exposes the dev server on the LAN (e.g. behind HAProxy). Vite then only
    // answers for the host names listed here (DNS-rebinding protection).
    host: process.env.LBSV_DEV_HOST || "localhost",
    allowedHosts: (process.env.LBSV_DEV_ALLOWED_HOSTS || "localhost").split(",").map((h) => h.trim()).filter(Boolean),
    proxy: {
      "/api": hub,
      "/ws": { target: hub.replace(/^http/, "ws"), ws: true },
      // Collectors may pair against the dev server's address too.
      "/collect": { target: hub.replace(/^http/, "ws"), ws: true },
      // MCP clients (M4) too.
      "/mcp": hub,
      // keep the Host header: the installers bake in the address the client used
      "/install": { target: hub, changeOrigin: false },
    },
  },
});
