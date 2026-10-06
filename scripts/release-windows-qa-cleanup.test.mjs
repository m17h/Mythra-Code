import { afterEach, expect, test, vi } from 'vitest';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, fileHash, objectHash, readJson } from './release-state.mjs';
import { captureWindowsQaWriters, cleanupSuccessfulWindowsQaProfile, provisionWindowsQaProfile, validateWindowsCleanupReceipt, verifyWindowsCleanupLive } from './release-windows-qa-cleanup.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Filesystem and injected system fixtures only: these never represent native UI
// acceptance, Windows ACL/process verification, or permission to remove a real root.
function fixture({ provision = true } = {}) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'mythra-windows-cleanup-test-'))); roots.push(state);
  const directory = join(state, 'workers/native-windows-x86_64'); mkdirSync(directory, { recursive: true });
  const candidate = join(state, 'candidate'); mkdirSync(candidate);
  const executable = join(candidate, 'mythra.exe'), webview = join(candidate, 'webview.exe'), packagePath = 'candidate/package.exe';
  writeFileSync(executable, 'synthetic candidate bytes'); writeFileSync(webview, 'synthetic browser bytes');
  writeFileSync(join(state, packagePath), 'synthetic package bytes');
  const profileId = randomUUID(), root = join(state, 'qa-profiles', profileId), runId = randomUUID(), pid = 4321;
  const processStart = '2026-10-06T12:00:00.000Z';
  let contract = { schemaVersion: 1, platform: 'windows-x86_64', version: '1.2.3', planHash: 'a'.repeat(64), commit: 'b'.repeat(40),
    packagePath, packageSha256: fileHash(join(state, packagePath)), executableSha256: fileHash(executable),
    profile: { profileId, root }, windowsCleanup: { version: 1, lifecycle: 'coordinator-owned-success-only' },
    checks: [{ id: 'native-startup:windows-x86_64', observations: ['visible-native-shell'] }] };
  contract = { ...contract, contractHash: objectHash(contract) };
  const baseProbe = () => ({ schemaVersion: 1, sid: 'S-1-5-21-fixture', sessionId: 1, processes: [], inventory: [], ambiguousWebviewPids: [], rootExists: existsSync(root) });
  const system = { probe: vi.fn((action, _contract, _executable, hostPid) => {
    if (action === 'provision') {
      mkdirSync(root);
      atomicJson(join(root, '.mythra-release-qa.json'), { schemaVersion: 1, purpose: 'mythra-release-qa', profileId });
    }
    const probe = baseProbe();
    if (hostPid === pid) probe.processes = [
      { pid, processStart, executablePath: executable, udfBound: false },
      { pid: pid + 1, processStart, executablePath: webview, udfBound: true },
    ];
    return probe;
  }), acl: vi.fn() };
  const event = (kind, details = {}) => ({ schemaVersion: 1, profileId, pid, runId, kind, details });
  const events = [event('profile-open', { contractVersion: 1, providers: 'blocked', persistentWebview: true }),
    event('window-constructed'), event('control-ready'), event('renderer-storage', { current: profileId, previous: null }),
    event('render-ready'), event('close-finish', { accepted: true, result: 'saved' }), event('exit')];
  const evidenceDirectory = join(state, 'evidence'); mkdirSync(evidenceDirectory);
  const evidence = ['evidence/screen.png', 'evidence/accessibility.json', 'evidence/native-events.jsonl'];
  writeFileSync(join(state, evidence[0]), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
  atomicJson(join(state, evidence[1]), { title: `Mythra Code — Release QA ${profileId}` });
  atomicJson(join(state, 'evidence/capability.json'), { tool: 'cua', inventory: ['fixture-window'] });
  const result = { status: 'passed', reason: '', capability: { verified: true, tool: 'cua', evidence: 'evidence/capability.json' }, cleanupComplete: false, restorationComplete: true,
    results: [{ checkId: contract.checks[0].id, executablePath: executable, executableSha256: contract.executableSha256,
      pid, processStart, runId, windowIdentity: `Mythra Code — Release QA ${profileId}`, version: contract.version,
      observations: [{ id: 'visible-native-shell', evidence: evidence[0] }], evidence: [] }] };
  const persistEvents = (values = events, suffix = '\n') => {
    const text = values.map((e) => JSON.stringify(e)).join('\n') + suffix;
    writeFileSync(join(root, 'events.jsonl'), text); writeFileSync(join(state, evidence[2]), text);
    result.results[0].evidence = evidence.map((path) => ({ path, sha256: fileHash(join(state, path)) }));
  };
  if (provision) {
    provisionWindowsQaProfile(contract, state, { system });
    atomicJson(join(directory, 'candidate-path.json'), { executablePath: executable });
    writeFileSync(join(root, 'events.jsonl'), events.slice(0, 5).map((e) => JSON.stringify(e)).join('\n') + '\n');
    captureWindowsQaWriters(contract, state, pid, { system });
    persistEvents();
    atomicJson(join(directory, 'worker-result.json'), result);
  }
  const remove = vi.fn(() => rmSync(root, { recursive: true }));
  const cleanup = () => cleanupSuccessfulWindowsQaProfile(result, contract, state, { system, remove });
  return { state, root, directory, contract, result, system, remove, cleanup, events, persistEvents, executable, baseProbe };
}

test('a fresh successful profile is removed once with portable proof and independently checked absence', () => {
  const f = fixture(), hashes = f.result.results[0].evidence.map((e) => e.sha256);
  const receipt = f.cleanup();
  expect(f.remove).toHaveBeenCalledTimes(1); expect(existsSync(f.root)).toBe(false);
  expect(receipt).toMatchObject({ cleanupComplete: true, rootAbsent: true, contractHash: f.contract.contractHash });
  const accepted = { ...f.result, cleanupComplete: true };
  expect(() => validateWindowsCleanupReceipt(accepted, f.contract, f.state)).not.toThrow();
  expect(() => verifyWindowsCleanupLive(f.contract, f.state, f.executable, { system: f.system })).not.toThrow();
  expect(f.result.results[0].evidence.map((e) => fileHash(join(f.state, e.path)))).toEqual(hashes);
  expect(() => f.cleanup()).toThrow(/once only/); expect(f.remove).toHaveBeenCalledTimes(1);
});

test('provisioning never adopts a preexisting profile', () => {
  const f = fixture({ provision: false }); mkdirSync(f.root, { recursive: true });
  writeFileSync(join(f.root, 'sentinel'), 'preserve');
  expect(() => provisionWindowsQaProfile(f.contract, f.state, { system: f.system })).toThrow(/existing/);
  expect(f.system.probe).not.toHaveBeenCalled(); expect(readFileSync(join(f.root, 'sentinel'), 'utf8')).toBe('preserve');
});
test('wrong provisioning identity prevents removal', () => {
  const f = fixture(), path = join(f.directory, 'provisioning.json'), record = readJson(path);
  atomicJson(path, { ...record, profileId: randomUUID() });
  expect(() => f.cleanup()).toThrow(/provisioning identity/); expect(f.remove).not.toHaveBeenCalled();
});
test.each([
  ['failed result', (f) => { f.result.status = 'failed'; }],
  ['missing selected observation', (f) => { f.result.results[0].observations = []; }],
  ['missing healthy render', (f) => { f.persistEvents(f.events.filter((e) => e.kind !== 'render-ready')); }],
  ['unsaved normal close', (f) => { f.events.find((e) => e.kind === 'close-finish').details.result = 'failed'; f.persistEvents(); }],
])('invalid observations prevent removal: %s', (_name, mutate) => {
  const f = fixture(); mutate(f);
  expect(() => f.cleanup()).toThrow(); expect(f.remove).not.toHaveBeenCalled(); expect(existsSync(f.root)).toBe(true);
  expect(readJson(join(f.directory, 'cleanup-receipt.json')).cleanupComplete).toBe(false);
});
test.each([
  ['live owned process', (f, probe) => { probe.inventory = [{ pid: f.result.results[0].pid, processStart: f.result.results[0].processStart }]; }],
  ['reparented persistent writer', (_f, probe) => { probe.processes = [{ pid: 9988, udfBound: true }]; }],
  ['ambiguous browser writer', (_f, probe) => { probe.ambiguousWebviewPids = [9988]; }],
  ['unavailable inventory', (_f, probe) => { delete probe.inventory; }],
  ['unresolved owned process start', (f, probe) => { probe.inventory = [{ pid: f.result.results[0].pid }]; }],
])('writer uncertainty prevents removal: %s', (_name, mutate) => {
  const f = fixture(); f.system.probe.mockImplementation(() => { const probe = f.baseProbe(); mutate(f, probe); return probe; });
  expect(() => f.cleanup()).toThrow(/alive|inventory|ambiguous/); expect(f.remove).not.toHaveBeenCalled();
});
test('an independently resolved reused PID is not the captured writer', () => {
  const f = fixture(); f.system.probe.mockImplementation(() => ({ ...f.baseProbe(),
    inventory: [{ pid: f.result.results[0].pid, processStart: '2026-10-06T13:00:00.000Z' }] }));
  expect(() => f.cleanup()).not.toThrow(); expect(f.remove).toHaveBeenCalledTimes(1);
});
test('healthy primary start time must match its captured process', () => {
  const f = fixture(); f.result.results[0].processStart = '2026-10-06T13:00:00.000Z';
  expect(() => f.cleanup()).toThrow(/primary process/); expect(f.remove).not.toHaveBeenCalled();
});
test('changed packaged bytes prevent removal', () => {
  const f = fixture(); writeFileSync(join(f.state, f.contract.packagePath), 'different package');
  expect(() => f.cleanup()).toThrow(/changed/); expect(f.remove).not.toHaveBeenCalled();
});
test('all observed launches need writer capture and normal saved exit', () => {
  const f = fixture(); f.persistEvents([...f.events, { ...f.events[0], pid: 4333, runId: randomUUID() }]);
  expect(() => f.cleanup()).toThrow(/Every owned native run/); expect(f.remove).not.toHaveBeenCalled();
});
test('retained evidence inside the owned root prevents removal', () => {
  const f = fixture(), entry = f.result.results[0], source = entry.evidence[0];
  const path = `qa-profiles/${f.contract.profile.profileId}/screen.png`;
  copyFileSync(join(f.state, source.path), join(f.state, path));
  entry.evidence[0] = { ...source, path }; entry.observations[0].evidence = path;
  expect(() => f.cleanup()).toThrow(/overlaps/); expect(f.remove).not.toHaveBeenCalled();
});
test('changed retained evidence prevents removal', () => {
  const f = fixture(); writeFileSync(join(f.state, 'evidence/screen.png'), 'corrupted');
  expect(() => f.cleanup()).toThrow(/hash mismatch/); expect(f.remove).not.toHaveBeenCalled();
});
test('matching hashes cannot turn a truncated event stream into complete evidence', () => {
  const f = fixture(); f.persistEvents(f.events, '');
  expect(() => f.cleanup()).toThrow(/truncated/); expect(f.remove).not.toHaveBeenCalled();
});
test('the retained event stream must contain all original native events', () => {
  const f = fixture(); writeFileSync(join(f.root, 'events.jsonl'), readFileSync(join(f.root, 'events.jsonl'), 'utf8') + JSON.stringify({ ...f.events[0], kind: 'control-ready' }) + '\n');
  expect(() => f.cleanup()).toThrow(/Complete native events/); expect(f.remove).not.toHaveBeenCalled();
});
test.each(['symlink', 'hardlink'])('a %s in the profile prevents removal and preserves its target', (kind) => {
  const f = fixture(), target = join(f.state, 'preserved-target'); writeFileSync(target, 'do not remove');
  if (kind === 'symlink') symlinkSync(target, join(f.root, 'linked-file')); else linkSync(target, join(f.root, 'linked-file'));
  expect(() => f.cleanup()).toThrow(/Unsafe/); expect(f.remove).not.toHaveBeenCalled();
  expect(readFileSync(target, 'utf8')).toBe('do not remove');
});
test('failed ACL boundary prevents removal without repairing it', () => {
  const f = fixture(); f.system.acl.mockImplementation(() => { throw new Error('fixture unsafe ACL'); });
  expect(() => f.cleanup()).toThrow(/unsafe ACL/); expect(f.remove).not.toHaveBeenCalled();
});
test.each(['denied', 'partial'])('a %s removal records failure and cannot retry', (mode) => {
  const f = fixture(); f.remove.mockImplementation(() => {
    if (mode === 'partial') unlinkSync(join(f.root, 'events.jsonl'));
    throw new Error(mode === 'denied' ? 'fixture action denied' : 'fixture partial removal');
  });
  expect(() => f.cleanup()).toThrow(/fixture/); expect(f.remove).toHaveBeenCalledTimes(1);
  expect(readJson(join(f.directory, 'cleanup-receipt.json'))).toMatchObject({ cleanupComplete: false, rootAbsent: false });
  expect(existsSync(f.root)).toBe(true);
  expect(() => f.cleanup()).toThrow(/once only/); expect(f.remove).toHaveBeenCalledTimes(1);
  expect(() => validateWindowsCleanupReceipt({ ...f.result, cleanupComplete: true }, f.contract, f.state)).toThrow();
});
test('a remover that leaves the root cannot report cleanup success', () => {
  const f = fixture(); f.remove.mockImplementation(() => {});
  expect(() => f.cleanup()).toThrow(/root remains/);
  expect(readJson(join(f.directory, 'cleanup-receipt.json')).cleanupComplete).toBe(false);
});
test('forged cleanup binding cannot satisfy retained validation', () => {
  const f = fixture(); f.cleanup(); const path = join(f.directory, 'cleanup-receipt.json');
  atomicJson(path, { ...readJson(path), profileId: randomUUID() });
  expect(() => validateWindowsCleanupReceipt({ ...f.result, cleanupComplete: true }, f.contract, f.state)).toThrow(/inconsistent/);
});
test('portable receipt validation does not substitute for actual root absence', () => {
  const f = fixture(); f.cleanup(); mkdirSync(f.root);
  expect(() => validateWindowsCleanupReceipt({ ...f.result, cleanupComplete: true }, f.contract, f.state)).not.toThrow();
  expect(() => verifyWindowsCleanupLive(f.contract, f.state, f.executable, { system: f.system })).toThrow(/still exists/);
});
test('a changed retained artifact invalidates a previously complete receipt', () => {
  const f = fixture(); f.cleanup(); writeFileSync(f.executable, 'replacement executable');
  expect(() => validateWindowsCleanupReceipt({ ...f.result, cleanupComplete: true }, f.contract, f.state)).toThrow(/evidence changed/);
});

// Use the production per-entry unlink/rmdir implementation on actual temporary
// files (including on the Windows unit lane), rather than the injected spy.
test('production removal deletes only the captured successful fixture tree', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'nested')); writeFileSync(join(f.root, 'nested/data'), 'fixture');
  const retained = join(f.state, 'retain'); writeFileSync(retained, 'outside target');
  cleanupSuccessfulWindowsQaProfile(f.result, f.contract, f.state, { system: f.system });
  expect(existsSync(f.root)).toBe(false); expect(readFileSync(retained, 'utf8')).toBe('outside target');
  expect(() => validateWindowsCleanupReceipt({ ...f.result, cleanupComplete: true }, f.contract, f.state)).not.toThrow();
});
