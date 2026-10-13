import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, assertPlan, atomicJson, fileHash, leaseStatus, objectHash, PLATFORMS, processIdentity, readJson, realPath, receiptPath, reconcile, saveReceipt, SHA, workerTreeAlive } from './release-state.mjs';
import { planFromCheckout } from './release-plan.mjs';
import { REPOSITORY } from './release-evidence.mjs';
import { assertPublicationVersion, assertRemoteRelease, assertTagTarget } from './release-audit.mjs';
import { combinePlatformManifests, uploadPlatformDraft } from './release-draft.mjs';
import { exportHandoff, mergeHandoff } from './release-handoff.mjs';
import { runWindowsWorker } from './release-remote.mjs';
import { candidateProcesses } from './release-candidate-contract.mjs';

const checkoutRoot = resolve(import.meta.dirname, '..');
export const RELEASE_OVERLAP_VERSION = 1;
const platform = process.platform === 'darwin' ? 'darwin-aarch64' : process.platform === 'win32' ? 'windows-x86_64' : null;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const gh = (root, args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
function recordEvent(stateRoot, event) {
  appendFileSync(resolve(stateRoot, 'coordinator-events.jsonl'), `${JSON.stringify({ recordedAt: new Date().toISOString(), host: hostname(), pid: process.pid, ...event })}\n`, { mode: 0o600 });
}
export function assertCheckout(root, plan) {
  if (git(root, ['rev-parse', 'HEAD']) !== plan.commit || git(root, ['status', '--porcelain'])) throw new Error('Release worker checkout must remain clean at the frozen commit');
  if (!/^(https:\/\/github\.com\/|git@github\.com:)m17h\/Mythra-Code(?:\.git)?$/.test(git(root, ['remote', 'get-url', 'origin']))) throw new Error('Wrong release repository');
}
export function assertStateLocation(root, stateRoot) {
  for (const path of ['release-assets/latest', 'RELEASE ASSETS', 'src-tauri/target']) {
    const difference = relative(realPath(resolve(root, path)), realPath(stateRoot));
    if (!difference || (difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference))) throw new Error('Release state must be outside builder-cleared staging/output');
  }
}
const publisherRegistry = () => resolve(homedir(), '.mythra-release', 'publishers');
function publisherLeaseDirectory(plan, registry) { return resolve(registry, objectHash({ repository: plan.repository })); }
export function assertPublisherOwner(plan, ownerToken, { registry = publisherRegistry() } = {}) {
  if (plan.publisherHost !== hostname() || process.platform === 'win32') throw new Error('Only the frozen designated publisher host can upload or publish');
  const lease = readJson(resolve(publisherLeaseDirectory(plan, registry), 'lease.json'));
  if (!ownerToken || lease.token !== ownerToken || leaseStatus(lease) !== 'running' || lease.planHash !== plan.planHash || lease.commit !== plan.commit || lease.version !== plan.version) throw new Error('Publication has no matching live host-global owner');
  return lease;
}
export function acquirePublisherLease(plan, { recover = false, registry = publisherRegistry() } = {}) {
  if (plan.publisherHost !== hostname() || process.platform === 'win32') throw new Error('Only the frozen designated publisher host can upload or publish');
  const directory = publisherLeaseDirectory(plan, registry);
  let release;
  try {
    release = acquireLease(directory, { recover, validateRecovery: (old) => {
      if (old.mutationStarted !== undefined) throw Object.assign(new Error('Interrupted publisher mutation has unresolved subprocess ownership; inspect preserved processes and remote release evidence, prove every publisher exited, and archive the orphaned lease before manual recovery'), { status: 'blocked' });
    } });
  }
  catch (error) { if (/already has a (running|foreign-host) owner/.test(error.message)) error.status = 'waiting'; throw error; }
  const lease = readJson(resolve(directory, 'lease.json'));
  atomicJson(resolve(directory, 'lease.json'), { ...lease, planHash: plan.planHash, commit: plan.commit, version: plan.version, repository: plan.repository });
  release.token = lease.token;
  return release;
}
export function markPublisherMutation(plan, ownerToken, { registry = publisherRegistry(), stage = 'publish' } = {}) {
  if (!['draft', 'publish'].includes(stage)) throw new Error('Invalid publisher mutation stage');
  const directory = publisherLeaseDirectory(plan, registry), guard = resolve(directory, 'lease-recovery.lock');
  let guardFd;
  try {
    // Serialize registration with orphan recovery. A child whose coordinator
    // died before registration cannot authorize mutation against a replaced lease.
    guardFd = openSync(guard, 'wx', 0o600);
    const lease = assertPublisherOwner(plan, ownerToken, { registry });
    if (lease.mutationStarted === undefined) atomicJson(resolve(directory, 'lease.json'), {
      ...lease, mutationStarted: { stage, recordedAt: new Date().toISOString() },
    });
  } finally { if (guardFd !== undefined) { closeSync(guardFd); rmSync(guard, { force: true }); } }
}
export function createReleaseWorkspace(root, destination, commit) {
  if (!SHA.test(commit) || existsSync(destination)) throw new Error('Workspace needs an exact commit and a new destination');
  // Detached release checkout: the developer keeps their current branch, index,
  // dist and Cargo output. Never reset/switch the originating checkout.
  git(root, ['worktree', 'add', '--detach', resolve(destination), commit]);
  return { path: resolve(destination), commit, host: hostname() };
}
const evidence = (stateRoot, path) => ({ path: relative(stateRoot, path).replaceAll('\\', '/'), sha256: fileHash(path) });
function envelope(plan, check, startedAt, files, stateRoot, details = {}) {
  return { schemaVersion: 1, checkId: check.id, status: 'passed', planHash: plan.planHash, commit: plan.commit,
    ...(check.platform ? { platform: check.platform } : {}), checkerVersion: 'release-coordinator-v1', startedAt, completedAt: new Date().toISOString(),
    evidence: files.map((file) => evidence(stateRoot, file)), details };
}

export function assertReadyToPublish(plan, stateRoot) {
  assertActiveRelease(plan, stateRoot);
  const stages = reconcile(plan, stateRoot);
  const pending = stages.filter((s) => !['publish', 'public'].includes(s.id) && !['passed', 'not-required'].includes(s.status));
  if (pending.length) throw new Error(`Release operations incomplete: ${pending.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  return readJson(receiptPath(stateRoot, 'draft'));
}

export function assertActiveRelease(plan, stateRoot) {
  if (plan.policyVersion !== 2) throw new Error('Legacy frozen release plans are read-only; create a new state directory for a newly authorized release');
  if (['cancelled.json', 'cancellation.json'].some((name) => existsSync(resolve(stateRoot, name)))) throw new Error('Release is cancelled');
  const active = resolve(stateRoot, 'active-stage.json');
  if (existsSync(active) && readJson(active).status === 'cancelled') throw new Error('Release is cancelled');
}

export function prepareMacBuildDependencies({ root, env, descriptor, execute = spawnSync }) {
  const args = ['ci', '--no-audit', '--no-fund'];
  const result = execute('npm', args, { cwd: root, env, stdio: ['ignore', descriptor, descriptor], timeout: 15 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`macOS dependency setup failed (${result.status ?? result.error?.code}); inspect preserved native build log`);
  return { command: ['npm', ...args], exitCode: 0 };
}

function buildStage({ root, stateRoot, plan, check, allowBuild }) {
  if (!allowBuild) throw new Error('Build requires release authorization at kickoff (--build); status/plan never build');
  assertActiveRelease(plan, stateRoot);
  const startedAt = new Date().toISOString();
  const stage = resolve(stateRoot, 'candidates', check.platform);
  if (existsSync(stage)) throw new Error('Candidate files already exist without a valid receipt; inspect and recover them, never rebuild automatically');
  const log = resolve(stateRoot, 'logs', `build-${check.platform}-${Date.now()}.log`);
  mkdirSync(resolve(stateRoot, 'logs'), { recursive: true });
  const env = { ...process.env };
  if (check.platform === 'windows-x86_64') {
    env.MYTHRA_RELEASE_CANDIDATE_STATE = stateRoot;
    env.MYTHRA_RELEASE_CANDIDATE_OWNER = readJson(resolve(stateRoot, 'lease.json')).token;
    env.MYTHRA_RELEASE_CANDIDATE_WORKER_PID = String(process.pid);
    env.MYTHRA_RELEASE_CANDIDATE_WORKER_START = processIdentity();
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const command = process.platform === 'win32' ? 'powershell.exe' : npm;
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/release-build-job.ps1')] : ['run', 'release:build'];
  const descriptor = openSync(log, 'wx', 0o600);
  let result, dependencySetup;
  try {
    if (check.platform === 'darwin-aarch64') dependencySetup = prepareMacBuildDependencies({ root, env, descriptor });
    result = spawnSync(command, args, { cwd: root, env, stdio: ['ignore', descriptor, descriptor], timeout: 60 * 60 * 1000 });
  }
  finally { closeSync(descriptor); }
  if (result.status !== 0) throw new Error(`Native build failed (${result.status ?? result.error?.code}); preserved log ${log}`);
  assertCheckout(root, plan);
  const output = resolve(root, check.platform === 'darwin-aarch64' ? 'release-assets/latest' : 'RELEASE ASSETS');
  const names = readdirSync(output).filter((name) => name !== 'README.md');
  const expected = check.platform === 'darwin-aarch64'
    ? ['MythraCode-icon.png', `MythraCode_${plan.version}_aarch64.app.tar.gz`, `MythraCode_${plan.version}_aarch64.dmg`, 'build-info.txt', 'latest.json', 'release-notes.md']
    : [`MythraCode_${plan.version}_x64-setup.exe`, `MythraCode_${plan.version}_x64-setup.exe.sig`, 'build-info.json', 'latest.json'];
  if (objectHash(names.sort()) !== objectHash(expected.sort())) throw new Error('Builder produced an unexpected asset inventory');
  mkdirSync(stage, { recursive: true });
  for (const name of names) cpSync(resolve(output, name), resolve(stage, name), { errorOnExist: true, force: false });
  const packageName = check.platform === 'darwin-aarch64' ? `MythraCode_${plan.version}_aarch64.dmg` : `MythraCode_${plan.version}_x64-setup.exe`;
  const details = { packageSha256: fileHash(resolve(stage, packageName)), packagePath: relative(stateRoot, resolve(stage, packageName)).replaceAll('\\', '/'),
    command: [npm, 'run', 'release:build'], exitCode: result.status, node: process.version, host: hostname(), ...(dependencySetup ? { dependencySetup } : {}) };
  return envelope(plan, check, startedAt, [log, ...names.map((name) => resolve(stage, name))], stateRoot, details);
}

async function durableBuild({ root, stateRoot, plan, check }) {
  const token = readJson(resolve(stateRoot, 'lease.json')).token;
  const child = spawn(process.execPath, [resolve(root, 'scripts/release-coordinator.mjs'), 'build-worker', '--state', stateRoot, '--check', check.id, '--owner', token],
    { cwd: root, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  const startedAt = new Date().toISOString();
  const processStart = Number.isInteger(child.pid) ? processIdentity(child.pid) : null;
  if (!processStart) { child.kill(); throw new Error('Cannot establish native build worker identity'); }
  atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'running', startedAt,
    worker: { host: hostname(), pid: child.pid, processStart }, ownerToken: token, planHash: plan.planHash, commit: plan.commit, root: realPath(root) });
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Native build worker exited ${code}; inspect active-stage.json and preserved logs`))); });
  // The worker owns its completion receipt, so it can finish after a coordinator
  // interruption. Returning it never invokes the builder a second time.
  return readJson(receiptPath(stateRoot, check.id));
}

const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));

function remoteStage({ root, stateRoot, plan, check, allowUpload }) {
  if (!allowUpload) throw new Error('Draft upload requires release authorization at kickoff (--upload)');
  const startedAt = new Date().toISOString(), tag = `v${plan.version}`;
  assertPublicationVersion({ latest: JSON.parse(gh(root, ['api', `repos/${REPOSITORY}/releases/latest`])), plan });
  const manifests = {};
  for (const p of PLATFORMS) {
    assertActiveRelease(plan, stateRoot);
    const directory = resolve(stateRoot, 'candidates', p);
    manifests[p] = readJson(resolve(directory, 'latest.json'));
    uploadPlatformDraft({ root, repository: REPOSITORY, tag, target: plan.commit,
      manifest: manifests[p], assetPaths: readdirSync(directory).map((name) => resolve(directory, name)),
      ...(p === 'darwin-aarch64' ? { notesFile: resolve(directory, 'release-notes.md') } : {}) });
  }
  gh(root, ['release', 'edit', tag, '--repo', REPOSITORY, '--notes-file', resolve(stateRoot, 'candidates/darwin-aarch64/release-notes.md')]);
  const release = JSON.parse(gh(root, ['release', 'view', tag, '--repo', REPOSITORY,
    '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body']));
  assertRemoteRelease(release, plan, 'draft');
  assertTagTarget({ root, plan, phase: 'draft' });
  const path = resolve(stateRoot, 'evidence', 'draft.json');
  atomicJson(path, { commit: plan.commit, version: plan.version, tag,
    manifest: combinePlatformManifests(manifests['darwin-aarch64'], manifests['windows-x86_64']),
    assets: release.assets.map(({ name, id, size }) => ({ name, id, size })) });
  return envelope(plan, check, startedAt, [path], stateRoot,
    { commit: plan.commit, version: plan.version, tag, platforms: PLATFORMS });
}

export async function runRelease({ root, stateRoot, allowBuild = false, allowUpload = false, allowPublish = false, nativeOnly = false, resume = false, retryReason = '', handlers = {}, remoteWorker = runWindowsWorker, lifecycle = {}, waitMs = 15_000, deadlineMs = 2 * 60 * 60_000 }) {
  if (!Number.isFinite(waitMs) || waitMs < 1 || !Number.isFinite(deadlineMs) || deadlineMs < 1) throw new Error('Release coordinator needs a bounded polling interval and deadline');
  assertStateLocation(root, stateRoot);
  const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
  assertActiveRelease(plan, stateRoot);
  if (nativeOnly && (!allowBuild || allowUpload || allowPublish || hostname() === plan.publisherHost || platform !== 'windows-x86_64')) throw new Error('Native-only coordination is restricted to the non-publisher Windows build host, without upload/publication');
  if (!nativeOnly && hostname() !== plan.publisherHost) throw new Error('Only the designated publisher coordinates publication; remote Windows uses --native-only');
  assertCheckout(root, plan);
  const activePath = resolve(stateRoot, 'active-stage.json');
  if (existsSync(activePath)) {
    const previous = readJson(activePath);
    if (previous.worker && workerTreeAlive(previous.worker)) throw new Error('Native worker or its descendants are still running (or belong to another host); wait for its receipt, do not restart it');
    if (previous.status === 'running' && previous.worker && !existsSync(receiptPath(stateRoot, previous.checkId)) && !retryReason.trim()) throw new Error('Interrupted native worker has no completion receipt; inspect logs/outputs and record a retry reason after confirming its process tree is gone');
    if (previous.status === 'blocked' && !retryReason.trim()) throw new Error(`Previous ${previous.checkId} failed: ${previous.reason}. Resume needs --retry-reason explaining the resolved cause; no blind retries.`);
    if (retryReason.trim()) atomicJson(resolve(stateRoot, 'recovery', `retry-${Date.now()}.json`), { checkId: previous.checkId, reason: retryReason, recordedAt: new Date().toISOString() });
  }
  const coordinatorCommand = allowBuild ? candidateProcesses().find((p) => p.pid === process.pid)?.command : undefined;
  if (allowBuild && !coordinatorCommand) throw new Error('Cannot establish the native coordinator launch command');
  const releaseLease = acquireLease(stateRoot, { recover: resume });
  let publisherLease;
  const ownerLease = readJson(resolve(stateRoot, 'lease.json'));
  atomicJson(resolve(stateRoot, 'lease.json'), { ...ownerLease, root: realPath(root), planHash: plan.planHash, commit: plan.commit, allowBuild,
    ...(coordinatorCommand ? { coordinatorCommand } : {}) });
  const ownerToken = ownerLease.token;
  const waiting = new Map();
  const deadline = Date.now() + deadlineMs;
  let remoteTask = null, remoteResult = null, remoteError = null, remoteCollected = false, remoteNextAt = 0;
  const workerAbort = new AbortController();
  try {
    recordEvent(stateRoot, { kind: 'coordinator-started', resume, planHash: plan.planHash });
    if (allowUpload || allowPublish) {
      while (!publisherLease) {
        assertActiveRelease(plan, stateRoot);
        try { publisherLease = acquirePublisherLease(plan, { recover: resume }); }
        catch (error) {
          if (error.status !== 'waiting') throw error;
          atomicJson(activePath, { status: 'waiting', checkId: 'publisher', reason: error.message });
          if (Date.now() >= deadline) return { complete: false, stages: reconcile(plan, stateRoot), waiting: [{ checkId: 'publisher', reason: error.message }] };
          await new Promise((accept) => setTimeout(accept, Math.min(waitMs, deadline - Date.now())));
        }
      }
    }
    while (true) {
      assertActiveRelease(plan, stateRoot);
      const stages = reconcile(plan, stateRoot);
      const invalid = stages.filter((s) => s.status === 'invalid');
      if (invalid.length) throw new Error(`Evidence invalidated; inspect before rerunning: ${JSON.stringify(invalid)}`);
      if (!remoteTask && Date.now() >= remoteNextAt && Date.now() < deadline && platform === 'darwin-aarch64' && allowBuild && !handlers['build:windows-x86_64']
        && stages.some((s) => s.id.endsWith(':windows-x86_64') && !['passed', 'not-required'].includes(s.status))) {
        remoteTask = remoteWorker({ root, stateRoot, plan, signal: workerAbort.signal, onPrepared: lifecycle.remotePrepared, onStatus: (status) => atomicJson(resolve(stateRoot, 'remote-status.json'), status) })
          .then((path) => { remoteResult = path; }, (error) => { remoteError = error; });
      }
      if (remoteError) {
        if (remoteError.status !== 'waiting') throw remoteError;
        remoteNextAt = Date.now() + waitMs;
        waiting.set('windows-worker', { checkId: 'windows-worker', reason: remoteError.message, retryAt: remoteNextAt });
        remoteError = null; remoteTask = null;
      }
      if (remoteResult && !remoteCollected) {
        mergeHandoff(remoteResult, stateRoot, { ownerToken }); remoteCollected = true;
        waiting.delete('windows-worker');
        continue;
      }
      const ready = stages.filter((s) => s.status === 'pending' && (!waiting.has(s.id) || (Date.now() < deadline && Date.now() >= waiting.get(s.id).retryAt))).map((s) => plan.checks.find((c) => c.id === s.id));
      const check = ready.find((c) => (!nativeOnly || c.platform === platform) && (handlers[c.id] || (c.kind === 'build' && c.platform === platform && allowBuild)
        || (c.id === 'draft' && allowUpload) || (c.id === 'publish' && allowPublish) || c.id === 'public'));
      if (!check) {
        const pendingTasks = [remoteTask && !remoteCollected ? remoteTask : null].filter(Boolean);
        if (pendingTasks.length && Date.now() < deadline) { await Promise.race([...pendingTasks, pause(Math.min(waitMs, Math.max(1, deadline - Date.now())))]); continue; }
        if (waiting.size && Date.now() < deadline) { await new Promise((accept) => setTimeout(accept, Math.min(waitMs, deadline - Date.now()))); continue; }
        return { complete: stages.every((s) => ['passed', 'not-required'].includes(s.status)), stages, waiting: [...waiting.values()] };
      }
      const startedAt = new Date().toISOString();
      recordEvent(stateRoot, { kind: 'check-started', checkId: check.id, startedAt });
      atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'running', startedAt, host: hostname(), pid: process.pid });
      let receipt;
      try {
        if (handlers[check.id]) receipt = await handlers[check.id]({ root, stateRoot, plan, check });
        else if (check.kind === 'build') receipt = await durableBuild({ root, stateRoot, plan, check });
        else if (check.id === 'draft') {
          if (!publisherLease) publisherLease = acquirePublisherLease(plan, { recover: resume });
          if (check.id === 'draft') markPublisherMutation(plan, publisherLease.token, { stage: 'draft' });
          receipt = remoteStage({ root, stateRoot, plan, check, allowUpload });
        }
        else if (check.id === 'publish') {
          assertReadyToPublish(plan, stateRoot);
          // Reconcile a network-interrupted publication before invoking it again.
          const remote = JSON.parse(gh(root, ['release', 'view', `v${plan.version}`, '--repo', REPOSITORY, '--json', 'isDraft,targetCommitish']));
          if (remote.targetCommitish !== plan.commit) throw new Error('Publication target changed');
          assertPublicationVersion({ latest: JSON.parse(gh(root, ['api', `repos/${REPOSITORY}/releases/latest`])), plan, alreadyPublished: !remote.isDraft });
          if (remote.isDraft) {
            markPublisherMutation(plan, publisherLease.token);
            execFileSync(process.execPath, [resolve(root, 'scripts/finalize-release.mjs')], { cwd: root, env: { ...process.env, MYTHRA_RELEASE_STATE: stateRoot, MYTHRA_RELEASE_OWNER: readJson(resolve(stateRoot, 'lease.json')).token, MYTHRA_RELEASE_PUBLISHER_OWNER: publisherLease.token }, stdio: 'inherit' });
          }
          const path = resolve(stateRoot, 'evidence', 'published.json');
          atomicJson(path, { commit: plan.commit, tag: `v${plan.version}`, publishedAt: new Date().toISOString() });
          receipt = envelope(plan, check, startedAt, [path], stateRoot, { tag: `v${plan.version}` });
        }
        else if (check.id === 'public') {
          const release = JSON.parse(gh(root, ['release', 'view', `v${plan.version}`, '--repo', REPOSITORY,
            '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body']));
          assertRemoteRelease(release, plan, 'public');
          const path = resolve(stateRoot, 'evidence', 'public.json');
          atomicJson(path, { commit: plan.commit, tag: `v${plan.version}`,
            recordedAt: new Date().toISOString(), release });
          receipt = envelope(plan, check, startedAt, [path], stateRoot, { tag: `v${plan.version}` });
        }
        if (!(check.kind === 'build' && !handlers[check.id])) saveReceipt(stateRoot, plan, receipt);
        waiting.delete(check.id);
        recordEvent(stateRoot, { kind: 'check-passed', checkId: check.id, startedAt: receipt.startedAt, completedAt: receipt.completedAt });
        atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'passed', startedAt, completedAt: receipt.completedAt });
      } catch (error) {
        if (error.status === 'waiting') {
          const record = { checkId: check.id, reason: error.message, retryAt: Date.now() + waitMs };
          waiting.set(check.id, record);
          recordEvent(stateRoot, { kind: 'check-waiting', ...record });
          atomicJson(resolve(stateRoot, 'active-stage.json'), { ...record, status: 'waiting', startedAt });
          continue;
        }
        const active = existsSync(activePath) ? readJson(activePath) : {};
        recordEvent(stateRoot, { kind: 'check-blocked', checkId: check.id, reason: error.message });
        atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: active.status === 'cancelled' ? 'cancelled' : 'blocked', startedAt, stoppedAt: new Date().toISOString(), reason: error.message,
          ...(active.checkId === check.id && active.worker ? { worker: active.worker } : {}) });
        throw error;
      }
    }
  } finally {
    // A detached remote worker keeps ownership and can be collected on resume.
    // It cannot upload or publish, and a lost parent never authorizes a rebuild.
    workerAbort.abort();
    releaseLease();
    publisherLease?.();
  }
}

async function main(args) {
  const [command, ...rest] = args;
  const option = (name) => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
  const stateRoot = option('--state') && resolve(option('--state'));
  if (!stateRoot) throw new Error('Specify --state <absolute release state directory outside builder staging>');
  assertStateLocation(checkoutRoot, stateRoot);
  if (command === 'build-worker') {
    const registration = resolve(stateRoot, 'active-stage.json');
    const deadline = Date.now() + 30_000;
    while (!(existsSync(registration) && readJson(registration).worker?.pid === process.pid)) {
      if (Date.now() >= deadline) throw new Error('Worker registration handshake timed out; inspect preserved ownership');
      await pause(20);
    }
  }
  if (command === 'build-worker') {
    const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
    assertActiveRelease(plan, stateRoot);
    const check = plan.checks.find((c) => c.id === option('--check') && c.kind === 'build' && c.platform === platform);
    const lease = readJson(resolve(stateRoot, 'lease.json')), active = readJson(resolve(stateRoot, 'active-stage.json'));
    if (!check || lease.token !== option('--owner') || leaseStatus(lease) !== 'running' || lease.planHash !== plan.planHash
      || active.ownerToken !== lease.token || active.planHash !== plan.planHash || active.worker.pid !== process.pid || leaseStatus(active.worker) !== 'running') throw new Error('Native worker has no matching live coordinator contract');
    assertCheckout(checkoutRoot, plan);
    try {
      const receipt = buildStage({ root: checkoutRoot, stateRoot, plan, check, allowBuild: true });
      saveReceipt(stateRoot, plan, receipt);
      atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'passed', completedAt: receipt.completedAt });
    } catch (error) {
      atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'blocked', stoppedAt: new Date().toISOString(), reason: error.message,
        worker: { host: hostname(), pid: process.pid, processStart: processIdentity() } });
      throw error;
    }
  } else if (command === 'plan') {
    if (existsSync(resolve(stateRoot, 'plan.json'))) throw new Error('Release plan already frozen; use a new state directory');
    const input = readJson(option('--input'));
    atomicJson(resolve(stateRoot, 'plan.json'), planFromCheckout(checkoutRoot, input));
  } else if (command === 'workspace') {
    const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
    console.log(JSON.stringify(createReleaseWorkspace(checkoutRoot, option('--path'), plan.commit), null, 2));
  } else if (command === 'status') {
    const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
    console.log(JSON.stringify({ commit: plan.commit, planHash: plan.planHash,
      owner: existsSync(resolve(stateRoot, 'lease.json')) ? leaseStatus(readJson(resolve(stateRoot, 'lease.json'))) : 'idle',
      stages: reconcile(plan, stateRoot) }, null, 2));
  } else if (command === 'export') {
    console.log(JSON.stringify(exportHandoff(stateRoot, resolve(option('--to')), option('--platform')), null, 2));
  } else if (command === 'merge') {
    console.log(JSON.stringify(mergeHandoff(resolve(option('--from')), stateRoot), null, 2));
  } else if (command === 'run' || command === 'resume') {
    const result = await runRelease({ root: checkoutRoot, stateRoot, allowBuild: rest.includes('--build'), allowUpload: rest.includes('--upload'), allowPublish: rest.includes('--publish'), nativeOnly: rest.includes('--native-only'), resume: command === 'resume', retryReason: option('--retry-reason') ?? '' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  } else throw new Error('Commands: plan, workspace, status, export, merge, run, resume');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
