import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, fileHash } from './release-state.mjs';
import { assertQaSourceSupport, validateNativeResult } from './release-native-check.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'mythra-native-result-test-')); roots.push(root);
  mkdirSync(resolve(root, 'candidate')); writeFileSync(resolve(root, 'candidate/app'), 'fixture executable');
  atomicJson(resolve(root, 'capability.json'), { tool: 'cua', inventory: ['fixture-window'] });
  atomicJson(resolve(root, 'accessibility.json'), { role: 'window', title: 'fixture' });
  // Schema fixtures, never represented as real pixels/native verification.
  writeFileSync(resolve(root, 'screen.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
  const profileId = randomUUID(), runId = randomUUID(), pid = 4321;
  atomicJson(resolve(root, 'accessibility.json'), { role: 'window', title: `Mythra Code — Release QA ${profileId}` });
  const events = ['profile-open', 'window-constructed', 'renderer-storage', 'render-ready', 'close-finish', 'exit'].map((kind) => ({ schemaVersion: 1, profileId, pid, runId, kind,
    details: kind === 'profile-open' ? { contractVersion: 1, providers: 'blocked', persistentWebview: true }
      : kind === 'renderer-storage' ? { current: profileId, previous: null }
        : kind === 'close-finish' ? { accepted: true, result: 'saved' } : {} }));
  writeFileSync(resolve(root, 'native-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  const contract = { version: '1.2.3', executableSha256: fileHash(resolve(root, 'candidate/app')), profile: { profileId }, checks: [{ id: 'native-startup:darwin-aarch64', observations: ['visible-native-shell'] }] };
  const result = { status: 'passed', reason: '', capability: { verified: true, tool: 'cua', evidence: 'capability.json' }, cleanupComplete: true, restorationComplete: true,
    results: [{ checkId: contract.checks[0].id, executablePath: resolve(root, 'candidate/app'), executableSha256: contract.executableSha256, pid, processStart: 'fixture-start', runId, windowIdentity: `Mythra Code — Release QA ${profileId}`, version: contract.version,
      observations: [{ id: 'visible-native-shell', evidence: 'screen.png' }], evidence: ['screen.png', 'accessibility.json', 'native-events.jsonl'].map((path) => ({ path, sha256: fileHash(resolve(root, path)) })) }] };
  return { root, result, contract, events };
}
function persistEvents(root, result, events) {
  writeFileSync(resolve(root, 'native-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  result.results[0].evidence.find((e) => e.path === 'native-events.jsonl').sha256 = fileHash(resolve(root, 'native-events.jsonl'));
}
test.each(['renderer-storage', 'render-ready', 'close-finish'])('native acceptance requires primary-run %s proof', (kind) => {
  const { root, result, contract, events } = fixture();
  persistEvents(root, result, events.filter((e) => e.kind !== kind));
  expect(() => validateNativeResult(result, contract, root)).toThrow();
});
test.each(['render-failed', 'setup-failed', 'renderer-storage-failed', 'control-rejected'])('reported pass cannot override native %s', (kind) => {
  const { root, result, contract, events } = fixture();
  events.push({ ...events[0], kind, details: {} }); persistEvents(root, result, events);
  expect(() => validateNativeResult(result, contract, root)).toThrow();
});
test.each(['failed', 'cancel'])('close result %s cannot substitute for saved close', (value) => {
  const { root, result, contract, events } = fixture();
  events.find((e) => e.kind === 'close-finish').details.result = value; persistEvents(root, result, events);
  expect(() => validateNativeResult(result, contract, root)).toThrow();
});
test('another launch cannot supply missing healthy render evidence', () => {
  const { root, result, contract, events } = fixture();
  events.find((e) => e.kind === 'render-ready').runId = randomUUID(); persistEvents(root, result, events);
  expect(() => validateNativeResult(result, contract, root)).toThrow();
});
test('foreign-profile failures do not contaminate this profile', () => {
  const { root, result, contract, events } = fixture();
  events.push({ ...events[0], profileId: randomUUID(), kind: 'render-failed' }); persistEvents(root, result, events);
  expect(validateNativeResult(result, contract, root)).toBe(result);
});
test('unsupported failed secondary launches cannot be passed as a maintained negative case', () => {
  const { root, result, contract, events } = fixture();
  events.push({ ...events[0], pid: 4322, runId: randomUUID(), kind: 'setup-failed' }); persistEvents(root, result, events);
  expect(() => validateNativeResult(result, contract, root)).toThrow();
});
test('typed native acceptance binds selected observations, package bytes and app launch identity', () => {
  const { root, result, contract } = fixture(); expect(validateNativeResult(result, contract, root)).toBe(result);
});
test('old or incompletely integrated source is rejected before any native worker launch', () => {
  const source = { 'src-tauri/src/release_qa.rs': 'pub(crate) const RELEASE_QA_CONTRACT_VERSION: u32 = 1; MYTHRA_RELEASE_QA_ROOT',
    'src-tauri/src/lib.rs': 'mod release_qa; release_qa::initialize(); release_qa::configure_context; release_qa::configure_window;',
    'docs/operations/native-release-qa.md': 'Maintained native fixture recipe' };
  const execute = (_command, args) => { const path = args[1].split(':').slice(1).join(':'); if (!source[path]) throw new Error('not in frozen commit'); return source[path]; };
  const input = { root: '.', plan: { commit: 'a'.repeat(40) }, execute };
  expect(assertQaSourceSupport(input).version).toBe(1);
  source['src-tauri/src/lib.rs'] = 'mod release_qa;'; expect(() => assertQaSourceSupport(input)).toThrow(/launch is forbidden/);
  delete source['src-tauri/src/release_qa.rs']; expect(() => assertQaSourceSupport(input)).toThrow(/refusing to launch/);
});
test('generic pass or missing capability/cleanup cannot satisfy native release checks', () => {
  for (const mutate of [(r) => { r.capability.verified = false; }, (r) => { r.cleanupComplete = false; }, (r) => { r.results = []; }, (r) => { r.status = 'blocked'; }]) {
    const { root, result, contract } = fixture(); mutate(result); expect(() => validateNativeResult(result, contract, root)).toThrow();
  }
});
test('old process run or mismatching executable cannot satisfy the exact candidate', () => {
  for (const mutate of [(r) => { r.results[0].runId = randomUUID(); }, (r) => { r.results[0].pid++; }, (r) => { r.results[0].executableSha256 = 'a'.repeat(64); }]) {
    const { root, result, contract } = fixture(); mutate(result); expect(() => validateNativeResult(result, contract, root)).toThrow();
  }
});
test('missing close and textual screenshot evidence are rejected even with recomputed hashes', () => {
  for (const mode of ['no-exit', 'fake-pixels']) {
    const { root, result, contract, events } = fixture();
    const path = mode === 'no-exit' ? 'native-events.jsonl' : 'screen.png';
    writeFileSync(resolve(root, path), mode === 'no-exit' ? events.filter((e) => e.kind !== 'exit').map((e) => JSON.stringify(e)).join('\n') : 'not actual encoded image evidence');
    result.results[0].evidence.find((e) => e.path === path).sha256 = fileHash(resolve(root, path));
    expect(() => validateNativeResult(result, contract, root)).toThrow();
  }
});
test('missing observation proof and empty accessibility are rejected', () => {
  const { root, result, contract } = fixture();
  result.results[0].observations[0].evidence = 'missing.json'; expect(() => validateNativeResult(result, contract, root)).toThrow(/observation/);
  result.results[0].observations[0].evidence = 'screen.png'; atomicJson(resolve(root, 'accessibility.json'), {});
  result.results[0].evidence.find((e) => e.path === 'accessibility.json').sha256 = fileHash(resolve(root, 'accessibility.json'));
  expect(() => validateNativeResult(result, contract, root)).toThrow(/accessibility/);
});
test('macOS cleanup requires verified absence of this profiles exact store', () => {
  const { root, result, contract, events } = fixture(); contract.platform = 'darwin-aarch64';
  events[0].details.webviewStoreId = randomUUID();
  const persist = () => { writeFileSync(resolve(root, 'native-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n')); result.results[0].evidence.find((e) => e.path === 'native-events.jsonl').sha256 = fileHash(resolve(root, 'native-events.jsonl')); };
  persist(); expect(() => validateNativeResult(result, contract, root)).toThrow(/cleanup/);
  events.push({ profileId: contract.profile.profileId, kind: 'webview-dispose-complete', details: { verifiedAbsent: true, webviewStoreId: randomUUID() } });
  persist(); expect(() => validateNativeResult(result, contract, root)).toThrow(/cleanup/);
  events.at(-1).details.webviewStoreId = events[0].details.webviewStoreId;
  const maintenanceRun = randomUUID(); events.at(-1).runId = maintenanceRun;
  events.unshift({ profileId: contract.profile.profileId, runId: maintenanceRun, kind: 'webview-maintenance-initialized', details: { mainThread: true, persistent: false, url: 'about:blank' } });
  persist(); expect(validateNativeResult(result, contract, root)).toBe(result);
});
