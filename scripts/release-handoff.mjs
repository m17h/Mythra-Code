import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquireLease, assertPlan, atomicJson, containedPath, fileHash, leaseStatus, readJson, receiptPath, reconcile, saveReceipt } from './release-state.mjs';

// Portable file handoffs contain no credentials, lease, active process state or
// code to execute. Transfer through the authorized LAN mechanism, then merge.
export function exportHandoff(source, destination, platform, { platformOnly = false } = {}) {
  if (platformOnly && !platform) throw new Error('Platform-only handoff needs a platform');
  if (existsSync(destination)) throw new Error('Handoff destination must be new');
  const plan = assertPlan(readJson(resolve(source, 'plan.json')));
  const statuses = reconcile(plan, source);
  mkdirSync(destination, { recursive: true });
  atomicJson(resolve(destination, 'plan.json'), plan);
  const checks = [];
  for (const check of plan.checks) {
    if (statuses.find((s) => s.id === check.id).status !== 'passed' || (platform && check.platform && check.platform !== platform)
      || (platformOnly && check.platform !== platform)
      || ['draft', 'publish', 'public'].includes(check.id)) continue;
    const receipt = readJson(receiptPath(source, check.id));
    for (const item of receipt.evidence) {
      const target = containedPath(destination, item.path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(containedPath(source, item.path), target, { force: false, errorOnExist: false });
    }
    const target = receiptPath(destination, check.id);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(receiptPath(source, check.id), target);
    checks.push(check.id);
  }
  atomicJson(resolve(destination, 'handoff.json'), { schemaVersion: 1, planHash: plan.planHash, checks });
  return { planHash: plan.planHash, checks };
}

export function mergeHandoff(source, destination, { ownerToken } = {}) {
  const incoming = assertPlan(readJson(resolve(source, 'plan.json')));
  const existing = assertPlan(readJson(resolve(destination, 'plan.json')));
  if (incoming.planHash !== existing.planHash) throw new Error('Worker handoff is for another release plan');
  const manifest = readJson(resolve(source, 'handoff.json'));
  if (manifest.schemaVersion !== 1 || manifest.planHash !== existing.planHash || !Array.isArray(manifest.checks)
    || new Set(manifest.checks).size !== manifest.checks.length) throw new Error('Invalid worker handoff manifest');
  const statuses = reconcile(incoming, source);
  const records = manifest.checks.map((id) => {
    if (['draft', 'publish', 'public'].includes(id) || statuses.find((s) => s.id === id)?.status !== 'passed') throw new Error(`Worker handoff has invalid stage ${id}`);
    return readJson(receiptPath(source, id));
  });
  if (ownerToken && (readJson(resolve(destination, 'lease.json')).token !== ownerToken || leaseStatus(readJson(resolve(destination, 'lease.json'))) !== 'running')) throw new Error('Handoff merge has no live coordinator owner');
  const releaseLease = ownerToken ? () => {} : acquireLease(destination);
  try {
    // Validate ALL collisions before copying: never overwrite approved evidence.
    for (const record of records) {
      const previous = receiptPath(destination, record.checkId);
      if (existsSync(previous) && fileHash(previous) !== fileHash(receiptPath(source, record.checkId))) throw new Error(`Conflicting receipt ${record.checkId}`);
      for (const item of record.evidence) {
        const path = containedPath(destination, item.path);
        if (existsSync(path) && fileHash(path) !== item.sha256) throw new Error(`Conflicting evidence ${item.path}`);
      }
    }
    for (const record of records) for (const item of record.evidence) {
      const target = containedPath(destination, item.path);
      if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); cpSync(containedPath(source, item.path), target, { force: false, errorOnExist: true }); }
    }
    // Dependency order is semantic; valid plans need not list parents first.
    const pending = records.filter((record) => !existsSync(receiptPath(destination, record.checkId)));
    while (pending.length) {
      const ready = pending.findIndex((record) => existing.checks.find((c) => c.id === record.checkId).dependsOn.every((id) => existsSync(receiptPath(destination, id))));
      if (ready < 0) throw new Error('Handoff has no importable dependency order');
      saveReceipt(destination, existing, pending.splice(ready, 1)[0]);
    }
    return { imported: records.map((r) => r.checkId), stages: reconcile(existing, destination) };
  } finally { releaseLease(); }
}
