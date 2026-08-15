import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPOSITORY = "m17h/OpenKiwi-Windows";
const PLATFORM = "windows-x86_64";
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "RELEASE ASSETS");

if (process.platform !== "win32") {
  throw new Error("Windows releases must be published from the Windows build machine.");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function checked(command, args, label) {
  const result = run(command, args);
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${label} failed.${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const installerName = `OpenKiwi_${packageVersion}_x64-setup.exe`;
const signatureName = `${installerName}.sig`;
const expectedFiles = [installerName, signatureName, "build-info.json", "latest.json"];
for (const name of expectedFiles) {
  if (!existsSync(resolve(output, name))) {
    throw new Error(`Missing Windows release asset: ${resolve(output, name)}\nRun npm run release:build first.`);
  }
}

const status = checked("git", ["status", "--porcelain"], "Working-tree check");
if (status) {
  throw new Error(`Refusing to publish from a dirty working tree:\n${status}\nCommit the release source before building and publishing.`);
}

const head = checked("git", ["rev-parse", "HEAD"], "Release commit check");
const buildInfo = JSON.parse(readFileSync(resolve(output, "build-info.json"), "utf8").replace(/^\uFEFF/, ""));
const manifest = JSON.parse(readFileSync(resolve(output, "latest.json"), "utf8").replace(/^\uFEFF/, ""));
const updaterSignature = readFileSync(resolve(output, signatureName), "utf8").trim();
const installerDigest = createHash("sha256").update(readFileSync(resolve(output, installerName))).digest("hex");
const platformEntry = manifest.platforms?.[PLATFORM];
const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/v${packageVersion}/${installerName}`;

if (buildInfo.version !== packageVersion || manifest.version !== packageVersion) {
  throw new Error(`Release version mismatch. package=${packageVersion}, build=${buildInfo.version}, manifest=${manifest.version}`);
}
if (buildInfo.commit !== head || buildInfo.dirty) {
  throw new Error(`Release assets were not built from clean HEAD ${head}. Rebuild after committing the release source.`);
}
if (buildInfo.platform !== PLATFORM || buildInfo.architecture !== "x64" || buildInfo.peSubsystem !== "WindowsGui") {
  throw new Error("Windows release provenance is invalid or incomplete.");
}
if (buildInfo.installer !== installerName || buildInfo.signature !== signatureName) {
  throw new Error("Windows release provenance names do not match the expected assets.");
}
if (!updaterSignature || platformEntry?.signature !== updaterSignature || platformEntry?.url !== expectedUrl) {
  throw new Error("latest.json does not contain the expected OpenKiwi-Windows updater signature and URL.");
}
if (buildInfo.sha256 !== installerDigest) {
  throw new Error(`Installer SHA-256 mismatch: build-info=${buildInfo.sha256}, actual=${installerDigest}`);
}
if (buildInfo.authenticodeStatus !== "Valid" && process.env.OPENKIWI_ALLOW_UNSIGNED_WINDOWS !== "1") {
  throw new Error(`Installer Authenticode status is ${buildInfo.authenticodeStatus}. Set OPENKIWI_ALLOW_UNSIGNED_WINDOWS=1 only for an explicitly approved unsigned release.`);
}

checked("gh", ["auth", "status"], "GitHub authentication check");
const ciJson = checked("gh", [
  "run", "list",
  "--repo", REPOSITORY,
  "--commit", head,
  "--workflow", "Verify",
  "--limit", "10",
  "--json", "status,conclusion,headSha",
], "Windows CI check");
const runs = JSON.parse(ciJson || "[]");
const successfulRun = runs.find((run) => run.headSha === head && run.status === "completed" && run.conclusion === "success");
if (!successfulRun) {
  throw new Error(`No successful Windows Verify workflow exists for ${head}. Push the commit and wait for CI before publishing.`);
}

const tag = `v${packageVersion}`;
const title = `OpenKiwi for Windows ${packageVersion}`;
const assetPaths = expectedFiles.map((name) => resolve(output, name));
const existing = run("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,targetCommitish"]);

if (existing.status === 0) {
  const release = JSON.parse(existing.stdout || "{}");
  if (!release.isDraft) {
    throw new Error(`${tag} is already published. Bump the version instead of replacing a released build.`);
  }
  if (release.targetCommitish !== head) {
    throw new Error(`Draft ${tag} targets ${release.targetCommitish}, not the current release commit ${head}.`);
  }
  const upload = run("gh", ["release", "upload", tag, ...assetPaths, "--clobber", "--repo", REPOSITORY], { stdio: "inherit" });
  if (upload.status !== 0) process.exit(upload.status ?? 1);
} else {
  const create = run("gh", [
    "release", "create", tag, ...assetPaths,
    "--repo", REPOSITORY,
    "--title", title,
    "--notes", manifest.notes || title,
    "--draft",
    "--target", head,
  ], { stdio: "inherit" });
  if (create.status !== 0) process.exit(create.status ?? 1);
}

const publish = run("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--title", title, "--notes", manifest.notes || title, "--draft=false", "--latest"], { stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

const fetchTags = run("git", ["fetch", "origin", "--tags"], { stdio: "inherit" });
if (fetchTags.status !== 0) console.warn("Warning: published successfully, but local tags could not be refreshed.");

console.log(`Published ${tag} to https://github.com/${REPOSITORY}/releases/tag/${tag}`);
