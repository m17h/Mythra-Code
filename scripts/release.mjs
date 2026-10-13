// One-command Mythra Code release, run on the Mac.
//
//   node scripts/release.mjs prepare <version> [--merge]
//   node scripts/release.mjs publish <version> [--background] [--commit <sha>] [--notes <file>] [--no-publish] [--rebuild]
//   node scripts/release.mjs status [<version>]
//   node scripts/release.mjs stop
//
// `prepare` opens (and optionally merges) the version-bump PR and drafts notes.
// `publish` builds macOS locally and Windows over SSH in parallel from the same
// commit, then uploads both platforms to one draft with a combined latest.json
// and publishes it. Re-running `publish` reuses any platform already built for
// that commit, so a failure costs only the failed step. `status` and `stop`
// report on or cancel the current run. Machine-specific settings live in the
// private ~/.mythra-release/release.config.json, never in this repository.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY = "m17h/Mythra-Code";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`;
const MAC_PLATFORM = "darwin-aarch64";
const WINDOWS_PLATFORM = "windows-x86_64";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"];
const NOTES_DRAFT_MARKER = "<!-- DRAFT: rewrite these commit subjects as user-facing bullets, then delete this line. -->";
const root = resolve(import.meta.dirname, "..");
const privateRoot = process.env.MYTHRA_RELEASE_HOME || resolve(homedir(), ".mythra-release");
const runStatePath = resolve(privateRoot, "run.json");

// The run in progress, if this process owns one; failures are recorded on it.
let activeRun = null;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

function readRunState() {
  try {
    return readJson(runStatePath);
  } catch {
    return null;
  }
}

function updateRunState(patch) {
  if (!activeRun) return;
  Object.assign(activeRun, patch, { updatedAt: new Date().toISOString() });
  writeFileSync(runStatePath, `${JSON.stringify(activeRun, null, 2)}\n`);
}

function fail(message) {
  updateRunState({ state: "failed", message });
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

// Synchronous commands get a generous deadline so a hung network call fails
// with a clear message instead of stalling the release.
function run(command, args, options = {}) {
  const timeout = options.timeout ?? 10 * 60_000;
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options, timeout });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} ${args[0] || ""} did not finish within ${Math.round(timeout / 60_000)} minutes.`);
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compareVersions(a, b) {
  const parse = (v) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// True only while that PID is still a release.mjs process, so a recycled PID
// is never mistaken for (or stopped as) a release run.
function processAlive(pid) {
  if (!pid) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes("release.mjs");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A group counts as running while any member is not a zombie: exited children
// stay zombies until this process reaps them, which it cannot do mid-wait.
function groupAlive(pgid) {
  const ps = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return ps.stdout.split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat && !stat.startsWith("Z");
  });
}

// A recorded process group belongs to a release only while one of its
// processes is still release work; a recycled group id is left alone.
function releaseGroup(pgid, config) {
  const markers = ["build-release.mjs", "release-windows.ps1", "npm ci", config.mac.buildDir, config.windows.sshHost];
  const ps = spawnSync("ps", ["-A", "-o", "pgid=,command="], { encoding: "utf8" });
  return ps.stdout.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && Number(match[1]) === pgid && markers.some((marker) => match[2].includes(marker));
  });
}

// Stops process groups and waits for them to exit. Returns the ones that are
// still running so callers never report an unconfirmed stop as done.
function stopGroups(groups) {
  let remaining = [...new Set(groups)].filter((pgid) => pgid && groupAlive(pgid));
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pgid of remaining) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // Exited meanwhile.
      }
    }
    const deadline = Date.now() + (signal === "SIGTERM" ? 15_000 : 5_000);
    while (remaining.length && Date.now() < deadline) {
      sleepSync(250);
      remaining = remaining.filter(groupAlive);
    }
    if (!remaining.length) break;
  }
  return remaining;
}

// Exclusive claim on the build checkouts and run record: created atomically,
// reclaimed only when its owner is no longer a running release.mjs process.
const lockPath = resolve(privateRoot, "release.lock");
function lockOwner() {
  try {
    return Number(readFileSync(lockPath, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}
function acquireLock() {
  mkdirSync(privateRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      process.on("exit", () => {
        if (lockOwner() === process.pid) rmSync(lockPath, { force: true });
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = lockOwner();
      if (processAlive(owner)) fail(`A release is already running (pid ${owner}). Check: node scripts/release.mjs status`);
      rmSync(lockPath, { force: true });
    }
  }
  fail("Another release run claimed the lock at the same moment. Check: node scripts/release.mjs status");
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

function elapsed(since, until = Date.now()) {
  const seconds = Math.round((until - since) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function tailOf(path, lines = 40) {
  try {
    return stripAnsi(readFileSync(path, "utf8")).split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
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

const USAGE = `Usage:
  node scripts/release.mjs prepare <x.y.z> [--merge]
  node scripts/release.mjs publish <x.y.z> [--background] [--commit <sha>] [--notes <file>] [--no-publish] [--rebuild]
  node scripts/release.mjs status [<x.y.z>]
  node scripts/release.mjs stop`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const version = rest[0] && !rest[0].startsWith("--") ? rest.shift() : "";
  const flags = { commit: "", notes: "", publish: true, rebuild: false, merge: false, background: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--commit") flags.commit = rest[++i] || "";
    else if (flag === "--notes") flags.notes = rest[++i] || "";
    else if (flag === "--no-publish") flags.publish = false;
    else if (flag === "--rebuild") flags.rebuild = true;
    else if (flag === "--merge") flags.merge = true;
    else if (flag === "--background") flags.background = true;
    else fail(`Unknown option ${flag}\n${USAGE}`);
  }
  const needsVersion = command === "prepare" || command === "publish";
  if (!["prepare", "publish", "status", "stop"].includes(command) || (needsVersion && !version) || (version && !/^\d+\.\d+\.\d+$/.test(version))) {
    fail(USAGE);
  }
  return { command, version, flags };
}

// Runs a command asynchronously in its own process group, appending all output
// to a log file and keeping the most recent non-empty line for progress lines.
function runLogged(task, command, args, { timeoutMinutes = 30, ...options } = {}) {
  return new Promise((resolvePromise) => {
    task.log.write(`\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
    const deadline = setTimeout(() => {
      task.timedOut = timeoutMinutes;
      task.log.write(`\nNo result after ${timeoutMinutes} minutes; stopping this step.\n`);
      stopGroups([child.pid]);
    }, timeoutMinutes * 60_000);
    task.child = child;
    if (child.pid) updateRunState({ processGroups: { ...activeRun?.processGroups, [task.name]: child.pid } });
    const onData = (chunk) => {
      task.log.write(chunk);
      const lines = stripAnsi(chunk.toString()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) task.lastLine = lines.at(-1);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(deadline);
      task.log.write(`\n${command} could not start: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      task.child = null;
      resolvePromise(code ?? 1);
    });
  });
}

async function step(task, label, command, args, options) {
  task.stage = label;
  task.timedOut = 0;
  const code = await runLogged(task, command, args, options);
  if (task.timedOut) throw new Error(`${label} did not finish within ${task.timedOut} minutes and was stopped. See ${task.logPath}`);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}). See ${task.logPath}`);
}

function windowsRunnerCommand(config, extra) {
  const { runnerPath, buildDir } = config.windows;
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", runnerPath.replaceAll("/", "\\"), "-BuildDir", buildDir.replaceAll("/", "\\"), ...extra].join(" ");
}

// Windows keeps processes alive after SSH disconnects; the runner's -StopOnly
// mode stops anything still running from the build directory and exits
// non-zero unless they are confirmed gone. Returns "" on success, else why not.
function stopWindowsBuild(config) {
  try {
    const result = run("ssh", [...SSH_OPTIONS, config.windows.sshHost, windowsRunnerCommand(config, ["-StopOnly"])], { timeout: 90_000 });
    if (result.status === 0) return "";
    return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).at(-1) || `exit ${result.status}`;
  } catch (error) {
    return error.message;
  }
}

const nonEmpty = (path) => existsSync(path) && statSync(path).size > 0;
const macArchive = (version) => `MythraCode_${version}_aarch64.app.tar.gz`;
const windowsInstaller = (version) => `MythraCode_${version}_x64-setup.exe`;

// A platform folder is reused only when every file it publishes is present
// and its manifest points at its own signed package; anything partial or
// unreadable is rebuilt instead of failing the same way on every retry.
function macBuildMatches(dir, version, commit) {
  try {
    const files = ["build-info.txt", "latest.json", "release-notes.md", "MythraCode-icon.png", macArchive(version), `MythraCode_${version}_aarch64.dmg`];
    if (!files.every((name) => nonEmpty(resolve(dir, name)))) return false;
    const info = readFileSync(resolve(dir, "build-info.txt"), "utf8");
    const entry = readJson(resolve(dir, "latest.json")).platforms?.[MAC_PLATFORM];
    return info.includes(`version: ${version}\n`) && info.includes(`commit: ${commit}\n`) && Boolean(entry?.signature) && entry.url?.endsWith(`/v${version}/${macArchive(version)}`);
  } catch {
    return false;
  }
}

function windowsBuildMatches(dir, version, commit) {
  try {
    const installer = resolve(dir, windowsInstaller(version));
    const files = ["build-info.json", "latest.json", windowsInstaller(version), `${windowsInstaller(version)}.sig`];
    if (!files.every((name) => nonEmpty(resolve(dir, name)))) return false;
    const info = readJson(resolve(dir, "build-info.json"));
    const entry = readJson(resolve(dir, "latest.json")).platforms?.[WINDOWS_PLATFORM];
    const signature = readFileSync(`${installer}.sig`, "utf8").trim();
    return info.version === version && info.commit === commit && !info.dirty && info.sha256 === sha256(installer)
      && entry?.signature === signature && entry.url?.endsWith(`/v${version}/${windowsInstaller(version)}`);
  } catch {
    return false;
  }
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
    checked("git", ["worktree", "prune"], "Pruning stale worktrees");
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
  await step(task, "npm ci", "npm", ["ci", "--no-audit", "--no-fund"], { cwd: buildDir, env, timeoutMinutes: 20 });
  await step(task, "build, sign and notarize", process.execPath, ["scripts/build-release.mjs"], { cwd: buildDir, env, timeoutMinutes: 120 });

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
  try {
    await step(task, "sending build runner", "scp", ["-q", ...SSH_OPTIONS, resolve(root, "scripts/release-windows.ps1"), remote(runnerPath)], { timeoutMinutes: 3 });
    await step(task, "build and sign on Windows", "ssh", [...SSH_OPTIONS, sshHost,
      windowsRunnerCommand(config, ["-Commit", commit, "-Version", version, "-Repository", REPOSITORY_URL])], { timeoutMinutes: 120 });
  } catch (error) {
    // The Windows build outlives a dropped or timed-out SSH session; stop it now
    // instead of leaving it to consume the PC until the next run.
    const unconfirmed = stopWindowsBuild(config);
    throw new Error(`${error.message}${unconfirmed ? `\nWindows build processes could not be confirmed stopped: ${unconfirmed}` : ""}`);
  }

  task.stage = "downloading assets";
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const assetDir = `${buildDir.replaceAll("\\", "/")}/RELEASE ASSETS`;
  for (const name of [windowsInstaller(version), `${windowsInstaller(version)}.sig`, "build-info.json", "latest.json"]) {
    await step(task, `downloading ${name}`, "scp", ["-q", ...SSH_OPTIONS, remote(`${assetDir}/${name}`), resolve(outDir, name)], { timeoutMinutes: 15 });
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

// Returns null only when GitHub says the release does not exist; any other
// lookup failure throws rather than being mistaken for "no release".
function releaseState(tag) {
  const view = run("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,targetCommitish,assets,url"], { timeout: 2 * 60_000 });
  if (view.status === 0) return JSON.parse(view.stdout);
  if (/release not found/i.test(view.stderr)) return null;
  throw new Error(`Looking up release ${tag} on GitHub failed:\n${view.stderr.trim()}`);
}

// The commit an existing remote tag points to, or "" when there is no tag.
function remoteTagCommit(tag) {
  const lines = checked("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], "Looking up the release tag", { timeout: 2 * 60_000 }).split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith("^{}")) || lines[0] || "";
  return peeled.split(/\s+/)[0] || "";
}

function uploadWithRetry(tag, files) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let upload;
    try {
      upload = run("gh", ["release", "upload", tag, ...files, "--clobber", "--repo", REPOSITORY], { stdio: "inherit", timeout: 30 * 60_000 });
    } catch (error) {
      upload = { status: 1 };
      console.warn(error.message);
    }
    if (upload.status === 0) return;
    console.warn(`Upload attempt ${attempt} failed${attempt < 3 ? "; retrying" : ""}.`);
  }
  throw new Error(`Uploading assets to draft ${tag} failed three times. Re-run the same command to retry; built assets are reused.`);
}

// Starts `publish` detached from this terminal so an agent's command timeout or
// a closed shell cannot kill the release halfway. Waits only for preflight.
async function publishInBackground(version) {
  if (processAlive(lockOwner())) fail(`A release is already running (pid ${lockOwner()}). Check: node scripts/release.mjs status`);
  const outRoot = resolve(privateRoot, "out", version);
  mkdirSync(outRoot, { recursive: true });
  const logPath = resolve(outRoot, "release.log");
  const log = openSync(logPath, "a");
  writeFileSync(log, `\n===== ${new Date().toISOString()} release ${version} =====\n`);
  const args = process.argv.slice(2).filter((arg) => arg !== "--background");
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "release.mjs"), ...args], { cwd: root, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  let exitCode = null;
  child.on("exit", (code) => { exitCode = code ?? 1; });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500));
    if (exitCode !== null) {
      console.log(tailOf(logPath, 30).split(/\n===== /).at(-1));
      process.exit(exitCode);
    }
    const state = readRunState();
    if (state?.pid === child.pid && state.state === "building") {
      child.unref();
      console.log(`Preflight passed. Release ${version} is building in the background (pid ${child.pid}).
  Progress:  node scripts/release.mjs status
  Full log:  ${logPath}
  Cancel:    node scripts/release.mjs stop`);
      process.exit(0);
    }
  }
  child.unref();
  console.log(`Release ${version} started in the background (pid ${child.pid}) but preflight is still running. Check: node scripts/release.mjs status`);
}

async function publish({ version, flags }) {
  if (process.platform !== "darwin") fail("Run releases from the Mac; it builds Windows over SSH.");
  if (flags.background) return publishInBackground(version);
  const config = loadConfig();
  const tag = `v${version}`;
  const startedAt = Date.now();

  // One release run at a time: two runs would share the build checkouts.
  acquireLock();
  const previous = readRunState();
  if (previous && ["preflight", "building", "publishing"].includes(previous.state)) {
    console.log(`The previous ${previous.version} run was interrupted; stopping anything it left running on this Mac.`);
    const leftovers = Object.values(previous.processGroups || {}).filter((pgid) => releaseGroup(pgid, config));
    const stuck = stopGroups(leftovers);
    if (stuck.length) fail(`Processes from the interrupted run are still running (process groups ${stuck.join(", ")}). Stop them, then re-run.`);
  }
  activeRun = { version, pid: process.pid, state: "preflight", startedAt: new Date(startedAt).toISOString(), processGroups: {} };
  updateRunState({});
  const cancel = (signal) => {
    const stuck = stopGroups(tasks.map((task) => task.child?.pid).filter(Boolean));
    const windows = stopWindowsBuild(config);
    const unconfirmed = [stuck.length ? `Mac process groups ${stuck.join(", ")} still running` : "", windows ? `Windows cleanup unconfirmed: ${windows}` : ""].filter(Boolean);
    fail(`Stopped by ${signal}.${unconfirmed.length ? ` ${unconfirmed.join("; ")}. Run node scripts/release.mjs stop again.` : " Builds on both machines are stopped."} Re-run the release to continue; finished builds are reused.`);
  };
  let tasks = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => cancel(signal));

  // Preflight: seconds, not minutes. Each check is a prerequisite that would
  // otherwise fail the build or publish later; none of them is a test.
  checked("gh", ["auth", "status"], "GitHub CLI authentication");
  checked("git", ["fetch", "--quiet", "origin"], "Fetching origin");
  const commit = checked("git", ["rev-parse", "--verify", `${flags.commit || "origin/main"}^{commit}`], "Resolving the release commit");
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const found = JSON.parse(checked("git", ["show", `${commit}:${file}`], `Reading ${file}`)).version;
    if (found !== version) fail(`${file} at ${commit.slice(0, 10)} is version ${found}, not ${version}. Merge the version PR first:\n  node scripts/release.mjs prepare ${version} --merge`);
  }
  let existing = releaseState(tag);
  if (existing && !existing.isDraft) fail(`${tag} is already published: ${existing.url}`);
  if (existing && existing.targetCommitish !== commit) {
    // Drafts are never public; one left by an earlier attempt at another commit is replaced.
    console.log(`Replacing the unpublished ${tag} draft from an earlier attempt (${existing.targetCommitish.slice(0, 10)}).`);
    // Drafts never create their tag (GitHub creates it on publish), so deleting
    // the draft is enough.
    checked("gh", ["release", "delete", tag, "--repo", REPOSITORY, "--yes"], "Deleting the stale draft");
    existing = null;
  }
  // GitHub ignores --target when the tag already exists, so a tag pushed some
  // other way at another commit would label these binaries with the wrong source.
  const tagCommit = remoteTagCommit(tag);
  if (tagCommit && tagCommit !== commit) {
    fail(`Tag ${tag} already exists at ${tagCommit.slice(0, 10)}, not the release commit ${commit.slice(0, 10)}, and no published release uses it. If it is left over from an unpublished attempt, delete it (git push origin :refs/tags/${tag}) and re-run.`);
  }
  const latest = run("gh", ["api", `repos/${REPOSITORY}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.status === 0 && latest.stdout.trim() && compareVersions(version, latest.stdout.trim()) <= 0) {
    fail(`${version} is not newer than the published ${latest.stdout.trim()}.`);
  }
  const notesPath = resolve(flags.notes || resolve(privateRoot, "notes", `${version}.md`));
  if (!existsSync(notesPath)) fail(`Release notes not found at ${notesPath}. Run prepare to draft them, or pass --notes <file>.`);
  const notes = readFileSync(notesPath, "utf8").trim();
  if (notes.includes(NOTES_DRAFT_MARKER)) fail(`${notesPath} is still the drafted commit list. Rewrite it as user-facing bullets and delete the DRAFT line.`);
  if (!notes.includes(version)) fail(`${notesPath} never mentions ${version}; it looks like stale notes.`);
  if (!/Developer ID Application/.test(run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout)) {
    fail("No Developer ID Application signing identity is visible. Run the release outside any agent sandbox, as Morgan's logged-in Mac user.");
  }
  if (run("security", ["find-generic-password", "-a", process.env.USER || "", "-s", "com.openkiwi.updater-signing"]).status !== 0) {
    fail("The macOS updater signing password (Keychain item com.openkiwi.updater-signing) is not readable. Run outside any agent sandbox.");
  }
  const notary = run("xcrun", ["notarytool", "history", "--keychain-profile", config.mac.notaryKeychainProfile], { timeout: 60_000 });
  if (notary.status !== 0) fail(`Apple notarization credentials (${config.mac.notaryKeychainProfile}) are not usable:\n${`${notary.stdout}${notary.stderr}`.trim().slice(0, 500)}`);
  const windowsCheck = run("ssh", [...SSH_OPTIONS, config.windows.sshHost,
    "'' + $env:COMPUTERNAME + '|' + (Test-Path \"$env:USERPROFILE\\.tauri\\openkiwi-windows-updater.key\") + '|' + (Test-Path \"$env:USERPROFILE\\.tauri\\openkiwi-windows-updater-password.xml\")"], { timeout: 60_000 });
  if (windowsCheck.status !== 0) fail(`Cannot reach the Windows PC over SSH (${config.windows.sshHost}). Is it awake and on the LAN?\n${(windowsCheck.stderr || "").trim()}`);
  const [windowsHost, windowsKey, windowsPassword] = windowsCheck.stdout.trim().split("|");
  if (windowsKey !== "True" || windowsPassword !== "True") fail(`The Windows updater signing key or its password file is missing on ${windowsHost}.`);

  const outRoot = resolve(privateRoot, "out", version);
  mkdirSync(outRoot, { recursive: true });
  const macDir = resolve(outRoot, "mac");
  const windowsDir = resolve(outRoot, "windows");
  updateRunState({ state: "building", commit });
  console.log(`Mythra Code ${version}\n  commit   ${commit}\n  notes    ${notesPath}\n  windows  ${windowsHost} via ${config.windows.sshHost}\n  output   ${outRoot}\n`);

  // Both native builds run at once. A failure on one side does not stop the
  // other, so its finished assets are reused on the next run.
  const makeTask = (name) => {
    const logPath = resolve(outRoot, `${name}.log`);
    return { name, logPath, log: createWriteStream(logPath, { flags: "a" }), stage: "starting", lastLine: "", child: null, reused: false, startedAt: Date.now() };
  };
  tasks = [makeTask("mac"), makeTask("windows")];
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

  const failures = [];
  results.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === "fulfilled") {
      console.log(`✔ ${task.name}: ${task.reused ? "reused existing build for this commit" : `built in ${elapsed(task.startedAt, task.finishedAt)}`}`);
    } else {
      failures.push(task.name);
      console.error(`✖ ${task.name}: ${result.reason?.message || result.reason}\n--- last lines of ${task.logPath} ---\n${tailOf(task.logPath)}\n---`);
    }
  });
  if (failures.length) fail(`The ${failures.join(" and ")} build failed; see the log lines above. Fix the cause and re-run the same command. Completed platform builds are reused.`);

  // Notes may have been edited since a reused Mac build; publish the current text.
  writeFileSync(resolve(macDir, "release-notes.md"), `${notes}\n`);
  const manifest = combinedManifest({ version, notes, macDir, windowsDir });
  const manifestPath = resolve(outRoot, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const assets = [
    ...readdirSync(macDir).filter((name) => name !== "latest.json").map((name) => resolve(macDir, name)),
    ...readdirSync(windowsDir).filter((name) => name !== "latest.json").map((name) => resolve(windowsDir, name)),
    manifestPath,
  ];
  if (!flags.publish) {
    updateRunState({ state: "built", message: "Built both platforms; not published (--no-publish)." });
    console.log(`\nBuilt both platforms; not publishing (--no-publish). Assets:\n${assets.map((path) => `  ${path}`).join("\n")}`);
    return;
  }

  updateRunState({ state: "publishing" });
  console.log(`\nUploading ${assets.length} assets to draft ${tag}…`);
  if (!existing) {
    checked("gh", ["release", "create", tag, "--repo", REPOSITORY, "--draft", "--target", commit, "--title", `Mythra Code ${version}`, "--notes-file", notesPath], "Creating the draft release");
  }
  uploadWithRetry(tag, assets);
  const draft = releaseState(tag);
  const uploaded = new Map((draft?.assets || []).map((asset) => [asset.name, asset]));
  const missing = assets.filter((path) => uploaded.get(path.split("/").at(-1))?.size !== statSync(path).size).map((path) => path.split("/").at(-1));
  for (const entry of Object.values(manifest.platforms)) {
    const name = decodeURIComponent(entry.url.split("/").at(-1));
    if (!uploaded.has(name) && !missing.includes(name)) missing.push(name);
  }
  if (missing.length) fail(`Draft ${tag} is missing or has incomplete assets: ${missing.join(", ")}. Re-run to retry the upload.`);

  checked("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--notes-file", notesPath, "--draft=false", "--latest"], "Publishing the release");
  const published = releaseState(tag);
  if (!published || published.isDraft) fail(`GitHub still reports ${tag} as a draft.`);
  updateRunState({ state: "published", url: published.url, message: `Published in ${elapsed(startedAt)}.` });
  console.log(`\n✔ Published Mythra Code ${version} for macOS and Windows in ${elapsed(startedAt)}\n  ${published.url}`);
}

function status({ version }) {
  const state = readRunState();
  const shown = version || state?.version;
  if (!shown) return console.log("No release has been run on this Mac yet.");
  if (state && state.version === shown) {
    const live = processAlive(state.pid);
    const active = ["preflight", "building", "publishing"].includes(state.state);
    const label = active && !live ? "interrupted (re-run publish to continue)" : state.state;
    console.log(`Release ${shown}: ${label}${active && live ? ` (pid ${state.pid}, started ${state.startedAt})` : ""}`);
    if (state.commit) console.log(`  commit   ${state.commit}`);
    if (state.url) console.log(`  url      ${state.url}`);
    if (state.message) console.log(`  message  ${state.message}`);
  } else {
    console.log(`Release ${shown}: no run recorded on this Mac.`);
  }
  const outRoot = resolve(privateRoot, "out", shown);
  for (const name of ["mac", "windows"]) {
    const last = tailOf(resolve(outRoot, `${name}.log`), 200).split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    if (last) console.log(`  ${name.padEnd(8)} ${last.slice(0, 140)}`);
  }
  const background = tailOf(resolve(outRoot, "release.log"), 6).trim();
  if (background) console.log(`  --- release.log ---\n${background.replace(/^/gm, "  ")}`);
  const github = releaseState(`v${shown}`);
  console.log(`  github   ${github ? (github.isDraft ? "draft (not public)" : `published ${github.url}`) : "no release yet"}`);
}

// Cancels the current run and confirms its processes are gone on both machines.
// Safe to repeat: it always re-checks both machines, so an unconfirmed stop can
// simply be run again.
function stop() {
  const config = loadConfig();
  const state = readRunState();
  const owner = [lockOwner(), state?.pid].find((pid) => processAlive(pid));
  if (owner) {
    console.log(`Stopping release ${state?.version || ""} (pid ${owner})…`);
    process.kill(owner, "SIGTERM");
    const deadline = Date.now() + 150_000;
    while (processAlive(owner) && Date.now() < deadline) sleepSync(500);
    if (processAlive(owner)) {
      console.log(`pid ${owner} did not exit; stopping it and its builds directly.`);
      process.kill(owner, "SIGKILL");
    }
  }
  const latest = readRunState() || state;
  const stuck = stopGroups(Object.values(latest?.processGroups || {}).filter((pgid) => releaseGroup(pgid, config)));
  const windows = stopWindowsBuild(config);
  const problems = [stuck.length ? `Mac process groups ${stuck.join(", ")} are still running` : "", windows ? `Windows cleanup is unconfirmed: ${windows}` : ""].filter(Boolean);
  if (latest && (owner || ["preflight", "building", "publishing"].includes(latest.state))) {
    activeRun = latest;
    updateRunState({ state: "failed", message: problems.length
      ? `Stopped by release:stop, but ${problems.join("; ")}. Run node scripts/release.mjs stop again.`
      : "Stopped by release:stop; confirmed nothing is running on the Mac or Windows. Re-run the release to continue." });
  }
  if (problems.length) {
    console.error(`✖ ${problems.join("; ")}. Run node scripts/release.mjs stop again.`);
    process.exit(1);
  }
  console.log(owner ? "Stopped. No release processes are running on the Mac or Windows." : "No release was running; confirmed nothing is left on the Mac or Windows.");
}

function prepare({ version, flags }) {
  checked("gh", ["auth", "status"], "GitHub CLI authentication");
  checked("git", ["fetch", "--quiet", "--prune", "origin", "--tags"], "Fetching origin");
  const current = JSON.parse(checked("git", ["show", "origin/main:package.json"], "Reading package.json")).version;
  if (current !== version && compareVersions(version, current) <= 0) fail(`${version} is not newer than main's ${current}.`);
  const branch = `release/v${version}`;

  // Reuse an open version PR from an earlier attempt; otherwise bump in a
  // throwaway worktree so the developer checkout is never touched.
  let url = current === version ? "" : checked("gh", ["pr", "list", "--repo", REPOSITORY, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""], "Looking for an open version PR");
  if (current === version) {
    console.log(`origin/main is already version ${version}; no version PR needed.`);
  } else if (url) {
    console.log(`Using the open version PR ${url}`);
  } else {
    const worktree = mkdtempSync(join(tmpdir(), "mythra-release-prepare-"));
    rmSync(worktree, { recursive: true, force: true });
    run("git", ["worktree", "prune"]);
    run("git", ["branch", "-D", branch]);
    try {
      checked("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], "Creating the version worktree");
      checked(process.execPath, ["scripts/bump-version.mjs", version], "Bumping the version", { cwd: worktree });
      checked("git", ["commit", "-qam", `Release ${version}`], "Committing the version bump", { cwd: worktree });
      checked("git", ["push", "-q", "--force", "-u", "origin", branch], "Pushing the version branch", { cwd: worktree });
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
  } else if (url) {
    console.log(`Merge ${url} before publishing.`);
  }

  const notesPath = resolve(privateRoot, "notes", `${version}.md`);
  if (!existsSync(notesPath)) {
    const previousTag = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", "origin/main"]).stdout.trim();
    const log = previousTag ? run("git", ["log", "--no-merges", "--format=- %s", `${previousTag}..origin/main`]).stdout.trim() : "";
    mkdirSync(resolve(privateRoot, "notes"), { recursive: true });
    writeFileSync(notesPath, `${NOTES_DRAFT_MARKER}\n# Mythra Code ${version}\n\n${log || "- "}\n`);
    console.log(`Drafted release notes at ${notesPath}. Rewrite them as user-facing bullets and delete the DRAFT line before publishing.`);
  } else {
    console.log(`Release notes already exist at ${notesPath}.`);
  }
}

const parsed = parseArguments(process.argv.slice(2));
try {
  if (parsed.command === "prepare") prepare(parsed);
  else if (parsed.command === "status") status(parsed);
  else if (parsed.command === "stop") stop();
  else await publish(parsed);
} catch (error) {
  fail(error.message);
}
