import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, readdirSync } from 'node:fs';

// Each child owns a process group so a browser deadlock cannot consume the
// entire CI job or leave its WebKit processes running into the next shard.
mkdirSync('.test-artifacts', { recursive: true });
const log = createWriteStream('.test-artifacts/webkit.log');
function write(chunk) { process.stdout.write(chunk); log.write(chunk); }
async function run(args, timeout) {
  write(`\nRunning ${args.join(' ')}\n`);
  const child = spawn(process.execPath, args, {
    detached: process.platform !== 'win32',
    env: { ...process.env, MYTHRA_BROWSER_TEST_ENGINE: 'webkit', DEBUG: 'pw:browser' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('exit', () => {
    // Release pipes inherited by browser descendants before awaiting close.
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
  });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    write(`\nBrowser check exceeded ${timeout / 1000}s; terminating its process group.\n`);
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }, timeout);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 && !expired ? resolve() : reject(new Error(`Browser check failed (${expired ? 'timeout' : signal ?? code}). See .test-artifacts/webkit.log.`)));
    });
  } finally {
    clearTimeout(timer);
    // A failed test runner may exit while browser descendants retain its
    // pipes. Clean up the owned group even when the parent already exited.
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
  }
}

try {
  // Diagnose browser startup independently from React, Vitest and app code.
  await run(['--input-type=module', '-e', `
    import { webkit } from 'playwright';
    const browser = await webkit.launch();
    try {
      console.log('WebKit launched:', browser.version());
      const page = await browser.newPage();
      await page.setContent('<button>Browser ready</button>');
      await page.getByRole('button', { name: 'Browser ready' }).click();
      console.log('WebKit blank-page check passed');
    } finally { await browser.close(); }
  `], 45_000);
  const files = readdirSync('src', { recursive: true }).filter((file) => /\.browser\.test\.tsx?$/.test(file));
  if (!files.length) throw new Error('No browser specs were found.');
  const shards = Math.ceil(files.length / 3);
  const failures = [];
  for (let shard = 1; shard <= shards; shard++) {
    try {
      await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.config.ts', '--shard', `${shard}/${shards}`], 180_000);
    } catch (error) {
      // Collect assertion failures across the complete suite in one CI run.
      // A hung browser still fails promptly instead of spending the job budget.
      if (String(error).includes('(timeout)')) throw error;
      failures.push(error);
      write(`WebKit shard ${shard}/${shards} failed: ${error.message}\n`);
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} WebKit shard(s) failed.`);
} catch (error) {
  write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally { log.end(); }
