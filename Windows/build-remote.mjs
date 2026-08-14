import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const allowUnsigned = process.argv.includes("--allow-unsigned") || process.env.OPENKIWI_ALLOW_UNSIGNED_WINDOWS === "1";
const keepRemote = process.argv.includes("--keep-remote");

if (process.platform !== "darwin") {
  throw new Error("Windows/build-remote.mjs must run on the release Mac. Run Windows/build.ps1 directly when already on Windows.");
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${command} failed.${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

const dirty = checked("git", ["status", "--porcelain"]);
if (dirty) throw new Error(`Refusing to build Windows from a dirty working tree:\n${dirty}`);
const head = checked("git", ["rev-parse", "HEAD"]);
const remoteHead = checked("git", ["rev-parse", "origin/main"]);
if (head !== remoteHead) throw new Error(`HEAD ${head} is not the pushed origin/main commit ${remoteHead}. Push the release commit first.`);

const defaultKeyPath = resolve(homedir(), ".tauri/openkiwi-updater.key");
const keySetting = process.env.TAURI_SIGNING_PRIVATE_KEY || defaultKeyPath;
const privateKey = existsSync(keySetting) ? readFileSync(keySetting, "utf8") : keySetting;
if (!privateKey.trim() || privateKey.length < 64 || privateKey.includes("\0")) {
  throw new Error("The Tauri updater private key is unavailable or invalid.");
}

let signingPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
if (!signingPassword) {
  signingPassword = checked("security", ["find-generic-password", "-s", "com.openkiwi.updater-signing", "-w"]);
}
if (!signingPassword) throw new Error("The Tauri updater signing password is unavailable.");

checked("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "zeds-pc-ai", "$env:COMPUTERNAME; whoami"]);

const suffix = randomBytes(4).toString("hex");
const remoteDirectory = `C:\\Users\\puzzl\\AppData\\Local\\Temp\\OpenKiwi-release-${version}-${head.slice(0, 8)}-${suffix}`;
const powerShellString = (value) => `'${value.replaceAll("'", "''")}'`;
const remoteDirectoryLiteral = powerShellString(remoteDirectory);
const unsignedArgument = allowUnsigned ? " -AllowUnsigned" : "";
const remoteScript = [
  '$ErrorActionPreference = "Stop"',
  '$payload = ([Console]::In.ReadToEnd() | ConvertFrom-Json)',
  `$buildDirectory = ${remoteDirectoryLiteral}`,
  'if (Test-Path -LiteralPath $buildDirectory) { throw "Remote build directory already exists." }',
  'git clone --no-checkout https://github.com/m17h/OpenKiwi.git $buildDirectory',
  'if ($LASTEXITCODE -ne 0) { throw "git clone failed." }',
  `git -C $buildDirectory fetch origin ${head} --depth 1`,
  'if ($LASTEXITCODE -ne 0) { throw "git fetch failed." }',
  `git -C $buildDirectory checkout --detach ${head}`,
  'if ($LASTEXITCODE -ne 0) { throw "git checkout failed." }',
  '$env:TAURI_SIGNING_PRIVATE_KEY = $payload.privateKey',
  '$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $payload.signingPassword',
  `& (Join-Path $buildDirectory "Windows\\build.ps1") -ExpectedCommit ${head}${unsignedArgument}`,
  'if ($LASTEXITCODE -ne 0) { throw "Windows release build failed." }',
  'Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue',
  'Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue',
].join("; ");
const encodedCommand = Buffer.from(remoteScript, "utf16le").toString("base64");
const payload = JSON.stringify({ privateKey, signingPassword });
const build = spawnSync("ssh", [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "zeds-pc-ai",
  "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand,
], {
  cwd: root,
  input: payload,
  stdio: ["pipe", "inherit", "inherit"],
});
if (build.status !== 0) process.exit(build.status ?? 1);

const output = resolve(root, "Windows/latest");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const installerName = `OpenKiwi_${version}_x64-setup.exe`;
for (const name of [installerName, `${installerName}.sig`, "build-info.json"]) {
  const remotePath = `${remoteDirectory.replaceAll("\\", "/")}/Windows/latest/${name}`;
  const copy = spawnSync("scp", ["-q", `zeds-pc-ai:${remotePath}`, resolve(output, name)], { cwd: root, stdio: "inherit" });
  if (copy.status !== 0) process.exit(copy.status ?? 1);
}

const buildInfo = JSON.parse(readFileSync(resolve(output, "build-info.json"), "utf8"));
if (buildInfo.version !== version || buildInfo.commit !== head || buildInfo.platform !== "windows-x86_64") {
  throw new Error("The downloaded Windows build provenance does not match this release commit and version.");
}
if (buildInfo.authenticodeStatus !== "Valid" && !allowUnsigned) {
  throw new Error(`The downloaded Windows installer is not Authenticode-signed (${buildInfo.authenticodeStatus}).`);
}

if (!keepRemote) {
  const cleanupScript = `$path = ${remoteDirectoryLiteral}; $prefix = 'C:\\Users\\puzzl\\AppData\\Local\\Temp\\OpenKiwi-release-'; if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe cleanup path." }; Remove-Item -LiteralPath $path -Recurse -Force`;
  const cleanupEncoded = Buffer.from(cleanupScript, "utf16le").toString("base64");
  const cleanup = spawnSync("ssh", ["zeds-pc-ai", "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", cleanupEncoded], { cwd: root, stdio: "inherit" });
  if (cleanup.status !== 0) console.warn(`Warning: remote build output remains at ${remoteDirectory}`);
}

console.log(`Downloaded OpenKiwi ${version} Windows release assets to ${output}`);
if (buildInfo.authenticodeStatus !== "Valid") {
  console.warn("WARNING: Windows installer is updater-signed but not Authenticode-signed; SmartScreen may report Unknown publisher.");
}
