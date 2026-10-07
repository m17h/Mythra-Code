// Deliberately independent of application builds, Vitest, CI and release gates.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  resolve: {
    // Production React normally disables Profiler callbacks. Both variants use
    // the same minified profiling renderer; this is disclosed in every report.
    alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }],
  },
  build: { target: "es2022", minify: true, sourcemap: false, outDir: resolve(".test-artifacts/isolated-performance-build"), emptyOutDir: true },
});
