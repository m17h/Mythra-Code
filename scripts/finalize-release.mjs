import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPOSITORY = "m17h/OpenKiwi";
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

checked("gh", ["auth", "status"], "GitHub authentication check");
const release = JSON.parse(checked("gh", [
  "release", "view", tag,
  "--repo", REPOSITORY,
  "--json", "isDraft,targetCommitish,assets",
], "Draft release check"));
if (!release.isDraft) throw new Error(`${tag} is not a draft release.`);
if (release.targetCommitish !== head) {
  throw new Error(`Draft ${tag} targets ${release.targetCommitish || "an unknown commit"}, not current HEAD ${head}.`);
}

const runs = JSON.parse(checked("gh", [
  "run", "list",
  "--repo", REPOSITORY,
  "--commit", head,
  "--workflow", "Verify",
  "--limit", "10",
  "--json", "status,conclusion,headSha",
], "CI check") || "[]");
if (!runs.some((run) => run.headSha === head && run.status === "completed" && run.conclusion === "success")) {
  throw new Error(`No successful Verify workflow exists for ${head}.`);
}

const temporary = mkdtempSync(join(tmpdir(), "openkiwi-finalize-"));
try {
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
    "OpenKiwi-icon.png",
    `OpenKiwi_${version}_aarch64.app.tar.gz`,
    `OpenKiwi_${version}_aarch64.dmg`,
    `OpenKiwi_${version}_x64-setup.exe`,
    `OpenKiwi_${version}_x64-setup.exe.sig`,
    "build-info.txt",
    "build-info.json",
  ]) {
    if (!assetNames.has(required)) throw new Error(`Draft ${tag} is missing required cross-platform asset ${required}.`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const publish = spawnSync("gh", [
  "release", "edit", tag,
  "--repo", REPOSITORY,
  "--title", `OpenKiwi ${version}`,
  "--draft=false",
  "--latest",
], { cwd: root, stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

const fetchTags = spawnSync("git", ["fetch", "origin", "--tags"], { cwd: root, stdio: "inherit" });
if (fetchTags.status !== 0) console.warn("Warning: published successfully, but local tags could not be refreshed.");
console.log(`Published the combined macOS and Windows release: https://github.com/${REPOSITORY}/releases/tag/${tag}`);
