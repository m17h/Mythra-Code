import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '.test-artifacts');
export const unitShards = 2;
export const lanes = {
  native: ['lint:rust', 'check:rust', 'test:rust'],
  unit: ['test:run'],
  renderer: ['verify:release-config', 'lint', 'check:types', 'test:browser', 'build', 'verify:startup', 'verify:performance'],
};
const shaPattern = /^[a-f0-9]{40}$/;
const fail = (message) => { throw new Error(message); };
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sorted = (values) => [...values].sort();
const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const relativeFile = (path) => relative(root, path).replaceAll('\\', '/');

export function assertContract(scripts) {
  const expand = (name, seen = []) => {
    if (seen.includes(name)) fail(`Verification script cycle: ${name}`);
    if (name === 'verify:ci') return [];
    if (name !== 'verify' && name !== 'check') return [name];
    return String(scripts[name]).split(' && ').flatMap((command) => {
      const match = /^npm run ([\w:-]+)$/.exec(command);
      if (!match) fail(`Unrecognized verification command: ${command}`);
      return expand(match[1], [...seen, name]);
    });
  };
  const expected = expand('verify');
  const actual = Object.values(lanes).flat();
  if (!equal(expected, actual) || new Set(actual).size !== actual.length) {
    fail('CI lanes must cover every npm run verify step exactly once. Update the lane contract with the local script.');
  }
  for (const name of actual) if (!scripts[name]) fail(`Missing verification script: ${name}`);
}

export function assertTestReport(report, label) {
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0
    || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1
    || !Array.isArray(report.testResults) || !report.testResults.length) fail(`${label}: missing or failed test results`);
  const files = report.testResults.map((result) => {
    if (result.status !== 'passed' || typeof result.name !== 'string') fail(`${label}: incomplete test file`);
    return relativeFile(result.name);
  });
  if (new Set(files).size !== files.length) fail(`${label}: duplicate test files`);
  return { files: sorted(files), tests: report.numTotalTests, skipped: report.numPendingTests };
}

export function expectedReceipts() {
  return ['macOS', 'Windows'].flatMap((os) => [
    `native-${os}`, `renderer-${os}`,
    ...Array.from({ length: unitShards }, (_, index) => `unit-${os}-${index + 1}`),
  ]).concat('webkit-macOS');
}

export function selectVerificationArtifacts(artifacts, { runId, head }) {
  if (!Number.isSafeInteger(runId) || runId < 1 || !shaPattern.test(head)) fail('Artifact selection requires exact workflow identity');
  const names = expectedReceipts().map((id) => id === 'webkit-macOS' ? 'verification-webkit' : `verification-${id}`);
  const relevant = artifacts.filter((a) => a.name?.startsWith('verification-'));
  if (!equal([...new Set(relevant.map((a) => a.name))], names)) fail('Missing or unexpected verification artifacts');
  return names.map((name) => {
    const candidates = relevant.filter((a) => a.name === name).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (candidates.some((a) => !Number.isFinite(Date.parse(a.created_at)))
      || (candidates[1] && Date.parse(candidates[0].created_at) === Date.parse(candidates[1].created_at))) fail(`${name}: ambiguous artifact chronology`);
    const latest = candidates[0];
    // Never fall back to an earlier success when the newest attempt is invalid.
    if (!Number.isSafeInteger(latest.id) || latest.id < 1 || latest.expired !== false
      || latest.workflow_run?.id !== runId || latest.workflow_run?.head_sha !== head
      || !/^sha256:[a-f0-9]{64}$/.test(latest.digest ?? '')) fail(`${name}: invalid latest artifact identity`);
    return latest;
  });
}

export function assertUnitInventory(inventory, trackedFiles) {
  const trackedTests = trackedFiles.filter((file) => /\.(?:test|spec)\.(?:tsx?|jsx?|mjs)$/.test(file) && !file.includes('.browser.test.'));
  const omitted = trackedTests.filter((file) => !inventory.includes(file));
  if (omitted.length) fail(`Unit discovery omitted tracked tests: ${omitted.join(', ')}`);
}

export function assertReleaseVerification(run, jobs, expectedSha) {
  if (run.headSha !== expectedSha || run.status !== 'completed' || run.conclusion !== 'success') fail('Release CI must succeed on the exact merged commit');
  const expected = ['WebKit (macOS 15)', 'Verify gate', ...['macos-latest', 'windows-latest'].flatMap((os) => [
    `Rust (${os})`, `Renderer (${os})`, ...Array.from({ length: unitShards }, (_, i) => `Unit (${os}, ${i + 1}/${unitShards})`),
  ])];
  for (const name of expected) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') fail(`Release CI is missing successful ${name}`);
  }
}

export function assertGate(needs, receipts, expectedSha) {
  if (!shaPattern.test(expectedSha ?? '')) fail('Gate requires the exact tested checkout SHA');
  const jobs = ['native', 'unit', 'renderer', 'webkit'];
  if (!equal(Object.keys(needs), jobs)) fail('Gate dependency set is incomplete or unexpected');
  for (const job of jobs) if (needs[job]?.result !== 'success') fail(`Required job ${job} did not succeed`);
  const expected = expectedReceipts();
  if (!equal(receipts.map((r) => r.id), expected)) fail('Missing, duplicate, or unexpected verification receipts');
  const reference = receipts[0]?.input;
  if (!reference || reference.checkout !== expectedSha) fail('Receipt checkout does not match the workflow commit');
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(reference.event)) fail('Gate requires hosted workflow evidence, not local receipts');
  for (const receipt of receipts) {
    if (receipt.schemaVersion !== 1 || receipt.status !== 'success'
      || JSON.stringify(receipt.input) !== JSON.stringify(reference)) fail(`${receipt.id}: failed or mismatched verification input`);
    if (reference.event === 'pull_request' && (!shaPattern.test(reference.head ?? '') || !shaPattern.test(reference.base ?? ''))) {
      fail('Pull-request receipts must record both head and base');
    }
    const kind = receipt.id.split('-')[0];
    const required = kind === 'webkit' ? ['build', 'verify:startup', 'test:webkit'] : lanes[kind];
    if (!Array.isArray(receipt.steps) || !equal(receipt.steps.map((s) => s.name), required)
      || receipt.steps.some((s) => s.status !== 'success')) fail(`${receipt.id}: incomplete verification steps`);
    if (kind === 'renderer') {
      const targets = receipt.id.endsWith('Windows') ? ['safari13', 'chrome105'] : ['safari13'];
      if (!equal(receipt.profiles ?? [], targets) || !equal(Object.keys(receipt.performance ?? {}), targets)) {
        fail(`${receipt.id}: missing build/startup/performance profile`);
      }
      for (const target of targets) if (receipt.performance[target]?.schemaVersion !== 1
        || receipt.performance[target]?.budgetEvaluation?.passed !== true
        || receipt.performance[target]?.environment?.buildProfile !== `${target}-minified`) {
        fail(`${receipt.id}: missing performance report`);
      }
      if (!receipt.browser?.files?.length || receipt.browser.tests < 1) fail(`${receipt.id}: missing browser results`);
    }
  }
  for (const os of ['macOS', 'Windows']) {
    const shards = receipts.filter((r) => r.id.startsWith(`unit-${os}-`));
    const all = shards[0]?.inventory;
    if (!all?.length || new Set(all).size !== all.length) fail(`${os}: missing unit-test inventory`);
    const executed = shards.flatMap((r) => r.unit?.files ?? []);
    if (new Set(executed).size !== executed.length || !equal(executed, all)
      || shards.some((r) => !equal(r.inventory ?? [], all) || !(r.unit?.tests > 0))) {
      fail(`${os}: unit shards omitted or duplicated test files`);
    }
  }
  const webkit = receipts.find((r) => r.id === 'webkit-macOS');
  if (!webkit.inventory?.length || !equal(webkit.browser?.files ?? [], webkit.inventory)) fail('WebKit omitted browser test files');
  for (const os of ['macOS', 'Windows']) {
    const renderer = receipts.find((r) => r.id === `renderer-${os}`);
    if (!equal(renderer.browser.files, webkit.inventory)) fail(`${os}: Chromium browser coverage differs from WebKit`);
  }
  return reference;
}

function command(program, args, env = process.env) {
  // npm.cmd needs a shell, which splits paths containing spaces. Node's bundled
  // npm CLI preserves argument boundaries on Windows without invoking cmd.exe.
  if (program === 'npm' && process.platform === 'win32') {
    const cli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!existsSync(cli)) fail('Cannot locate the bundled npm CLI');
    program = process.execPath;
    args = [cli, ...args];
  }
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveCommand() : reject(new Error(`${program} ${args.join(' ')} failed (${signal ?? code})`)));
  });
}

async function runLane(kind, shard) {
  const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : fail('CI lanes require macOS or Windows');
  if (kind === 'webkit' && os !== 'macOS') fail('WebKit must run on macOS');
  if (!lanes[kind] && kind !== 'webkit') fail(`Unknown CI lane: ${kind}`);
  if (kind === 'unit' && !['1/2', '2/2'].includes(shard)) fail('Unit lane requires shard 1/2 or 2/2');
  mkdirSync(artifacts, { recursive: true });
  const id = `${kind}-${os}${kind === 'unit' ? `-${shard[0]}` : ''}`;
  const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : {};
  const receipt = {
    schemaVersion: 1, id, status: 'failed', steps: [],
    input: { checkout: process.env.GITHUB_SHA, event: process.env.GITHUB_EVENT_NAME ?? 'local',
      head: event.pull_request?.head?.sha ?? process.env.GITHUB_SHA, base: event.pull_request?.base?.sha ?? null },
  };
  // Refuse a stale/different checkout even if all commands happen to pass.
  const { execFileSync } = await import('node:child_process');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== receipt.input.checkout) fail('Checkout differs from GITHUB_SHA');
  const env = { ...process.env, ...(kind === 'webkit' ? { MYTHRA_BROWSER_TEST_ENGINE: 'webkit' } : {}) };
  delete env.TAURI_ENV_PLATFORM;
  if (kind !== 'webkit') env.MYTHRA_BROWSER_TEST_ENGINE = 'chromium';
  const step = async (name, work) => {
    const started = Date.now();
    const entry = { name, status: 'failed', durationMs: 0 };
    receipt.steps.push(entry);
    try { await work(); entry.status = 'success'; } finally { entry.durationMs = Date.now() - started; }
  };
  const npm = (name, args = [], overrides = {}) => command('npm', ['run', name, ...(args.length ? ['--', ...args] : [])], { ...env, ...overrides });
  const vitest = (args) => command(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), ...args], env);
  try {
    assertContract(readJson(resolve(root, 'package.json')).scripts);
    if (kind === 'unit') {
      const inventoryPath = resolve(artifacts, `inventory-${id}.json`);
      await vitest(['list', '--filesOnly', '--json', inventoryPath]);
      receipt.inventory = sorted(readJson(inventoryPath).map((r) => relativeFile(r.file)));
      assertUnitInventory(receipt.inventory, execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/));
      const reportPath = resolve(artifacts, `tests-${id}.json`);
      await step('test:run', () => npm('test:run', ['--shard', shard, '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`]));
      receipt.unit = assertTestReport(readJson(reportPath), id);
    } else if (kind === 'renderer') {
      receipt.performance = {};
      receipt.profiles = [];
      for (const name of lanes.renderer) {
        await step(name, async () => {
          if (name === 'test:browser') {
            const path = resolve(artifacts, `tests-${id}.json`);
            await npm(name, ['--reporter=default', '--reporter=json', `--outputFile=${path}`]);
            receipt.browser = assertTestReport(readJson(path), id);
          } else await npm(name);
        });
      }
      receipt.profiles.push('safari13');
      receipt.performance.safari13 = readJson(resolve(root, 'dist/performance-scorecard.json'));
      if (os === 'Windows') {
        const started = Date.now();
        for (const name of ['build', 'verify:startup', 'verify:performance']) await npm(name, [], { TAURI_ENV_PLATFORM: 'windows' });
        receipt.windowsProfileMs = Date.now() - started;
        receipt.profiles.push('chrome105');
        receipt.performance.chrome105 = readJson(resolve(root, 'dist/performance-scorecard.json'));
      }
    } else if (kind === 'webkit') {
      receipt.inventory = sorted(readdirSync(resolve(root, 'src'), { recursive: true })
        .filter((f) => /\.browser\.test\.tsx?$/.test(f)).map((f) => `src/${f.replaceAll('\\', '/')}`));
      await step('build', () => npm('build'));
      await step('verify:startup', () => npm('verify:startup'));
      await step('test:webkit', () => command(process.execPath, ['scripts/verify-webkit.mjs'], env));
      const reports = readdirSync(artifacts).filter((f) => /^webkit-tests-\d+\.json$/.test(f))
        .map((f) => assertTestReport(readJson(resolve(artifacts, f)), f));
      const files = reports.flatMap((r) => r.files);
      if (new Set(files).size !== files.length) fail('WebKit duplicate test files');
      receipt.browser = { files: sorted(files), tests: reports.reduce((sum, r) => sum + r.tests, 0) };
    } else {
      for (const name of lanes.native) await step(name, () => npm(name));
    }
    receipt.status = 'success';
  } finally {
    writeFileSync(resolve(artifacts, `receipt-${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

async function main(args) {
  const [mode, shard] = args;
  if (mode === 'contract') {
    assertContract(readJson(resolve(root, 'package.json')).scripts);
    console.log('Local and hosted verification commands have complete coverage parity.');
  } else if (mode === 'artifact-ids') {
    const { execFileSync } = await import('node:child_process');
    const runId = Number(process.env.GITHUB_RUN_ID);
    const event = readJson(process.env.GITHUB_EVENT_PATH);
    const head = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
    const response = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`], { encoding: 'utf8' }));
    const selected = selectVerificationArtifacts(response.flatMap((page) => page.artifacts), { runId, head });
    writeFileSync(process.env.GITHUB_OUTPUT, `ids=${selected.map((a) => a.id).join(',')}\n`, { flag: 'a' });
    console.log(JSON.stringify(selected.map(({ id, name, digest, created_at }) => ({ id, name, digest, created_at }))));
  } else if (mode === 'gate') {
    assertContract(readJson(resolve(root, 'package.json')).scripts);
    const receipts = readdirSync(artifacts).filter((f) => /^receipt-.*\.json$/.test(f)).map((f) => readJson(resolve(artifacts, f)));
    const input = assertGate(JSON.parse(process.env.VERIFY_NEEDS ?? '{}'), receipts, process.env.GITHUB_SHA);
    const output = `Verification passed for checkout ${input.checkout}; head ${input.head}; base ${input.base ?? 'not applicable'}.\n\n`
      + '| Lane | Check execution | Tests |\n| --- | ---: | ---: |\n'
      + receipts.map((r) => `| ${r.id} | ${((r.steps.reduce((n, s) => n + s.durationMs, 0) + (r.windowsProfileMs ?? 0)) / 1000).toFixed(1)}s | ${r.unit?.tests ?? r.browser?.tests ?? 'native suite'} |`).join('\n')
      + '\n\nExecution excludes runner setup/queue/cache transfer; compare those in the Actions job timings.\n';
    console.log(output);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, output, { flag: 'a' });
  } else await runLane(mode, shard);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
