import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// This file runs under Node, but the project deliberately avoids depending on
// @types/node; declare the one Node global the config reads.
declare const process: { env: Record<string, string | undefined> };

const buildTarget = process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13";
const debugBuild = process.env.TAURI_ENV_DEBUG === "true" || process.env.TAURI_ENV_DEBUG === "1";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "mythra-performance-build-metadata",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: ".vite/performance-build.json",
          source: JSON.stringify({ schemaVersion: 1, target: buildTarget, minified: !debugBuild }),
        });
      },
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    // Real-browser layout specs need genuine measurement, which jsdom cannot
    // provide. They run under vitest.browser.config.ts instead.
    exclude: [...configDefaults.exclude, "src/**/*.browser.test.{ts,tsx}"],
    // Timer-heavy virtual-scroll tests can starve under Vitest's default
    // one-worker-per-core fan-out and then contaminate later fake-timer tests.
    maxWorkers: 2,
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: buildTarget,
    manifest: true,
    minify: !debugBuild,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{
            name: "shared",
            minShareCount: 2,
            includeDependenciesRecursively: false,
          }],
        },
      },
    },
    sourcemap: debugBuild,
  },
});
