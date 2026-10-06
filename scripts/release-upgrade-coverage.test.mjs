import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { changedSource, createPlan, planFromCheckout } from './release-plan.mjs';
import { atomicJson, digest, fileHash, objectHash, readJson, receiptPath, reconcile } from './release-state.mjs';
import { exportUpgradeCoverage, fingerprintUpgradeInputs, revalidatePlanCoverage, resolveUpgradeCoverage } from './release-upgrade-coverage.mjs';
import { syntheticGh, syntheticGit, syntheticPassedState } from './release-upgrade-coverage.fixture.mjs';
import { captureUpgradeSnapshot, sourceUpgradeSchema } from './release-upgrade-snapshot.mjs';

// Every release, executable, pixel, event, CI and public asset below is a
// synthetic schema fixture. Passing this suite is not native acceptance.
const roots = [];
const temp = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'mythra-synthetic-upgrade-'))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nativeIds = (plan) => plan.checks.filter((check) => check.required && check.kind === 'native').map((check) => check.id);

function fixture({ acceptedIssues = [] } = {}) {
  const root = temp(), stateRoot = temp(), history = syntheticGit(root);
  const predecessors = [{ tag: 'v1.2.2', commit: history.predecessor, reason: 'Synthetic shipped then withdrawn release', changedFiles: changedSource(root, history.predecessor, history.accepted) }];
  const acceptedPlan = createPlan({ commit: history.accepted, version: '1.2.3', baseline: { tag: 'v1.2.1', commit: history.baseline, reason: 'Synthetic last accepted public baseline' }, predecessors,
    changedFiles: changedSource(root, history.baseline, history.accepted), policyHash: 'c'.repeat(64), knownIssues: acceptedIssues });
  syntheticPassedState(root, stateRoot, acceptedPlan);
  const hashes = readJson(receiptPath(stateRoot, 'public')).details.hashes;
  const gh = syntheticGh(history, 'v1.2.3', hashes);
  const input = { commit: history.current, version: '1.2.4', baseline: { tag: 'v1.2.3', commit: history.accepted, reason: 'Synthetic accepted public release' }, predecessors: predecessors.map((p) => ({ ...p, changedFiles: changedSource(root, p.commit, history.current) })), changedFiles: changedSource(root, history.accepted, history.current), policyHash: 'c'.repeat(64) };
  const exportProof = (platform = 'windows-x86_64', extra = {}) => exportUpgradeCoverage({ root, stateRoot, predecessorTag: 'v1.2.2', platform, check: 'native-startup', execute: gh.execute, ...extra });
  const storeProof = (proof, name = 'windows') => { const path = join(temp(), `${name}.json`); atomicJson(path, proof); return path; };
  const resolveProofs = (proofPaths, scope = input, execute = gh.execute) => resolveUpgradeCoverage({ root, proofPaths, baseline: scope.baseline, commit: scope.commit, predecessors: scope.predecessors, execute });
  return { root, stateRoot, history, gh, input, acceptedPlan, exportProof, storeProof, resolveProofs };
}

function rewriteProof(proof, mutate) {
  const value = structuredClone(proof); mutate(value);
  const { proofHash: _, ...body } = value; value.proofHash = objectHash(body); return value;
}

// Preserve a syntactically valid receipt DAG after deliberate fixture mutation.
// This makes native semantic rejection observable beyond outer hash rejection.
function rehashState(stateRoot, plan) {
  for (const check of plan.checks.filter((c) => c.required)) {
    const path = receiptPath(stateRoot, check.id), receipt = readJson(path);
    receipt.parents = Object.fromEntries(check.dependsOn.map((id) => [id, fileHash(receiptPath(stateRoot, id))]));
    for (const item of receipt.evidence) item.sha256 = fileHash(join(stateRoot, item.path));
    atomicJson(path, receipt);
  }
}

describe('accepted historical native upgrade coverage', { timeout: 30_000 }, () => {
  test('CSS-only releases repeatedly select a withdrawn predecessor without accepted coverage', () => {
    const f = fixture();
    expect(f.input.changedFiles).toEqual(['src/components/UsageDashboard.css']);
    expect(nativeIds(createPlan(f.input))).toEqual(['native-startup:darwin-aarch64', 'native-startup:windows-x86_64']);
    f.history.put('package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.5' }));
    f.history.put('src/components/UsageDashboard.css', 'color: purple;');
    const commit = f.history.commit('Synthetic repeated presentation release');
    expect(nativeIds(createPlan({ ...f.input, commit, version: '1.2.5', changedFiles: changedSource(f.root, f.history.accepted, commit), predecessors: f.input.predecessors.map((p) => ({ ...p, changedFiles: changedSource(f.root, p.commit, commit) })) }))).toHaveLength(2);
  });

  test('the exporter and verifier suppress only the proven historical platform/check tuple', () => {
    const f = fixture(), proof = f.exportProof(), path = f.storeProof(proof);
    expect(reconcile(f.acceptedPlan, f.stateRoot).every((entry) => ['passed', 'not-required'].includes(entry.status))).toBe(true);
    const decisions = f.resolveProofs([path]); expect(decisions[0].reusable).toBe(true);
    const plan = createPlan({ ...f.input, upgradeCoverage: decisions });
    expect(nativeIds(plan)).toEqual(['native-startup:darwin-aarch64']);
    expect(plan.checks.filter((c) => c.required && c.kind !== 'native').map((c) => c.id)).toEqual(['ci', 'build:darwin-aarch64', 'audit:darwin-aarch64', 'build:windows-x86_64', 'audit:windows-x86_64', 'draft', 'publish', 'public']);
    expect(() => revalidatePlanCoverage({ root: f.root, plan, execute: f.gh.execute })).not.toThrow();
    expect(f.gh.calls.some((args) => args[1].endsWith('/releases/tags/v1.2.3'))).toBe(true);
    expect(f.gh.calls.some((args) => args[1].endsWith('/git/ref/tags/v1.2.2'))).toBe(true);
  });

  test('both native platforms require their own accepted upgrade evidence', () => {
    const f = fixture();
    const paths = ['windows-x86_64', 'darwin-aarch64'].map((platform) => f.storeProof(f.exportProof(platform), platform));
    expect(nativeIds(createPlan({ ...f.input, upgradeCoverage: f.resolveProofs(paths) }))).toEqual([]);
    expect(() => f.resolveProofs([paths[0], paths[0]])).toThrow(/duplicate/i);
  });

  test('checkout planning resolves retained proof against actual clean source and fresh public baseline', () => {
    const f = fixture(), path = f.storeProof(f.exportProof());
    const plan = planFromCheckout(f.root, { baseline: { tag: 'v1.2.3', reason: 'Synthetic accepted public baseline' }, predecessors: [{ tag: 'v1.2.2', reason: 'Synthetic withdrawn predecessor' }], upgradeCoverage: [path] }, { execute: f.gh.execute });
    expect(plan.commit).toBe(f.history.current); expect(plan.baseline.publicEvidence.commit).toBe(f.history.accepted);
    expect(nativeIds(plan)).toEqual(['native-startup:darwin-aarch64']);
    expect(() => revalidatePlanCoverage({ root: f.root, plan, execute: f.gh.execute })).not.toThrow();
  });

  test('raw or serialized verifier decisions cannot waive a historical requirement', () => {
    const f = fixture(), decisions = f.resolveProofs([f.storeProof(f.exportProof())]);
    expect(() => createPlan({ ...f.input, upgradeCoverage: JSON.parse(JSON.stringify(decisions)) })).toThrow();
    expect(() => createPlan({ ...f.input, upgradeCoverage: [{ ...decisions[0], reusable: true }] })).toThrow();
  });

  test('a previously verified decision cannot be edited in place to hide changed inputs', () => {
    const f = fixture(), path = f.storeProof(f.exportProof());
    f.history.put('scripts/new-runtime-input.mjs', 'export const changed = true;');
    const scope = { ...f.input, commit: f.history.commit('Synthetic changed runtime input') };
    const decisions = f.resolveProofs([path], scope); expect(decisions[0].reusable).toBe(false);
    expect(() => {
      decisions[0].inputs = decisions[0].acceptedInputs; decisions[0].reusable = true;
      createPlan({ ...scope, upgradeCoverage: decisions });
    }).toThrow();
  });

  test.each([
    ['current native source diff', 'src-tauri/src/startup_guard.rs', 'new current startup behavior'],
    ['unfamiliar input', 'scripts/new-runtime-input.mjs', 'export const behavior = true;'],
    ['dependency change', 'package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.4', dependencies: { example: '2.0.0' } })],
    ['changed maintained recipe', 'docs/operations/native-release-qa.md', 'Changed upgrade recipe'],
  ])('%s invalidates historical reuse', (_label, path, contents) => {
    const f = fixture(), proofPath = f.storeProof(f.exportProof());
    f.history.put(path, contents); const commit = f.history.commit('Synthetic upgrade input mutation');
    const scope = { ...f.input, commit, changedFiles: changedSource(f.root, f.history.accepted, commit), predecessors: f.input.predecessors.map((p) => ({ ...p, changedFiles: changedSource(f.root, p.commit, commit) })) };
    // Unknown input still selects predecessor checks, even before classification.
    const decisions = f.resolveProofs([proofPath], scope); expect(decisions[0].reusable).toBe(false);
    expect(nativeIds(createPlan({ ...scope, upgradeCoverage: decisions }))).toHaveLength(2);
  });

  test.each(['knownIssues', 'overrides', 'boundaryHints'])('current %s cannot be suppressed by historical acceptance', (field) => {
    const f = fixture(), decisions = f.resolveProofs([f.storeProof(f.exportProof())]);
    const plan = createPlan({ ...f.input, upgradeCoverage: decisions, [field]: [{ check: 'native-startup', platform: 'windows-x86_64', reason: 'Synthetic active current startup requirement' }] });
    expect(nativeIds(plan)).toContain('native-startup:windows-x86_64');
  });

  test.each([
    ['wrong predecessor tag', (p) => { p.predecessor.tag = 'v9.9.9'; }],
    ['wrong platform', (p) => { p.platform = 'darwin-aarch64'; }],
    ['wrong check', (p) => { p.check = 'native-storage'; }],
    ['wrong accepted source', (p) => { p.accepted.commit = 'f'.repeat(40); }],
    ['wrong repository', (p) => { p.accepted.repository = 'someone/else'; }],
    ['forged generic pass', (p) => { p.status = 'passed'; p.evidenceHash = 'f'.repeat(64); }],
    ['invented resolved issue', (p) => { p.resolvedIssues = ['f'.repeat(64)]; }],
  ])('rehashed proof rejects %s', (_label, mutate) => {
    const f = fixture(); expect(() => f.resolveProofs([f.storeProof(rewriteProof(f.exportProof(), mutate))])).toThrow();
  });

  test('changed or missing retained bytes invalidate export, import and resume', () => {
    const f = fixture(), path = f.storeProof(f.exportProof()), plan = createPlan({ ...f.input, upgradeCoverage: f.resolveProofs([path]) });
    const executable = join(f.stateRoot, 'executables/windows-x86_64/app');
    writeFileSync(executable, 'Changed synthetic executable');
    expect(() => f.exportProof()).toThrow(); expect(() => f.resolveProofs([path])).toThrow();
    expect(() => revalidatePlanCoverage({ root: f.root, plan, execute: f.gh.execute })).toThrow();
    rmSync(executable); expect(() => f.exportProof()).toThrow();
  });

  test.each(['public-assets', 'accepted-tag', 'predecessor-tag', 'withdrawn-accepted-release'])('fresh remote %s mismatch invalidates retained proof', (mode) => {
    const f = fixture(), path = f.storeProof(f.exportProof());
    const execute = (command, args, options) => {
      const value = JSON.parse(f.gh.execute(command, args, options));
      if (mode === 'public-assets' && args[1].endsWith('/releases/tags/v1.2.3')) value.assets[0].digest = `sha256:${'f'.repeat(64)}`;
      if (mode === 'accepted-tag' && args[1].endsWith('/git/ref/tags/v1.2.3')) value.object.sha = f.history.predecessor;
      if (mode === 'predecessor-tag' && args[1].endsWith('/git/ref/tags/v1.2.2')) value.object.sha = f.history.baseline;
      if (mode === 'withdrawn-accepted-release' && args[1].endsWith('/releases/tags/v1.2.3')) value.draft = true;
      return JSON.stringify(value);
    };
    expect(() => f.resolveProofs([path], f.input, execute)).toThrow();
  });

  test.each(['missing-upgrade-case', 'missing-upgrade-observation', 'generic-observation', 'empty-prior-rows', 'wrong-source-rows', 'no-exit', 'fake-pixels', 'missing-portable-executable', 'wrong-profile', 'wrong-pid', 'wrong-run', 'capture-order', 'same-database', 'protected-row-changed', 'unknown-settings-changed', 'null-json-rows', 'empty-object-json-rows'])('rehashed native chain rejects %s', (mode) => {
    const f = fixture(), receiptFile = receiptPath(f.stateRoot, 'native-startup:windows-x86_64'), receipt = readJson(receiptFile);
    const contractPath = join(f.stateRoot, 'native-workers/windows-x86_64/contract.json'), resultPath = join(f.stateRoot, 'native-workers/windows-x86_64/result.json');
    const contract = readJson(contractPath), result = readJson(resultPath), entry = result.results[0];
    const upgrade = contract.checks[0].upgradeCases[0];
    const observation = entry.observations.find((o) => o.id === upgrade.id);
    if (mode === 'missing-upgrade-case') { contract.checks[0].upgradeCases = []; contract.checks[0].observations = contract.checks[0].observations.filter((id) => id !== upgrade.id); }
    if (mode === 'missing-upgrade-observation') entry.observations = entry.observations.filter((o) => o.id !== upgrade.id);
    if (mode === 'generic-observation') observation.evidence = 'native-workers/windows-x86_64/screen.png';
    const proofModes = ['empty-prior-rows', 'wrong-source-rows', 'wrong-profile', 'wrong-pid', 'wrong-run', 'capture-order', 'same-database', 'protected-row-changed', 'unknown-settings-changed', 'null-json-rows', 'empty-object-json-rows'];
    if (proofModes.includes(mode)) {
      const proofPath = join(f.stateRoot, observation.evidence), proof = readJson(proofPath), beforePath = join(f.stateRoot, proof.fixtureBefore.path), afterPath = join(f.stateRoot, proof.fixtureAfter.path);
      if (['empty-prior-rows', 'protected-row-changed', 'unknown-settings-changed'].includes(mode)) {
        const db = new DatabaseSync(mode === 'empty-prior-rows' ? beforePath : afterPath);
        try {
          if (mode === 'empty-prior-rows') db.exec('DELETE FROM app_state');
          if (mode === 'protected-row-changed') db.exec("UPDATE app_state SET value='changed' WHERE key='synthetic.unknown-row'");
          if (mode === 'unknown-settings-changed') db.prepare("UPDATE app_state SET value=? WHERE key='kiwi.settings'").run(JSON.stringify({ theme: 'light-mythra', unknownProtectedSetting: 'changed' }));
        } finally { db.close(); }
      }
      if (mode === 'wrong-source-rows') proof.predecessor.commit = f.history.baseline;
      if (mode === 'wrong-profile') proof.profileId = randomUUID();
      if (mode === 'wrong-pid') proof.pid++;
      if (mode === 'wrong-run') proof.runId = randomUUID();
      if (mode === 'capture-order') proof.beforeCapture = proof.afterCapture;
      if (mode === 'null-json-rows' || mode === 'empty-object-json-rows') writeFileSync(beforePath, JSON.stringify({ schemaVersion: 1, rows: mode === 'null-json-rows' ? [null] : [{}] }));
      proof.fixtureBefore.sha256 = fileHash(beforePath); proof.fixtureAfter.sha256 = fileHash(afterPath);
      if (mode === 'same-database') proof.fixtureAfter = proof.fixtureBefore;
      atomicJson(proofPath, proof);
    }
    if (mode === 'no-exit') { const events = join(f.stateRoot, 'native-workers/windows-x86_64/native-events.jsonl'); writeFileSync(events, readFileSync(events, 'utf8').split('\n').filter((line) => JSON.parse(line).kind !== 'exit').join('\n')); }
    if (mode === 'fake-pixels') writeFileSync(join(f.stateRoot, 'native-workers/windows-x86_64/screen.png'), 'Synthetic plain text pretending to be image');
    if (mode === 'missing-portable-executable') delete receipt.details.portableExecutablePath;
    const { contractHash: _, ...body } = contract; contract.contractHash = objectHash(body);
    for (const item of entry.evidence) item.sha256 = fileHash(join(f.stateRoot, item.path));
    receipt.details.observations = entry.observations; receipt.details.workerContractHash = contract.contractHash;
    atomicJson(contractPath, contract); atomicJson(resultPath, result); atomicJson(receiptFile, receipt); rehashState(f.stateRoot, f.acceptedPlan);
    expect(() => f.exportProof()).toThrow();
  });

  test('failed native result on the other required platform blocks Windows historical export', () => {
    const f = fixture(), resultPath = join(f.stateRoot, 'native-workers/darwin-aarch64/result.json'), result = readJson(resultPath);
    result.status = 'failed'; atomicJson(resultPath, result); rehashState(f.stateRoot, f.acceptedPlan);
    expect(() => f.exportProof()).toThrow();
  });

  test.each([
    ['custom component className', '<Custom className="after" width="40" d="M0" >Before</Custom>'],
    ['custom component width', '<Custom className="before" width="80" d="M0" >Before</Custom>'],
    ['custom component path data', '<Custom className="before" width="40" d="M1" >Before</Custom>'],
    ['custom component child text', '<Custom className="before" width="40" d="M0" >After</Custom>'],
  ])('%s remains a bound executable input', (_name, jsx) => {
    const f = fixture(), acceptedHash = fingerprintUpgradeInputs(f.root, f.history.accepted, 'windows-x86_64');
    f.history.put('src/components/SyntheticCard.tsx', `export function Card() { return ${jsx}; }`);
    const commit = f.history.commit('Synthetic custom component behavior changed');
    expect(fingerprintUpgradeInputs(f.root, commit, 'windows-x86_64')).not.toBe(acceptedHash);
  });

  test('missing typed hosted proof or public-stage receipt blocks historical export', () => {
    for (const checkId of ['ci', 'public']) {
      const f = fixture(); rmSync(receiptPath(f.stateRoot, checkId)); expect(() => f.exportProof()).toThrow(/incomplete|evidence changed/i);
    }
  });

  test('retained Windows executable evidence survives an unavailable original absolute path', () => {
    const f = fixture(), receiptFile = receiptPath(f.stateRoot, 'native-startup:windows-x86_64'), receipt = readJson(receiptFile);
    const resultPath = join(f.stateRoot, 'native-workers/windows-x86_64/result.json'), result = readJson(resultPath);
    result.results[0].executablePath = 'C:\\synthetic-host-only\\candidate.exe'; receipt.details.executablePath = result.results[0].executablePath;
    atomicJson(resultPath, result); atomicJson(receiptFile, receipt); rehashState(f.stateRoot, f.acceptedPlan);
    expect(f.resolveProofs([f.storeProof(f.exportProof())])[0].reusable).toBe(true);
  });

  test('ordinary native release module loads when node:sqlite is unavailable', () => {
    const script = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const Module = require('node:module'); const original = Module._load; Module._load = function(id, ...args) { if (id === 'node:sqlite') throw new Error('Synthetic Node 20 capability absence'); return original.call(this, id, ...args); }; await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'release-native-check.mjs')).href)});`;
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })).not.toThrow();
  });

  test('capture retains actual synthetic database bytes around save-close-reopen and binds the final launch', () => {
    const f = fixture(), contractPath = join(f.stateRoot, 'native-workers/windows-x86_64/contract.json'), contract = readJson(contractPath);
    const profile = contract.profile.root; mkdirSync(join(profile, 'app-data'), { recursive: true });
    atomicJson(join(profile, '.mythra-release-qa.json'), { schemaVersion: 1, purpose: 'mythra-release-qa', profileId: contract.profile.profileId });
    const database = join(profile, 'app-data/openkiwi.sqlite3'), syntheticBefore = join(f.stateRoot, 'native-workers/windows-x86_64/upgrade-native-startup-0-before.sqlite3');
    copyFileSync(syntheticBefore, database);
    const beforePath = join(f.stateRoot, 'native-workers/windows-x86_64/captured-before.json'), output = join(f.stateRoot, 'native-workers/windows-x86_64/captured-after.json');
    const args = { root: f.root, stateRoot: f.stateRoot, contractPath, predecessorTag: 'v1.2.2', checkId: 'native-startup:windows-x86_64' };
    const before = captureUpgradeSnapshot({ ...args, phase: 'before', output: beforePath });
    const db = new DatabaseSync(database); try { db.prepare("UPDATE app_state SET value=?, updated_at=2 WHERE key='kiwi.settings'").run(JSON.stringify({ theme: 'light-mythra', unknownProtectedSetting: 'synthetic-preserved' })); } finally { db.close(); }
    const events = readFileSync(join(f.stateRoot, 'native-workers/windows-x86_64/native-events.jsonl'), 'utf8').split('\n').map(JSON.parse);
    for (const e of events) e.pid = 2147483000;
    const reopened = events.map((e) => ({ ...e, pid: 2147483001, runId: '00000000-0000-4000-8000-000000000099' }));
    writeFileSync(join(profile, 'events.jsonl'), [...events, ...reopened].map((e) => JSON.stringify(e)).join('\n'));
    const after = captureUpgradeSnapshot({ ...args, phase: 'after', beforePath, output });
    expect(after.pid).toBe(2147483001); expect(after.runId).toBe(reopened[0].runId);
    expect(after.beforeCapture.eventsLines).toBe(0); expect(after.afterCapture.eventsLines).toBe(12);
    expect(after.fixtureBefore.sha256).toBe(before.fixtureBefore.sha256); expect(after.fixtureAfter.sha256).not.toBe(before.fixtureBefore.sha256);
    writeFileSync(`${database}-wal`, 'Synthetic uncheckpointed WAL');
    expect(() => captureUpgradeSnapshot({ ...args, phase: 'after', beforePath, output: `${output}.rejected` })).toThrow(/WAL/);
  });

  test('macOS cleanup events after capture preserve the accepted UI replay while later ordinary launches invalidate it', () => {
    const f = fixture(), directory = 'native-workers/darwin-aarch64', resultPath = join(f.stateRoot, directory, 'result.json'), result = readJson(resultPath);
    const entry = result.results[0], observation = entry.observations.find((o) => o.id.startsWith('upgrade:'));
    const proofPath = join(f.stateRoot, observation.evidence), proof = readJson(proofPath), eventsPath = join(f.stateRoot, directory, 'native-events.jsonl');
    const events = readFileSync(eventsPath, 'utf8').split('\n').map(JSON.parse);
    // The real disposal executable initializes this same profile before its
    // headless maintenance events; this is distinct from an ordinary reopen.
    const maintenance = { ...events[0], pid: 2147483002, runId: events[6].runId };
    events.splice(6, 0, maintenance); events.push({ ...maintenance, kind: 'exit', details: {} });
    proof.afterCapture.eventsLines = 6; proof.afterCapture.eventsSha256 = digest(events.slice(0, 6).map((e) => JSON.stringify(e)).join('\n'));
    const persist = () => {
      atomicJson(proofPath, proof); writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n'));
      for (const item of entry.evidence) item.sha256 = fileHash(join(f.stateRoot, item.path));
      atomicJson(resultPath, result); rehashState(f.stateRoot, f.acceptedPlan);
    };
    persist(); expect(() => f.exportProof('darwin-aarch64')).not.toThrow();
    events.push({ ...events[0], pid: 2147483003, runId: randomUUID() }); persist();
    expect(() => f.exportProof('darwin-aarch64')).toThrow();
  });

  test('unsupported frontend storage migrations cannot manufacture an optional upgrade case', () => {
    const f = fixture();
    expect(sourceUpgradeSchema({ root: f.root, predecessorCommit: f.history.predecessor, candidateCommit: f.history.accepted })?.version).toBe(28);
    const storagePath = join(f.root, 'src/lib/storage.ts');
    writeFileSync(storagePath, readFileSync(storagePath, 'utf8').replace('STORAGE_SCHEMA_VERSION = 28;', 'STORAGE_SCHEMA_VERSION = 29;'));
    const commit = f.history.commit('Synthetic unsupported frontend storage migration');
    expect(sourceUpgradeSchema({ root: f.root, predecessorCommit: f.history.predecessor, candidateCommit: commit })).toBeNull();
  });

  test('unversioned defaults source changes cannot manufacture predecessor-compatible initialization', () => {
    const f = fixture();
    const source = sourceUpgradeSchema({ root: f.root, predecessorCommit: f.history.predecessor, candidateCommit: f.history.accepted });
    expect(source.defaultsSha256).toMatch(/^[a-f0-9]{64}$/);
    f.history.put('src/lib/appConfig.ts', 'export const DEFAULT_SETTINGS = { theme: "changed-without-schema-version" };');
    const commit = f.history.commit('Synthetic unsupported defaults source change');
    expect(sourceUpgradeSchema({ root: f.root, predecessorCommit: f.history.predecessor, candidateCommit: commit })).toBeNull();
  });

  test('fingerprints bind platform and executable inputs while tolerating CSS and version-only changes', () => {
    const f = fixture();
    expect(fingerprintUpgradeInputs(f.root, f.history.accepted, 'windows-x86_64')).toBe(fingerprintUpgradeInputs(f.root, f.history.current, 'windows-x86_64'));
    expect(fingerprintUpgradeInputs(f.root, f.history.current, 'windows-x86_64')).not.toBe(fingerprintUpgradeInputs(f.root, f.history.current, 'darwin-aarch64'));
    expect(() => fingerprintUpgradeInputs(f.root, f.history.current, 'linux-x86_64')).toThrow();
  });
});
