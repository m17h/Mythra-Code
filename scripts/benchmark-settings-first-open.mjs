// Run a production web preview on 127.0.0.1:1421 first. This uses disposable
// browser profiles and blocks external requests; no account or native IPC.
import { chromium, webkit } from "playwright";

const settleMs = Number(process.argv[2] ?? 3000);
if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > 60_000) throw new Error("Expected a launch-settle delay from 0 to 60000 ms");
const results = [];
for (const [engine, driver] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await driver.launch();
  try {
    for (let sample = 0; sample < 5; sample++) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:1421/") ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "claude", model: "haiku", theme: "mythra" })));
      await page.goto("http://127.0.0.1:1421/");
      await page.locator(".sidebar-settings").waitFor();
      await page.waitForTimeout(settleMs);
      const preloaded = await page.evaluate(() => performance.getEntriesByType("resource").some(r => /\/SettingsModal-.*\.js/.test(r.name)));
      const measure = () => page.evaluate(() => new Promise((resolve, reject) => {
        const start = performance.now(); let commitMs = null;
        document.querySelector(".sidebar-settings").click(); // no implicit hover preload
        const frame = () => {
          const modal = document.querySelector(".settings-backdrop.open");
          if (modal) commitMs ??= performance.now() - start;
          if (modal && Number(getComputedStyle(modal).opacity) > 0) resolve({ commitMs, visibleMs: performance.now() - start });
          else if (performance.now() - start > 10_000) reject(new Error("Settings did not become visible"));
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      const first = await measure();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForTimeout(350);
      const second = await measure();
      results.push({ engine, sample, settleMs, preloaded, first, second });
      await page.close();
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify(results, null, 2));
