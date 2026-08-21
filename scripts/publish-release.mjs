import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { uploadPlatformDraft } from "./release-draft.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "release-assets/latest");
const manifestPath = resolve(output, "latest.json");
const buildInfoPath = resolve(output, "build-info.txt");
if (!existsSync(manifestPath)) throw new Error("No prepared release found. Run npm run release:build first.");
if (!existsSync(buildInfoPath)) throw new Error("The staged release has no build-info.txt provenance record. Run npm run release:build again before publishing.");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tag = `v${manifest.version}`;
const platformKeys = Object.keys(manifest.platforms || {});
if (platformKeys.length !== 1 || !/^darwin-(aarch64|x86_64)$/.test(platformKeys[0])) {
  throw new Error(`OpenKiwi macOS releases require exactly one darwin platform in latest.json; found: ${platformKeys.join(", ") || "none"}.`);
}
const macArch = platformKeys[0].slice("darwin-".length);
const expectedAssetNames = [
  "OpenKiwi-icon.png",
  `OpenKiwi_${manifest.version}_${macArch}.app.tar.gz`,
  `OpenKiwi_${manifest.version}_${macArch}.dmg`,
  "build-info.txt",
  "latest.json",
  "release-notes.md",
].sort();
const stagedAssetNames = readdirSync(output).sort();
if (JSON.stringify(stagedAssetNames) !== JSON.stringify(expectedAssetNames)) {
  throw new Error(`The staged release is not the exact macOS-only asset set.\nExpected: ${expectedAssetNames.join(", ")}\nFound: ${stagedAssetNames.join(", ")}`);
}
// release-notes.md is deliberately included: the runbook requires the notes
// both as the release body and as a downloadable asset.
const assets = readdirSync(output).map((name) => resolve(output, name));
const notes = resolve(output, "release-notes.md");

// Preflight: never publish stale or unverified assets.
const treeStatus = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (treeStatus.status !== 0) throw new Error("Could not check the git working tree (git status --porcelain failed).");
if (treeStatus.stdout.trim()) {
  throw new Error(`Refusing to publish from a dirty working tree:\n${treeStatus.stdout.trimEnd()}\nCommit or stash these changes so the release tag matches what was built.`);
}
if (manifest.version !== packageVersion) {
  throw new Error(`Staged release-assets/latest/latest.json is version ${manifest.version} but package.json is ${packageVersion}.\nThe staged assets are stale. Run npm run release:build to restage before publishing.`);
}

// Tag the exact commit being released, not whatever the remote default branch
// head happens to be at publish time.
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status !== 0 || !head.stdout.trim()) throw new Error("Could not resolve the release commit for tagging.");
const target = head.stdout.trim();
const buildInfo = readFileSync(buildInfoPath, "utf8");
const builtCommit = buildInfo.match(/^commit: ([0-9a-f]{40})$/m)?.[1];
if (builtCommit !== target) {
  throw new Error(`The staged assets were built from ${builtCommit ?? "an unknown or dirty commit"}, but HEAD is ${target}.\nRun npm run release:build again so the published binaries match the release commit.`);
}

// The commit being released must have a green Verify run before it ships.
if (process.argv.includes("--skip-ci-check")) {
  console.warn(`WARNING: skipping the CI check. Publishing ${tag} without verified CI for ${target}.`);
} else {
  const ci = spawnSync("gh", ["run", "list", "--repo", "m17h/OpenKiwi", "--commit", target, "--workflow", "Verify", "--json", "status,conclusion"], { cwd: root, encoding: "utf8" });
  if (ci.status !== 0) {
    throw new Error(`Could not query the Verify workflow for ${target}.\n${(ci.stderr || "").trim()}\nFix gh access, or rerun with --skip-ci-check to override.`);
  }
  const runs = JSON.parse(ci.stdout || "[]");
  if (runs.length === 0) {
    throw new Error(`No Verify workflow run exists for ${target}. Push the commit and wait for CI to pass, or rerun with --skip-ci-check to override.`);
  }
  const latestRun = runs[0];
  if (latestRun.status !== "completed") {
    throw new Error(`The Verify workflow for ${target} is still ${latestRun.status}. Wait for it to finish, or rerun with --skip-ci-check to override.`);
  }
  if (latestRun.conclusion !== "success") {
    throw new Error(`The Verify workflow for ${target} finished with conclusion "${latestRun.conclusion}". Fix CI before publishing, or rerun with --skip-ci-check to override.`);
  }
}

uploadPlatformDraft({
  root,
  repository: "m17h/OpenKiwi",
  tag,
  target,
  manifest,
  assetPaths: assets,
  notesFile: notes,
});
