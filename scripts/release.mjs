// One-command Mythra Code release, run on the Mac.
//
//   node scripts/release.mjs prepare <version> [--merge]
//   node scripts/release.mjs publish <version> [--commit <sha>] [--notes <file>] [--no-publish] [--rebuild]
//
// `prepare` opens (and optionally merges) the version-bump PR. `publish` builds
// macOS locally and Windows over SSH in parallel from the same commit, then
// uploads both platforms to one draft with a combined latest.json and publishes
// it. Re-running `publish` reuses any platform already built for that commit,
// so a failure costs only the failed step. Machine-specific settings live in
// the private ~/.mythra-release/release.config.json, never in this repository.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY = "m17h/Mythra-Code";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`;
const MAC_PLATFORM = "darwin-aarch64";
const WINDOWS_PLATFORM = "windows-x86_64";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"];
const root = resolve(import.meta.dirname, "..");
const privateRoot = process.env.MYTHRA_RELEASE_HOME || resolve(homedir(), ".mythra-release");

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  return result;
}

function checked(command, args, label, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${label} failed (exit ${result.status}).${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compareVersions(a, b) {
  const parse = (v) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

function elapsed(since, until = Date.now()) {
  const seconds = Math.round((until - since) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function loadConfig() {
  const path = resolve(privateRoot, "release.config.json");
  if (!existsSync(path)) fail(`Missing private release config at ${path}. See docs/operations/releasing.md.`);
  const config = readJson(path);
  for (const key of ["mac.buildDir", "mac.notaryKeychainProfile", "windows.sshHost", "windows.buildDir", "windows.runnerPath"]) {
    const value = key.split(".").reduce((node, part) => node?.[part], config);
    if (!value) fail(`${path} is missing ${key}.`);
  }
  return config;
}

function parseArguments(argv) {
  const [command, version, ...rest] = argv;
  const flags = { commit: "", notes: "", publish: true, rebuild: false, merge: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--commit") flags.commit = rest[++i] || "";
    else if (flag === "--notes") flags.notes = rest[++i] || "";
    else if (flag === "--no-publish") flags.publish = false;
    else if (flag === "--rebuild") flags.rebuild = true;
    else if (flag === "--merge") flags.merge = true;
    else fail(`Unknown option ${flag}`);
  }
  if (!["prepare", "publish"].includes(command) || !/^\d+\.\d+\.\d+$/.test(version || "")) {
    fail("Usage:\n  node scripts/release.mjs prepare <x.y.z> [--merge]\n  node scripts/release.mjs publish <x.y.z> [--commit <sha>] [--notes <file>] [--no-publish] [--rebuild]");
  }
  return { command, version, flags };
}

// Runs a command asynchronously, appending all output to a log file and keeping
// the most recent non-empty line for progress messages.
function runLogged(task, command, args, options = {}) {
  return new Promise((resolvePromise) => {
    task.log.write(`\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    task.child = child;
    const onData = (chunk) => {
      task.log.write(chunk);
      const lines = stripAnsi(chunk.toString()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) task.lastLine = lines.at(-1);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      task.log.write(`\n${command} could not start: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on("close", (code) => {
      task.child = null;
      resolvePromise(code ?? 1);
    });
  });
}

async function step(task, label, command, args, options) {
  task.stage = label;
  const code = await runLogged(task, command, args, options);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}). See ${task.logPath}`);
}

function tailOf(path, lines = 40) {
  try {
    return stripAnsi(readFileSync(path, "utf8")).split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function macBuildMatches(dir, version, commit) {
  const infoPath = resolve(dir, "build-info.txt");
  const manifestPath = resolve(dir, "latest.json");
  if (!existsSync(infoPath) || !existsSync(manifestPath)) return false;
  const info = readFileSync(infoPath, "utf8");
  return info.includes(`version: ${version}\n`) && info.includes(`commit: ${commit}\n`) && readJson(manifestPath).version === version;
}

function windowsBuildMatches(dir, version, commit) {
  const infoPath = resolve(dir, "build-info.json");
  if (!existsSync(infoPath)) return false;
  const info = readJson(infoPath);
  const installer = resolve(dir, `MythraCode_${version}_x64-setup.exe`);
  return info.version === version && info.commit === commit && !info.dirty && existsSync(installer) && info.sha256 === sha256(installer);
}

async function buildMac(task, { config, version, commit, notesPath, outDir, rebuild }) {
  if (!rebuild && macBuildMatches(outDir, version, commit)) {
    task.reused = true;
    return;
  }
  const buildDir = config.mac.buildDir;
  task.stage = "preparing checkout";
  if (!existsSync(resolve(buildDir, ".git"))) {
    mkdirSync(resolve(buildDir, ".."), { recursive: true });
    checked("git", ["worktree", "add", "--detach", buildDir, commit], "Creating the Mac release worktree");
  } else {
    checked("git", ["-C", buildDir, "checkout", "--quiet", "--force", "--detach", commit], "Checking out the release commit");
    // Keep ignored node_modules/ and src-tauri/target/ so rebuilds stay warm.
    checked("git", ["-C", buildDir, "clean", "-fdq"], "Cleaning the Mac release worktree");
  }
  mkdirSync(resolve(buildDir, "release-assets"), { recursive: true });
  copyFileSync(notesPath, resolve(buildDir, "release-assets/release-notes.md"));

  const env = {
    ...process.env,
    PATH: ["/opt/homebrew/bin", resolve(homedir(), ".cargo/bin"), process.env.PATH].join(":"),
    APPLE_NOTARY_KEYCHAIN_PROFILE: config.mac.notaryKeychainProfile,
  };
  await step(task, "npm ci", "npm", ["ci", "--no-audit", "--no-fund"], { cwd: buildDir, env });
  await step(task, "build, sign and notarize", process.execPath, ["scripts/build-release.mjs"], { cwd: buildDir, env });

  task.stage = "collecting assets";
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const staged = resolve(buildDir, "release-assets/latest");
  for (const name of readdirSync(staged)) copyFileSync(resolve(staged, name), resolve(outDir, name));
  if (!macBuildMatches(outDir, version, commit)) throw new Error(`Mac assets in ${outDir} do not match ${version} at ${commit}.`);
}

async function buildWindows(task, { config, version, commit, outDir, rebuild }) {
  if (!rebuild && windowsBuildMatches(outDir, version, commit)) {
    task.reused = true;
    return;
  }
  const { sshHost, buildDir, runnerPath } = config.windows;
  const remote = (path) => `${sshHost}:/${path.replaceAll("\\", "/")}`;
  await step(task, "sending build runner", "scp", ["-q", ...SSH_OPTIONS, resolve(root, "scripts/release-windows.ps1"), remote(runnerPath)]);
  const runnerArguments = [
    "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", runnerPath.replaceAll("/", "\\"),
    "-BuildDir", buildDir.replaceAll("/", "\\"),
    "-Commit", commit,
    "-Version", version,
    "-Repository", REPOSITORY_URL,
  ];
  await step(task, "build and sign on Windows", "ssh", [...SSH_OPTIONS, sshHost, runnerArguments.join(" ")]);

  task.stage = "downloading assets";
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const assetDir = `${buildDir.replaceAll("\\", "/")}/RELEASE ASSETS`;
  for (const name of [`MythraCode_${version}_x64-setup.exe`, `MythraCode_${version}_x64-setup.exe.sig`, "build-info.json", "latest.json"]) {
    await step(task, `downloading ${name}`, "scp", ["-q", ...SSH_OPTIONS, remote(`${assetDir}/${name}`), resolve(outDir, name)]);
  }
  if (!windowsBuildMatches(outDir, version, commit)) throw new Error(`Windows assets in ${outDir} do not match ${version} at ${commit} (or the installer hash changed in transfer).`);
}

function combinedManifest({ version, notes, macDir, windowsDir }) {
  const mac = readJson(resolve(macDir, "latest.json"));
  const windows = readJson(resolve(windowsDir, "latest.json"));
  const platforms = { [MAC_PLATFORM]: mac.platforms?.[MAC_PLATFORM], [WINDOWS_PLATFORM]: windows.platforms?.[WINDOWS_PLATFORM] };
  for (const [platform, entry] of Object.entries(platforms)) {
    if (!entry?.signature || !entry?.url?.includes(`/download/v${version}/`)) throw new Error(`The ${platform} updater entry is missing its signature or URL.`);
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}

function releaseState(tag) {
  const view = run("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,targetCommitish,assets,url"]);
  return view.status === 0 ? JSON.parse(view.stdout) : null;
}

function uploadWithRetry(tag, files) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const upload = run("gh", ["release", "upload", tag, ...files, "--clobber", "--repo", REPOSITORY], { stdio: "inherit" });
    if (upload.status === 0) return;
    console.warn(`Upload attempt ${attempt} failed${attempt < 3 ? "; retrying" : ""}.`);
  }
  throw new Error(`Uploading assets to draft ${tag} failed three times. Re-run the same command to retry; built assets are reused.`);
}

async function publish({ version, flags }) {
  if (process.platform !== "darwin") fail("Run releases from the Mac; it builds Windows over SSH.");
  const config = loadConfig();
  const tag = `v${version}`;
  const startedAt = Date.now();

  // Preflight: seconds, not minutes. Everything here is a precondition for a
  // correct release, not a test suite.
  checked("gh", ["auth", "status"], "GitHub CLI authentication");
  checked("git", ["fetch", "--quiet", "origin"], "Fetching origin");
  const commit = checked("git", ["rev-parse", "--verify", `${flags.commit || "origin/main"}^{commit}`], "Resolving the release commit");
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const found = JSON.parse(checked("git", ["show", `${commit}:${file}`], `Reading ${file}`)).version;
    if (found !== version) fail(`${file} at ${commit.slice(0, 10)} is version ${found}, not ${version}. Merge the version PR first:\n  node scripts/release.mjs prepare ${version} --merge`);
  }
  const existing = releaseState(tag);
  if (existing && !existing.isDraft) fail(`${tag} is already published: ${existing.url}`);
  if (existing && existing.targetCommitish !== commit) fail(`A stale draft ${tag} targets ${existing.targetCommitish}. Delete it first: gh release delete ${tag} --repo ${REPOSITORY}`);
  const latest = run("gh", ["api", `repos/${REPOSITORY}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.status === 0 && latest.stdout.trim() && compareVersions(version, latest.stdout.trim()) <= 0) {
    fail(`${version} is not newer than the published ${latest.stdout.trim()}.`);
  }
  const notesPath = resolve(flags.notes || resolve(privateRoot, "notes", `${version}.md`));
  if (!existsSync(notesPath)) fail(`Release notes not found at ${notesPath}. Write them (prepare creates a draft) or pass --notes <file>.`);
  const notes = readFileSync(notesPath, "utf8").trim();
  if (!notes.includes(version)) fail(`${notesPath} never mentions ${version}; it looks like stale notes.`);
  const hostname = run("ssh", [...SSH_OPTIONS, config.windows.sshHost, "hostname"]);
  if (hostname.status !== 0) fail(`Cannot reach the Windows PC over SSH (${config.windows.sshHost}). Is it awake and on the LAN?\n${hostname.stderr.trim()}`);

  const outRoot = resolve(privateRoot, "out", version);
  mkdirSync(outRoot, { recursive: true });
  const macDir = resolve(outRoot, "mac");
  const windowsDir = resolve(outRoot, "windows");
  console.log(`Mythra Code ${version}\n  commit   ${commit}\n  notes    ${notesPath}\n  windows  ${hostname.stdout.trim()} via ${config.windows.sshHost}\n  output   ${outRoot}\n`);

  // Both native builds run at once. A failure on one side does not stop the
  // other, so its finished assets are reused on the next run.
  const makeTask = (name) => {
    const logPath = resolve(outRoot, `${name}.log`);
    return { name, logPath, log: createWriteStream(logPath, { flags: "a" }), stage: "starting", lastLine: "", child: null, reused: false, startedAt: Date.now() };
  };
  const tasks = [makeTask("mac"), makeTask("windows")];
  const stopChildren = () => {
    for (const task of tasks) task.child?.kill("SIGTERM");
  };
  process.once("SIGINT", () => {
    stopChildren();
    fail("Interrupted. Closing the SSH session stops the Windows build; re-run the same command to continue.");
  });
  const heartbeat = setInterval(() => {
    for (const task of tasks) {
      if (task.done) continue;
      console.log(`  [${task.name}] ${elapsed(task.startedAt)} ${task.stage}${task.lastLine ? ` | ${task.lastLine.slice(0, 110)}` : ""}`);
    }
  }, 60_000);
  const builders = { mac: buildMac, windows: buildWindows };
  const results = await Promise.allSettled(tasks.map(async (task) => {
    try {
      await builders[task.name](task, { config, version, commit, notesPath, outDir: task.name === "mac" ? macDir : windowsDir, rebuild: flags.rebuild });
    } finally {
      task.done = true;
      task.finishedAt = Date.now();
      task.log.end();
    }
  }));
  clearInterval(heartbeat);

  let failed = false;
  results.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === "fulfilled") {
      console.log(`✔ ${task.name}: ${task.reused ? "reused existing build for this commit" : `built in ${elapsed(task.startedAt, task.finishedAt)}`}`);
    } else {
      failed = true;
      console.error(`✖ ${task.name}: ${result.reason?.message || result.reason}\n--- last lines of ${task.logPath} ---\n${tailOf(task.logPath)}\n---`);
    }
  });
  if (failed) fail("Fix the failure above and re-run the same command. Completed platform builds are reused.");

  const manifest = combinedManifest({ version, notes, macDir, windowsDir });
  const manifestPath = resolve(outRoot, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const assets = [
    ...readdirSync(macDir).filter((name) => name !== "latest.json").map((name) => resolve(macDir, name)),
    ...readdirSync(windowsDir).filter((name) => name !== "latest.json").map((name) => resolve(windowsDir, name)),
    manifestPath,
  ];
  if (!flags.publish) {
    console.log(`\nBuilt both platforms; not publishing (--no-publish). Assets:\n${assets.map((path) => `  ${path}`).join("\n")}`);
    return;
  }

  console.log(`\nUploading ${assets.length} assets to draft ${tag}…`);
  if (!existing) {
    checked("gh", ["release", "create", tag, "--repo", REPOSITORY, "--draft", "--target", commit, "--title", `Mythra Code ${version}`, "--notes-file", notesPath], "Creating the draft release");
  }
  uploadWithRetry(tag, assets);
  const draft = releaseState(tag);
  const uploaded = new Map((draft?.assets || []).map((asset) => [asset.name, asset]));
  const missing = assets.filter((path) => {
    const name = path.split("/").at(-1);
    return uploaded.get(name)?.size !== statSync(path).size;
  });
  if (missing.length) fail(`Draft ${tag} is missing or has incomplete assets: ${missing.map((path) => path.split("/").at(-1)).join(", ")}. Re-run to retry the upload.`);

  checked("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest"], "Publishing the release");
  const published = releaseState(tag);
  if (!published || published.isDraft) fail(`GitHub still reports ${tag} as a draft.`);
  console.log(`\n✔ Published Mythra Code ${version} for macOS and Windows in ${elapsed(startedAt)}\n  ${published.url}`);
}

function prepare({ version, flags }) {
  checked("gh", ["auth", "status"], "GitHub CLI authentication");
  checked("git", ["fetch", "--quiet", "origin", "--tags"], "Fetching origin");
  const current = JSON.parse(checked("git", ["show", "origin/main:package.json"], "Reading package.json")).version;
  const branch = `release/v${version}`;

  // Bump in a throwaway worktree so the developer checkout is never touched.
  let url = "";
  if (current === version) {
    console.log(`origin/main is already version ${version}; no version PR needed.`);
  } else {
    const worktree = mkdtempSync(join(tmpdir(), "mythra-release-prepare-"));
    rmSync(worktree, { recursive: true, force: true });
    try {
      checked("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], "Creating the version worktree");
      checked(process.execPath, ["scripts/bump-version.mjs", version], "Bumping the version", { cwd: worktree });
      checked("git", ["commit", "-qam", `Release ${version}`], "Committing the version bump", { cwd: worktree });
      checked("git", ["push", "-q", "-u", "origin", branch], "Pushing the version branch", { cwd: worktree });
      url = checked("gh", ["pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", branch, "--title", `Release ${version}`,
        "--body", `Bumps Mythra Code from ${current} to ${version} for release.`], "Opening the version PR", { cwd: worktree });
      console.log(`Opened ${url}`);
    } finally {
      if (existsSync(worktree)) run("git", ["worktree", "remove", "--force", worktree]);
    }
  }
  if (url && flags.merge) {
    checked("gh", ["pr", "merge", url, "--squash"], "Merging the version PR");
    run("git", ["push", "-q", "origin", "--delete", branch]);
    run("git", ["branch", "-D", branch]);
    checked("git", ["fetch", "--quiet", "origin"], "Fetching origin");
    console.log(`Merged ${url}`);
  }

  // Draft notes from commit subjects since the last release; edit them into
  // user-facing bullets before publishing.
  const notesPath = resolve(privateRoot, "notes", `${version}.md`);
  if (!existsSync(notesPath)) {
    const previous = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", "origin/main"]).stdout.trim();
    const log = previous ? run("git", ["log", "--no-merges", "--format=- %s", `${previous}..origin/main`]).stdout.trim() : "";
    mkdirSync(resolve(privateRoot, "notes"), { recursive: true });
    writeFileSync(notesPath, `# Mythra Code ${version}\n\n${log || "- "}\n`);
    console.log(`Drafted release notes at ${notesPath} (edit before publishing).`);
  } else {
    console.log(`Release notes already exist at ${notesPath}.`);
  }
}

const parsed = parseArguments(process.argv.slice(2));
try {
  if (parsed.command === "prepare") prepare(parsed);
  else await publish(parsed);
} catch (error) {
  fail(error.message);
}
