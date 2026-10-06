import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appliesToPlatform, assertPlan, atomicJson, objectHash, PLATFORMS, SHA } from './release-state.mjs';

import { coversHistoricalUpgrade, historicalCoverageReason, isVerifiedUpgradeCoverage, resolveUpgradeCoverage } from './release-upgrade-coverage.mjs';

export const POLICY_VERSION = 1;
const boundaries = {
  'native-startup': /^(index\.html|vite\.config\.ts|public\/bootstrap\.|src\/(main\.tsx|lib\/(startApplication|startup|startupData)\.)|src-tauri\/src\/(startup_guard)\.rs|src-tauri\/tauri[^/]*\.json|scripts\/(build-release|prepare-release)\.mjs|Windows\/build\.ps1)/,
  'native-close': /^src\/(hooks\/useFlushOnClose\.|lib\/(storage|localTranscriptPersistence|transcriptSaveScheduler)\.)|^src-tauri\/src\/(close_guard)\.rs/,
  'native-storage': /^src\/(hooks\/usePersistedState\.|lib\/(storage|startupData|localTranscriptPersistence|transcriptSaveScheduler|taskStore)\.)|^src-tauri\/src\/persistence\.rs/,
  'native-onboarding': /^src\/.*[Oo]nboarding[^/]*\.(tsx?|css)$|^src-tauri\/src\/profile[^/]*\.rs$/,
  'native-installer': /^Windows\/.*\.(nsi|nsh)$|^src-tauri\/(tauri[^/]*\.json|capabilities\/)|^scripts\/(build-release|prepare-release)\.mjs$|^src\/.*[Uu]pdat[^/]*\.(tsx?|js)$/,
};
const isTest = (file) => /\.(test|spec)\.|^scripts\/native-close-fixture\//.test(file);
const metadata = new Set(['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']);
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
export function verifyPublicBaseline({ root, baseline, predecessors = [], execute = execFileSync }) {
  const repository = 'm17h/Mythra-Code';
  if (!baseline || typeof baseline.tag !== 'string' || !baseline.tag.trim() || !SHA.test(baseline.commit)) throw new Error('Public baseline needs an exact tag and commit');
  const api = (path) => JSON.parse(execute('gh', ['api', `repos/${repository}/${path}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const publicRelease = (release, tag) => {
    if (!release || typeof tag !== 'string' || !tag.trim() || release.tag_name !== tag || release.draft !== false || release.prerelease !== false
      || !Number.isSafeInteger(release.id) || release.id <= 0 || !Number.isFinite(Date.parse(release.published_at))) throw new Error(`Release baseline must be public and non-prerelease: ${tag}`);
    return release;
  };
  const taggedCommit = (tag) => {
    let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object;
    for (let depth = 0; depth < 5; depth++) {
      if (!object || !SHA.test(object.sha)) throw new Error(`Public release tag has no exact source: ${tag}`);
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') throw new Error(`Public release tag does not resolve to a commit: ${tag}`);
      object = api(`git/tags/${object.sha}`).object;
    }
    throw new Error(`Public release tag nesting is excessive: ${tag}`);
  };
  const latest = api('releases/latest');
  publicRelease(latest, latest.tag_name);
  if (latest.tag_name !== baseline.tag && !predecessors.some((p) => p.tag === latest.tag_name && typeof p.reason === 'string' && p.reason.trim())) {
    throw new Error(`Baseline ${baseline.tag} is not the latest public release ${latest.tag_name}; explicitly record the superseding shipped predecessor and its reason`);
  }
  const release = latest.tag_name === baseline.tag ? latest : publicRelease(api(`releases/tags/${encodeURIComponent(baseline.tag)}`), baseline.tag);
  const commit = taggedCommit(baseline.tag);
  if (baseline.commit !== commit) throw new Error('Public baseline tag differs from the local source tag');
  return { schemaVersion: 1, repository, releaseId: release.id, tag: baseline.tag, commit,
    publishedAt: release.published_at, latestReleaseId: latest.id, latestTag: latest.tag_name,
    latestCommit: latest.tag_name === baseline.tag ? commit : taggedCommit(latest.tag_name), verifiedAt: new Date().toISOString() };
}
const validFiles = (files) => Array.isArray(files) && files.every((f) => typeof f === 'string' && !f.startsWith('/') && !f.includes('..'));
function needsReview(file, classifications) {
  if (isTest(file) || classifications.some((c) => c.path === file)) return false;
  // This script mixes verification/staging with installer behavior. Require a
  // reviewed installer decision even though its conservative startup rule matches.
  if (file === 'Windows/build.ps1') return true;
  if (file === 'src-tauri/src/lib.rs' || file === 'src/App.tsx' || /^(package(-lock)?\.json|src-tauri\/Cargo\.(toml|lock))$/.test(file)) return true;
  if (Object.values(boundaries).some((pattern) => pattern.test(file))) return false;
  // Unfamiliar shared helpers and hooks can own startup, lifecycle or durable
  // state. A component/style change does not imply any of those boundaries.
  return /^src\/(lib|hooks)\/.*\.(tsx?|jsx?|mjs)$/.test(file)
    || !/^(src\/|docs\/|\.github\/|scripts\/|public\/|.*\.md$)/.test(file);
}

function nativeIntegrationHints(root, from, to, context = '') {
  const integrationFiles = { 'src-tauri/src/lib.rs': {
    'native-startup': /startup_guard|WebviewWindowBuilder|\.setup\(|StartupGuard|setup_failure|report_renderer_ready/,
    'native-close': /close_guard|CloseRequested|ExitRequested|RunEvent::Exit|on_window_event|flush.*close/,
    'native-storage': /StateDb|state_db_path|open_state_db|app_state|persistence::/,
  }, 'src/App.tsx': {
    'native-startup': /markRendererLaunch|startApplication|startupRanRef|reportRenderer|startup_(ready|failed)|initial(Projects|WorkspaceMode|KnownThreads|Settings)/,
    'native-close': /useFlushOnClose|flushBeforeClose|flushPendingStateWrites|localTranscriptSaves\.flushAll/,
    'native-storage': /usePersistedState|loadStored|readStoredRaw|storeValue|flushPendingStateWrites|useTranscriptSaves|localTranscriptSaves/,
    'native-onboarding': /[Oo]nboarding/,
  } };
  return Object.entries(integrationFiles).flatMap(([file, patterns]) => {
    const diff = git(root, ['diff', '--unified=3', from, to, '--', file]);
    const changed = diff.split('\n').filter((line) => /^[+-][^+-]/.test(line)).join('\n');
    return Object.entries(patterns).filter(([, pattern]) => pattern.test(changed)).map(([check]) => ({ check,
      reason: `${context ? `${context}: ` : ''}${file}: Changed native integration for ${check}` }));
  });
}

function withoutVersion(text, file) {
  if (file.endsWith('.json')) {
    const value = JSON.parse(text); delete value.version;
    if (file === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
    return JSON.stringify(value);
  }
  // Only the app package's version may be ignored, never dependency versions.
  if (file === 'src-tauri/Cargo.toml') return text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, '$1"<release-version>"');
  return text.replace(/(\[\[package\]\]\nname = "mythra-code"\nversion = )"[^"]+"/, '$1"<release-version>"');
}
export function changedSource(root, from, to) {
  const files = git(root, ['diff', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
  return files.filter((file) => {
    if (!metadata.has(file)) return true;
    try { return withoutVersion(git(root, ['show', `${from}:${file}`]), file) !== withoutVersion(git(root, ['show', `${to}:${file}`]), file); }
    catch { return true; }
  });
}

export function createPlan({ commit, version, baseline, changedFiles, predecessors = [], knownIssues = [], overrides = [], policyHash, classifications = [], boundaryHints = [], publisherHost = hostname(), upgradeCoverage = [] }) {
  if (!SHA.test(commit) || !SHA.test(baseline?.commit) || !baseline.tag || !baseline.reason || !policyHash) throw new Error('Plan requires exact source, accepted public baseline and policy fingerprint');
  if (!validFiles(changedFiles)) throw new Error('Invalid cumulative diff');
  for (const predecessor of predecessors) if (!SHA.test(predecessor.commit) || !predecessor.tag || !predecessor.reason || !validFiles(predecessor.changedFiles)) throw new Error('Each shipped predecessor needs commit, tag, reason and cumulative diff');
  if (!Array.isArray(upgradeCoverage) || upgradeCoverage.some((d) => !isVerifiedUpgradeCoverage(d))) throw new Error('Upgrade coverage must be resolved from accepted coordinator evidence');
  const scope = { upgradeCoverage };
  const allowedIds = Object.keys(boundaries);
  for (const item of [...knownIssues, ...overrides, ...boundaryHints, ...predecessors.flatMap((p) => p.boundaryHints ?? [])]) {
    if (!allowedIds.includes(item.check) || !item.reason || (item.platform && !PLATFORMS.includes(item.platform))) throw new Error('Invalid native-check addition');
  }
  for (const scope of [{ changedFiles, classifications }, ...predecessors]) {
    for (const c of scope.classifications ?? []) if (!scope.changedFiles.includes(c.path) || !c.reason || !c.evidence || !Array.isArray(c.boundaries) || c.boundaries.some((b) => !allowedIds.includes(b))) throw new Error('Invalid semantic classification');
  }
  const checks = [{ id: 'ci', kind: 'ci', required: true, reason: 'Complete Verify gate for exact merged source', dependsOn: [] }];
  for (const platform of PLATFORMS) {
    checks.push({ id: `build:${platform}`, kind: 'build', platform, required: true, reason: 'Native package with exact production startup and platform signing', dependsOn: [] });
    checks.push({ id: `audit:${platform}`, kind: 'audit', platform, required: true, reason: 'Package hashes, provenance and cryptographic/platform integrity', dependsOn: [`build:${platform}`] });
    for (const [id, pattern] of Object.entries(boundaries)) {
      const current = changedFiles.filter((f) => !isTest(f) && appliesToPlatform(f, platform) && pattern.test(f));
      // Only actual shipped predecessor differences add upgrade risk. Intermediate
      // never-shipped/reverted commits are review context, not automatic gates.
      const previous = predecessors.filter((p) => !coversHistoricalUpgrade(scope, p, id, platform)).flatMap((p) => p.changedFiles.filter((f) => !isTest(f) && appliesToPlatform(f, platform) && pattern.test(f)).map((f) => `${p.tag}:${f}`));
      // Provenance comes from the containing scope, never an input item's fields.
      const additions = [...knownIssues, ...overrides, ...boundaryHints,
        ...predecessors.filter((p) => !coversHistoricalUpgrade(scope, p, id, platform)).flatMap((p) => [
          ...(p.boundaryHints ?? []), ...(p.classifications ?? []).filter((c) => appliesToPlatform(c.path, platform))
            .flatMap((c) => c.boundaries.map((check) => ({ check, reason: `${p.tag}:${c.path}: ${c.reason}` }))),
        ]),
        ...classifications.filter((c) => appliesToPlatform(c.path, platform)).flatMap((c) => c.boundaries.map((check) => ({ check, reason: `${c.path}: ${c.reason}` })))
      ].filter((i) => i.check === id && (!i.platform || i.platform === platform));
      const triggers = [...current, ...previous, ...additions.map((a) => a.reason)];
      checks.push({ id: `${id}:${platform}`, kind: 'native', platform, required: triggers.length > 0,
        reason: triggers.length ? triggers.join('; ') : historicalCoverageReason(upgradeCoverage, id, platform),
        ...(upgradeCoverage.some((d) => d.reusable && d.check === id && d.platform === platform) ? { historicalCoverage: upgradeCoverage.filter((d) => d.reusable && d.check === id && d.platform === platform).map((d) => d.proofHash) } : {}), dependsOn: [`audit:${platform}`] });
    }
  }
  const nativePrerequisites = checks.filter((c) => c.required && (c.kind === 'native' || c.kind === 'audit')).map((c) => c.id);
  checks.push({ id: 'draft', kind: 'draft', required: true, reason: 'Combined fresh-download draft audit', dependsOn: ['ci', ...nativePrerequisites] });
  checks.push({ id: 'publish', kind: 'publish', required: true, reason: 'Publish the audited combined release under explicit authorization', dependsOn: ['draft'] });
  checks.push({ id: 'public', kind: 'public', required: true, reason: 'Fresh public packages and latest updater endpoint match audited inputs', dependsOn: ['publish'] });
  const reviewRequired = [...changedFiles.filter((f) => needsReview(f, classifications)),
    ...predecessors.flatMap((p) => p.changedFiles.filter((f) => needsReview(f, p.classifications ?? [])).map((f) => `${p.tag}:${f}`))];
  const payload = { schemaVersion: 1, policyVersion: POLICY_VERSION, policyHash, repository: 'm17h/Mythra-Code', publisherHost, commit, version,
    baseline, predecessors, ...(upgradeCoverage.length ? { upgradeCoverage } : {}), changedFiles: [...changedFiles].sort(), knownIssues, overrides, classifications, boundaryHints, reviewRequired, checks };
  return assertPlan({ ...payload, planHash: objectHash(payload) });
}

export function planFromCheckout(root, { baseline, predecessors = [], knownIssues = [], overrides = [], classifications = [], reviewNotes = '', upgradeCoverage = [] }, { execute = execFileSync } = {}) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (git(root, ['status', '--porcelain'])) throw new Error('Freeze a clean release checkout before planning');
  const origin = git(root, ['remote', 'get-url', 'origin']);
  if (!/^(https:\/\/github\.com\/|git@github\.com:)m17h\/Mythra-Code(?:\.git)?$/.test(origin)) throw new Error('Non-canonical release repository');
  const baselineCommit = git(root, ['rev-parse', `${baseline.tag}^{commit}`]);
  if (baseline.commit && baseline.commit !== baselineCommit) throw new Error('Baseline tag moved');
  git(root, ['merge-base', '--is-ancestor', baselineCommit, commit]);
  const publicEvidence = verifyPublicBaseline({ root, baseline: { ...baseline, commit: baselineCommit }, predecessors, execute });
  const packageInfo = JSON.parse(git(root, ['show', `${commit}:package.json`]));
  const policyFiles = ['AGENTS.md', '.github/workflows/verify.yml', 'scripts/verify-ci.mjs', 'scripts/release-plan.mjs', 'scripts/release-state.mjs', 'scripts/release-upgrade-coverage.mjs'];
  const policyHash = objectHash(policyFiles.map((file) => ({ file, contents: git(root, ['show', `${commit}:${file}`]) })));
  const boundaryHints = nativeIntegrationHints(root, baselineCommit, commit);
  const preparedPredecessors = predecessors.map((p) => {
    const sha = git(root, ['rev-parse', `${p.tag}^{commit}`]);
    if (p.commit && p.commit !== sha) throw new Error(`Predecessor tag moved: ${p.tag}`);
    if (p.tag === publicEvidence.latestTag && sha !== publicEvidence.latestCommit) throw new Error(`Public predecessor tag differs from the local source tag: ${p.tag}`);
    return { ...p, commit: sha, changedFiles: changedSource(root, sha, commit), boundaryHints: nativeIntegrationHints(root, sha, commit, p.tag) };
  });
  const coverage = resolveUpgradeCoverage({ root, proofPaths: upgradeCoverage, baseline: { ...baseline, commit: baselineCommit }, commit, predecessors: preparedPredecessors, execute });
  for (const p of preparedPredecessors) {
    const inherited = coverage.filter((d) => d.reusable && d.predecessor.tag === p.tag).flatMap((d) => d.historicalClassifications);
    const classifications = [...(p.classifications ?? [])];
    for (const c of inherited) if (p.changedFiles.includes(c.path) && !classifications.some((existing) => existing.path === c.path)) classifications.push(c);
    p.classifications = classifications;
  }
  const plan = createPlan({ commit, version: packageInfo.version, baseline: { ...baseline, commit: baselineCommit, publicEvidence },
    changedFiles: changedSource(root, baselineCommit, commit), predecessors: preparedPredecessors, upgradeCoverage: coverage,
    knownIssues, overrides, classifications, boundaryHints, policyHash });
  if (plan.reviewRequired.length) throw new Error(`Release classification requires review notes for: ${plan.reviewRequired.join(', ')}`);
  const { planHash: _hash, ...payload } = plan;
  payload.reviewNotes = reviewNotes;
  return assertPlan({ ...payload, planHash: objectHash(payload) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, output] = process.argv.slice(2);
  if (!configPath || !output) throw new Error('Usage: node scripts/release-plan.mjs <plan-input.json> <state-directory>');
  const { readJson } = await import('./release-state.mjs');
  const plan = planFromCheckout(resolve(import.meta.dirname, '..'), readJson(configPath));
  atomicJson(resolve(output, 'plan.json'), plan);
  console.log(JSON.stringify({ planHash: plan.planHash, commit: plan.commit, required: plan.checks.filter((c) => c.required).map((c) => c.id) }, null, 2));
}
