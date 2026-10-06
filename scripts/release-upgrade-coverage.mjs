// Historical upgrade acceptance affects test selection, never current package acceptance.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlan, atomicJson, containedPath, digest, fileHash, HASH, objectHash, PLATFORMS, readJson, receiptPath, reconcile, SHA } from './release-state.mjs';
import { expectedNativeObservations, validateNativeResult } from './release-native-check.mjs';
import { sourceUpgradeSchema } from './release-upgrade-snapshot.mjs';

const require = createRequire(import.meta.url);
const verified = new WeakMap();
const repository = 'm17h/Mythra-Code';
const checks = ['native-startup', 'native-close', 'native-storage', 'native-onboarding', 'native-installer'];
const ensure = (condition, message) => { if (!condition) throw new Error(`Upgrade coverage: ${message}`); };
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const source = (root, commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export const upgradeObservationId = (predecessor) => `upgrade:${predecessor.tag}@${predecessor.commit}`;
export const upgradeIssueId = (issue) => objectHash({ check: issue.check, platform: issue.platform ?? null, reason: issue.reason });

function normalizedSource(bytes, path) {
  const text = bytes.toString('utf8');
  if (['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'].includes(path)) {
    const value = JSON.parse(text); delete value.version;
    if (path === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
    return JSON.stringify(value);
  }
  if (path === 'src-tauri/Cargo.toml') return text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, '$1"<release-version>"');
  if (path === 'src-tauri/Cargo.lock') return text.replace(/(\[\[package\]\]\nname = "mythra-code"\nversion = )"[^"]+"/, '$1"<release-version>"');
  if (path === 'src/components/BrandLogos.tsx') {
    // The audited icon module may change literal intrinsic SVG paint/geometry.
    // Custom component props, text, imports and all executable syntax stay bound.
    const ast = require('@babel/core').parseSync(text, { configFile: false, babelrc: false, parserOpts: { plugins: ['typescript', 'jsx'] } });
    const visual = new Set(['fill', 'stroke', 'strokeWidth', 'viewBox', 'd', 'points', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2']);
    const shapes = new Set(['svg', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g', 'use']);
    const visit = (node, svg = false, attribute = false) => {
      if (Array.isArray(node)) return node.map((n) => visit(n, svg, attribute));
      if (!node || typeof node !== 'object') return node;
      if (node.type === 'JSXElement') svg = svg || node.openingElement.name?.name === 'svg';
      if (node.type === 'JSXAttribute' && attribute && visual.has(node.name?.name) && node.value?.type === 'StringLiteral') {
        return { type: node.type, name: visit(node.name), value: { type: 'StringLiteral', value: '<svg-presentation>' } };
      }
      return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens'].includes(key)).map(([key, value]) =>
        [key, visit(value, svg, key === 'attributes' && node.type === 'JSXOpeningElement' && svg && shapes.has(node.name?.name))]));
    };
    return JSON.stringify(visit(ast));
  }
  return bytes;
}

export function fingerprintUpgradeInputs(root, commit, platform) {
  ensure(SHA.test(commit) && PLATFORMS.includes(platform), 'invalid fingerprint source/platform');
  const files = git(root, ['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean);
  const inputs = [];
  for (const path of files) {
    if (/\.(test|spec)\.|^scripts\/native-close-fixture\/|^docs\/(?!operations\/native-release-qa\.md$)|^\.github\/|(^|\/)\.gitignore$/.test(path)
      || (path.endsWith('.md') && path !== 'docs/operations/native-release-qa.md' && path !== 'AGENTS.md')) continue;
    if (platform !== 'windows-x86_64' && (path.startsWith('Windows/') || path === 'src-tauri/tauri.windows.conf.json')) continue;
    // Known passive presentation assets may change. Bootstrap/native onboarding
    // still force their existing checks through the current-diff classifier.
    if (/\.css$|\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(path) && path !== 'public/bootstrap.css') continue;
    const bytes = source(root, commit, path);
    if (/\.svg$/i.test(path) && !/<\s*(script|foreignObject)\b|\bon[a-z]+\s*=|(?:javascript:|data:text\/html)/i.test(bytes.toString('utf8'))) continue;
    inputs.push({ path, sha256: digest(normalizedSource(bytes, path)) });
  }
  return objectHash({ schemaVersion: 1, platform, inputs });
}

function remoteIdentity(root, tag, execute, { publicOnly = false } = {}) {
  const api = (path) => JSON.parse(execute('gh', ['api', `repos/${repository}/${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const release = api(`releases/tags/${encodeURIComponent(tag)}`);
  ensure(release.tag_name === tag && Number.isSafeInteger(release.id) && release.id > 0, 'release tag identity missing');
  if (publicOnly) ensure(release.draft === false && release.prerelease === false && Number.isFinite(Date.parse(release.published_at)), 'accepted release is no longer public');
  let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = api(`git/tags/${object.sha}`).object;
  ensure(object?.type === 'commit' && SHA.test(object.sha), 'release tag does not resolve to exact source');
  return { release, identity: { tag, commit: object.sha, releaseId: release.id } };
}

function validateAcceptedNative({ root, stateRoot, plan, platform }) {
  const selectedIds = plan.checks.filter((c) => c.kind === 'native' && c.required && c.platform === platform).map((c) => c.id).sort();
  ensure(selectedIds.length, 'no required native platform checks');
  const checkId = selectedIds[0];
  const receipt = readJson(receiptPath(stateRoot, checkId));
  const evidenceJson = (suffix) => {
    const matches = receipt.evidence.filter((e) => e.path.endsWith(suffix));
    ensure(matches.length === 1, `missing or ambiguous ${suffix} evidence`);
    return readJson(containedPath(stateRoot, matches[0].path));
  };
  const contract = evidenceJson('/contract.json'), result = evidenceJson('/result.json');
  const { contractHash, ...contractBody } = contract;
  ensure(contractHash === objectHash(contractBody) && receipt.details.workerContractHash === contractHash && contract.planHash === plan.planHash
    && contract.commit === plan.commit && contract.platform === platform && contract.packageSha256 === receipt.packageSha256, 'native contract binding differs');
  const recipe = contract.sourceCapability;
  ensure(recipe?.recipePath === 'docs/operations/native-release-qa.md' && digest(source(root, plan.commit, recipe.recipePath)) === recipe.recipeSha256, 'maintained recipe differs');
  ensure(objectHash(contract.checks.map((c) => c.id).sort()) === objectHash(selectedIds), 'native contract omits required platform checks');
  for (const item of contract.checks) ensure(objectHash(item.observations) === objectHash(expectedNativeObservations(item.id.split(':')[0])), 'native acceptance observations were weakened');
  validateNativeResult(result, contract, stateRoot, { executablePath: (entry) => {
    const native = readJson(receiptPath(stateRoot, entry.checkId));
    ensure(native.details.workerContractHash === contractHash && native.details.portableExecutablePath && native.evidence.some((e) => e.path === native.details.portableExecutablePath && e.sha256 === entry.executableSha256), 'portable native executable proof missing');
    ensure(objectHash(native.details.observations) === objectHash(entry.observations) && native.details.pid === entry.pid && native.details.runId === entry.runId && native.details.executableSha256 === entry.executableSha256, 'native result differs from accepted receipt');
    return containedPath(stateRoot, native.details.portableExecutablePath);
  } });
  return { contract, result, recipe, contractHash };
}
const acceptedStack = new Set();
function acceptedContext({ root, stateRoot, execute }) {
  const key = resolve(stateRoot);
  ensure(!acceptedStack.has(key) && acceptedStack.size < 16, 'cyclic or excessively deep accepted coverage');
  acceptedStack.add(key);
  try {
    const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
    revalidatePlanCoverage({ root, plan, execute });
    ensure(reconcile(plan, stateRoot).every((c) => c.status === 'passed' || c.status === 'not-required'), 'accepted coordinator state is incomplete or evidence changed');
    for (const platform of PLATFORMS) if (plan.checks.some((c) => c.kind === 'native' && c.required && c.platform === platform)) validateAcceptedNative({ root, stateRoot, plan, platform });
    const accepted = remoteIdentity(root, `v${plan.version}`, execute, { publicOnly: true });
    ensure(accepted.identity.commit === plan.commit, 'accepted public tag moved');
    const publicReceipt = readJson(receiptPath(stateRoot, 'public'));
    const hashes = publicReceipt.details.hashes;
    const assets = accepted.release.assets ?? [];
    ensure(assets.length === Object.keys(hashes).length && new Set(assets.map((a) => a.name)).size === assets.length
      && assets.every((asset) => Number.isSafeInteger(asset.id) && asset.id > 0 && asset.digest === `sha256:${hashes[asset.name]}`), 'accepted public assets differ from audited evidence');
    const records = plan.checks.filter((c) => c.required).map((c) => ({ checkId: c.id, sha256: fileHash(receiptPath(stateRoot, c.id)) }));
    return { plan, accepted: { ...accepted.identity, assets: assets.map((a) => ({ id: a.id, name: a.name, digest: a.digest })).sort((a, b) => a.name.localeCompare(b.name)) }, evidenceHash: objectHash(records) };
  } finally { acceptedStack.delete(key); }
}

function buildUpgradeCoverage({ root, stateRoot, predecessorTag, platform, check, resolvedIssues = [], execute = execFileSync }, context) {
  ensure(PLATFORMS.includes(platform) && checks.includes(check), 'unknown platform/check');
  const { plan, accepted, evidenceHash } = context ?? acceptedContext({ root, stateRoot, execute });
  const predecessor = plan.predecessors.find((p) => p.tag === predecessorTag);
  ensure(predecessor, 'predecessor was not in the accepted plan');
  const previous = remoteIdentity(root, predecessorTag, execute).identity;
  ensure(previous.commit === predecessor.commit, 'predecessor tag moved');
  git(root, ['merge-base', '--is-ancestor', previous.commit, plan.commit]);
  ensure(previous.commit !== plan.commit, 'predecessor must predate accepted source');
  const checkId = `${check}:${platform}`;
  ensure(plan.checks.some((c) => c.id === checkId && c.required), 'accepted native check was not executed');
  const { contract, result, recipe, contractHash } = validateAcceptedNative({ root, stateRoot, plan, platform });
  const selected = contract.checks.find((c) => c.id === checkId);
  ensure(selected?.upgradeCases?.some((c) => c.id === upgradeObservationId(previous) && c.predecessor.tag === previous.tag && c.predecessor.commit === previous.commit && c.recipeSha256 === recipe.recipeSha256 && c.storageSchema && objectHash(c.storageSchema) === objectHash(sourceUpgradeSchema({ root, predecessorCommit: previous.commit, candidateCommit: plan.commit }))), 'legacy native result has no explicit predecessor upgrade proof');
  ensure(result.results?.find((r) => r.checkId === checkId)?.observations.some((o) => o.id === upgradeObservationId(previous)), 'native result did not execute the predecessor upgrade case');
  const issues = plan.knownIssues.filter((i) => i.check === check && (!i.platform || i.platform === platform)).map(upgradeIssueId);
  ensure(Array.isArray(resolvedIssues) && new Set(resolvedIssues).size === resolvedIssues.length && resolvedIssues.every((id) => issues.includes(id)), 'resolved issue is not an accepted checked issue');
  const body = { schemaVersion: 1, kind: 'accepted-upgrade-coverage', sourceState: resolve(stateRoot), sourcePlanHash: plan.planHash,
    predecessor: previous, accepted, platform, check, nativeReceiptHash: fileHash(receiptPath(stateRoot, checkId)), contractHash,
    recipe: { path: recipe.recipePath, sha256: recipe.recipeSha256 }, inputs: { version: 1, sha256: fingerprintUpgradeInputs(root, plan.commit, platform) },
    resolvedIssues: [...resolvedIssues].sort(), evidenceHash };
  return { ...body, proofHash: objectHash(body) };
}

export function exportUpgradeCoverage(options) { return buildUpgradeCoverage(options); }

export function resolveUpgradeCoverage({ root, proofPaths = [], baseline, commit, predecessors, execute = execFileSync }) {
  const contexts = new Map(), keys = new Set();
  return proofPaths.map((path) => {
    const proofPath = resolve(path), proof = readJson(proofPath), { proofHash, ...body } = proof;
    ensure(proof.schemaVersion === 1 && proof.kind === 'accepted-upgrade-coverage' && HASH.test(proofHash) && objectHash(body) === proofHash, 'invalid coverage document');
    const predecessor = predecessors.find((p) => p.tag === proof.predecessor?.tag && p.commit === proof.predecessor?.commit);
    ensure(predecessor, 'proof predecessor is absent or different');
    if (!contexts.has(proof.sourceState)) contexts.set(proof.sourceState, acceptedContext({ root, stateRoot: proof.sourceState, execute }));
    const expected = buildUpgradeCoverage({ root, stateRoot: proof.sourceState, predecessorTag: predecessor.tag, platform: proof.platform, check: proof.check, resolvedIssues: proof.resolvedIssues, execute }, contexts.get(proof.sourceState));
    ensure(objectHash(expected) === objectHash(proof), 'coverage no longer matches accepted evidence');
    git(root, ['merge-base', '--is-ancestor', proof.accepted.commit, baseline.commit]);
    git(root, ['merge-base', '--is-ancestor', baseline.commit, commit]);
    const baselinePublic = remoteIdentity(root, baseline.tag, execute, { publicOnly: true });
    ensure(baselinePublic.identity.commit === baseline.commit, 'current baseline public tag moved');
    const currentInputs = fingerprintUpgradeInputs(root, commit, proof.platform);
    const key = `${predecessor.tag}:${proof.platform}:${proof.check}`; ensure(!keys.has(key), 'duplicate coverage tuple'); keys.add(key);
    const decision = { proofPath, proofHash, predecessor: proof.predecessor, accepted: { tag: proof.accepted.tag, commit: proof.accepted.commit },
      platform: proof.platform, check: proof.check, baselineCommit: baseline.commit, commit, inputs: currentInputs, acceptedInputs: proof.inputs.sha256,
      reusable: currentInputs === proof.inputs.sha256, resolvedIssues: proof.resolvedIssues,
      historicalClassifications: contexts.get(proof.sourceState).plan.predecessors.find((p) => p.tag === predecessor.tag).classifications ?? [] };
    verified.set(decision, objectHash(decision)); return decision;
  });
}
export function historicalCoverageReason(decisions, check, platform) {
  const covered = decisions.filter((d) => d.reusable && d.check === check && d.platform === platform);
  return covered.length ? `Historical upgrade validated at ${[...new Set(covered.map((d) => d.accepted.tag))].sort().join(', ')}; boundary inputs unchanged and no current trigger` : 'Unaffected cumulative source and shipped upgrade predecessors';
}
export function coversHistoricalUpgrade(plan, predecessor, check, platform) {
  return (plan.upgradeCoverage ?? []).some((d) => d.reusable && d.predecessor.tag === predecessor.tag && d.predecessor.commit === predecessor.commit && d.check === check && d.platform === platform);
}
export function isVerifiedUpgradeCoverage(decision) { return verified.get(decision) === objectHash(decision); }
export function assertUpgradeDecision(decision, plan) {
  ensure(decision && HASH.test(decision.proofHash) && HASH.test(decision.inputs) && HASH.test(decision.acceptedInputs)
    && typeof decision.proofPath === 'string' && decision.proofPath && decision.commit === plan.commit && decision.baselineCommit === plan.baseline.commit
    && SHA.test(decision.accepted?.commit) && decision.accepted.tag && PLATFORMS.includes(decision.platform) && checks.includes(decision.check)
    && plan.predecessors.some((p) => p.tag === decision.predecessor?.tag && p.commit === decision.predecessor?.commit)
    && decision.reusable === (decision.inputs === decision.acceptedInputs) && Array.isArray(decision.resolvedIssues), 'invalid frozen coverage decision');
}
export function revalidatePlanCoverage({ root, plan, execute = execFileSync }) {
  const decisions = plan.upgradeCoverage ?? [];
  if (!decisions.length) return;
  const fresh = resolveUpgradeCoverage({ root, proofPaths: decisions.map((d) => d.proofPath), baseline: plan.baseline, commit: plan.commit, predecessors: plan.predecessors, execute });
  ensure(objectHash(fresh) === objectHash(decisions), 'frozen coverage decisions changed; create a new plan');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateRoot, predecessorTag, platform, check, output, ...resolvedIssues] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/release-upgrade-coverage.mjs <accepted-state> <predecessor-tag> <platform> <check> <proof-output> [resolved-issue-hashes...]');
  const proof = exportUpgradeCoverage({ root: resolve(import.meta.dirname, '..'), stateRoot, predecessorTag, platform, check, resolvedIssues });
  atomicJson(resolve(output), proof); console.log(JSON.stringify({ proofHash: proof.proofHash, accepted: proof.accepted.tag, predecessor: proof.predecessor.tag, platform, check }));
}
