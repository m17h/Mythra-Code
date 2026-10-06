import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { assertContract, assertGate, assertTestReport, assertUnitInventory, assertReleaseVerification, expectedReceipts, lanes, selectVerificationArtifacts } from './verify-ci.mjs';

const sha = '1'.repeat(40);
const input = { checkout: sha, event: 'pull_request', head: '2'.repeat(40), base: '3'.repeat(40) };
const needs = () => Object.fromEntries(['native', 'unit', 'renderer', 'webkit'].map((name) => [name, { result: 'success' }]));
const browserFiles = ['src/fixture.browser.test.tsx'];
const unitFiles = ['scripts/fixture.test.mjs', 'src/fixture.test.ts'];
const performance = (target) => ({ schemaVersion: 1, budgetEvaluation: { passed: true }, environment: { buildProfile: `${target}-minified` } });
function receipts() {
  return expectedReceipts().map((id) => {
    const kind = id.split('-')[0];
    const steps = kind === 'webkit' ? ['build', 'verify:startup', 'test:webkit'] : lanes[kind];
    const receipt = { schemaVersion: 1, id, input: { ...input }, status: 'success', steps: steps.map((name) => ({ name, status: 'success' })) };
    if (kind === 'unit') {
      receipt.inventory = [...unitFiles];
      receipt.unit = { files: [unitFiles[Number(id.at(-1)) - 1]], tests: 5 };
    }
    if (kind === 'renderer' || kind === 'webkit') receipt.browser = { files: [...browserFiles], tests: 6 };
    if (kind === 'webkit') receipt.inventory = [...browserFiles];
    if (kind === 'renderer') {
      receipt.profiles = id.endsWith('Windows') ? ['safari13', 'chrome105'] : ['safari13'];
      receipt.performance = Object.fromEntries(receipt.profiles.map((target) => [target, performance(target)]));
    }
    return receipt;
  });
}

describe('complete verification gate', () => {
  test('accepts complete, matching evidence and reports the tested head/base/checkout', () => {
    expect(assertGate(needs(), receipts(), sha)).toEqual(input);
  });
  test.each(['failure', 'cancelled', 'skipped', 'timed_out', undefined])('rejects a non-successful matrix lane: %s', (status) => {
    const jobs = needs();
    jobs.unit.result = status;
    expect(() => assertGate(jobs, receipts(), sha)).toThrow(/did not succeed/);
  });
  test('rejects missing or unexpected dependencies', () => {
    const jobs = needs();
    delete jobs.native;
    expect(() => assertGate(jobs, receipts(), sha)).toThrow(/dependency set/);
    expect(() => assertGate({ ...needs(), extra: { result: 'success' } }, receipts(), sha)).toThrow(/dependency set/);
  });
  test('rejects missing and duplicate receipts even if all job statuses are green', () => {
    const reports = receipts();
    expect(() => assertGate(needs(), reports.slice(1), sha)).toThrow(/receipts/);
    reports.push(reports[0]);
    expect(() => assertGate(needs(), reports, sha)).toThrow(/receipts/);
  });
  test('rejects stale checkout, mismatched heads, absent base and failed receipt', () => {
    expect(() => assertGate(needs(), receipts(), '4'.repeat(40))).toThrow(/checkout/);
    let reports = receipts();
    reports[1].input.head = '5'.repeat(40);
    expect(() => assertGate(needs(), reports, sha)).toThrow(/mismatched/);
    reports = receipts();
    for (const r of reports) r.input.base = null;
    expect(() => assertGate(needs(), reports, sha)).toThrow(/head and base/);
    reports = receipts();
    reports[0].status = 'failed';
    expect(() => assertGate(needs(), reports, sha)).toThrow(/failed/);
  });
  test('rejects omitted native commands and incomplete renderer steps', () => {
    let reports = receipts();
    reports[0].steps.pop();
    expect(() => assertGate(needs(), reports, sha)).toThrow(/incomplete verification steps/);
    reports = receipts();
    reports.find((r) => r.id === 'renderer-Windows').steps[0].status = 'failed';
    expect(() => assertGate(needs(), reports, sha)).toThrow(/incomplete verification steps/);
  });
  test('rejects overlapping shards, omitted files, differing inventories and empty test runs', () => {
    const mutation = [
      (r) => { r.unit.files = [unitFiles[0]]; },
      (r) => { r.unit.files = []; },
      (r) => { r.inventory = ['other.test.ts']; },
      (r) => { r.unit.tests = 0; },
    ];
    for (const mutate of mutation) {
      const reports = receipts();
      mutate(reports.find((r) => r.id === 'unit-Windows-2'));
      expect(() => assertGate(needs(), reports, sha)).toThrow(/unit shards/);
    }
  });
  test('rejects missing Windows Chrome profile, empty reports and failed performance checks', () => {
    for (const mutate of [
      (r) => { r.profiles.pop(); },
      (r) => { delete r.performance.chrome105; },
      (r) => { r.performance.chrome105 = {}; },
      (r) => { r.performance.chrome105.budgetEvaluation.passed = false; },
      (r) => { r.performance.chrome105.environment.buildProfile = 'safari13-minified'; },
    ]) {
      const reports = receipts();
      mutate(reports.find((r) => r.id === 'renderer-Windows'));
      expect(() => assertGate(needs(), reports, sha)).toThrow(/profile|performance/);
    }
  });
  test('rejects omitted WebKit files and cross-engine browser coverage drift', () => {
    let reports = receipts();
    reports.find((r) => r.id === 'webkit-macOS').browser.files = [];
    expect(() => assertGate(needs(), reports, sha)).toThrow(/WebKit omitted/);
    reports = receipts();
    reports.find((r) => r.id === 'renderer-Windows').browser.files.push('src/extra.browser.test.tsx');
    expect(() => assertGate(needs(), reports, sha)).toThrow(/coverage differs/);
  });
});

test('local verification and distributed commands cover the same steps, without silently accepting new checks', () => {
  const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts;
  expect(() => assertContract(scripts)).not.toThrow();
  expect(() => assertContract({ ...scripts, verify: `${scripts.verify} && npm run extra` })).toThrow(/cover every/);
  expect(() => assertContract({ ...scripts, verify: scripts.verify.replace('npm run test:rust && ', '') })).toThrow(/cover every/);
  expect(() => assertContract({ ...scripts, check: 'npm run check' })).toThrow(/cycle/);
  expect(() => assertContract({ ...scripts, verify: `${scripts.verify} && echo ignored` })).toThrow(/Unrecognized/);
});

test('test report validation rejects empty, failed, incomplete and duplicate results', () => {
  const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 2, numPendingTests: 1,
    testResults: [{ name: resolve('src/fixture.test.ts'), status: 'passed' }] };
  expect(assertTestReport(report, 'fixture')).toEqual({ files: ['src/fixture.test.ts'], tests: 2, skipped: 1 });
  for (const update of [{ success: false }, { numFailedTests: 1 }, { numTotalTests: 0 }, { testResults: [] },
    { testResults: [{ ...report.testResults[0], status: 'failed' }] }, { testResults: [...report.testResults, ...report.testResults] }]) {
    expect(() => assertTestReport({ ...report, ...update }, 'fixture')).toThrow();
  }
});

test('unit discovery cannot silently drop tracked tests outside its configured globs', () => {
  expect(() => assertUnitInventory(['src/a.test.ts'], ['src/a.test.ts', 'src/a.browser.test.tsx', 'README.md'])).not.toThrow();
  expect(() => assertUnitInventory(['src/a.test.ts'], ['src/a.test.ts', 'other/new.spec.mjs'])).toThrow(/omitted tracked tests/);
});

test('release finalization requires the exact merged commit and every successful lane, not just a green workflow', () => {
  const run = { headSha: sha, status: 'completed', conclusion: 'success' };
  const jobs = ['WebKit (macOS 15)', 'Verify gate', ...['macos-latest', 'windows-latest'].flatMap((os) => [
    `Rust (${os})`, `Renderer (${os})`, `Unit (${os}, 1/2)`, `Unit (${os}, 2/2)`,
  ])].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  expect(() => assertReleaseVerification(run, jobs, sha)).not.toThrow();
  expect(() => assertReleaseVerification(run, jobs.slice(1), sha)).toThrow(/missing successful/);
  expect(() => assertReleaseVerification(run, jobs, '4'.repeat(40))).toThrow(/exact merged commit/);
  expect(() => assertReleaseVerification(run, jobs.map((job) => job.name === 'Verify gate' ? { ...job, conclusion: 'skipped' } : job), sha)).toThrow(/Verify gate/);
  expect(() => assertReleaseVerification(run, [...jobs, jobs[0]], sha)).toThrow(/missing successful/);
});

test('local diagnostic receipts cannot approve hosted merges', () => {
  const reports = receipts();
  for (const receipt of reports) receipt.input.event = 'local';
  expect(() => assertGate(needs(), reports, sha)).toThrow(/hosted workflow evidence/);
});


describe('immutable verification artifact selection', () => {
  const make = () => expectedReceipts().map((id, index) => ({ id: index + 100, name: id === 'webkit-macOS' ? 'verification-webkit' : `verification-${id}`,
    created_at: '2026-01-01T00:00:00Z', expired: false, digest: `sha256:${'a'.repeat(64)}`, workflow_run: { id: 123, head_sha: input.head } }));
  const identity = { runId: 123, head: input.head };
  test('selects newest attempt by chronology, preserves prior artifacts and ignores ID ordering', () => {
    const artifacts = make(), previous = artifacts.find((a) => a.name === 'verification-unit-Windows-1');
    const current = { ...previous, id: 1, created_at: '2026-01-01T00:01:00Z' };
    artifacts.push(current);
    expect(selectVerificationArtifacts(artifacts, identity)).toHaveLength(9);
    expect(selectVerificationArtifacts(artifacts, identity).find((a) => a.name === previous.name)).toBe(current);
    expect(artifacts).toContain(previous);
  });
  test('rejects missing lanes, unexpected lanes and ambiguous newest chronology', () => {
    const artifacts = make();
    expect(() => selectVerificationArtifacts(artifacts.slice(1), identity)).toThrow(/Missing/);
    expect(() => selectVerificationArtifacts([...artifacts, { ...artifacts[0], name: 'verification-unknown' }], identity)).toThrow(/unexpected/);
    expect(() => selectVerificationArtifacts([...artifacts, { ...artifacts[0], id: 999 }], identity)).toThrow(/ambiguous/);
  });
  test.each([
    { expired: true }, { workflow_run: { id: 999, head_sha: input.head } },
    { workflow_run: { id: 123, head_sha: '9'.repeat(40) } }, { digest: null }, { id: -1 }, { created_at: 'invalid' },
  ])('rejects invalid newest upload without falling back to old evidence: %j', (change) => {
    const artifacts = make();
    artifacts.push({ ...artifacts[0], id: 999, created_at: '2026-01-01T00:01:00Z', ...change });
    expect(() => selectVerificationArtifacts(artifacts, identity)).toThrow();
  });
  test('a newest failed receipt is still rejected by the complete gate', () => {
    const artifacts = make(), previous = artifacts.find((a) => a.name === 'verification-unit-Windows-1');
    const latest = { ...previous, id: 1, created_at: '2026-01-01T00:01:00Z' };
    artifacts.push(latest);
    expect(selectVerificationArtifacts(artifacts, identity)).toContain(latest);
    const reports = receipts(); reports.find((r) => r.id === 'unit-Windows-1').status = 'failed';
    expect(() => assertGate(needs(), reports, sha)).toThrow(/failed/);
  });
});
