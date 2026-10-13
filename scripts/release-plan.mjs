import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlan, atomicJson, objectHash, PLATFORMS } from './release-state.mjs';

export const POLICY_VERSION = 2;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
// Kept for callers that display source differences; release execution does not
// require cumulative classifications or upgrade proofs.
export function changedSource(root, from, to) {
  return git(root, ['diff', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
}

export function createPlan({ commit, version, policyHash, publisherHost = hostname(), baseline, reviewNotes = '' }) {
  const checks = PLATFORMS.map((platform) => ({
    id: `build:${platform}`, kind: 'build', platform, required: true,
    reason: 'Build and sign the requested version on its native operating system', dependsOn: [],
  }));
  checks.push({ id: 'draft', kind: 'draft', required: true,
    reason: 'Assemble both platform manifests and upload the combined draft',
    dependsOn: PLATFORMS.map((platform) => `build:${platform}`) });
  checks.push({ id: 'publish', kind: 'publish', required: true,
    reason: 'Publish the requested combined release', dependsOn: ['draft'] });
  checks.push({ id: 'public', kind: 'public', required: true,
    reason: 'Record the completed GitHub publication', dependsOn: ['publish'] });
  const payload = { schemaVersion: 1, policyVersion: POLICY_VERSION, policyHash,
    repository: 'm17h/Mythra-Code', publisherHost, commit, version, checks, reviewNotes,
    ...(baseline ? { baseline } : {}) };
  return assertPlan({ ...payload, planHash: objectHash(payload) });
}

export function planFromCheckout(root, input = {}) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (git(root, ['status', '--porcelain'])) throw new Error('Freeze a clean release checkout before planning');
  if (!/^(https:\/\/github\.com\/|git@github\.com:)m17h\/Mythra-Code(?:\.git)?$/.test(git(root, ['remote', 'get-url', 'origin']))) throw new Error('Non-canonical release repository');
  const packageInfo = JSON.parse(git(root, ['show', `${commit}:package.json`]));
  if (input.version && input.version !== packageInfo.version) throw new Error('Requested version differs from the frozen source');
  const policyFiles = ['scripts/release-plan.mjs', 'scripts/release-state.mjs', 'scripts/release-coordinator.mjs'];
  const policyHash = objectHash(policyFiles.map((file) => ({ file, contents: git(root, ['show', `${commit}:${file}`]) })));
  return createPlan({ commit, version: packageInfo.version, policyHash,
    publisherHost: input.publisherHost ?? hostname(), reviewNotes: input.reviewNotes ?? '' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, output] = process.argv.slice(2);
  if (!configPath || !output) throw new Error('Usage: node scripts/release-plan.mjs <plan-input.json> <state-directory>');
  const { readJson } = await import('./release-state.mjs');
  const plan = planFromCheckout(resolve(import.meta.dirname, '..'), readJson(configPath));
  atomicJson(resolve(output, 'plan.json'), plan);
  console.log(JSON.stringify({ planHash: plan.planHash, commit: plan.commit, required: plan.checks.filter((c) => c.required).map((c) => c.id) }, null, 2));
}
