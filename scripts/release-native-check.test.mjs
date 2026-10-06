import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, fileHash, objectHash } from './release-state.mjs';
import { assertNativeContract, assertQaSourceSupport, validateNativeResult } from './release-native-check.mjs';
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
function closeFaultFixture() {
  const f = fixture(), { root, contract, result, events } = f;
  const nonce = randomUUID(), runId = randomUUID(), profileId = contract.profile.profileId, pid = 4320, requestId = 1;
  contract.platform = 'windows-x86_64';
  contract.sourceCapability = { closeFailure: { version: 1 } };
  contract.closeFailureScenario = { schemaVersion: 1, nonce, kind: 'save-failure-once', cause: 'override-saved-result' };
  contract.checks = [{ id: 'native-close:windows-x86_64', observations: ['healthy-save-close-reopen', 'affected-close-failure', 'owned-processes-exited'] }];
  const entry = result.results[0]; entry.checkId = contract.checks[0].id;
  entry.observations = contract.checks[0].observations.map((id) => ({ id, evidence: id === 'affected-close-failure' ? 'close-failure.json' : 'screen.png' }));
  const event = (kind, details = {}) => ({ schemaVersion: 1, profileId, pid, runId, kind, details });
  events.find((e) => e.kind === 'renderer-storage').details.previous = profileId;
  const fault = { nonce, kind: 'save-failure-once', cause: 'override-saved-result' }, key = { label: 'main', requestId };
  events.unshift(event('profile-open', { closeFailureVersion: 1 }), event('render-ready'),
    event('qa-close-fault-armed', fault), event('qa-close-fault-applied', { ...fault, ...key, originalResult: 'saved', result: 'failed' }),
    event('close-finish', { ...key, accepted: true, result: 'failed', faultNonce: nonce }),
    event('close-prompt', { ...key, reason: 'SaveFailed' }), event('close-prompt-answer', { ...key, accepted: true, confirmed: false, choice: 'keep-open' }),
    event('close-cancelled', key), event('close-finish', { label: 'main', requestId: 2, accepted: true, result: 'saved', faultNonce: null }), event('exit'));
  const proof = { schemaVersion: 1, ...fault, profileId, pid, runId, requestId,
    prompt: { pid, runId, phase: 'prompt', screenshot: 'prompt.png', accessibility: 'prompt-ax.json' },
    recovery: { pid, runId, phase: 'recovery', screenshot: 'recovery.png', accessibility: 'recovery-ax.json' } };
  atomicJson(resolve(root, 'close-failure.json'), proof);
  for (const [index, path] of ['prompt.png', 'recovery.png'].entries()) writeFileSync(resolve(root, path), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, index)]));
  atomicJson(resolve(root, 'prompt-ax.json'), { title: `Mythra Code — Release QA ${profileId}`, dialog: `Close Mythra Code? — Release QA ${profileId}`, button: 'Keep open' });
  atomicJson(resolve(root, 'recovery-ax.json'), { title: `Mythra Code — Release QA ${profileId}`, theme: 'Light Mythra' });
  entry.evidence.push(...['close-failure.json', 'prompt.png', 'recovery.png', 'prompt-ax.json', 'recovery-ax.json'].map((path) => ({ path, sha256: fileHash(resolve(root, path)) })));
  persistEvents(root, result, events);
  return { ...f, proof };
}
test('declared one-shot native close failure requires prompt cancellation, recovery and a healthy reopened primary', () => {
  const { root, result, contract } = closeFaultFixture();
  expect(validateNativeResult(result, contract, root)).toBe(result);
});
test('selected close replay cannot omit its declaration and substitute healthy-only evidence', () => {
  const f = closeFaultFixture();
  delete f.contract.closeFailureScenario;
  f.events = f.events.filter((e) => e.runId !== f.proof.runId);
  f.result.results[0].observations.find((o) => o.id === 'affected-close-failure').evidence = 'screen.png';
  persistEvents(f.root, f.result, f.events);
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow(/declaration/);
});
test('persisted native contract rejects changed content retaining an old ownership hash', () => {
  const { contract } = closeFaultFixture();
  contract.contractHash = objectHash(contract);
  expect(() => assertNativeContract(contract)).not.toThrow();
  delete contract.closeFailureScenario;
  expect(() => assertNativeContract(contract)).toThrow(/hash/);
});
test('healthy reopen rejects undeclared timeout prompt recovery before a later saved close', () => {
  const f = closeFaultFixture(), primary = f.events.find((e) => e.runId === f.result.results[0].runId);
  const index = f.events.findIndex((e) => e.runId === primary.runId && e.kind === 'close-finish');
  f.events.splice(index, 0, ...[
    ['close-prompt', { reason: 'Deadline' }],
    ['close-prompt-answer', { accepted: true, confirmed: false, choice: 'keep-open' }],
    ['close-cancelled', {}],
  ].map(([kind, details]) => ({ ...primary, kind, details: { label: 'main', requestId: 1, ...details } })));
  persistEvents(f.root, f.result, f.events);
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow(/prompt/);
});
test('renamed prompt captures cannot stand in for the recovered owned window', () => {
  const f = closeFaultFixture(), entry = f.result.results[0];
  writeFileSync(resolve(f.root, 'recovery.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
  atomicJson(resolve(f.root, 'recovery-ax.json'), { title: `Mythra Code — Release QA ${f.contract.profile.profileId}`, dialog: `Close Mythra Code? — Release QA ${f.contract.profile.profileId}`, button: 'Keep open' });
  for (const e of entry.evidence) e.sha256 = fileHash(resolve(f.root, e.path));
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow();
});
test('healthy reopen cannot report a new renderer store after fault recovery', () => {
  const f = closeFaultFixture();
  f.events.find((e) => e.runId === f.result.results[0].runId && e.kind === 'renderer-storage').details.previous = null;
  persistEvents(f.root, f.result, f.events);
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow(/persistent store/);
});
test.each(['pid', 'runId', 'phase'])('recovery capture rejects wrong %s binding', (field) => {
  const f = closeFaultFixture();
  f.proof.recovery[field] = field === 'pid' ? f.proof.pid + 1 : field === 'runId' ? randomUUID() : 'prompt';
  atomicJson(resolve(f.root, 'close-failure.json'), f.proof);
  f.result.results[0].evidence.find((e) => e.path === 'close-failure.json').sha256 = fileHash(resolve(f.root, 'close-failure.json'));
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow();
});
test.each([
  ['missing declaration', (f) => { delete f.contract.closeFailureScenario; }],
  ['wrong nonce', (f) => { f.events.find((e) => e.kind === 'qa-close-fault-applied').details.nonce = randomUUID(); }],
  ['wrong fault run', (f) => { f.events.find((e) => e.kind === 'qa-close-fault-applied').runId = randomUUID(); }],
  ['wrong close request', (f) => { f.events.find((e) => e.kind === 'close-prompt').details.requestId++; }],
  ['missing native prompt', (f) => { f.events = f.events.filter((e) => e.kind !== 'close-prompt'); }],
  ['missing cancellation', (f) => { f.events = f.events.filter((e) => e.kind !== 'close-cancelled'); }],
  ['discard choice', (f) => { f.events.find((e) => e.kind === 'close-prompt-answer').details.confirmed = true; }],
  ['implicit dialog dismissal', (f) => { f.events.find((e) => e.kind === 'close-prompt-answer').details.choice = 'other'; }],
  ['real save failure', (f) => { f.events.find((e) => e.kind === 'qa-close-fault-applied').details.originalResult = 'failed'; }],
  ['repeated failure', (f) => { f.events.push({ ...f.events.find((e) => e.kind === 'close-finish' && e.details.result === 'failed') }); }],
  ['repeated arming', (f) => { f.events.push({ ...f.events.find((e) => e.kind === 'qa-close-fault-armed') }); }],
  ['missing healthy recovery', (f) => { f.events = f.events.filter((e) => !(e.runId === f.proof.runId && e.kind === 'close-finish' && e.details.result === 'saved')); }],
  ['fault as primary', (f) => { f.result.results[0].runId = f.proof.runId; f.result.results[0].pid = f.proof.pid; }],
  ['unexpected setup failure', (f) => { f.events.push({ ...f.events[0], kind: 'setup-failed' }); }],
  ['unexpected render failure', (f) => { f.events.push({ ...f.events[0], kind: 'render-failed' }); }],
  ['unexpected storage failure', (f) => { f.events.push({ ...f.events[0], kind: 'renderer-storage-failed' }); }],
  ['failed healthy primary', (f) => { f.events.find((e) => e.runId === f.result.results[0].runId && e.kind === 'close-finish').details.result = 'failed'; }],
])('maintained negative recipe rejects %s even with updated evidence hashes', (_name, mutate) => {
  const f = closeFaultFixture(); mutate(f); persistEvents(f.root, f.result, f.events);
  expect(() => validateNativeResult(f.result, f.contract, f.root)).toThrow();
});
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
