// Retain the owned profile's actual SQLite bytes around the maintained UI replay.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { atomicJson, containedPath, digest, fileHash, objectHash, readJson } from './release-state.mjs';

const ensure = (value, message) => { if (!value) throw new Error(`Upgrade snapshot: ${message}`); };
const require = createRequire(import.meta.url);
const eventHash = (events) => digest(events.map((event) => JSON.stringify(event)).join('\n'));
function unlinked(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    const stat = lstatSync(current); ensure(!stat.isSymbolicLink() && (stat.isDirectory() || stat.nlink === 1), 'linked profile/database ancestor; use canonical real paths for the owned state and profile');
    if (current === dirname(current)) break;
  }
}
function rows(path, storageSchemaVersion) {
  unlinked(path);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new Error('Upgrade snapshot: SQLite capture requires Node 22 or later; ordinary release checks remain available'); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    ensure(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'invalid SQLite integrity');
    ensure([0, 1].includes(db.prepare('PRAGMA user_version').get().user_version), 'unsupported predecessor database schema');
    const columns = db.prepare('PRAGMA table_info(app_state)').all();
    ensure(columns.length === 3 && columns.map((c) => `${c.name}:${c.type.toUpperCase()}:${c.pk}`).join(',') === 'key:TEXT:1,value:TEXT:0,updated_at:INTEGER:0', 'unsupported app_state schema');
    const result = db.prepare('SELECT key, value, updated_at FROM app_state ORDER BY key').all();
    ensure(result.length >= 2 && result.every((r) => typeof r.key === 'string' && typeof r.value === 'string' && Number.isSafeInteger(r.updated_at)), 'untyped or empty predecessor rows');
    ensure(result.find((r) => r.key === 'kiwi.onboardingVersion')?.value === '1', 'missing predecessor onboarding state');
    ensure(result.find((r) => r.key === 'kiwi.schemaVersion')?.value === String(storageSchemaVersion), 'database storage schema differs from frozen predecessor');
    const drafts = JSON.parse(result.find((r) => r.key === 'kiwi.drafts')?.value ?? 'null');
    ensure(drafts && typeof drafts === 'object' && !Array.isArray(drafts) && Object.keys(drafts).length > 0
      && Object.values(drafts).every((value) => typeof value === 'string' && value.length > 0), 'missing representative protected predecessor draft');
    return result;
  } finally { db.close(); }
}

function knownDefaultsImports(text, allowed) {
  const ast = require('@babel/core').parseSync(text, { configFile: false, babelrc: false, parserOpts: { plugins: ['typescript'] } });
  const safe = (node) => {
    if (Array.isArray(node)) return node.every(safe);
    if (!node || typeof node !== 'object') return true;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && !(node.specifiers.length && node.specifiers.every((s) => s.importKind === 'type')) && !allowed.includes(node.source.value)) return false;
    if ((node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source && node.exportKind !== 'type') return false;
    if (node.type === 'ImportExpression' || node.type === 'TSImportEqualsDeclaration' || (node.type === 'CallExpression' && (node.callee?.type === 'Import' || node.callee?.name === 'require'))) return false;
    return Object.values(node).every(safe);
  };
  return safe(ast);
}

export function sourceUpgradeSchema({ root, predecessorCommit, candidateCommit }) {
  const source = (commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const commit of [predecessorCommit, candidateCommit]) {
      const native = source(commit, 'src-tauri/src/persistence.rs');
      if (!/STATE_DB_SCHEMA_VERSION:\s*i64\s*=\s*1\s*;/.test(native) || !/CREATE TABLE IF NOT EXISTS app_state\s*\(\s*key TEXT PRIMARY KEY,\s*value TEXT NOT NULL,\s*updated_at INTEGER NOT NULL/s.test(native)) return null;
    }
    const prior = source(predecessorCommit, 'src/lib/storage.ts'), current = source(candidateCommit, 'src/lib/storage.ts');
    const defaults = source(predecessorCommit, 'src/lib/appConfig.ts');
    if (!/export const DEFAULT_SETTINGS\b/.test(defaults) || defaults !== source(candidateCommit, 'src/lib/appConfig.ts')) return null;
    const usageDefaults = source(predecessorCommit, 'src/lib/providerUsage.ts');
    if (usageDefaults !== source(candidateCommit, 'src/lib/providerUsage.ts') || !knownDefaultsImports(defaults, ['./providerUsage']) || !knownDefaultsImports(usageDefaults, [])) return null;
    const version = (text) => Number(text.match(/export const STORAGE_SCHEMA_VERSION\s*=\s*(\d+)\s*;/)?.[1]);
    return Number.isSafeInteger(version(prior)) && version(prior) > 0 && version(prior) === version(current) ? { version: version(prior), sourceSha256: digest(prior), defaultsSha256: digest(defaults), usageDefaultsSha256: digest(usageDefaults) } : null;
  } catch { return null; }
}

export function validateUpgradeObservation({ proof, upgrade, entry, contract, stateRoot, events }) {
  ensure(proof.schemaVersion === 1 && proof.kind === 'native-upgrade-observation' && objectHash(proof.predecessor) === objectHash(upgrade.predecessor)
    && proof.platform === contract.platform && proof.checkId === entry.checkId && proof.recipeSha256 === upgrade.recipeSha256, 'observation source or recipe differs');
  ensure(proof.profileId === contract.profile.profileId && proof.pid === entry.pid && proof.runId === entry.runId, 'observation profile or launch differs');
  ensure(upgrade.storageSchema && Number.isSafeInteger(upgrade.storageSchema.version) && upgrade.storageSchema.version > 0
    && objectHash(proof.storageSchema) === objectHash(upgrade.storageSchema), 'storage source binding differs');
  const before = proof.beforeCapture, after = proof.afterCapture;
  ensure(before && after && Number.isFinite(Date.parse(before.capturedAt)) && Number.isFinite(Date.parse(after.capturedAt)) && Date.parse(before.capturedAt) <= Date.parse(after.capturedAt), 'invalid capture order');
  for (const capture of [before, after]) ensure(Number.isSafeInteger(capture.eventsLines) && capture.eventsLines >= 0 && capture.eventsLines <= events.length
    && capture.eventsSha256 === eventHash(events.slice(0, capture.eventsLines)), 'captured app event prefix differs');
  const primary = (event) => event.profileId === proof.profileId && event.pid === proof.pid && event.runId === proof.runId;
  const opened = events.findIndex((event) => primary(event) && event.kind === 'profile-open');
  const exited = events.findIndex((event) => primary(event) && event.kind === 'exit');
  ensure(opened >= before.eventsLines && exited > opened && after.eventsLines > exited, 'snapshots do not bracket the accepted launch');
  const tail = events.slice(after.eventsLines).filter((event) => event.profileId === proof.profileId);
  ensure(tail.every((event) => ['profile-open', 'exit', 'webview-dispose-started', 'webview-dispose-deferred', 'webview-maintenance-initialized', 'webview-dispose-complete'].includes(event.kind)
    && tail.some((initialized) => initialized.runId === event.runId && initialized.kind === 'webview-maintenance-initialized')), 'a later ordinary candidate launch invalidates capture');
  const saved = events.findIndex((event) => primary(event) && event.kind === 'close-finish' && event.details?.accepted === true && event.details.result === 'saved');
  ensure(saved > opened && exited > saved && ['renderer-storage', 'render-ready'].every((kind) => events.some((event) => primary(event) && event.kind === kind))
    && !events.some((event) => event.profileId === proof.profileId && ['render-failed', 'setup-failed', 'renderer-storage-failed', 'control-rejected'].includes(event.kind)), 'capture does not bind a healthy saved launch');
  ensure(proof.fixtureBefore.path !== proof.fixtureAfter.path && proof.fixtureBefore.sha256 !== proof.fixtureAfter.sha256, 'same database cannot prove a persisted UI change');
  const readSnapshot = (snapshot) => {
    ensure(snapshot && entry.evidence.some((e) => e.path === snapshot.path && e.sha256 === snapshot.sha256), 'SQLite snapshot is not retained native evidence');
    const path = containedPath(stateRoot, snapshot.path); ensure(fileHash(path) === snapshot.sha256, 'SQLite snapshot bytes changed'); return rows(path, upgrade.storageSchema.version);
  };
  const prior = readSnapshot(proof.fixtureBefore), later = readSnapshot(proof.fixtureAfter);
  ensure(prior.length === later.length, 'prior rows were lost or added');
  for (const row of prior) {
    const saved = later.find((r) => r.key === row.key); ensure(saved, 'prior row was lost');
    if (row.key !== 'kiwi.settings') ensure(objectHash(row) === objectHash(saved), 'protected predecessor row changed');
    else {
      const initial = JSON.parse(row.value), final = JSON.parse(saved.value);
      ensure(initial && final && typeof initial === 'object' && !Array.isArray(initial) && !Array.isArray(final)
        && initial.theme === 'mythra' && final.theme === 'light-mythra' && saved.updated_at >= row.updated_at, 'maintained settings replay is absent');
      delete initial.theme; delete final.theme; ensure(objectHash(initial) === objectHash(final), 'unknown predecessor settings changed');
    }
  }
  ensure(prior.some((r) => r.key === 'kiwi.settings'), 'missing representative predecessor settings');
  return proof;
}

export function captureUpgradeSnapshot({ contractPath, predecessorTag, checkId, phase, beforePath, output, root = process.cwd(), stateRoot = resolve(dirname(contractPath), '../..') }) {
  ensure(['before', 'after'].includes(phase), 'unknown capture phase');
  const contract = readJson(contractPath), check = contract.checks.find((c) => c.id === checkId), upgrade = check?.upgradeCases?.find((c) => c.predecessor.tag === predecessorTag);
  ensure(upgrade, 'predecessor was not selected by the native contract');
  const storageSchema = sourceUpgradeSchema({ root, predecessorCommit: upgrade.predecessor.commit, candidateCommit: contract.commit });
  ensure(storageSchema && objectHash(upgrade.storageSchema) === objectHash(storageSchema), 'unsupported or unbound storage migration');
  const profile = containedPath(stateRoot, relative(stateRoot, contract.profile.root)); unlinked(profile);
  const markerPath = resolve(profile, '.mythra-release-qa.json'); unlinked(markerPath);
  const marker = readJson(markerPath);
  ensure(objectHash(marker) === objectHash({ schemaVersion: 1, purpose: 'mythra-release-qa', profileId: contract.profile.profileId }), 'owned profile marker differs');
  const database = resolve(profile, 'app-data/openkiwi.sqlite3'); unlinked(database);
  if (existsSync(`${database}-wal`)) unlinked(`${database}-wal`);
  ensure(!existsSync(`${database}-wal`) || lstatSync(`${database}-wal`).size === 0, 'active or uncheckpointed SQLite WAL');
  const eventPath = resolve(profile, 'events.jsonl'); if (existsSync(eventPath)) unlinked(eventPath);
  const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const launches = events.filter((e) => e.profileId === marker.profileId && e.kind === 'profile-open');
  for (const launch of launches) {
    let active = true; try { process.kill(launch.pid, 0); } catch (error) { active = error.code !== 'ESRCH'; }
    ensure(!active && events.some((e) => e.profileId === launch.profileId && e.pid === launch.pid && e.runId === launch.runId && e.kind === 'exit'), 'candidate PID has not exited');
  }
  const out = containedPath(stateRoot, relative(stateRoot, resolve(output))), snapshotPath = `${out}.sqlite3`;
  ensure(!existsSync(out) && !existsSync(snapshotPath), 'capture output already exists');
  rows(database, upgrade.storageSchema.version); copyFileSync(database, snapshotPath);
  const capture = { capturedAt: new Date().toISOString(), eventsLines: events.length, eventsSha256: eventHash(events) };
  const snapshot = { path: relative(stateRoot, snapshotPath).replaceAll('\\', '/'), sha256: fileHash(snapshotPath) };
  let manifest = { schemaVersion: 1, kind: 'native-upgrade-before', predecessor: upgrade.predecessor, profileId: marker.profileId, platform: contract.platform, checkId, recipeSha256: upgrade.recipeSha256, storageSchema: upgrade.storageSchema, fixtureBefore: snapshot, beforeCapture: capture };
  if (phase === 'after') {
    ensure(beforePath && launches.length, 'after capture needs retained before proof and an owned launch');
    const before = readJson(containedPath(stateRoot, relative(stateRoot, resolve(beforePath))));
    ensure(before.kind === 'native-upgrade-before', 'before capture manifest missing');
    const launch = launches.at(-1);
    manifest = { ...before, kind: 'native-upgrade-observation', pid: launch.pid, runId: launch.runId, fixtureAfter: snapshot, afterCapture: capture };
    validateUpgradeObservation({ proof: manifest, upgrade, contract, stateRoot, events, entry: { checkId, pid: launch.pid, runId: launch.runId, evidence: [before.fixtureBefore, snapshot] } });
  }
  atomicJson(out, manifest); return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contractPath, predecessorTag, checkId, phase, output, beforePath] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/release-upgrade-snapshot.mjs <contract> <predecessor-tag> <check-id> <before|after> <output> [before-manifest]');
  const result = captureUpgradeSnapshot({ contractPath: resolve(contractPath), predecessorTag, checkId, phase, output: resolve(output), beforePath: beforePath && resolve(beforePath) });
  console.log(JSON.stringify({ kind: result.kind, checkId: result.checkId, predecessor: result.predecessor, capturedAt: result.afterCapture?.capturedAt ?? result.beforeCapture.capturedAt }));
}
