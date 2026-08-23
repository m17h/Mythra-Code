import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/**
 * Real-browser project, kept separate from the jsdom suite on purpose.
 *
 * The jsdom setup stubs `ResizeObserver` and has no layout engine, so it cannot
 * observe virtualized row geometry at all. These specs need genuine measurement,
 * so they run in Chromium and skip that setup file entirely.
 */
export default defineConfig({
  plugins: [react()],
  // ChatTimeline converts local image paths for sent attachment previews.
  // Pre-bundling the Tauri helper prevents Vite from reloading a live browser
  // spec the first time that lazy timeline chunk is imported.
  optimizeDeps: { include: ["@tauri-apps/api/core"] },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/test/browser-setup.ts"],
    restoreMocks: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      // The overlap this suite guards depends on real geometry, so the viewport
      // is pinned rather than left to the runner's default.
      viewport: { width: 1400, height: 900 },
      instances: [{ browser: "chromium" }],
    },
  },
});
