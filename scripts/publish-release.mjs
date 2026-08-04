import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "release-assets/latest");
const manifestPath = resolve(output, "latest.json");
const buildInfoPath = resolve(output, "build-info.txt");
if (!existsSync(manifestPath)) throw new Error("No prepared release found. Run npm run release:build first.");
if (!existsSync(buildInfoPath)) throw new Error("The staged release has no build-info.txt provenance record. Run npm run release:build again before publishing.");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tag = `v${manifest.version}`;
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

const view = spawnSync("gh", ["release", "view", tag, "--repo", "m17h/OpenKiwi", "--json", "targetCommitish"], { encoding: "utf8" });
if (view.status === 0) {
  const existingTarget = JSON.parse(view.stdout || "{}").targetCommitish;
  if (existingTarget !== target) {
    throw new Error(`The existing ${tag} release points to ${existingTarget || "an unknown target"}, not the current commit ${target}.\nBump the app version and build a new release instead of replacing another commit's published assets.`);
  }
}
if (view.status !== 0) {
  // Create as a draft so updater clients can never observe a half-uploaded
  // release; it is flipped to published+latest only after every upload lands.
  const create = spawnSync("gh", ["release", "create", tag, ...assets, "--repo", "m17h/OpenKiwi", "--title", `OpenKiwi ${manifest.version}`, "--notes-file", notes, "--draft", "--target", target], { cwd: root, stdio: "inherit" });
  if (create.status !== 0) process.exit(create.status ?? 1);
} else {
  const upload = spawnSync("gh", ["release", "upload", tag, ...assets, "--clobber", "--repo", "m17h/OpenKiwi"], { cwd: root, stdio: "inherit" });
  if (upload.status !== 0) process.exit(upload.status ?? 1);
}

const edit = spawnSync("gh", ["release", "edit", tag, "--repo", "m17h/OpenKiwi", "--title", `OpenKiwi ${manifest.version}`, "--notes-file", notes, "--draft=false", "--latest"], { cwd: root, stdio: "inherit" });
if (edit.status !== 0) process.exit(edit.status ?? 1);

// Keep local tags in sync with the tag GitHub just created for the release.
const fetchTags = spawnSync("git", ["fetch", "--tags"], { cwd: root, stdio: "inherit" });
if (fetchTags.status !== 0) console.warn("Warning: git fetch --tags failed; local tags may lag behind the published release.");

console.log(`Published ${tag} to https://github.com/m17h/OpenKiwi/releases/tag/${tag}`);
