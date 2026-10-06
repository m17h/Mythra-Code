// Synthetic schema fixtures only. These bytes and observations are never real
// packaged-native acceptance, hosted CI execution, or public release evidence.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { assetNames } from './release-audit.mjs';
import { assertHostedEvidence } from './release-evidence.mjs';
import { createNativeContract, validateNativeResult } from './release-native-check.mjs';
import { atomicJson, digest, fileHash, readJson, receiptPath, saveReceipt } from './release-state.mjs';
import { expectedReceipts, lanes } from './verify-ci.mjs';

// Load this Node 22 built-in at runtime; Vite's client transformer does not
// recognize node:sqlite as external on the hosted Node 22 toolchain.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export function syntheticGit(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'synthetic@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git']);
  const put = (path, contents) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); };
  const commit = (message, tag) => { git(['add', '.']); git(['commit', '-m', message]); const sha = git(['rev-parse', 'HEAD']); if (tag) git(['tag', tag]); return sha; };
  for (const path of ['AGENTS.md', '.github/workflows/verify.yml', 'scripts/verify-ci.mjs', 'scripts/release-plan.mjs', 'scripts/release-state.mjs', 'scripts/release-native-check.mjs', 'scripts/release-upgrade-coverage.mjs', 'scripts/release-upgrade-snapshot.mjs', 'src-tauri/src/persistence.rs', 'src/lib/storage.ts', 'src/lib/appConfig.ts', 'src/lib/providerUsage.ts']) {
    put(path, readFileSync(join(import.meta.dirname, '..', path)));
  }
  put('src-tauri/src/release_qa.rs', 'pub(crate) const RELEASE_QA_CONTRACT_VERSION: u32 = 1; MYTHRA_RELEASE_QA_ROOT');
  put('src-tauri/src/lib.rs', 'mod release_qa; release_qa::initialize(); release_qa::configure_context; release_qa::configure_window;');
  put('docs/operations/native-release-qa.md', 'Synthetic maintained recipe fixture');
  put('package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.1' }));
  put('src-tauri/src/startup_guard.rs', 'accepted startup boundary');
  put('src/components/UsageDashboard.css', 'color: blue;');
  put('src/components/SyntheticCard.tsx', 'export function Card() { return <Custom className="before" width="40" d="M0" >Before</Custom>; }');
  const baseline = commit('Synthetic accepted baseline', 'v1.2.1');
  put('package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.2' }));
  put('src-tauri/src/startup_guard.rs', 'withdrawn startup boundary');
  const predecessor = commit('Synthetic shipped then withdrawn predecessor', 'v1.2.2');
  put('package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.3' }));
  put('src-tauri/src/startup_guard.rs', 'accepted startup boundary');
  put('src/components/UsageDashboard.css', 'color: green;');
  const accepted = commit('Synthetic accepted presentation release', 'v1.2.3');
  put('package.json', JSON.stringify({ name: 'mythra-code', version: '1.2.4' }));
  put('src/components/UsageDashboard.css', 'color: red;');
  const current = commit('Synthetic subsequent presentation release');
  return { git, put, commit, baseline, predecessor, accepted, current };
}

export function syntheticGh(history, latestTag = 'v1.2.3', publicHashes = {}) {
  const commits = { 'v1.2.1': history.baseline, 'v1.2.2': history.predecessor, 'v1.2.3': history.accepted };
  const calls = [];
  const execute = (command, args, options) => {
    if (command !== 'gh') return execFileSync(command, args, options);
    calls.push(args);
    if (args[0] !== 'api') throw new Error(`Unexpected synthetic GH invocation: ${args}`);
    const path = args[1].replace('repos/m17h/Mythra-Code/', '');
    if (path.startsWith('git/ref/tags/')) {
      const tag = decodeURIComponent(path.slice('git/ref/tags/'.length));
      if (!commits[tag]) throw new Error(`Unknown synthetic public tag: ${tag}`);
      return JSON.stringify({ object: { type: 'commit', sha: commits[tag] } });
    }
    const tag = path === 'releases/latest' ? latestTag : decodeURIComponent(path.replace('releases/tags/', ''));
    if (!commits[tag]) throw new Error(`Unknown synthetic public release: ${path}`);
    return JSON.stringify({ id: Number(tag.at(-1)), tag_name: tag, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z',
      assets: Object.entries(publicHashes).map(([name, sha256], index) => ({ id: index + 1, name, digest: `sha256:${sha256}` })) });
  };
  return { execute, calls, commits };
}

function syntheticHosted(commit) {
  const input = { checkout: commit, head: commit, base: null, event: 'push' };
  const receipts = expectedReceipts().map((id) => {
    const kind = id.split('-')[0], steps = kind === 'webkit' ? ['build', 'verify:startup', 'test:webkit'] : lanes[kind];
    const receipt = { schemaVersion: 1, id, input, status: 'success', steps: steps.map((name) => ({ name, status: 'success' })) };
    if (kind === 'unit') { receipt.inventory = ['a.test.ts', 'b.test.ts']; receipt.unit = { files: [receipt.inventory[Number(id.at(-1)) - 1]], tests: 1 }; }
    if (kind === 'renderer' || kind === 'webkit') receipt.browser = { files: ['a.browser.test.ts'], tests: 1 };
    if (kind === 'webkit') receipt.inventory = ['a.browser.test.ts'];
    if (kind === 'renderer') { receipt.profiles = id.endsWith('Windows') ? ['safari13', 'chrome105'] : ['safari13']; receipt.performance = Object.fromEntries(receipt.profiles.map((target) => [target, { schemaVersion: 1, budgetEvaluation: { passed: true }, environment: { buildProfile: `${target}-minified` } }])); }
    return receipt;
  });
  const names = ['WebKit (macOS 15)', 'Verify gate', ...['macos-latest', 'windows-latest'].flatMap((os) => [`Rust (${os})`, `Renderer (${os})`, `Unit (${os}, 1/2)`, `Unit (${os}, 2/2)`])];
  return assertHostedEvidence({ run: { id: 123, run_attempt: 1, repository: { full_name: 'm17h/Mythra-Code' }, head_repository: { full_name: 'm17h/Mythra-Code' }, path: '.github/workflows/verify.yml', event: 'push', head_branch: 'main', head_sha: commit, status: 'completed', conclusion: 'success' }, jobs: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })), receipts }, commit);
}

export function syntheticNative(root, plan, platform, checkout) {
  const directory = `native-workers/${platform}`;
  mkdirSync(join(root, directory), { recursive: true });
  const contract = createNativeContract({ root: checkout, stateRoot: root, plan, platform });
  const executablePath = join(root, `executables/${platform}/app`);
  mkdirSync(dirname(executablePath), { recursive: true }); writeFileSync(executablePath, `Synthetic executable ${platform}`);
  const paths = ['screen.png', 'accessibility.json', 'native-events.jsonl'].map((name) => `${directory}/${name}`);
  const capabilityPath = `${directory}/capability.json`, contractPath = `${directory}/contract.json`, resultPath = `${directory}/result.json`;
  const runId = randomUUID(), profileId = contract.profile.profileId, pid = 4321, storeId = randomUUID();
  atomicJson(join(root, capabilityPath), { synthetic: true, tool: 'cua', inventory: ['synthetic-window'] });
  atomicJson(join(root, paths[1]), { synthetic: true, role: 'window', title: `Mythra Code — Release QA ${profileId}` });
  writeFileSync(join(root, paths[0]), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
  const events = ['profile-open', 'window-constructed', 'renderer-storage', 'render-ready', 'close-finish', 'exit'].map((kind) => ({ schemaVersion: 1, profileId, pid, runId, kind,
    details: kind === 'profile-open' ? { contractVersion: 1, providers: 'blocked', persistentWebview: true, webviewStoreId: storeId }
      : kind === 'renderer-storage' ? { current: profileId, previous: null }
        : kind === 'close-finish' ? { accepted: true, result: 'saved' } : {} }));
  if (platform === 'darwin-aarch64') {
    const maintenance = randomUUID();
    events.push({ schemaVersion: 1, profileId, runId: maintenance, kind: 'webview-maintenance-initialized', details: { mainThread: true, persistent: false, url: 'about:blank' } }, { schemaVersion: 1, profileId, runId: maintenance, kind: 'webview-dispose-complete', details: { webviewStoreId: storeId, verifiedAbsent: true } });
  }
  writeFileSync(join(root, paths[2]), events.map((event) => JSON.stringify(event)).join('\n'));
  const results = contract.checks.map((check) => {
    const evidencePaths = [...paths, `executables/${platform}/app`], observations = check.observations.map((id) => ({ id, evidence: paths[0] }));
    for (const [index, upgrade] of (check.upgradeCases ?? []).entries()) {
      const before = `${directory}/upgrade-${check.id.split(':')[0]}-${index}-before.sqlite3`, after = `${directory}/upgrade-${check.id.split(':')[0]}-${index}-after.sqlite3`, proof = `${directory}/upgrade-${check.id.split(':')[0]}-${index}.json`;
      for (const [phase, path] of [before, after].entries()) {
        const db = new DatabaseSync(join(root, path));
        try {
          db.exec('PRAGMA user_version = 1; CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);');
          const insert = db.prepare('INSERT INTO app_state VALUES (?, ?, ?)');
          insert.run('kiwi.settings', JSON.stringify({ theme: phase === 0 ? 'mythra' : 'light-mythra', unknownProtectedSetting: 'synthetic-preserved' }), phase + 1);
          insert.run('kiwi.onboardingVersion', '1', 1); insert.run('synthetic.unknown-row', 'synthetic-preserved', 1);
          insert.run('kiwi.schemaVersion', String(upgrade.storageSchema.version), 1); insert.run('kiwi.drafts', JSON.stringify({ 'synthetic-old-thread': 'Synthetic prior-version unsent draft' }), 1);
        } finally { db.close(); }
      }
      atomicJson(join(root, proof), { schemaVersion: 1, kind: 'native-upgrade-observation', predecessor: upgrade.predecessor, platform, checkId: check.id, recipeSha256: upgrade.recipeSha256,
        profileId, pid, runId, storageSchema: upgrade.storageSchema, beforeCapture: { capturedAt: '2026-01-01T00:00:00Z', eventsLines: 0, eventsSha256: digest('') }, afterCapture: { capturedAt: '2026-01-01T00:00:01Z', eventsLines: events.length, eventsSha256: digest(events.map((e) => JSON.stringify(e)).join('\n')) },
        fixtureBefore: { path: before, sha256: fileHash(join(root, before)) }, fixtureAfter: { path: after, sha256: fileHash(join(root, after)) } });
      observations.push({ id: upgrade.id, evidence: proof });
      evidencePaths.push(before, after, proof);
    }
    return { checkId: check.id, executablePath, executableSha256: fileHash(executablePath), pid, processStart: 'synthetic-start', runId, windowIdentity: `Mythra Code — Release QA ${profileId}`, version: plan.version,
      observations, evidence: evidencePaths.map((path) => ({ path, sha256: fileHash(join(root, path)) })) };
  });
  const result = { status: 'passed', reason: 'Synthetic schema fixture only', capability: { verified: true, tool: 'cua', evidence: capabilityPath }, cleanupComplete: true, restorationComplete: true, results };
  atomicJson(join(root, contractPath), contract); atomicJson(join(root, resultPath), result);
  validateNativeResult(result, contract, root);
  return results.map((entry) => ({ ...entry, contract, result, evidence: [...entry.evidence, ...[contractPath, resultPath, capabilityPath].map((path) => ({ path, sha256: fileHash(join(root, path)) }))] }));
}

export function syntheticPassedState(checkout, stateRoot, plan) {
  atomicJson(join(stateRoot, 'plan.json'), plan);
  const native = new Map();
  const base = (check, details, evidence, checkerVersion = 'release-coordinator-v1') => ({ schemaVersion: 1, checkId: check.id, status: 'passed', planHash: plan.planHash, commit: plan.commit, checkerVersion, ...(check.platform ? { platform: check.platform } : {}), startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', details, evidence });
  const file = (path, bytes) => { mkdirSync(dirname(join(stateRoot, path)), { recursive: true }); writeFileSync(join(stateRoot, path), bytes); return { path, sha256: fileHash(join(stateRoot, path)) }; };
  for (const check of plan.checks.filter((entry) => entry.required)) {
    const evidence = [file(`proof/${check.id.replaceAll(':', '_')}.txt`, 'Synthetic schema proof only')];
    let receipt;
    if (check.kind === 'ci') receipt = base(check, syntheticHosted(plan.commit), evidence);
    if (check.kind === 'build') {
      const packagePath = `MythraCode_${plan.version}_${check.platform === 'darwin-aarch64' ? 'aarch64.dmg' : 'x64-setup.exe'}`;
      const bytes = file(packagePath, `Synthetic package ${check.platform}`); evidence.push(bytes);
      receipt = base(check, { packagePath, packageSha256: bytes.sha256, exitCode: 0, command: ['npm', 'run', 'release:build'], node: process.version, host: hostname() }, evidence);
    }
    if (check.kind === 'audit') receipt = base(check, { packageSha256: readJson(receiptPath(stateRoot, `build:${check.platform}`)).details.packageSha256, archiveSha256: 'f'.repeat(64), executableSha256: file(`executables/${check.platform}/app`, `Synthetic executable ${check.platform}`).sha256, codesign: 'passed', notarization: 'passed', gatekeeper: 'passed', bundleEquivalence: 'passed', bundleEntries: 9, payloadPe: { machine: 0x8664, subsystem: 'WindowsGui' }, payloadVersion: plan.version, authenticodeStatus: 'NotSigned' }, evidence, 'native-integrity-v1');
    if (check.kind === 'native') {
      if (!native.has(check.platform)) {
        for (const entry of syntheticNative(stateRoot, plan, check.platform, checkout)) native.set(entry.checkId, entry);
        native.set(check.platform, true);
      }
      const entry = native.get(check.id);
      receipt = { ...base(check, { ...entry, contract: undefined, result: undefined, portableExecutablePath: `executables/${check.platform}/app`, workerContractHash: entry.contract.contractHash, sessionId: 'synthetic-session', runtime: { model: 'gpt-6.1-sol', reasoningEffort: 'high', approvalPolicy: 'never', sandbox: 'danger-full-access' }, cleanupComplete: true, restorationComplete: true }, entry.evidence, 'native-check-v1'), packageSha256: entry.contract.packageSha256 };
    }
    if (check.kind === 'draft' || check.kind === 'public') {
      const files = assetNames(plan.version).map((name) => file(`assets-${check.id}/${name}`, `Synthetic asset ${name}`));
      receipt = base(check, { version: plan.version, commit: plan.commit, hashes: Object.fromEntries(files.map((entry) => [entry.path.split('/').at(-1), entry.sha256])), signaturesVerified: ['darwin-aarch64', 'windows-x86_64'] }, [...evidence, ...files]);
    }
    if (check.kind === 'publish') receipt = base(check, { tag: `v${plan.version}` }, evidence);
    saveReceipt(stateRoot, plan, receipt);
  }
}
