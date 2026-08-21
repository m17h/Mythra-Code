import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(root, command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

export function uploadPlatformDraft({
  root,
  repository,
  tag,
  target,
  manifest,
  assetPaths,
  notesFile,
}) {
  const title = `OpenKiwi ${manifest.version}`;
  const view = run(root, "gh", ["release", "view", tag, "--repo", repository, "--json", "isDraft,targetCommitish"]);
  let exists = false;
  if (view.status === 0) {
    exists = true;
    const release = JSON.parse(view.stdout || "{}");
    if (!release.isDraft) {
      throw new Error(`${tag} is already published. Bump the version instead of replacing released assets.`);
    }
    if (release.targetCommitish !== target) {
      throw new Error(`Draft ${tag} targets ${release.targetCommitish || "an unknown commit"}, not ${target}.`);
    }
  }

  const temporary = mkdtempSync(join(tmpdir(), "openkiwi-release-"));
  try {
    let combined = manifest;
    if (exists) {
      const download = run(root, "gh", [
        "release", "download", tag,
        "--repo", repository,
        "--pattern", "latest.json",
        "--dir", temporary,
        "--clobber",
      ]);
      if (download.status !== 0) {
        throw new Error(`Could not download the draft's combined updater manifest.\n${download.stderr || download.stdout || ""}`);
      }
      const previous = JSON.parse(readFileSync(resolve(temporary, "latest.json"), "utf8"));
      if (previous.version !== manifest.version) {
        throw new Error(`Draft manifest version ${previous.version} does not match local version ${manifest.version}.`);
      }
      combined = {
        ...previous,
        ...manifest,
        notes: manifest.notes || previous.notes,
        pub_date: manifest.pub_date || previous.pub_date,
        platforms: { ...(previous.platforms || {}), ...(manifest.platforms || {}) },
      };
    }

    const combinedManifest = resolve(temporary, "latest.json");
    writeFileSync(combinedManifest, `${JSON.stringify(combined, null, 2)}\n`);
    const uploads = [
      ...assetPaths.filter((path) => basename(path).toLowerCase() !== "latest.json"),
      combinedManifest,
    ];

    if (exists) {
      const upload = run(root, "gh", ["release", "upload", tag, ...uploads, "--clobber", "--repo", repository], { stdio: "inherit" });
      if (upload.status !== 0) throw new Error(`Could not upload assets to draft ${tag}.`);
    } else {
      const args = ["release", "create", tag, ...uploads, "--repo", repository, "--title", title, "--draft", "--target", target];
      if (notesFile) args.push("--notes-file", notesFile);
      else args.push("--notes", manifest.notes || title);
      const create = run(root, "gh", args, { stdio: "inherit" });
      if (create.status !== 0) throw new Error(`Could not create draft ${tag}.`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  console.log(`Attached this platform to draft ${tag}. Run npm run release:finalize only after both platform manifests and assets are present.`);
}
