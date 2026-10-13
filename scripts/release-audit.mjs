import { execFileSync } from 'node:child_process';
import { objectHash, PLATFORMS, SHA } from './release-state.mjs';
import { REPOSITORY } from './release-evidence.mjs';

export function assetNames(version) {
  return ['latest.json', 'release-notes.md', 'MythraCode-icon.png', 'build-info.txt', 'build-info.json',
    `MythraCode_${version}_aarch64.app.tar.gz`, `MythraCode_${version}_aarch64.dmg`,
    `MythraCode_${version}_x64-setup.exe`, `MythraCode_${version}_x64-setup.exe.sig`].sort();
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function assertRemoteRelease(release, plan, phase) {
  if (release.targetCommitish !== plan.commit || release.tagName !== `v${plan.version}` || release.isPrerelease
    || release.isDraft !== (phase === 'draft') || !same(release.assets.map((a) => a.name), assetNames(plan.version))) throw new Error(`Unexpected ${phase} release state`);
}

export function assertPlatformManifests({ manifest, candidates, version }) {
  const mac = candidates['darwin-aarch64'];
  if (manifest.notes !== mac?.notes || manifest.pub_date !== mac?.pub_date) throw new Error('Combined manifest changed the approved macOS release copy');
  for (const platform of PLATFORMS) {
    const approved = candidates[platform];
    if (approved?.version !== version || !same(Object.keys(approved.platforms ?? {}), [platform])
      || objectHash(approved.platforms[platform]) !== objectHash(manifest.platforms?.[platform])) throw new Error(`Combined manifest changed approved platform entry: ${platform}`);
  }
}

export function assertTagTarget({ root, plan, phase, execute = execFileSync }) {
  const gh = (path) => JSON.parse(execute('gh', ['api', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const tag = `v${plan.version}`, refs = gh(`repos/${REPOSITORY}/git/matching-refs/tags/${tag}`).filter((ref) => ref.ref === `refs/tags/${tag}`);
  if (refs.length === 0 && phase === 'draft') return { tag, status: 'created-at-publication' };
  if (refs.length !== 1) throw new Error('Published tag is missing or ambiguous');
  let object = refs[0].object;
  const seen = new Set();
  while (object.type === 'tag') {
    if (!SHA.test(object.sha) || seen.has(object.sha) || seen.size >= 8) throw new Error('Invalid annotated tag chain');
    seen.add(object.sha); object = gh(`repos/${REPOSITORY}/git/tags/${object.sha}`).object;
  }
  if (object.type !== 'commit' || object.sha !== plan.commit) throw new Error('Release tag does not resolve to frozen source');
  return { tag, commit: object.sha };
}

export function assertPublicationVersion({ latest, plan, alreadyPublished = false }) {
  if (!latest) return; // Only callers with a verified initial-release 404 use null.
  const parse = (value) => {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) throw new Error('Cannot establish canonical published semantic version');
    return value.replace(/^v/, '').split('.').map(BigInt);
  };
  const current = parse(latest.tag_name), candidate = parse(plan.version);
  if (latest.draft !== false || latest.prerelease !== false) throw new Error('Latest release is not an accepted public stable version');
  let comparison = 0;
  for (let i = 0; i < 3; i++) if (candidate[i] !== current[i]) { comparison = candidate[i] > current[i] ? 1 : -1; break; }
  if (comparison > 0) return;
  if (comparison === 0 && alreadyPublished && latest.tag_name === `v${plan.version}` && latest.target_commitish === plan.commit) return;
  throw new Error('Refusing to publish an equal or older version over the current public release');
}
