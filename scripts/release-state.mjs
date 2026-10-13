import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const PLATFORMS = ['darwin-aarch64', 'windows-x86_64'];
export const appliesToPlatform = (file, platform) => platform === 'windows-x86_64'
  || (!file.startsWith('Windows/') && file !== 'src-tauri/tauri.windows.conf.json');
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
  if (plan.schemaVersion !== 1 || ![1, 2].includes(plan.policyVersion) || !HASH.test(plan.policyHash)
    || typeof plan.publisherHost !== 'string' || plan.publisherHost.length > 253
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan.publisherHost)
    || plan.repository !== 'm17h/Mythra-Code' || !SHA.test(plan.commit)
    || !/^\d+\.\d+\.\d+$/.test(plan.version) || objectHash(payload) !== planHash)
    throw new Error('Invalid or modified release plan');
  if (!Array.isArray(plan.checks) || plan.checks.some((c) => !c || typeof c.id !== 'string'
    || typeof c.kind !== 'string' || typeof c.required !== 'boolean' || !Array.isArray(c.dependsOn))
    || new Set(plan.checks.map((c) => c.id)).size !== plan.checks.length
    || plan.checks.some((c) => c.dependsOn.some((id) => !plan.checks.some((p) => p.id === id))))
    throw new Error('Invalid release stage inventory');
  const visited = new Set(), visiting = new Set();
  const visit = (stage) => {
    if (visiting.has(stage.id)) throw new Error('Cyclic release operation dependencies');
    if (visited.has(stage.id)) return;
    visiting.add(stage.id);
    for (const id of stage.dependsOn) visit(plan.checks.find((parent) => parent.id === id));
    visiting.delete(stage.id); visited.add(stage.id);
  };
  plan.checks.forEach(visit);
  // Historical plans remain inspectable, without rewriting their frozen graph or
  // fabricating receipts. Only version 2 plans are executable by this coordinator.
  if (plan.policyVersion === 1) return plan;
  const contracts = new Map(PLATFORMS.map((platform) => [`build:${platform}`,
    { kind: 'build', platform, dependsOn: [] }]));
  contracts.set('draft', { kind: 'draft', dependsOn: PLATFORMS.map((p) => `build:${p}`) });
  contracts.set('publish', { kind: 'publish', dependsOn: ['draft'] });
  contracts.set('public', { kind: 'public', dependsOn: ['publish'] });
  if (plan.checks.length !== contracts.size) throw new Error('Invalid release stage inventory');
  for (const stage of plan.checks) {
    const contract = contracts.get(stage.id);
    if (!contract || stage.kind !== contract.kind || stage.platform !== contract.platform || !stage.required
      || typeof stage.reason !== 'string' || !stage.reason.trim()
      || objectHash([...stage.dependsOn].sort()) !== objectHash([...contract.dependsOn].sort()))
      throw new Error(`Invalid release stage contract: ${stage.id}`);
  }
  return plan;
}

// Operation records bind completed work to its frozen source and dependencies.
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
  if (plan.policyVersion === 2) assertReceiptDetails(receipt, check, plan, stateRoot);
  return receipt;
}

function assertReceiptDetails(receipt, check, plan, root) {
  const d = receipt.details;
  if (!d || typeof d !== 'object' || receipt.checkerVersion !== 'release-coordinator-v1')
    throw new Error('Receipt is missing its release operation result');
  if (check.kind === 'build') {
    if (d.exitCode !== 0 || !Array.isArray(d.command) || d.command.length !== 3
      || d.command[1] !== 'run' || d.command[2] !== 'release:build'
      || !d.node || !d.host || !HASH.test(d.packageSha256) || !d.packagePath)
      throw new Error('Invalid native build result');
    if (fileHash(containedPath(root, d.packagePath)) !== d.packageSha256
      || !receipt.evidence.some((e) => e.path === d.packagePath && e.sha256 === d.packageSha256))
      throw new Error('Build package is missing from its record');
    const expected = check.platform === 'darwin-aarch64'
      ? `MythraCode_${plan.version}_aarch64.dmg` : `MythraCode_${plan.version}_x64-setup.exe`;
    if (d.packagePath.split('/').at(-1) !== expected) throw new Error('Build package/version mismatch');
  } else if (check.kind === 'draft') {
    if (d.version !== plan.version || d.commit !== plan.commit || d.tag !== `v${plan.version}`
      || objectHash([...(d.platforms ?? [])].sort()) !== objectHash([...PLATFORMS].sort()))
      throw new Error('Invalid combined draft operation result');
  } else if (check.kind === 'publish' || check.kind === 'public') {
    if (d.tag !== `v${plan.version}`) throw new Error('Invalid publication result');
  } else throw new Error('Unknown release operation');
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
