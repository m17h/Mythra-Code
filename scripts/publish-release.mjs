import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "release-assets/latest");
const manifestPath = resolve(output, "latest.json");
if (!existsSync(manifestPath)) throw new Error("No prepared release found. Run npm run release:build first.");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tag = `v${manifest.version}`;
// release-notes.md is deliberately included: the runbook requires the notes
// both as the release body and as a downloadable asset.
const assets = readdirSync(output).map((name) => resolve(output, name));
const notes = resolve(output, "release-notes.md");

// Tag the exact commit being released, not whatever the remote default branch
// head happens to be at publish time.
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status !== 0 || !head.stdout.trim()) throw new Error("Could not resolve the release commit for tagging.");
const target = head.stdout.trim();

const view = spawnSync("gh", ["release", "view", tag, "--repo", "m17h/OpenKiwi"], { stdio: "ignore" });
const args = view.status === 0
  ? ["release", "upload", tag, ...assets, "--clobber", "--repo", "m17h/OpenKiwi"]
  : ["release", "create", tag, ...assets, "--repo", "m17h/OpenKiwi", "--title", `OpenKiwi ${manifest.version}`, "--notes-file", notes, "--latest", "--target", target];
const publish = spawnSync("gh", args, { cwd: root, stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

if (view.status === 0) {
  const edit = spawnSync("gh", ["release", "edit", tag, "--repo", "m17h/OpenKiwi", "--title", `OpenKiwi ${manifest.version}`, "--notes-file", notes, "--latest"], { cwd: root, stdio: "inherit" });
  if (edit.status !== 0) process.exit(edit.status ?? 1);
}

console.log(`Published ${tag} to https://github.com/m17h/OpenKiwi/releases/tag/${tag}`);
