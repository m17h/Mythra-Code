import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// This file runs under Node, but the project deliberately avoids depending on
// @types/node; declare the one Node global the config reads.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
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
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
