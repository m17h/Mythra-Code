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
  // The real-App header spec (App.header.browser.test.tsx) imports the whole
  // App, which pulls in these too; pre-bundle them so the first run is stable.
  optimizeDeps: { include: ["@tauri-apps/api/core", "@tauri-apps/api/webview", "@tauri-apps/plugin-notification", "@testing-library/user-event"] },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/test/browser-setup.ts"],
    restoreMocks: true,
    browser: {
      enabled: true,
      provider: playwright(),
      // The larger hosted WebKit suite stalled with concurrent file workers.
      // Keep every spec, but isolate WebKit files while retaining Chromium's
      // parallel run; this also bounds the scope of any browser-session stall.
      fileParallelism: process.env.MYTHRA_BROWSER_TEST_ENGINE !== "webkit",
      commands: {
        async setStreamTestReducedMotion({ page }, reduced: boolean) {
          await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
          // WebKit dispatches MediaQueryList changes on a later rendering step.
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        },
        async setForcedColors({ page }, active: boolean) {
          await page.emulateMedia({ forcedColors: active ? "active" : "none" });
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
