import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createPlan, changedSource } from './release-plan.mjs';
import { acquireLease, assertPlan, atomicJson, containedPath, fileHash, leaseStatus, objectHash, readJson, reconcile, saveReceipt } from './release-state.mjs';
import { acquirePublisherLease, assertPublisherOwner, assertReadyToPublish, assertStateLocation, createReleaseWorkspace, prepareMacBuildDependencies, runRelease } from './release-coordinator.mjs';
import { assertHostedEvidence, verifyHostedEvidence } from './release-evidence.mjs';
import { assetNames, assertAssetMetadata, verifyMinisign } from './release-audit.mjs';
import { expectedReceipts, lanes } from './verify-ci.mjs';
import { exportHandoff, mergeHandoff } from './release-handoff.mjs';

const sha = 'a'.repeat(40), roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'mythra-release-test-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = (extra = {}) => createPlan({ commit: sha, version: '1.2.3', baseline: { commit: 'b'.repeat(40), tag: 'v1.2.2', reason: 'Last accepted public release',
  publicEvidence: { schemaVersion: 1, repository: 'm17h/Mythra-Code', releaseId: 1, tag: 'v1.2.2', commit: 'b'.repeat(40), publishedAt: '2026-01-01T00:00:00Z', latestReleaseId: 1, latestTag: 'v1.2.2', latestCommit: 'b'.repeat(40), verifiedAt: '2026-01-01T00:00:01Z' } }, changedFiles: [], policyHash: 'c'.repeat(64), ...extra });
function receipt(p, root, id, extra = {}) {
  const check = p.checks.find((c) => c.id === id);
  const path = resolve(root, `${id.replaceAll(':', '_')}.txt`); writeFileSync(path, `${id} evidence`);
  const files = [{ path: path.split(/[\\/]/).at(-1), sha256: fileHash(path) }];
  let checkerVersion = 'release-coordinator-v1', details = {};
  if (check.kind === 'ci') details = assertHostedEvidence(hosted(), sha), details.commit = p.commit, details.input = { ...details.input, checkout: p.commit, head: p.commit };
  if (check.kind === 'build') {
    const packagePath = `MythraCode_${p.version}_${check.platform === 'darwin-aarch64' ? 'aarch64.dmg' : 'x64-setup.exe'}`;
    writeFileSync(resolve(root, packagePath), `fixture package ${check.platform}`);
    details = { packagePath, packageSha256: fileHash(resolve(root, packagePath)), exitCode: 0, command: ['npm', 'run', 'release:build'], node: process.version, host: hostname() };
    files.push({ path: packagePath, sha256: details.packageSha256 });
  }
  if (check.kind === 'audit') {
    checkerVersion = 'native-integrity-v1';
    details = { packageSha256: readJson(resolve(root, 'receipts', `build_${check.platform}.json`)).details.packageSha256, archiveSha256: 'f'.repeat(64), executableSha256: 'f'.repeat(64), codesign: 'passed', notarization: 'passed', gatekeeper: 'passed', bundleEquivalence: 'passed', bundleEntries: 9, payloadPe: { machine: 0x8664, subsystem: 'WindowsGui' }, payloadVersion: p.version, authenticodeStatus: 'NotSigned' };
  }
  if (check.kind === 'native') {
    checkerVersion = 'native-check-v1';
    for (const name of ['screen.png', 'accessibility.json']) { writeFileSync(resolve(root, name), 'native fixture evidence'); files.push({ path: name, sha256: fileHash(resolve(root, name)) }); }
    details = { workerContractHash: 'a'.repeat(64), sessionId: 'fixture', executablePath: '/fixture/candidate', executableSha256: 'f'.repeat(64), pid: 123, runId: '00000000-0000-4000-8000-000000000001', version: p.version,
      runtime: { model: 'gpt-6.1-sol', reasoningEffort: 'high', approvalPolicy: 'never', sandbox: 'danger-full-access' }, windowIdentity: 'fixture-window', observations: ['fixture assertion'], cleanupComplete: true, restorationComplete: true };
  }
  if (check.kind === 'draft' || check.kind === 'public') {
    details = { version: p.version, commit: p.commit, hashes: {}, signaturesVerified: ['darwin-aarch64', 'windows-x86_64'] };
    for (const name of assetNames(p.version)) { const asset = `assets-${id}/${name}`; mkdirSync(resolve(root, `assets-${id}`), { recursive: true }); writeFileSync(resolve(root, asset), name); details.hashes[name] = fileHash(resolve(root, asset)); files.push({ path: asset, sha256: details.hashes[name] }); }
  }
  if (check.kind === 'publish') details = { tag: `v${p.version}` };
  return { schemaVersion: 1, checkId: id, status: 'passed', planHash: p.planHash, commit: p.commit, checkerVersion,
    ...(check.platform ? { platform: check.platform } : {}), startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', evidence: files,
    ...extra, details: { ...details, ...extra.details } };
}
describe('release selection', () => {
  test('routine presentation release keeps required baseline and no native tour', () => {
    const p = plan({ changedFiles: ['src/components/UsageDashboard.css', 'src/components/UsageCalendar.tsx'] });
    expect(p.checks.filter((c) => c.required && c.kind === 'native')).toEqual([]);
    expect(p.checks.filter((c) => c.required).map((c) => c.id)).toEqual(['ci', 'build:darwin-aarch64', 'audit:darwin-aarch64', 'build:windows-x86_64', 'audit:windows-x86_64', 'draft', 'publish', 'public']);
  });
  test('storage and reported Windows failure select affected native checks only', () => {
    const p = plan({ changedFiles: ['src-tauri/src/persistence.rs'], knownIssues: [{ check: 'native-startup', platform: 'windows-x86_64', reason: 'Reported blank window' }] });
    expect(p.checks.find((c) => c.id === 'native-startup:darwin-aarch64').required).toBe(false);
    expect(p.checks.find((c) => c.id === 'native-startup:windows-x86_64').required).toBe(true);
    expect(p.checks.filter((c) => c.required && c.id.startsWith('native-storage')).length).toBe(2);
  });
  test('ordinary lib command needs semantic review, not a guessed startup/close tour', () => {
    const p = plan({ changedFiles: ['src-tauri/src/lib.rs'] });
    expect(p.reviewRequired).toEqual(['src-tauri/src/lib.rs']);
    expect(p.checks.filter((c) => c.required && c.kind === 'native')).toEqual([]);
    const reviewed = plan({ changedFiles: ['src-tauri/src/lib.rs'], classifications: [{ path: 'src-tauri/src/lib.rs', boundaries: [], reason: 'Git command output formatting only', evidence: 'get_git_status changed hunk' }], boundaryHints: [{ check: 'native-close', reason: 'close_guard integration changed' }] });
    expect(reviewed.reviewRequired).toEqual([]);
    expect(reviewed.checks.find((c) => c.id === 'native-close:windows-x86_64').required).toBe(true);
  });
  test('withdrawn shipped predecessor still contributes storage transition coverage', () => {
    const p = plan({ predecessors: [{ tag: 'v1.2.2-withdrawn', commit: 'd'.repeat(40), reason: 'Previously shipped', changedFiles: ['src-tauri/src/persistence.rs'] }] });
    expect(p.checks.find((c) => c.id === 'native-storage:windows-x86_64').required).toBe(true);
  });
  test('edited plans cannot remove a required gate silently', () => {
    const p = plan(); p.checks[0].required = false;
    expect(() => assertPlan(p)).toThrow(/modified/);
  });
});
describe('durable receipts and resume', () => {
  test('fresh Mac worker installs frozen dependencies into its owned checkout and stops on setup failure', () => {
    const calls = [], root = temp();
    expect(prepareMacBuildDependencies({ root, descriptor: 42, env: {}, execute: (...args) => { calls.push(args); return { status: 0 }; } }).exitCode).toBe(0);
    expect(calls[0]).toEqual(['npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env: {}, stdio: ['ignore', 42, 42], timeout: 900_000 }]);
    expect(() => prepareMacBuildDependencies({ root, descriptor: 42, execute: () => ({ status: 1 }) })).toThrow(/dependency setup failed/);
  });
  test('a changed dependency receipt invalidates downstream evidence', () => {
    const p = plan(), root = temp();
    saveReceipt(root, p, receipt(p, root, 'build:darwin-aarch64'));
    saveReceipt(root, p, receipt(p, root, 'audit:darwin-aarch64'));
    expect(reconcile(p, root).find((c) => c.id === 'audit:darwin-aarch64').status).toBe('passed');
    expect(() => saveReceipt(root, p, receipt(p, root, 'build:darwin-aarch64', { details: { revised: true } }))).toThrow(/immutable/);
    atomicJson(resolve(root, 'receipts/build_darwin-aarch64.json'), { ...readJson(resolve(root, 'receipts/build_darwin-aarch64.json')), revised: true });
    expect(reconcile(p, root).find((c) => c.id === 'audit:darwin-aarch64').status).toBe('invalid');
  });
  test('native evidence must match package and complete restoration', () => {
    const p = plan({ knownIssues: [{ check: 'native-startup', reason: 'Reported failure', platform: 'windows-x86_64' }] }), root = temp();
    const built = receipt(p, root, 'build:windows-x86_64'); saveReceipt(root, p, built);
    saveReceipt(root, p, receipt(p, root, 'audit:windows-x86_64'));
    const native = receipt(p, root, 'native-startup:windows-x86_64', { packageSha256: 'f'.repeat(64), details: { cleanupComplete: true, restorationComplete: true } });
    expect(() => saveReceipt(root, p, native)).toThrow(/package/);
    native.packageSha256 = built.details.packageSha256; native.details.restorationComplete = false;
    expect(() => saveReceipt(root, p, native)).toThrow(/restoration/);
    native.details.restorationComplete = true; saveReceipt(root, p, native);
    writeFileSync(resolve(root, native.evidence[0].path), 'modified');
    expect(reconcile(p, root).find((c) => c.id === native.checkId).status).toBe('invalid');
  });
  test('missing required check prevents finalization', () => expect(() => assertReadyToPublish(plan(), temp())).toThrow(/incomplete/));
  test('evidence cannot escape release directory through path or symlink', () => {
    const root = temp(), outside = temp(); writeFileSync(join(outside, 'secret'), 'outside');
    expect(() => containedPath(root, '../secret')).toThrow(/escapes/);
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    expect(() => containedPath(root, 'link')).toThrow(/escapes/);
    symlinkSync(outside, join(root, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => containedPath(root, 'directory-link/new-file')).toThrow(/escapes/);
  });
  test('state aliases cannot point inside builder-cleared outputs', () => {
    const root = temp(), alias = join(temp(), 'alias'); mkdirSync(join(root, 'release-assets/latest'), { recursive: true });
    symlinkSync(join(root, 'release-assets/latest'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertStateLocation(root, join(alias, 'new-state'))).toThrow(/builder-cleared/);
  });
  test('live owners and foreign hosts cannot be stolen; dead local owner can resume', () => {
    const root = temp(), identity = () => 'start-A';
    const release = acquireLease(root, { identity });
    expect(() => acquireLease(root, { recover: true, identity })).toThrow(/running/);
    release();
    atomicJson(join(root, 'lease.json'), { host: 'other-computer', pid: 10, processStart: 'old', token: 'foreign' });
    expect(() => acquireLease(root, { recover: true, identity })).toThrow(/foreign-host/);
    atomicJson(join(root, 'lease.json'), { host: hostname(), pid: 10, processStart: 'old', token: 'dead' });
    const resumed = acquireLease(root, { recover: true, identity }); resumed();
    expect(leaseStatus({ host: hostname(), pid: 10, processStart: 'old' }, identity)).toBe('orphaned');
  });
  test.skipIf(process.platform === 'win32')('publisher exclusion spans distinct state directories and preserves designated host', () => {
    const registry = temp(), p = plan();
    const owner = acquirePublisherLease(p, { registry });
    try {
      expect(assertPublisherOwner(p, owner.token, { registry }).pid).toBe(process.pid);
      expect(() => acquirePublisherLease(p, { registry, recover: true })).toThrow(/running/);
      expect(() => acquirePublisherLease(plan({ version: '1.2.4' }), { registry })).toThrow(/running/);
      expect(() => assertPublisherOwner(p, 'wrong', { registry })).toThrow(/matching live/);
      expect(() => acquirePublisherLease({ ...p, publisherHost: 'another-host' }, { registry })).toThrow(/designated/);
    } finally { owner(); }
  });
});

test('worker handoffs merge matching evidence once and reject changed bytes or another plan', () => {
  const p = plan(), source = temp(), destination = temp(), transfer = join(temp(), 'bundle');
  atomicJson(join(source, 'plan.json'), p); atomicJson(join(destination, 'plan.json'), p);
  saveReceipt(source, p, receipt(p, source, 'ci'));
  saveReceipt(source, p, receipt(p, source, 'build:windows-x86_64'));
  saveReceipt(source, p, receipt(p, source, 'audit:windows-x86_64'));
  expect(exportHandoff(source, transfer, 'windows-x86_64').checks.length).toBe(3);
  expect(mergeHandoff(transfer, destination).imported.length).toBe(3);
  expect(mergeHandoff(transfer, destination).imported.length).toBe(3);
  writeFileSync(join(transfer, 'build_windows-x86_64.txt'), 'tampered');
  expect(() => mergeHandoff(transfer, destination)).toThrow(/invalid stage/);
  atomicJson(join(transfer, 'plan.json'), plan({ version: '1.2.4' }));
  expect(() => mergeHandoff(transfer, destination)).toThrow(/another release/);
});

test('version-only metadata is excluded while dependency changes remain in release scope', () => {
  const root = temp(); const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mythra-code', version: '1.2.2', dependencies: { react: '1' } }));
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "mythra-code"\nversion = "1.2.2"\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n');
  git(['add', '.']); git(['commit', '-m', 'old']); const old = git(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mythra-code', version: '1.2.3', dependencies: { react: '1' } }));
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "mythra-code"\nversion = "1.2.3"\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n');
  git(['add', '.']); git(['commit', '-m', 'version']); const bump = git(['rev-parse', 'HEAD']);
  expect(changedSource(root, old, bump)).toEqual([]);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mythra-code', version: '1.2.3', dependencies: { react: '2' } }));
  git(['add', '.']); git(['commit', '-m', 'dependency']);
  expect(changedSource(root, old, git(['rev-parse', 'HEAD']))).toEqual(['package.json']);
});

function hosted() {
  const input = { checkout: sha, head: sha, base: null, event: 'push' };
  const receipts = expectedReceipts().map((id) => {
    const kind = id.split('-')[0], steps = kind === 'webkit' ? ['build', 'verify:startup', 'test:webkit'] : lanes[kind];
    const r = { schemaVersion: 1, id, input, status: 'success', steps: steps.map((name) => ({ name, status: 'success' })) };
    if (kind === 'unit') { r.inventory = ['a.test.ts', 'b.test.ts']; r.unit = { files: [r.inventory[Number(id.at(-1)) - 1]], tests: 1 }; }
    if (kind === 'renderer' || kind === 'webkit') r.browser = { files: ['a.browser.test.ts'], tests: 1 };
    if (kind === 'webkit') r.inventory = ['a.browser.test.ts'];
    if (kind === 'renderer') { r.profiles = id.endsWith('Windows') ? ['safari13', 'chrome105'] : ['safari13']; r.performance = Object.fromEntries(r.profiles.map((target) => [target, { schemaVersion: 1, budgetEvaluation: { passed: true }, environment: { buildProfile: `${target}-minified` } }])); }
    return r;
  });
  const names = ['WebKit (macOS 15)', 'Verify gate', ...['macos-latest', 'windows-latest'].flatMap((os) => [`Rust (${os})`, `Renderer (${os})`, `Unit (${os}, 1/2)`, `Unit (${os}, 2/2)`])];
  return { run: { id: 123, run_attempt: 1, repository: { full_name: 'm17h/Mythra-Code' }, head_repository: { full_name: 'm17h/Mythra-Code' }, path: '.github/workflows/verify.yml', event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success' },
    jobs: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })), receipts };
}
describe('hosted proof and asset audit', () => {
  test('queued hosted checks wait, but completed failed checks block', () => {
    for (const status of ['queued', 'in_progress']) {
      expect(() => verifyHostedEvidence({ root: '.', commit: sha, execute: () => JSON.stringify([{ databaseId: 1, headSha: sha, status, conclusion: null }]) })).toThrow(/queued/);
      try { verifyHostedEvidence({ root: '.', commit: sha, execute: () => '[]' }); } catch (error) { expect(error.status).toBe('waiting'); }
    }
    expect(() => verifyHostedEvidence({ root: '.', commit: sha, execute: () => JSON.stringify([{ databaseId: 1, headSha: sha, status: 'completed', conclusion: 'failure' }]) })).toThrow(/No complete/);
  });
  test('requires canonical exact-source run, every successful job and complete coverage', () => {
    expect(assertHostedEvidence(hosted(), sha).receiptHashes.length).toBe(9);
    for (const mutate of [(e) => e.jobs.pop(), (e) => { e.jobs[0].conclusion = 'skipped'; }, (e) => e.receipts.pop(), (e) => { e.run.event = 'pull_request'; }, (e) => { e.run.head_sha = 'f'.repeat(40); }, (e) => { e.run.repository.full_name = 'other/repo'; }, (e) => { e.receipts.find((r) => r.id === 'unit-Windows-2').unit.files = []; }]) {
      const e = hosted(); mutate(e); expect(() => assertHostedEvidence(e, sha)).toThrow();
    }
  });
  test('Minisign receives decoded material, and a rejected signature fails audit', () => {
    const material = Buffer.from('untrusted comment: example\nKEY\n').toString('base64');
    let calls = 0;
    verifyMinisign({ file: '/unused/package', publicKey: material, signature: material, execute: (_cmd, args) => { calls++; expect(readFileSync(args[args.indexOf('-p') + 1], 'utf8')).toContain('untrusted comment:'); } });
    expect(calls).toBe(1);
    expect(() => verifyMinisign({ file: '/unused/package', publicKey: material, signature: material, execute: () => { throw new Error('signature invalid'); } })).toThrow(/signature invalid/);
  });
  test('strict combined metadata rejects extra platform/assets, stale SHA and Windows hash mismatch', () => {
    const version = '1.2.3', installer = `MythraCode_${version}_x64-setup.exe`;
    const data = { version, commit: sha, names: assetNames(version), notes: 'Notes 1.2.3', signature: 'sig', hashes: { [installer]: 'digest' }, macInfo: `version: ${version}\ncommit: ${sha}\n`,
      windowsInfo: { version, commit: sha, dirty: false, platform: 'windows-x86_64', architecture: 'x64', peSubsystem: 'WindowsGui', authenticodeStatus: 'NotSigned', installer, signature: `${installer}.sig`, sha256: 'digest' },
      manifest: { version, notes: 'Notes 1.2.3', pub_date: '2026-01-01T00:00:00Z', platforms: Object.fromEntries([['darwin-aarch64', `MythraCode_${version}_aarch64.app.tar.gz`], ['windows-x86_64', installer]].map(([p, name]) => [p, { signature: 'sig', url: `https://github.com/m17h/Mythra-Code/releases/download/v${version}/${name}` }])) } };
    expect(() => assertAssetMetadata(data)).not.toThrow();
    for (const mutate of [(d) => d.names.push('stale.exe'), (d) => { d.manifest.platforms.linux = {}; }, (d) => { d.windowsInfo.sha256 = 'wrong'; }, (d) => { d.macInfo = 'old'; }]) {
      const copy = structuredClone(data); mutate(copy); expect(() => assertAssetMetadata(copy)).toThrow();
    }
  });
});

test('detached workspace preserves development edits; interrupted DAG resumes without repeating completed stages', async () => {
  const root = temp(), stateRoot = temp(), destination = join(temp(), 'release');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git']);
  writeFileSync(join(root, 'source'), 'frozen'); git(['add', '.']); git(['commit', '-m', 'fixture']); const commit = git(['rev-parse', 'HEAD']);
  const p = plan({ commit }); atomicJson(join(stateRoot, 'plan.json'), p);
  writeFileSync(join(root, 'source'), 'development continues');
  createReleaseWorkspace(root, destination, commit);
  expect(readFileSync(join(root, 'source'), 'utf8')).toBe('development continues');
  const executed = [];
  const handlers = Object.fromEntries(p.checks.filter((c) => c.required).map((c) => [c.id, ({ check }) => { executed.push(check.id); if (check.id === 'draft') throw new Error('simulated network outage'); return receipt(p, stateRoot, check.id); }]));
  let ciAttempts = 0;
  handlers.ci = ({ check }) => { executed.push(check.id); if (++ciAttempts === 1) throw Object.assign(new Error('CI queued'), { status: 'waiting' }); return receipt(p, stateRoot, check.id); };
  await expect(runRelease({ root: destination, stateRoot, handlers, waitMs: 20, deadlineMs: 1000 })).rejects.toThrow(/network outage/);
  expect(executed.indexOf('build:darwin-aarch64')).toBeLessThan(executed.lastIndexOf('ci'));
  const first = [...executed];
  handlers.draft = ({ check }) => { executed.push(check.id); return receipt(p, stateRoot, check.id); };
  await expect(runRelease({ root: destination, stateRoot, handlers, resume: true })).rejects.toThrow(/no blind retries/);
  const resumed = await runRelease({ root: destination, stateRoot, handlers, resume: true, retryReason: 'Simulated network outage resolved' });
  expect(resumed.complete).toBe(true);
  expect(executed.slice(first.length)).toEqual(['draft', 'publish', 'public']);
});
