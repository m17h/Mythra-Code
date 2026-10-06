import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertUpgradeDecision, coversHistoricalUpgrade, historicalCoverageReason } from './release-upgrade-coverage.mjs';
import { assertReleaseVerification, expectedReceipts } from './verify-ci.mjs';

export const PLATFORMS = ['darwin-aarch64', 'windows-x86_64'];
export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const fileHash = (path) => digest(readFileSync(path));
export function realPath(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor); }
  return resolve(realpathSync(ancestor), ...suffix);
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const objectHash = (value) => digest(JSON.stringify(canonical(value)));
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function containedPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Evidence paths must be relative to the release state directory');
  const target = resolve(root, name);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence path escapes release state');
  if (existsSync(target)) {
    const realRel = relative(realpathSync(root), realpathSync(target));
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('Evidence symlink escapes release state');
  } else {
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const realRel = relative(realpathSync(root), realpathSync(ancestor));
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('Evidence parent symlink escapes release state');
  }
  return target;
}

export function assertPlan(plan) {
  const { planHash, ...payload } = plan;
  if (plan.schemaVersion !== 1 || plan.policyVersion !== 1 || !HASH.test(plan.policyHash)
    || typeof plan.publisherHost !== 'string' || plan.publisherHost.length > 253
    || plan.publisherHost.trim() !== plan.publisherHost || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan.publisherHost)
    || plan.repository !== 'm17h/Mythra-Code' || !SHA.test(plan.commit) || !SHA.test(plan.baseline?.commit)
    || !plan.baseline.tag || !plan.baseline.reason
    || !/^\d+\.\d+\.\d+$/.test(plan.version) || objectHash(payload) !== planHash) throw new Error('Invalid or modified release plan');
  const nativeIds = ['native-startup', 'native-close', 'native-storage', 'native-onboarding', 'native-installer'];
  if (['changedFiles', 'predecessors', 'classifications', 'knownIssues', 'overrides', 'boundaryHints', 'reviewRequired'].some((key) => !Array.isArray(plan[key]))) throw new Error('Invalid release scope inventory');
  const publicBaseline = plan.baseline.publicEvidence;
  if (publicBaseline !== undefined) {
    if (!publicBaseline || typeof publicBaseline !== 'object') throw new Error('Invalid frozen public baseline evidence');
    const latestMatches = publicBaseline.latestTag === plan.baseline.tag
      ? publicBaseline.latestCommit === plan.baseline.commit && publicBaseline.latestReleaseId === publicBaseline.releaseId
      : plan.predecessors.some((p) => p.tag === publicBaseline.latestTag && p.commit === publicBaseline.latestCommit && typeof p.reason === 'string' && p.reason.trim());
    if (publicBaseline.schemaVersion !== 1 || publicBaseline.repository !== plan.repository
      || publicBaseline.tag !== plan.baseline.tag || publicBaseline.commit !== plan.baseline.commit
      || !Number.isSafeInteger(publicBaseline.releaseId) || publicBaseline.releaseId <= 0
      || !Number.isSafeInteger(publicBaseline.latestReleaseId) || publicBaseline.latestReleaseId <= 0
      || typeof publicBaseline.latestTag !== 'string' || !publicBaseline.latestTag.trim() || !SHA.test(publicBaseline.latestCommit)
      || !Number.isFinite(Date.parse(publicBaseline.publishedAt)) || !Number.isFinite(Date.parse(publicBaseline.verifiedAt))
      || Date.parse(publicBaseline.verifiedAt) < Date.parse(publicBaseline.publishedAt)
      || Date.parse(publicBaseline.verifiedAt) > Date.now() + 60_000 || !latestMatches) throw new Error('Invalid frozen public baseline evidence');
  }
  const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
  const fixed = new Map([['ci', { kind: 'ci', required: true, dependsOn: [] }]]);
  for (const platform of PLATFORMS) {
    fixed.set(`build:${platform}`, { kind: 'build', platform, required: true, dependsOn: [] });
    fixed.set(`audit:${platform}`, { kind: 'audit', platform, required: true, dependsOn: [`build:${platform}`] });
    for (const id of nativeIds) fixed.set(`${id}:${platform}`, { kind: 'native', platform, dependsOn: [`audit:${platform}`] });
  }
  fixed.set('draft', { kind: 'draft', required: true });
  fixed.set('publish', { kind: 'publish', required: true, dependsOn: ['draft'] });
  fixed.set('public', { kind: 'public', required: true, dependsOn: ['publish'] });
  if (!Array.isArray(plan.checks) || plan.checks.some((c) => !c || typeof c !== 'object')
    || !sameSet(plan.checks.map((c) => c.id), [...fixed.keys()])) throw new Error('Invalid release check inventory');
  if (plan.upgradeCoverage !== undefined && !Array.isArray(plan.upgradeCoverage)) throw new Error('Invalid upgrade coverage inventory');
  for (const decision of plan.upgradeCoverage ?? []) assertUpgradeDecision(decision, plan);
  if (new Set((plan.upgradeCoverage ?? []).map((d) => `${d.predecessor.tag}:${d.platform}:${d.check}`)).size !== (plan.upgradeCoverage ?? []).length) throw new Error('Duplicate upgrade coverage');
  for (const check of plan.checks) {
    const contract = fixed.get(check.id);
    const covered = (plan.upgradeCoverage ?? []).filter((d) => d.reusable && `${d.check}:${d.platform}` === check.id).map((d) => d.proofHash);
    if (!sameSet(check.historicalCoverage ?? [], covered)) throw new Error('Historical coverage decision differs from selected check');
    const dependencies = check.id === 'draft' ? ['ci', ...plan.checks.filter((c) => c.required && (c.kind === 'native' || c.kind === 'audit')).map((c) => c.id)] : contract.dependsOn;
    if (check.kind !== contract.kind || check.platform !== contract.platform || typeof check.required !== 'boolean'
      || (contract.required && !check.required) || typeof check.reason !== 'string' || !check.reason.trim()
      || !Array.isArray(check.dependsOn) || !sameSet(check.dependsOn, dependencies)
      || check.dependsOn.some((id) => !plan.checks.some((c) => c.id === id && c.required))
      || (check.kind === 'native' && check.required === (check.reason === historicalCoverageReason(plan.upgradeCoverage ?? [], check.id.split(':')[0], check.platform)))) throw new Error(`Invalid check contract: ${check.id}`);
  }
  // Additions/classifications can only add native gates. Keep their persisted
  // decisions consistent with required flags without duplicating the planner's
  // source-path classifier here. Exact fixed edges above also exclude cycles.
  const additions = [...plan.knownIssues, ...plan.overrides, ...plan.boundaryHints];
  for (const scope of [plan, ...plan.predecessors]) {
    if (!Array.isArray(scope.changedFiles) || (scope.classifications !== undefined && !Array.isArray(scope.classifications))
      || (scope.boundaryHints !== undefined && !Array.isArray(scope.boundaryHints))) throw new Error('Invalid release scope classification');
    if (scope !== plan) additions.push(...(scope.boundaryHints ?? []).map((item) => ({ ...item, predecessor: scope })));
    for (const c of scope.classifications ?? []) {
      if (!c || !scope.changedFiles.includes(c.path) || !c.reason || !c.evidence || !Array.isArray(c.boundaries)) throw new Error('Invalid release scope classification');
      additions.push(...c.boundaries.map((check) => ({ check, reason: c.reason, ...(scope !== plan ? { predecessor: scope } : {}) })));
    }
  }
  for (const item of additions) {
    if (!item || !nativeIds.includes(item.check) || !item.reason || (item.platform && !PLATFORMS.includes(item.platform))) throw new Error('Invalid native-check addition');
    for (const platform of item.platform ? [item.platform] : PLATFORMS) {
      if (item.predecessor && coversHistoricalUpgrade(plan, item.predecessor, item.check, platform)) continue;
      if (!plan.checks.find((c) => c.id === `${item.check}:${platform}`).required) throw new Error(`Required native addition omitted: ${item.check}:${platform}`);
    }
  }
  return plan;
}

// Native harnesses emit this same envelope. A receipt is evidence, not authority:
// the coordinator independently checks the frozen plan, dependencies and files.
export function assertReceipt(receipt, plan, stateRoot, { packageSha256 } = {}) {
  assertPlan(plan);
  const check = plan.checks.find((c) => c.id === receipt.checkId && c.required);
  if (!check || receipt.schemaVersion !== 1 || receipt.status !== 'passed' || receipt.planHash !== plan.planHash
    || receipt.commit !== plan.commit || typeof receipt.checkerVersion !== 'string' || !receipt.checkerVersion) throw new Error(`Invalid receipt: ${receipt.checkId}`);
  if (check.platform && receipt.platform !== check.platform) throw new Error('Receipt platform mismatch');
  if (check.dependsOn.some((id) => !existsSync(receiptPath(stateRoot, id)) || receipt.parents?.[id] !== fileHash(receiptPath(stateRoot, id)))
    || Object.keys(receipt.parents ?? {}).length !== check.dependsOn.length) throw new Error('Receipt dependency evidence changed');
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 60_000) throw new Error('Invalid receipt timestamps');
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.length) throw new Error('Receipt needs inspectable evidence');
  for (const item of receipt.evidence) {
    const path = containedPath(stateRoot, item.path);
    if (!HASH.test(item.sha256) || !statSync(path).isFile() || fileHash(path) !== item.sha256) throw new Error(`Changed or missing evidence: ${item.path}`);
  }
  if (check.kind === 'native') {
    if (!HASH.test(receipt.packageSha256) || !packageSha256 || receipt.packageSha256 !== packageSha256) throw new Error('Native receipt does not match approved package');
    if (receipt.details?.cleanupComplete !== true || receipt.details?.restorationComplete !== true) throw new Error('Native cleanup/restoration is incomplete');
  }
  if (check.kind === 'audit' && (!packageSha256 || receipt.details?.packageSha256 !== packageSha256)) throw new Error('Integrity receipt does not match approved package');
  assertReceiptDetails(receipt, check, plan, stateRoot);
  return receipt;
}

function assertReceiptDetails(receipt, check, plan, root) {
  const d = receipt.details;
  if (!d || typeof d !== 'object') throw new Error('Receipt is missing its typed checker result');
  const coordinator = receipt.checkerVersion === 'release-coordinator-v1';
  if (check.kind === 'ci') {
    if (!coordinator || d.repository !== plan.repository || d.commit !== plan.commit || !Number.isSafeInteger(d.runId)
      || d.input?.checkout !== plan.commit || d.input?.head !== plan.commit || !['push', 'workflow_dispatch'].includes(d.input?.event)
      || !Array.isArray(d.receiptHashes) || objectHash(d.receiptHashes.map((r) => r.id).sort()) !== objectHash(expectedReceipts().sort())
      || d.receiptHashes.some((r) => !HASH.test(r.sha256))) throw new Error('Invalid typed hosted CI result');
    assertReleaseVerification({ headSha: plan.commit, status: 'completed', conclusion: 'success' }, d.jobs ?? [], plan.commit);
  } else if (check.kind === 'build') {
    if (!coordinator || d.exitCode !== 0 || !Array.isArray(d.command) || d.command.length !== 3 || d.command[1] !== 'run' || d.command[2] !== 'release:build'
      || !d.node || !d.host || !HASH.test(d.packageSha256) || !d.packagePath) throw new Error('Invalid typed native build result');
    if (fileHash(containedPath(root, d.packagePath)) !== d.packageSha256 || !receipt.evidence.some((e) => e.path === d.packagePath && e.sha256 === d.packageSha256)) throw new Error('Build package is missing from its evidence');
    const expected = check.platform === 'darwin-aarch64' ? `MythraCode_${plan.version}_aarch64.dmg` : `MythraCode_${plan.version}_x64-setup.exe`;
    if (d.packagePath.split('/').at(-1) !== expected) throw new Error('Build package/version mismatch');
  } else if (check.kind === 'audit') {
    if (receipt.checkerVersion !== 'native-integrity-v1' || !HASH.test(d.packageSha256)) throw new Error('Invalid typed native integrity result');
    if (check.platform === 'darwin-aarch64' && (!HASH.test(d.archiveSha256) || !HASH.test(d.executableSha256) || ['codesign', 'notarization', 'gatekeeper', 'bundleEquivalence'].some((key) => d[key] !== 'passed') || !(d.bundleEntries > 0))) throw new Error('Incomplete macOS integrity audit');
    if (check.platform === 'windows-x86_64' && (!HASH.test(d.executableSha256) || d.payloadPe?.machine !== 0x8664 || d.payloadPe?.subsystem !== 'WindowsGui' || d.payloadVersion !== plan.version || d.authenticodeStatus !== 'NotSigned')) throw new Error('Incomplete Windows integrity audit');
  } else if (check.kind === 'draft' || check.kind === 'public') {
    const expected = ['latest.json', 'release-notes.md', 'MythraCode-icon.png', 'build-info.txt', 'build-info.json', `MythraCode_${plan.version}_aarch64.app.tar.gz`, `MythraCode_${plan.version}_aarch64.dmg`, `MythraCode_${plan.version}_x64-setup.exe`, `MythraCode_${plan.version}_x64-setup.exe.sig`];
    if (!coordinator || d.version !== plan.version || d.commit !== plan.commit || objectHash(Object.keys(d.hashes ?? {}).sort()) !== objectHash(expected.sort())
      || objectHash([...(d.signaturesVerified ?? [])].sort()) !== objectHash([...PLATFORMS].sort())
      || expected.some((name) => !HASH.test(d.hashes[name]) || !receipt.evidence.some((e) => e.path.split('/').at(-1) === name && e.sha256 === d.hashes[name]))) throw new Error('Invalid typed combined asset audit');
  } else if (check.kind === 'publish') {
    if (!coordinator || d.tag !== `v${plan.version}`) throw new Error('Invalid typed publication result');
  } else if (check.kind === 'native') {
    if (receipt.checkerVersion !== 'native-check-v1' || !d.workerContractHash || !HASH.test(d.workerContractHash) || !d.sessionId
      || !d.executablePath || !HASH.test(d.executableSha256) || !Number.isInteger(d.pid) || !d.windowIdentity
      || !Array.isArray(d.observations) || !d.observations.length
      || !receipt.evidence.some((e) => /\.(png|jpe?g)$/.test(e.path)) || !receipt.evidence.some((e) => /(?:accessibility|ax)\.json$/.test(e.path))) throw new Error('Invalid typed native UI worker result');
    if (d.runtime?.model !== 'gpt-6.1-sol' || d.runtime?.reasoningEffort !== 'high' || d.runtime?.approvalPolicy !== 'never' || d.runtime?.sandbox !== 'danger-full-access'
      || d.version !== plan.version || !/^[a-f0-9-]{36}$/.test(d.runId)
      || d.executableSha256 !== readJson(receiptPath(root, `audit:${check.platform}`)).details.executableSha256) throw new Error('Native worker runtime or audited executable identity mismatch');
  } else throw new Error('Unknown release checker kind');
}

export function processIdentity(pid = process.pid) {
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
export function leaseStatus(lease, identity = processIdentity) {
  if (lease.host !== hostname()) return 'foreign-host';
  const observed = identity(lease.pid);
  return observed && observed === lease.processStart ? 'running' : 'orphaned';
}
export function workerTreeAlive(worker) {
  if (worker.host !== hostname()) return true;
  if (!Number.isInteger(worker.pid)) throw new Error('Invalid worker process identity');
  if (process.platform === 'win32') {
    const processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' }));
    // Windows retains a child's creation parent PID after that parent exits.
    return processes.some((p) => p.ParentProcessId === worker.pid) || leaseStatus(worker) === 'running';
  }
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  return rows.some(([, group]) => group === worker.pid);
}
export function acquireLease(root, { recover = false, identity = processIdentity, validateRecovery = () => {} } = {}) {
  mkdirSync(root, { recursive: true });
  const path = resolve(root, 'lease.json');
  const lease = { token: randomUUID(), host: hostname(), pid: process.pid, processStart: identity(process.pid), startedAt: new Date().toISOString() };
  if (!lease.processStart) throw new Error('Cannot establish release worker identity');
  if (existsSync(path)) {
    const guard = resolve(root, 'lease-recovery.lock');
    let guardFd;
    try {
      guardFd = openSync(guard, 'wx', 0o600);
      const old = readJson(path), status = leaseStatus(old, identity);
      if (!recover || status !== 'orphaned') throw new Error(`Release already has a ${status} owner; inspect status before resume`);
      // The callback examines the reread owner under this same lock. Publisher
      // recovery must not mistake a dead coordinator for exited mutation children.
      validateRecovery(old);
      // Serialize recovery so another resumer cannot rename a newly owned lease.
      renameSync(path, resolve(root, `orphaned-lease-${objectHash(old)}.json`));
    } finally { if (guardFd !== undefined) { closeSync(guardFd); rmSync(guard, { force: true }); } }
  }
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(lease)}\n`); } finally { closeSync(fd); }
  return () => { if (existsSync(path) && readJson(path).token === lease.token) rmSync(path); };
}

export function reconcile(plan, stateRoot) {
  assertPlan(plan);
  const entries = new Map();
  const visit = (check) => {
    if (entries.has(check.id)) return entries.get(check.id);
    const dependencies = check.dependsOn.map((id) => visit(plan.checks.find((c) => c.id === id)));
    let entry;
    if (!check.required) entry = { id: check.id, status: 'not-required', reason: check.reason };
    else if (dependencies.some((d) => d.status !== 'passed')) entry = { id: check.id, status: 'waiting', reason: 'Required dependency is incomplete' };
    else {
      const path = resolve(stateRoot, 'receipts', `${check.id.replaceAll(':', '_')}.json`);
      if (!existsSync(path)) entry = { id: check.id, status: 'pending', reason: check.reason };
      else try {
        const build = check.platform && plan.checks.find((c) => c.id === `build:${check.platform}`);
        const buildReceipt = build && existsSync(resolve(stateRoot, 'receipts', `build_${check.platform}.json`)) ? readJson(resolve(stateRoot, 'receipts', `build_${check.platform}.json`)) : null;
        const receipt = assertReceipt(readJson(path), plan, stateRoot, { packageSha256: buildReceipt?.details?.packageSha256 });
        entry = { id: check.id, status: 'passed', completedAt: receipt.completedAt };
      } catch (error) { entry = { id: check.id, status: 'invalid', reason: error.message }; }
    }
    entries.set(check.id, entry); return entry;
  };
  return plan.checks.map(visit);
}

export function receiptPath(root, id) { return resolve(root, 'receipts', `${id.replaceAll(':', '_')}.json`); }
export function saveReceipt(root, plan, receipt) {
  const dependencies = plan.checks.find((c) => c.id === receipt.checkId)?.dependsOn ?? [];
  const current = reconcile(plan, root);
  if (dependencies.some((id) => current.find((c) => c.id === id)?.status !== 'passed')) throw new Error('Receipt dependencies are incomplete');
  const buildPath = receipt.platform && receiptPath(root, `build:${receipt.platform}`);
  const bound = { ...receipt, parents: Object.fromEntries(dependencies.map((id) => [id, fileHash(receiptPath(root, id))])) };
  assertReceipt(bound, plan, root, { packageSha256: buildPath && existsSync(buildPath) ? readJson(buildPath).details?.packageSha256 : undefined });
  if (existsSync(receiptPath(root, receipt.checkId))) {
    if (objectHash(readJson(receiptPath(root, receipt.checkId))) !== objectHash(bound)) throw new Error('Completion receipts are immutable; investigate conflicting worker evidence');
    return;
  }
  atomicJson(receiptPath(root, receipt.checkId), bound);
}
