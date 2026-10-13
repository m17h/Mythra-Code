import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLease, assertPlan, leaseStatus, readJson } from './release-state.mjs';
import { acquirePublisherLease, assertActiveRelease, assertCheckout, assertPublisherOwner, assertReadyToPublish, markPublisherMutation } from './release-coordinator.mjs';
import { assertPlatformManifests, assertPublicationVersion, assertRemoteRelease, assertTagTarget } from './release-audit.mjs';
import { REPOSITORY } from './release-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
function checked(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${label} failed.\n${result.stderr || result.stdout || ''}`);
  return (result.stdout || '').trim();
}

const stateRoot = process.env.MYTHRA_RELEASE_STATE;
if (!stateRoot) throw new Error('Finalization requires MYTHRA_RELEASE_STATE with the frozen plan and completed build/upload records');
const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
assertActiveRelease(plan, stateRoot);
if (readJson(resolve(root, 'package.json')).version !== plan.version) throw new Error('Release version differs from frozen source');
assertCheckout(root, plan);
if (process.env.MYTHRA_RELEASE_OWNER) {
  const lease = readJson(resolve(stateRoot, 'lease.json'));
  if (lease.token !== process.env.MYTHRA_RELEASE_OWNER || leaseStatus(lease) !== 'running')
    throw new Error('Publishing coordinator does not own the active release lease');
} else {
  const releaseLease = acquireLease(stateRoot);
  process.once('exit', releaseLease);
}
let publisherOwner = process.env.MYTHRA_RELEASE_PUBLISHER_OWNER;
if (publisherOwner) assertPublisherOwner(plan, publisherOwner);
else {
  const publisherLease = acquirePublisherLease(plan);
  publisherOwner = publisherLease.token;
  process.once('exit', publisherLease);
}
assertReadyToPublish(plan, stateRoot);
const tag = `v${plan.version}`;
const release = JSON.parse(checked('gh', ['release', 'view', tag, '--repo', REPOSITORY,
  '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body'], 'Draft release lookup'));
assertRemoteRelease(release, plan, 'draft');
assertTagTarget({ root, plan, phase: 'draft' });

// Read only the assembled manifest needed for publication. There are no CI,
// application QA, package audits, or independent reviewer prerequisites.
const temporary = mkdtempSync(join(tmpdir(), 'mythra-code-manifest-'));
try {
  checked('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--pattern', 'latest.json',
    '--dir', temporary], 'Combined manifest download');
  const manifest = readJson(resolve(temporary, 'latest.json'));
  if (manifest.version !== plan.version) throw new Error('Combined manifest version differs from requested version');
  assertPlatformManifests({ manifest, version: plan.version, candidates: {
    'darwin-aarch64': readJson(resolve(stateRoot, 'candidates/darwin-aarch64/latest.json')),
    'windows-x86_64': readJson(resolve(stateRoot, 'candidates/windows-x86_64/latest.json')),
  } });
  for (const platform of ['darwin-aarch64', 'windows-x86_64']) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.signature || !entry?.url) throw new Error(`Combined manifest is missing signed ${platform} entry`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
assertPublicationVersion({ latest: JSON.parse(checked('gh',
  ['api', `repos/${REPOSITORY}/releases/latest`], 'Current published version lookup')), plan });
assertActiveRelease(plan, stateRoot);
markPublisherMutation(plan, publisherOwner);
checked('gh', ['release', 'edit', tag, '--repo', REPOSITORY, '--title',
  `Mythra Code ${plan.version}`, '--draft=false', '--latest'], 'Combined release publication');
console.log(`Published combined macOS and Windows release: https://github.com/${REPOSITORY}/releases/tag/${tag}`);
