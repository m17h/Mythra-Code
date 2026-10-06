import { revalidatePlanCoverage } from './release-upgrade-coverage.mjs';
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertReleaseVerification } from "./verify-ci.mjs";
import { acquireLease, assertPlan, leaseStatus, readJson } from './release-state.mjs';
import { acquirePublisherLease, assertPublisherOwner, assertReadyToPublish, markPublisherMutation } from './release-coordinator.mjs';
import { auditAssets, assertDownloadedRemote, assertPlatformManifests, assertPublicationVersion, assertRemoteRelease, assertTagTarget } from './release-audit.mjs';

const REPOSITORY = "m17h/Mythra-Code";
const REQUIRED_PLATFORMS = ["darwin-aarch64", "windows-x86_64"];
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tag = `v${version}`;

function checked(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${label} failed.\n${result.stderr || result.stdout || ""}`);
  }
  return (result.stdout || "").trim();
}

const status = checked("git", ["status", "--porcelain"], "Working-tree check");
if (status) throw new Error(`Refusing to finalize from a dirty working tree:\n${status}`);
const head = checked("git", ["rev-parse", "HEAD"], "Release commit check");
const stateRoot = process.env.MYTHRA_RELEASE_STATE;
if (!stateRoot) throw new Error('Finalization requires MYTHRA_RELEASE_STATE with a frozen plan and complete validation receipts.');
if (process.env.MYTHRA_RELEASE_OWNER) {
  const lease = readJson(resolve(stateRoot, 'lease.json'));
  if (lease.token !== process.env.MYTHRA_RELEASE_OWNER || leaseStatus(lease) !== 'running') throw new Error('Publishing coordinator does not own the active release lease.');
} else {
  const releaseLease = acquireLease(stateRoot);
  process.once('exit', releaseLease);
}
const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
if (plan.commit !== head || plan.version !== version) throw new Error('Validation plan does not match release source/version.');
let publisherOwner = process.env.MYTHRA_RELEASE_PUBLISHER_OWNER;
if (publisherOwner) {
  assertPublisherOwner(plan, publisherOwner);
} else {
  const publisherLease = acquirePublisherLease(plan);
  publisherOwner = publisherLease.token;
  process.once('exit', publisherLease);
}
revalidatePlanCoverage({ root, plan });
const draftReceipt = assertReadyToPublish(plan, stateRoot);

checked("gh", ["auth", "status"], "GitHub authentication check");
const release = JSON.parse(checked("gh", [
  "release", "view", tag,
  "--repo", REPOSITORY,
  "--json", "tagName,isDraft,isPrerelease,targetCommitish,assets,body",
], "Draft release check"));
if (!release.isDraft) throw new Error(`${tag} is not a draft release.`);
if (release.targetCommitish !== head) {
  throw new Error(`Draft ${tag} targets ${release.targetCommitish || "an unknown commit"}, not current HEAD ${head}.`);
}
assertRemoteRelease(release, plan, 'draft');
assertTagTarget({ root, plan, phase: 'draft' });

const runs = JSON.parse(checked("gh", [
  "run", "list",
  "--repo", REPOSITORY,
  "--commit", head,
  "--workflow", "Verify",
  "--limit", "10",
  "--json", "databaseId,status,conclusion,headSha",
], "CI check") || "[]");
let verifiedRun = false;
for (const run of runs) {
  if (run.headSha !== head || run.status !== "completed" || run.conclusion !== "success") continue;
  const jobs = JSON.parse(checked("gh", [
    "api", `repos/${REPOSITORY}/actions/runs/${run.databaseId}/jobs?per_page=100`,
  ], "CI gate and lane check")).jobs;
  try {
    assertReleaseVerification(run, jobs, head);
    verifiedRun = true;
    break;
  } catch (error) {
    console.warn(`Verify run ${run.databaseId} cannot approve this release: ${error.message}`);
  }
}
if (!verifiedRun) {
  throw new Error(`No successful complete Verify gate and lane set exists for ${head}.`);
}

const temporary = mkdtempSync(join(tmpdir(), "mythra-code-finalize-"));
try {
  checked('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--dir', temporary, '--clobber'], 'Fresh package download');
  auditAssets({ root, directory: temporary, plan, expectedHashes: draftReceipt.details.hashes });
  assertDownloadedRemote({ release, directory: temporary, plan, phase: 'draft' });
  checked("gh", [
    "release", "download", tag,
    "--repo", REPOSITORY,
    "--pattern", "latest.json",
    "--dir", temporary,
    "--clobber",
  ], "Updater manifest download");
  checked("gh", [
    "release", "download", tag,
    "--repo", REPOSITORY,
    "--pattern", "release-notes.md",
    "--dir", temporary,
    "--clobber",
  ], "Release notes download");
  const manifest = JSON.parse(readFileSync(resolve(temporary, "latest.json"), "utf8"));
  assertPlatformManifests({ manifest, version, candidates: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform,
    readJson(resolve(stateRoot, 'candidates', platform, 'latest.json'))])) });
  if (manifest.version !== version) {
    throw new Error(`Draft manifest version ${manifest.version} does not match package version ${version}.`);
  }
  const approvedNotes = readFileSync(resolve(temporary, "release-notes.md"), "utf8").trim();
  if (manifest.notes !== approvedNotes) {
    throw new Error("The combined updater manifest does not preserve the approved release-notes.md content.");
  }

  const assetNames = new Set((release.assets || []).map((asset) => asset.name));
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.url || !entry?.signature) throw new Error(`The combined updater manifest is missing ${platform}.`);
    const expectedPrefix = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
    if (!entry.url.startsWith(expectedPrefix)) throw new Error(`${platform} uses a non-canonical release URL.`);
    const artifact = basename(new URL(entry.url).pathname);
    if (!assetNames.has(artifact)) throw new Error(`The updater artifact for ${platform} is not attached: ${artifact}`);
  }
  for (const required of [
    "latest.json",
    "release-notes.md",
    "MythraCode-icon.png",
    `MythraCode_${version}_aarch64.app.tar.gz`,
    `MythraCode_${version}_aarch64.dmg`,
    `MythraCode_${version}_x64-setup.exe`,
    `MythraCode_${version}_x64-setup.exe.sig`,
    "build-info.txt",
    "build-info.json",
  ]) {
    if (!assetNames.has(required)) throw new Error(`Draft ${tag} is missing required cross-platform asset ${required}.`);
  }
  const after = JSON.parse(checked('gh', ['release', 'view', tag, '--repo', REPOSITORY,
    '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets,body'], 'Draft stability check'));
  assertDownloadedRemote({ release, after, directory: temporary, plan, phase: 'draft' });
  assertTagTarget({ root, plan, phase: 'draft' });
  const latest = JSON.parse(checked('gh', ['api', `repos/${REPOSITORY}/releases/latest`], 'Current public version check'));
  assertPublicationVersion({ latest, plan });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

// Standalone finalization also owns subprocess mutation. If this process dies
// while gh survives, a replacement publisher must fail closed on recovery.
markPublisherMutation(plan, publisherOwner);
const publish = spawnSync("gh", [
  "release", "edit", tag,
  "--repo", REPOSITORY,
  "--title", `Mythra Code ${version}`,
  "--draft=false",
  "--latest",
], { cwd: root, stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

const fetchTags = spawnSync("git", ["fetch", "origin", "--tags"], { cwd: root, stdio: "inherit" });
if (fetchTags.status !== 0) console.warn("Warning: published successfully, but local tags could not be refreshed.");
console.log(`Published the combined macOS and Windows release: https://github.com/${REPOSITORY}/releases/tag/${tag}`);
