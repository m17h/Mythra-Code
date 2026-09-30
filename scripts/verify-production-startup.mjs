import { resolve } from 'node:path';
import { preview } from 'vite';
import { chromium, webkit } from 'playwright';

// Exercise the actual emitted modules, not Vite's development transforms or
// Vitest component fixtures. Native IPC is absent in this isolated browser;
// the app's existing browser fallback still renders the shell and Settings.
const engine = process.env.MYTHRA_BROWSER_TEST_ENGINE ?? 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error(`Unsupported browser: ${engine}`);
const server = await preview({
  configFile: false,
  root: resolve(import.meta.dirname, '..'),
  build: { outDir: resolve(process.env.MYTHRA_STARTUP_DIST ?? 'dist') },
  preview: { host: '127.0.0.1', port: 0, open: false },
});
let browser;
try {
  try {
    browser = await ({ chromium, webkit }[engine]).launch({ timeout: 30_000 });
  } catch (error) {
    throw new Error(`Production startup check could not launch ${engine}. Run "npx playwright install ${engine}" on this build machine.\n${error.message}`, { cause: error });
  }
  const context = await browser.newContext();
  // Synthetic browser-only storage; never load the user's native app profile.
  await context.addInitScript(() => localStorage.setItem('kiwi.settings', '{}'));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.stack ?? error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && /\.(?:js|css)(?:\?|$)/.test(response.url())) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (['script', 'stylesheet'].includes(request.resourceType())) {
      failures.push(`${request.failure()?.errorText}: ${request.url()}`);
    }
  });
  try {
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.locator('#root > .app-shell').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.getByRole('button', { name: /^Settings Default provider:/ }).click();
    await page.locator('[role="dialog"][aria-labelledby="settings-title"]').waitFor({ state: 'visible' });
    await page.reload({ waitUntil: 'load' });
    await page.locator('#root > .app-shell').waitFor({ state: 'visible' });
    if (failures.length) throw new Error('Production renderer reported errors.');
    console.log(`Production startup, lazy Settings, and reload passed (${engine}).`);
  } catch (error) {
    throw new Error(`${error.message}\n${failures.join('\n')}`, { cause: error });
  }
} finally {
  try { await browser?.close(); }
  finally { await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve())); }
}
