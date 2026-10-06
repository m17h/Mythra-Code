import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileHash, objectHash, PLATFORMS, readJson, SHA } from './release-state.mjs';
import { REPOSITORY } from './release-evidence.mjs';

export function assetNames(version) {
  return ['latest.json', 'release-notes.md', 'MythraCode-icon.png', 'build-info.txt', 'build-info.json',
    `MythraCode_${version}_aarch64.app.tar.gz`, `MythraCode_${version}_aarch64.dmg`,
    `MythraCode_${version}_x64-setup.exe`, `MythraCode_${version}_x64-setup.exe.sig`].sort();
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function assertAssetMetadata({ version, commit, manifest, macInfo, windowsInfo, signature, notes, names, hashes }) {
  if (!SHA.test(commit) || manifest.version !== version || !same(Object.keys(manifest.platforms ?? {}), PLATFORMS)
    || !same(names, assetNames(version))) throw new Error('Release must contain the exact version, two platforms and nine assets');
  if (manifest.notes !== notes.trim() || !notes.includes(version) || !Number.isFinite(Date.parse(manifest.pub_date))) throw new Error('Updater notes or publication date differ from release contract');
  if (macInfo.match(/^commit: ([a-f0-9]{40})$/m)?.[1] !== commit || macInfo.match(/^version: (.+)$/m)?.[1] !== version) throw new Error('macOS provenance mismatch');
  const installer = `MythraCode_${version}_x64-setup.exe`;
  if (windowsInfo.commit !== commit || windowsInfo.version !== version || windowsInfo.dirty !== false
    || windowsInfo.platform !== 'windows-x86_64' || windowsInfo.architecture !== 'x64'
    || windowsInfo.peSubsystem !== 'WindowsGui' || windowsInfo.authenticodeStatus !== 'NotSigned'
    || windowsInfo.installer !== installer || windowsInfo.signature !== `${installer}.sig`
    || windowsInfo.sha256 !== hashes[installer]) throw new Error('Windows provenance/hash mismatch');
  for (const [platform, name] of [['darwin-aarch64', `MythraCode_${version}_aarch64.app.tar.gz`], ['windows-x86_64', installer]]) {
    const entry = manifest.platforms[platform];
    if (entry.url !== `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}` || !entry.signature) throw new Error('Invalid updater asset URL/signature');
  }
  if (manifest.platforms['windows-x86_64'].signature !== signature.trim()) throw new Error('Windows signature differs from manifest');
}

export function verifyMinisign({ file, publicKey, signature, execute = execFileSync }) {
  const temporary = mkdtempSync(join(tmpdir(), 'mythra-minisign-'));
  try {
    const decode = (text) => {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw new Error('Updater material must be base64-encoded Minisign text');
      const compact = text.replace(/\s+/g, ''), bytes = Buffer.from(compact, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) throw new Error('Invalid base64 updater material');
      const decoded = bytes.toString('utf8');
      if (!decoded.startsWith('untrusted comment:')) throw new Error('Invalid decoded Minisign material');
      return decoded;
    };
    const keyPath = join(temporary, 'key.pub'), signaturePath = join(temporary, 'package.minisig');
    writeFileSync(keyPath, decode(publicKey)); writeFileSync(signaturePath, decode(signature));
    execute('minisign', ['-Vm', file, '-p', keyPath, '-x', signaturePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function auditAssets({ root, directory, plan, expectedHashes, execute = execFileSync }) {
  const names = readdirSync(directory).sort();
  if (!same(names, assetNames(plan.version))) throw new Error('Unexpected or missing release assets');
  const hashes = Object.fromEntries(names.map((name) => [name, fileHash(resolve(directory, name))]));
  if (expectedHashes && (!same(Object.keys(expectedHashes), names) || names.some((name) => expectedHashes[name] !== hashes[name]))) throw new Error('Downloaded assets differ from approved package hashes');
  const manifest = readJson(resolve(directory, 'latest.json'));
  assertAssetMetadata({ version: plan.version, commit: plan.commit, manifest, macInfo: readFileSync(resolve(directory, 'build-info.txt'), 'utf8'),
    windowsInfo: readJson(resolve(directory, 'build-info.json')), signature: readFileSync(resolve(directory, `MythraCode_${plan.version}_x64-setup.exe.sig`), 'utf8'),
    notes: readFileSync(resolve(directory, 'release-notes.md'), 'utf8'), names, hashes });
  const macKey = readJson(resolve(root, 'src-tauri/tauri.conf.json')).plugins.updater.pubkey;
  const windowsKey = readJson(resolve(root, 'src-tauri/tauri.windows.conf.json')).plugins.updater.pubkey;
  if (macKey === windowsKey) throw new Error('Platform updater keys must remain distinct');
  for (const [path, key] of [['src-tauri/tauri.conf.json', macKey], ['src-tauri/tauri.windows.conf.json', windowsKey]]) {
    const frozen = JSON.parse(execute('git', ['show', `${plan.commit}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (frozen.plugins.updater.pubkey !== key) throw new Error('Embedded updater key differs from frozen source');
  }
  for (const [platform, name, key] of [['darwin-aarch64', `MythraCode_${plan.version}_aarch64.app.tar.gz`, macKey], ['windows-x86_64', `MythraCode_${plan.version}_x64-setup.exe`, windowsKey]]) {
    verifyMinisign({ file: resolve(directory, name), publicKey: key, signature: manifest.platforms[platform].signature, execute });
  }
  return { schemaVersion: 1, commit: plan.commit, version: plan.version, hashes, signaturesVerified: PLATFORMS };
}

export function assertRemoteRelease(release, plan, phase) {
  if (release.targetCommitish !== plan.commit || release.tagName !== `v${plan.version}` || release.isPrerelease
    || release.isDraft !== (phase === 'draft') || !same(release.assets.map((a) => a.name), assetNames(plan.version))) throw new Error(`Unexpected ${phase} release state`);
}

/** Downloads change counters; every identity, digest and update marker stays fixed. */
export function releaseFingerprint(release) {
  return objectHash({ tagName: release.tagName, targetCommitish: release.targetCommitish,
    isDraft: release.isDraft, isPrerelease: release.isPrerelease, body: release.body,
    assets: release.assets.map(({ name, id, size, digest, updatedAt, updated_at }) => ({ name, id, size, digest, updatedAt, updated_at })).sort((a, b) => a.name.localeCompare(b.name)) });
}

export function assertDownloadedRemote({ release, after = release, directory, plan, phase }) {
  assertRemoteRelease(release, plan, phase); assertRemoteRelease(after, plan, phase);
  if (releaseFingerprint(release) !== releaseFingerprint(after)) throw new Error('Remote release changed during validation');
  for (const asset of release.assets) {
    const path = resolve(directory, asset.name);
    if (statSync(path).size !== asset.size || asset.digest !== `sha256:${fileHash(path)}`) throw new Error(`Downloaded asset differs from GitHub digest/size: ${asset.name}`);
  }
  if (release.body?.trim() !== readFileSync(resolve(directory, 'release-notes.md'), 'utf8').trim()) throw new Error('Remote release body differs from approved notes');
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
