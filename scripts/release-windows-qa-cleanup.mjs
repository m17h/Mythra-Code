/** Prospective lifecycle for one NEW successful Windows QA profile. Permanent
 * removal is explicit, once only, and still subject to the caller's action review.
 * Never adopt a pre-existing profile or retry an earlier denied cleanup. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { atomicJson, containedPath, fileHash, objectHash, readJson } from './release-state.mjs';
import { assertNativeContract, validateNativeObservations } from './release-native-check.mjs';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const markerName = '.mythra-release-qa.json';
const recordNames = ['provisioning.json', 'writers.json', 'cleanup-intent.json', 'cleanup-receipt.json'];
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const identity = (path) => { const s = lstatSync(path); return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs }; };
const equal = (a, b) => objectHash(a) === objectHash(b);

export function windowsCleanupContract(platform) {
  return platform === 'windows-x86_64' ? { version: 1, lifecycle: 'coordinator-owned-success-only' } : undefined;
}
function paths(contract, stateRoot) {
  assertNativeContract(contract);
  if (contract.platform !== 'windows-x86_64' || contract.windowsCleanup?.version !== 1
    || contract.windowsCleanup.lifecycle !== 'coordinator-owned-success-only' || !UUID.test(contract.profile?.profileId)) throw new Error('Profile is not eligible for prospective Windows cleanup');
  const state = realpathSync(stateRoot), root = resolve(state, 'qa-profiles', contract.profile.profileId);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(state)) throw new Error('Windows QA requires a local drive path');
  if (root !== contract.profile.root) throw new Error('QA root must be the exact registered state UUID child');
  const directory = containedPath(state, 'workers/native-windows-x86_64');
  return { state, root, directory, ...Object.fromEntries(recordNames.map((n) => [n.split('.')[0].replaceAll('-', '_'), join(directory, n)])) };
}
function jsonExclusive(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function binding(contract) { return { contractHash: contract.contractHash, planHash: contract.planHash, commit: contract.commit, packageSha256: contract.packageSha256, executableSha256: contract.executableSha256, profileId: contract.profile.profileId, root: contract.profile.root }; }
function systemPowerShell() {
  if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error('Windows lifecycle must execute on Windows');
  return join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
}
const os = {
  probe(action, contract, executable = '', pid = 0) {
    const output = execFileSync(systemPowerShell(), ['-NoProfile', '-NonInteractive', '-File', join(moduleDirectory, 'release-windows-qa-profile.ps1'),
      '-Action', action, '-Root', contract.profile.root, '-ProfileId', contract.profile.profileId, '-Executable', executable, '-HostPid', String(pid)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(output.replace(/^\uFEFF/, ''));
  },
  acl(contract) {
    execFileSync(systemPowerShell(), ['-NoProfile', '-NonInteractive', '-File', resolve(moduleDirectory, '../src-tauri/src/release_qa_windows_acl.ps1')], {
      env: { ...process.env, MYTHRA_QA_OWNER_PATH: contract.profile.root, MYTHRA_QA_CHECK_TREE: '1', MYTHRA_QA_REQUIRE_PROTECTED: '1' }, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  },
};
function assertProbe(probe, provision) {
  if (probe?.schemaVersion !== 1 || !Array.isArray(probe.processes) || !Array.isArray(probe.inventory)
    || probe.inventory.some((entry) => !Number.isSafeInteger(entry?.pid) || entry.pid < 0)
    || !Array.isArray(probe.ambiguousWebviewPids) || probe.ambiguousWebviewPids.length || !probe.sid || !Number.isInteger(probe.sessionId)
    || (provision && (probe.sid !== provision.sid || probe.sessionId !== provision.sessionId))) throw new Error('Windows process inventory/owner is unavailable or ambiguous');
}
function assertMarker(root, contract) {
  const marker = readJson(join(root, markerName));
  if (!equal(marker, { schemaVersion: 1, purpose: 'mythra-release-qa', profileId: contract.profile.profileId })) throw new Error('Owned QA marker changed');
}
export function inspectOwnedTree(root) {
  const entries = [], pending = [root];
  for (let p = dirname(root); ; p = dirname(p)) { if (lstatSync(p).isSymbolicLink()) throw new Error('Linked QA ancestor'); if (dirname(p) === p) break; }
  while (pending.length) {
    const path = pending.pop(), stat = lstatSync(path);
    if (entries.length >= 20_000 || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Unsafe or unbounded owned QA tree');
    entries.push({ path, directory: stat.isDirectory(), ...identity(path) });
    if (stat.isDirectory()) pending.push(...readdirSync(path).map((name) => join(path, name)));
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function provisionWindowsQaProfile(contract, stateRoot, { system = os } = {}) {
  const p = paths(contract, stateRoot);
  if (existsSync(p.root) || recordNames.some((name) => existsSync(join(p.directory, name)))) throw new Error('Refusing to adopt an existing/previously attempted QA profile');
  mkdirSync(dirname(p.root), { recursive: true });
  // An interrupted intent is deliberately ineligible for automatic replacement.
  jsonExclusive(`${p.provisioning}.intent`, { ...binding(contract), createdAt: new Date().toISOString(), host: hostname() });
  const probe = system.probe('provision', contract); assertProbe(probe);
  system.acl(contract); inspectOwnedTree(p.root); assertMarker(p.root, contract);
  const record = { schemaVersion: 1, ...binding(contract), host: hostname(), sid: probe.sid, sessionId: probe.sessionId,
    rootIdentity: identity(p.root), markerSha256: fileHash(join(p.root, markerName)), createdAt: new Date().toISOString() };
  jsonExclusive(p.provisioning, record);
  return record;
}
function readProvision(contract, p) {
  const provision = readJson(p.provisioning);
  if (provision.schemaVersion !== 1 || !equal(Object.fromEntries(Object.keys(binding(contract)).map((k) => [k, provision[k]])), binding(contract))) throw new Error('QA provisioning identity mismatch');
  if (!equal(provision.rootIdentity, identity(p.root)) || provision.markerSha256 !== fileHash(join(p.root, markerName))) throw new Error('Provisioned QA root or marker was replaced');
  assertMarker(p.root, contract);
  return provision;
}
function nativeEvents(path, contract) {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n') || !text.trim() || Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Native event stream is empty, truncated or oversized');
  const events = text.trimEnd().split('\n').map((line) => JSON.parse(line));
  if (events.some((e) => e.schemaVersion !== 1 || e.profileId !== contract.profile.profileId || !Number.isInteger(e.pid) || !UUID.test(e.runId))) throw new Error('Native event stream identity mismatch');
  return events;
}
export function captureWindowsQaWriters(contract, stateRoot, pid, { system = os } = {}) {
  const p = paths(contract, stateRoot), provision = readProvision(contract, p);
  if (existsSync(p.cleanup_intent) || existsSync(p.cleanup_receipt)) throw new Error('Cleanup attempt already owns this profile');
  const events = nativeEvents(join(p.root, 'events.jsonl'), contract);
  const opened = events.findLast((e) => e.kind === 'profile-open' && e.pid === pid);
  if (!opened || !events.some((e) => e.kind === 'control-ready' && e.pid === pid && e.runId === opened.runId)) throw new Error('Writer capture requires this live isolated launch');
  const launchPath = join(p.directory, 'candidate-path.json');
  const executable = readJson(launchPath).executablePath;
  if (!executable || !inside(p.state, executable) || inside(p.root, executable) || realpathSync(executable) !== resolve(executable) || fileHash(executable) !== contract.executableSha256) throw new Error('Retained candidate executable mismatch');
  const probe = system.probe('inspect', contract, executable, pid); assertProbe(probe, provision);
  const host = probe.processes.find((e) => e.pid === pid);
  if (!host || host.executablePath !== executable || !host.processStart || !probe.processes.some((e) => e.udfBound === true)) throw new Error('Candidate and persistent WebView writer identities are missing');
  const capture = { schemaVersion: 1, ...binding(contract), pid, runId: opened.runId, executablePath: executable,
    processes: probe.processes.map((e) => ({ ...e, executableSha256: fileHash(e.executablePath) })), capturedAt: new Date().toISOString() };
  const previous = existsSync(p.writers) ? readJson(p.writers) : [];
  if (!Array.isArray(previous) || previous.some((c) => c.contractHash !== contract.contractHash || (c.pid === pid && c.runId === opened.runId))) throw new Error('Writer identity already captured or stale');
  atomicJson(p.writers, [...previous, capture]); return capture;
}
function evidenceFiles(result, contract, p) {
  const evidence = new Map();
  for (const item of result.results.flatMap((r) => r.evidence)) evidence.set(containedPath(p.state, item.path), item.sha256);
  for (const entry of result.results) evidence.set(entry.executablePath, entry.executableSha256);
  evidence.set(containedPath(p.state, result.capability.evidence), fileHash(containedPath(p.state, result.capability.evidence)));
  evidence.set(containedPath(p.state, contract.packagePath), contract.packageSha256);
  for (const [path, hash] of evidence) if (inside(p.root, path) || inside(p.root, realpathSync(path)) || fileHash(path) !== hash) throw new Error('Required retained evidence/payload overlaps QA root or changed');
  return [...evidence].map(([path, sha256]) => ({ path: relative(p.state, path).replaceAll('\\', '/'), sha256 }));
}
function assertNoWriters(probe, captures, provision) {
  assertProbe(probe, provision);
  if (probe.processes.length || captures.flatMap((c) => c.processes).some((owned) => probe.inventory.some((live) => live.pid === owned.pid && (!live.processStart || !Number.isFinite(Date.parse(live.processStart)) || live.processStart === owned.processStart)))) throw new Error('Owned host or persistent WebView writer is still alive');
}
function removeSnapshot(entries) {
  // No recursive/force primitive and no ACL repair: check each original identity,
  // unlink original plain files, then remove empty directories, ending at ONE root.
  for (const entry of [...entries].sort((a, b) => b.path.length - a.path.length)) {
    const stat = lstatSync(entry.path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || !equal(identity(entry.path), { dev: entry.dev, ino: entry.ino, birthtimeMs: entry.birthtimeMs })) throw new Error('QA tree changed during removal');
    if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
  }
}
export function cleanupSuccessfulWindowsQaProfile(result, contract, stateRoot, { system = os, remove = removeSnapshot } = {}) {
  const p = paths(contract, stateRoot);
  if (existsSync(p.cleanup_intent) || existsSync(p.cleanup_receipt)) throw new Error('Cleanup is once only; an earlier attempt requires diagnosis, never fallback');
  const claim = openSync(`${p.cleanup_intent}.claim`, 'wx', 0o600); closeSync(claim);
  try {
    validateNativeObservations(result, contract, stateRoot);
    if (result.cleanupComplete !== false) throw new Error('Worker must leave prospective Windows cleanup to coordinator');
    const provision = readProvision(contract, p), captures = readJson(p.writers);
    if (!Array.isArray(captures) || !captures.length || captures.some((c) => c.contractHash !== contract.contractHash || !c.processes?.length)) throw new Error('Missing/stale captured process ownership');
    const eventsPath = join(p.root, 'events.jsonl'), events = nativeEvents(eventsPath, contract);
    for (const opened of events.filter((e) => e.kind === 'profile-open')) {
      const capture = captures.find((c) => c.pid === opened.pid && c.runId === opened.runId);
      const run = events.filter((e) => e.pid === opened.pid && e.runId === opened.runId);
      const saved = run.findLastIndex((e) => e.kind === 'close-finish' && e.details?.accepted === true && e.details.result === 'saved');
      if (!capture || saved < 0 || run.findIndex((e) => e.kind === 'exit') <= saved) throw new Error('Every owned native run requires captured writers and normal saved exit');
    }
    for (const entry of result.results) {
      const capture = captures.find((c) => c.pid === entry.pid && c.runId === entry.runId);
      const host = capture?.processes.find((e) => e.pid === entry.pid);
      if (!capture || capture.executablePath !== entry.executablePath || host?.processStart !== entry.processStart || host.executableSha256 !== contract.executableSha256) throw new Error('Healthy primary process was not captured');
      const retained = entry.evidence.find((e) => /native-events\.jsonl$/.test(e.path));
      if (!retained || retained.sha256 !== fileHash(eventsPath)) throw new Error('Complete native events were not preserved outside profile');
    }
    for (const process of captures.flatMap((c) => c.processes)) if (!Number.isInteger(process.pid) || !process.processStart || fileHash(process.executablePath) !== process.executableSha256) throw new Error('Captured process executable identity changed');
    const evidence = evidenceFiles(result, contract, p), executable = result.results[0].executablePath;
    system.acl(contract); const tree = inspectOwnedTree(p.root);
    const before = system.probe('inspect', contract, executable); assertNoWriters(before, captures, provision);
    const intent = { schemaVersion: 1, ...binding(contract), provisioningSha256: fileHash(p.provisioning), writersSha256: fileHash(p.writers),
      workerResultSha256: objectHash(result), evidence, rootIdentity: provision.rootIdentity, host: hostname(), processExit: before, createdAt: new Date().toISOString() };
    jsonExclusive(p.cleanup_intent, intent);
    // Recheck immediately before the explicit permanent removal. External claim
    // protects coordinator ownership; it cannot prevent arbitrary same-user races.
    readProvision(contract, p); system.acl(contract);
    if (!equal(inspectOwnedTree(p.root), tree)) throw new Error('QA tree changed before removal');
    assertNoWriters(system.probe('inspect', contract, executable), captures, provision);
    console.error(`Permanently removing ONE newly provisioned successful Windows QA profile: ${p.root}`);
    remove(tree);
    if (existsSync(p.root)) throw new Error('QA root remains after removal');
    const after = system.probe('inspect', contract, executable); assertNoWriters(after, captures, provision);
    if (after.rootExists !== false) throw new Error('Windows did not confirm root absence');
    for (const item of evidence) if (fileHash(containedPath(p.state, item.path)) !== item.sha256) throw new Error('Retained evidence changed during cleanup');
    const receipt = { schemaVersion: 1, ...binding(contract), cleanupComplete: true, rootAbsent: true, host: hostname(),
      intentSha256: fileHash(p.cleanup_intent), provisioningSha256: fileHash(p.provisioning), writersSha256: fileHash(p.writers), evidence,
      processExit: after, completedAt: new Date().toISOString() };
    jsonExclusive(p.cleanup_receipt, receipt); return receipt;
  } catch (error) {
    if (!existsSync(p.cleanup_receipt)) jsonExclusive(p.cleanup_receipt, { schemaVersion: 1, ...binding(contract), cleanupComplete: false, rootAbsent: !existsSync(p.root), reason: error.message, failedAt: new Date().toISOString() });
    throw error;
  }
}
export function validateWindowsCleanupReceipt(result, contract, stateRoot) {
  if (!contract.windowsCleanup) return;
  // Portable retained proof: never interpret a Windows source path on macOS as an absence check.
  const directory = containedPath(stateRoot, 'workers/native-windows-x86_64');
  const receipt = readJson(join(directory, 'cleanup-receipt.json')), intent = readJson(join(directory, 'cleanup-intent.json'));
  const expected = binding(contract);
  const provision = readJson(join(directory, 'provisioning.json'));
  const worker = readJson(join(directory, 'worker-result.json'));
  for (const record of [intent, provision]) if (!equal(Object.fromEntries(Object.keys(expected).map((k) => [k, record[k]])), expected)) throw new Error('Windows cleanup ownership binding changed');
  if (intent.workerResultSha256 !== objectHash(worker) || !equal(result, { ...worker, cleanupComplete: true })) throw new Error('Windows cleanup result does not match accepted worker evidence');
  if (!equal(Object.fromEntries(Object.keys(expected).map((k) => [k, receipt[k]])), expected) || receipt.cleanupComplete !== true || receipt.rootAbsent !== true
    || receipt.intentSha256 !== fileHash(join(directory, 'cleanup-intent.json')) || receipt.provisioningSha256 !== fileHash(join(directory, 'provisioning.json'))
    || receipt.writersSha256 !== fileHash(join(directory, 'writers.json')) || !equal(receipt.evidence, intent.evidence)
    || receipt.processExit?.rootExists !== false || receipt.processExit?.processes?.length !== 0 || receipt.processExit?.ambiguousWebviewPids?.length !== 0) throw new Error('Windows owned cleanup receipt is missing or inconsistent');
  for (const item of receipt.evidence) if (fileHash(containedPath(stateRoot, item.path)) !== item.sha256) throw new Error('Windows cleanup retained evidence changed');
  if (!result.cleanupComplete) throw new Error('Windows cleanup is incomplete');
}
export function verifyWindowsCleanupLive(contract, stateRoot, executable, { system = os } = {}) {
  const p = paths(contract, stateRoot), provision = readJson(p.provisioning), captures = readJson(p.writers);
  if (existsSync(p.root)) throw new Error('Windows QA root still exists');
  const probe = system.probe('inspect', contract, executable); assertNoWriters(probe, captures, provision);
  if (probe.rootExists !== false) throw new Error('Windows root absence could not be verified');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, stateRoot, pidText, executable] = process.argv.slice(2);
  if (action !== 'capture-writers' || !stateRoot || !/^[1-9][0-9]*$/.test(pidText ?? '')) throw new Error('Usage: node scripts/release-windows-qa-cleanup.mjs capture-writers STATE_ROOT PID RETAINED_EXECUTABLE');
  const contract = readJson(resolve(stateRoot, 'workers/native-windows-x86_64/contract.json'));
  const p = paths(contract, stateRoot), candidatePath = join(p.directory, 'candidate-path.json');
  if (!existsSync(candidatePath)) jsonExclusive(candidatePath, { executablePath: resolve(executable) });
  else if (readJson(candidatePath).executablePath !== resolve(executable)) throw new Error('Candidate executable path changed');
  console.log(JSON.stringify(captureWindowsQaWriters(contract, stateRoot, Number(pidText))));
}
