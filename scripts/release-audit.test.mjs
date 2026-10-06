import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetNames, assertDownloadedRemote, assertPlatformManifests, assertPublicationVersion, assertTagTarget } from './release-audit.mjs';
import { fileHash } from './release-state.mjs';
const roots = [], plan = { version: '1.2.3', commit: 'a'.repeat(40) };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function assets() {
  const directory = mkdtempSync(join(tmpdir(), 'release-remote-audit-')); roots.push(directory);
  const names = assetNames(plan.version);
  for (const name of names) writeFileSync(join(directory, name), '1.2.3');
  return { directory, release: { tagName: 'v1.2.3', targetCommitish: plan.commit, isDraft: true, isPrerelease: false, body: '1.2.3',
    assets: names.map((name, id) => ({ name, id, size: 5, digest: `sha256:${fileHash(join(directory, name))}`, updatedAt: '2026-01-01' })) } };
}
test('fresh downloads must match GitHub digests, sizes and stable identities', () => {
  const input = { ...assets(), plan, phase: 'draft' };
  expect(() => assertDownloadedRemote(input)).not.toThrow();
  for (const mutate of [(r) => { r.assets[0].digest = 'sha256:wrong'; }, (r) => { r.assets[0].size++; }, (r) => { r.assets[0].id++; }, (r) => { r.body = 'changed'; }]) {
    const after = structuredClone(input.release); mutate(after);
    expect(() => assertDownloadedRemote({ ...input, after })).toThrow();
  }
  const after = structuredClone(input.release); after.assets[0].downloadCount = 500;
  expect(() => assertDownloadedRemote({ ...input, after })).not.toThrow();
});
test('combined updater entries preserve each approved native platform manifest', () => {
  const platforms = { 'darwin-aarch64': { url: 'mac', signature: 'macsig' }, 'windows-x86_64': { url: 'win', signature: 'winsig' } };
  const releaseCopy = { notes: 'Release 1.2.3', pub_date: '2026-01-01T00:00:00Z' };
  const input = { version: plan.version, manifest: { ...releaseCopy, platforms }, candidates: Object.fromEntries(Object.entries(platforms).map(([p, entry]) => [p, { version: plan.version, ...releaseCopy, platforms: { [p]: structuredClone(entry) } }])) };
  expect(() => assertPlatformManifests(input)).not.toThrow();
  const changed = structuredClone(input); changed.manifest.platforms['darwin-aarch64'].signature = 'other-valid-signature';
  expect(() => assertPlatformManifests(changed)).toThrow(/changed approved/);
  const timestamp = structuredClone(input); timestamp.manifest.pub_date = '2026-02-01T00:00:00Z';
  expect(() => assertPlatformManifests(timestamp)).toThrow(/macOS release copy/);
});
test('draft absent tags are permitted, public absent tags and existing wrong tags fail', () => {
  const input = { root: '/unused', plan, execute: () => '[]' };
  expect(() => assertTagTarget({ ...input, phase: 'draft' })).not.toThrow();
  expect(() => assertTagTarget({ ...input, phase: 'public' })).toThrow(/missing/);
  expect(() => assertTagTarget({ ...input, phase: 'draft', execute: () => JSON.stringify([{ ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: 'b'.repeat(40) } }]) })).toThrow(/frozen/);
});
test('annotated tags must peel to the frozen commit', () => {
  const tagSha = 'c'.repeat(40), calls = [];
  const execute = (_, args) => { calls.push(args); return JSON.stringify(args[1].includes('matching-refs')
    ? [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagSha } }]
    : { object: { type: 'commit', sha: plan.commit } }); };
  expect(assertTagTarget({ root: '/unused', plan, phase: 'public', execute }).commit).toBe(plan.commit);
  expect(calls).toHaveLength(2);
});
test('a delayed release cannot replace a newer public version', () => {
  const latest = (tag) => ({ tag_name: tag, draft: false, prerelease: false, target_commitish: plan.commit });
  expect(() => assertPublicationVersion({ latest: latest('v1.2.2'), plan })).not.toThrow();
  for (const tag of ['v1.2.3', 'v1.2.10', 'v1.20.0', 'v2.0.0']) expect(() => assertPublicationVersion({ latest: latest(tag), plan })).toThrow(/equal or older/);
  expect(() => assertPublicationVersion({ latest: latest('v1.2.3'), plan, alreadyPublished: true })).not.toThrow();
  expect(() => assertPublicationVersion({ latest: { ...latest('v1.2.3'), target_commitish: 'b'.repeat(40) }, plan, alreadyPublished: true })).toThrow();
  expect(() => assertPublicationVersion({ latest: latest('nightly'), plan })).toThrow(/semantic/);
});
