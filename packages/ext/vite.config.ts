import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));
const out = fileURLToPath(new URL("./dist/build", import.meta.url));

// Bundles the background worker and the options page. scripts/build-ext.ts then copies the
// output into dist/chromium and dist/firefox, each with its own manifest.json.
export default defineConfig({
  root: src,
  base: "./",
  publicDir: false,
  build: {
    outDir: out,
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    minify: false, // reviewable extension code (and AMO prefers readable sources)
    rolldownOptions: {
      input: { background: `${src}/background.ts`, options: `${src}/options.html` },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});
