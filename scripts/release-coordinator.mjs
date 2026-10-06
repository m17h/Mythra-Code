import { revalidatePlanCoverage } from './release-upgrade-coverage.mjs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, assertPlan, atomicJson, containedPath, fileHash, leaseStatus, objectHash, PLATFORMS, processIdentity, readJson, realPath, receiptPath, reconcile, saveReceipt, SHA, workerTreeAlive } from './release-state.mjs';
import { planFromCheckout } from './release-plan.mjs';
import { REPOSITORY, verifyHostedEvidence } from './release-evidence.mjs';
import { assetNames, assertDownloadedRemote, assertPlatformManifests, assertPublicationVersion, assertRemoteRelease, assertTagTarget, auditAssets } from './release-audit.mjs';
import { uploadPlatformDraft } from './release-draft.mjs';
import { exportHandoff, mergeHandoff } from './release-handoff.mjs';
import { runNativeCheck } from './release-native-check.mjs';
import { runWindowsWorker } from './release-remote.mjs';

const checkoutRoot = resolve(import.meta.dirname, '..');
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
  if (plan.publisherHost !== hostname() || process.platform === 'win32') throw new Error('Only the frozen designated publisher host can upload, finalize or audit publication');
  const lease = readJson(resolve(publisherLeaseDirectory(plan, registry), 'lease.json'));
  if (!ownerToken || lease.token !== ownerToken || leaseStatus(lease) !== 'running' || lease.planHash !== plan.planHash || lease.commit !== plan.commit || lease.version !== plan.version) throw new Error('Publication has no matching live host-global owner');
  return lease;
}
export function acquirePublisherLease(plan, { recover = false, registry = publisherRegistry() } = {}) {
  if (plan.publisherHost !== hostname() || process.platform === 'win32') throw new Error('Only the frozen designated publisher host can upload, finalize or audit publication');
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
  if (!plan.baseline?.publicEvidence) throw new Error('Release plan has no verified public baseline; recreate it through release:plan');
  const stages = reconcile(plan, stateRoot);
  const pending = stages.filter((s) => !['publish', 'public'].includes(s.id) && !['passed', 'not-required'].includes(s.status));
  if (pending.length) throw new Error(`Release validation incomplete: ${pending.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  return readJson(receiptPath(stateRoot, 'draft'));
}

export function prepareMacBuildDependencies({ root, env, descriptor, execute = spawnSync }) {
  const args = ['ci', '--no-audit', '--no-fund'];
  const result = execute('npm', args, { cwd: root, env, stdio: ['ignore', descriptor, descriptor], timeout: 15 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`macOS dependency setup failed (${result.status ?? result.error?.code}); inspect preserved native build log`);
  return { command: ['npm', ...args], exitCode: 0 };
}

function buildStage({ root, stateRoot, plan, check, allowBuild }) {
  if (!allowBuild) throw new Error('Build requires release authorization at kickoff (--build); status/plan never build');
  const startedAt = new Date().toISOString();
  const stage = resolve(stateRoot, 'candidates', check.platform);
  if (existsSync(stage)) throw new Error('Candidate files already exist without a valid receipt; inspect and recover them, never rebuild automatically');
  const log = resolve(stateRoot, 'logs', `build-${check.platform}-${Date.now()}.log`);
  mkdirSync(resolve(stateRoot, 'logs'), { recursive: true });
  const env = { ...process.env };
  const proofPath = receiptPath(stateRoot, 'ci');
  if (existsSync(proofPath)) env.MYTHRA_RELEASE_CI_RUN = String(readJson(proofPath).details.runId);
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
    worker: { host: hostname(), pid: child.pid, processStart }, ownerToken: token });
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Native build worker exited ${code}; inspect active-stage.json and preserved logs`))); });
  // The worker owns its completion receipt, so it can finish after a coordinator
  // interruption. Returning it never invokes the builder a second time.
  return readJson(receiptPath(stateRoot, check.id));
}

function remoteStage({ root, stateRoot, plan, check, allowUpload }) {
  const startedAt = new Date().toISOString(), tag = `v${plan.version}`;
  if (check.id === 'draft' && !allowUpload) throw new Error('Draft upload/audit requires release authorization at kickoff (--upload)');
  if (check.id === 'draft') {
    assertPublicationVersion({ latest: JSON.parse(gh(root, ['api', `repos/${REPOSITORY}/releases/latest`])), plan });
    // One coordinator owns the draft. Platform uploads are serialized and read
    // immutable candidates, never rebuilding or repopulating mutable staging.
    for (const p of PLATFORMS) {
      const directory = resolve(stateRoot, 'candidates', p);
      uploadPlatformDraft({ root, repository: REPOSITORY, tag, target: plan.commit,
        manifest: readJson(resolve(directory, 'latest.json')),
        assetPaths: readdirSync(directory).map((name) => resolve(directory, name)),
        ...(p === 'darwin-aarch64' ? { notesFile: resolve(directory, 'release-notes.md') } : {}) });
    }
    gh(root, ['release', 'edit', tag, '--repo', REPOSITORY, '--notes-file', resolve(stateRoot, 'candidates/darwin-aarch64/release-notes.md')]);
  }
  const release = JSON.parse(gh(root, ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body']));
  assertRemoteRelease(release, plan, check.id === 'draft' ? 'draft' : 'public');
  assertTagTarget({ root, plan, phase: check.id });
  const directory = resolve(stateRoot, 'downloads', `${check.id}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  gh(root, ['release', 'download', tag, '--repo', REPOSITORY, '--dir', directory]);
  const approved = check.id === 'public' ? readJson(receiptPath(stateRoot, 'draft')).details.hashes : undefined;
  const result = auditAssets({ root, directory, plan, expectedHashes: approved });
  const after = JSON.parse(gh(root, ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body']));
  assertDownloadedRemote({ release, after, directory, plan, phase: check.id });
  assertPlatformManifests({ manifest: readJson(resolve(directory, 'latest.json')), version: plan.version,
    candidates: Object.fromEntries(PLATFORMS.map((p) => [p, readJson(resolve(stateRoot, 'candidates', p, 'latest.json'))])) });
  const notes = readFileSync(resolve(directory, 'release-notes.md'), 'utf8').trim();
  if (release.body.trim() !== notes) throw new Error('GitHub release body differs from approved release notes');
  if (check.id === 'draft') {
    for (const p of PLATFORMS) {
      const build = readJson(receiptPath(stateRoot, `build:${p}`));
      for (const item of build.evidence) {
        const name = item.path.split('/').at(-1);
        if (['latest.json'].includes(name) || !assetNames(plan.version).includes(name)) continue;
        if (result.hashes[name] !== item.sha256) throw new Error(`Draft differs from approved candidate: ${name}`);
      }
    }
  } else {
    const latest = JSON.parse(gh(root, ['api', `repos/${REPOSITORY}/releases/latest`]));
    if (latest.tag_name !== tag) throw new Error('The published release is not latest');
    const updater = execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`]);
    if (Buffer.compare(updater, readFileSync(resolve(directory, 'latest.json'))) !== 0) throw new Error('Public updater endpoint differs from the audited manifest');
  }
  const report = resolve(directory, '..', `${check.id}-audit-${Date.now()}.json`);
  atomicJson(report, { ...result, releaseAssets: release.assets.map(({ name, id, size }) => ({ name, id, size })) });
  return envelope(plan, check, startedAt, [report, ...assetNames(plan.version).map((name) => resolve(directory, name))], stateRoot, result);
}

export async function runRelease({ root, stateRoot, allowBuild = false, allowUpload = false, allowPublish = false, resume = false, retryReason = '', handlers = {}, remoteWorker = runWindowsWorker, waitMs = 15_000, deadlineMs = 2 * 60 * 60_000 }) {
  assertStateLocation(root, stateRoot);
  const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
  assertCheckout(root, plan);
  // Remote native workers consume the frozen selection only. The designated
  // publisher reopens historical evidence before any orchestration/publication.
  if (hostname() === plan.publisherHost) revalidatePlanCoverage({ root, plan });
  if (plan.reviewRequired?.length) throw new Error('Resolve semantic classification before running the release');
  const activePath = resolve(stateRoot, 'active-stage.json');
  if (existsSync(activePath)) {
    const previous = readJson(activePath);
    if (previous.worker && workerTreeAlive(previous.worker)) throw new Error('Native worker or its descendants are still running (or belong to another host); wait for its receipt, do not restart it');
    if (previous.status === 'running' && previous.worker && !existsSync(receiptPath(stateRoot, previous.checkId)) && !retryReason.trim()) throw new Error('Interrupted native worker has no completion receipt; inspect logs/outputs and record a retry reason after confirming its process tree is gone');
    if (previous.status === 'blocked' && !retryReason.trim()) throw new Error(`Previous ${previous.checkId} failed: ${previous.reason}. Resume needs --retry-reason explaining the resolved cause; no blind retries.`);
    if (retryReason.trim()) atomicJson(resolve(stateRoot, 'recovery', `retry-${Date.now()}.json`), { checkId: previous.checkId, reason: retryReason, recordedAt: new Date().toISOString() });
  }
  if (!plan.baseline?.publicEvidence) throw new Error('Release plan has no verified public baseline; recreate it through release:plan');
  const integrityAdapter = resolve(root, 'scripts/release-native-integrity.mjs');
  if (platform && existsSync(integrityAdapter) && !handlers[`audit:${platform}`]) {
    const { pathToFileURL } = await import('node:url');
    const { runNativeIntegrity } = await import(pathToFileURL(integrityAdapter).href);
    if (typeof runNativeIntegrity !== 'function') throw new Error('Native integrity adapter contract is missing');
    handlers = { ...handlers, [`audit:${platform}`]: runNativeIntegrity };
  }
  for (const check of plan.checks.filter((c) => c.kind === 'native' && c.platform === platform && c.required)) {
    if (!handlers[check.id]) handlers = { ...handlers, [check.id]: runNativeCheck };
  }
  const releaseLease = acquireLease(stateRoot, { recover: resume });
  let publisherLease;
  const ownerToken = readJson(resolve(stateRoot, 'lease.json')).token;
  const waiting = new Map();
  const deadline = Date.now() + deadlineMs;
  let remoteTask = null, remoteResult = null, remoteError = null, remoteCollected = false, remoteNextAt = 0;
  try {
    recordEvent(stateRoot, { kind: 'coordinator-started', resume, planHash: plan.planHash });
    if (allowUpload || allowPublish) {
      while (!publisherLease) {
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
      const stages = reconcile(plan, stateRoot);
      const invalid = stages.filter((s) => s.status === 'invalid');
      if (invalid.length) throw new Error(`Evidence invalidated; inspect before rerunning: ${JSON.stringify(invalid)}`);
      // Windows starts once complete CI can replace its duplicate local verify.
      // It then builds concurrently with the Mac package/native stages.
      if (!remoteTask && Date.now() >= remoteNextAt && Date.now() < deadline && platform === 'darwin-aarch64' && allowBuild && !handlers['build:windows-x86_64']
        && stages.find((s) => s.id === 'ci')?.status === 'passed'
        && stages.some((s) => s.id.endsWith(':windows-x86_64') && !['passed', 'not-required'].includes(s.status))) {
        remoteTask = remoteWorker({ root, stateRoot, plan, onStatus: (status) => atomicJson(resolve(stateRoot, 'remote-status.json'), status) })
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
      const check = ready.find((c) => handlers[c.id] || c.kind === 'ci' || (c.kind === 'build' && c.platform === platform && allowBuild)
        || (c.id === 'draft' && allowUpload) || (c.id === 'publish' && allowPublish) || (c.id === 'public' && plan.publisherHost === hostname() && process.platform !== 'win32'));
      if (!check) {
        if (remoteTask && !remoteCollected) { await remoteTask; continue; }
        if (waiting.size && Date.now() < deadline) { await new Promise((accept) => setTimeout(accept, Math.min(waitMs, deadline - Date.now()))); continue; }
        return { complete: stages.every((s) => ['passed', 'not-required'].includes(s.status)), stages, waiting: [...waiting.values()] };
      }
      const startedAt = new Date().toISOString();
      recordEvent(stateRoot, { kind: 'check-started', checkId: check.id, startedAt });
      atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'running', startedAt, host: hostname(), pid: process.pid });
      let receipt;
      try {
        if (handlers[check.id]) receipt = await handlers[check.id]({ root, stateRoot, plan, check });
        else if (check.kind === 'ci') {
          const proof = verifyHostedEvidence({ root, commit: plan.commit });
          const path = resolve(stateRoot, 'evidence', `ci-${proof.runId}.json`); atomicJson(path, proof);
          receipt = envelope(plan, check, startedAt, [path], stateRoot, proof);
        } else if (check.kind === 'build') receipt = await durableBuild({ root, stateRoot, plan, check });
        else if (check.id === 'draft' || check.id === 'public') {
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
        atomicJson(resolve(stateRoot, 'active-stage.json'), { checkId: check.id, status: 'blocked', startedAt, stoppedAt: new Date().toISOString(), reason: error.message,
          ...(active.checkId === check.id && active.worker ? { worker: active.worker } : {}) });
        throw error;
      }
    }
  } finally {
    // A detached remote worker keeps ownership and can be collected on resume.
    // It cannot upload or publish, and a lost parent never authorizes a rebuild.
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
    const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
    const check = plan.checks.find((c) => c.id === option('--check') && c.kind === 'build' && c.platform === platform);
    if (!check || readJson(resolve(stateRoot, 'lease.json')).token !== option('--owner')) throw new Error('Native worker has no matching coordinator contract');
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
    const result = await runRelease({ root: checkoutRoot, stateRoot, allowBuild: rest.includes('--build'), allowUpload: rest.includes('--upload'), allowPublish: rest.includes('--publish'), resume: command === 'resume', retryReason: option('--retry-reason') ?? '' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  } else throw new Error('Commands: plan, workspace, status, export, merge, run, resume');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
