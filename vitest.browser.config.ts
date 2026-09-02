import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

declare const process: { env: Record<string, string | undefined> };

/**
 * Real-browser project, kept separate from the jsdom suite on purpose.
 *
 * The jsdom setup stubs `ResizeObserver` and has no layout engine, so it cannot
 * observe virtualized row geometry at all. These specs need genuine measurement,
 * so they run in Chromium by default and skip that setup file entirely.
 * MYTHRA_BROWSER_TEST_ENGINE=webkit exercises the macOS engine as well.
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
      commands: {
        async setStreamTestReducedMotion({ page }, reduced: boolean) {
          await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
          // WebKit dispatches MediaQueryList changes on a later rendering step.
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        },
      },
      headless: true,
      screenshotFailures: false,
      // The overlap this suite guards depends on real geometry, so the viewport
      // is pinned rather than left to the runner's default.
      viewport: { width: 1400, height: 900 },
      instances: [{ browser: process.env.MYTHRA_BROWSER_TEST_ENGINE === "webkit" ? "webkit" : "chromium" }],
    },
  },
});
