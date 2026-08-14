import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = packageJson.version;
if (tauriConfig.version !== version) throw new Error(`Version mismatch: package.json=${version}, tauri.conf.json=${tauriConfig.version}`);
if (process.platform !== "darwin") throw new Error("The current OpenKiwi release preparation workflow targets macOS.");

const tauriArch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platform = `darwin-${tauriArch}`;
const windowsPlatform = "windows-x86_64";
const macosBundle = resolve(root, "src-tauri/target/release/bundle/macos");
const appSource = resolve(macosBundle, "OpenKiwi.app");
const updaterSource = resolve(macosBundle, "OpenKiwi.app.tar.gz");
const signatureSource = `${updaterSource}.sig`;
const dmgCandidates = [
  resolve(root, `src-tauri/target/release/bundle/dmg/OpenKiwi_${version}_${tauriArch}.dmg`),
  resolve(root, "src-tauri/target/release/bundle/dmg/OpenKiwi.dmg"),
];
const dmgSource = dmgCandidates.find(existsSync);
const windowsDirectory = resolve(root, "Windows/latest");
const windowsInstallerName = `OpenKiwi_${version}_x64-setup.exe`;
const windowsInstallerSource = resolve(windowsDirectory, windowsInstallerName);
const windowsSignatureSource = `${windowsInstallerSource}.sig`;
const windowsBuildInfoSource = resolve(windowsDirectory, "build-info.json");

function tarEntryNames(archivePath) {
  const archive = gunzipSync(readFileSync(archivePath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const textField = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const name = textField(0, 100);
    const prefix = textField(345, 155);
    entries.push(prefix ? `${prefix}/${name}` : name);
    const sizeText = textField(124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error(`Updater archive has an invalid tar entry size at byte ${offset}.`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function isMacMetadataEntry(entry) {
  return entry.split("/").some((part) => part === "__MACOSX" || part.startsWith("._"));
}

for (const path of [appSource, updaterSource, signatureSource]) {
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}\nRun npm run release:build first.`);
}
if (!dmgSource) throw new Error(`Missing DMG. Looked for:\n${dmgCandidates.join("\n")}`);
for (const path of [windowsInstallerSource, windowsSignatureSource, windowsBuildInfoSource]) {
  if (!existsSync(path)) {
    throw new Error(`Missing Windows release artifact: ${path}\nRun npm run release:windows from the release commit first.`);
  }
}
const metadataEntries = tarEntryNames(updaterSource).filter(isMacMetadataEntry);
if (metadataEntries.length) {
  throw new Error(`Updater archive contains macOS metadata entries that Tauri cannot unpack:\n${metadataEntries.join("\n")}\nRebuild it with COPYFILE_DISABLE=1.`);
}

function requireSuccess(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${label} failed.${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

requireSuccess("codesign", ["--verify", "--deep", "--strict", appSource], "App signature verification");
requireSuccess("xcrun", ["stapler", "validate", appSource], "App notarization ticket validation");
requireSuccess("spctl", ["--assess", "--type", "execute", "--verbose=4", appSource], "App Gatekeeper assessment");
requireSuccess("codesign", ["--verify", "--verbose=4", dmgSource], "DMG signature verification");
requireSuccess("xcrun", ["stapler", "validate", dmgSource], "DMG notarization ticket validation");
requireSuccess("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgSource], "DMG Gatekeeper assessment");
const bundledVersion = requireSuccess("plutil", ["-extract", "CFBundleShortVersionString", "raw", resolve(appSource, "Contents/Info.plist")], "Bundle version check");
if (bundledVersion !== version) throw new Error(`Bundle version mismatch: expected ${version}, found ${bundledVersion}`);

const windowsBuildInfo = JSON.parse(readFileSync(windowsBuildInfoSource, "utf8").replace(/^\uFEFF/, ""));
const releaseCommit = requireSuccess("git", ["rev-parse", "HEAD"], "Release commit check");
if (windowsBuildInfo.version !== version) {
  throw new Error(`Windows build version mismatch: expected ${version}, found ${windowsBuildInfo.version ?? "unknown"}.`);
}
if (windowsBuildInfo.commit !== releaseCommit) {
  throw new Error(`Windows build commit mismatch: expected ${releaseCommit}, found ${windowsBuildInfo.commit ?? "unknown"}.`);
}
if (windowsBuildInfo.platform !== windowsPlatform || windowsBuildInfo.architecture !== "x64") {
  throw new Error(`Windows build platform mismatch: expected ${windowsPlatform}/x64.`);
}
if (windowsBuildInfo.installer !== windowsInstallerName || windowsBuildInfo.signature !== `${windowsInstallerName}.sig`) {
  throw new Error("Windows build provenance names do not match the expected release artifacts.");
}
if (windowsBuildInfo.dirty) throw new Error("The Windows artifact was built from a dirty working tree.");
if (windowsBuildInfo.authenticodeStatus !== "Valid" && process.env.OPENKIWI_ALLOW_UNSIGNED_WINDOWS !== "1") {
  throw new Error(`Windows installer Authenticode status is ${windowsBuildInfo.authenticodeStatus ?? "unknown"}. Install a trusted code-signing certificate, or explicitly set OPENKIWI_ALLOW_UNSIGNED_WINDOWS=1 for this release.`);
}
const windowsInstallerDigest = createHash("sha256").update(readFileSync(windowsInstallerSource)).digest("hex");
if (windowsBuildInfo.sha256 !== windowsInstallerDigest) {
  throw new Error(`Windows installer SHA-256 mismatch: build-info=${windowsBuildInfo.sha256 ?? "missing"}, actual=${windowsInstallerDigest}.`);
}
const windowsSignature = readFileSync(windowsSignatureSource, "utf8").trim();
if (!windowsSignature) throw new Error("The Windows updater signature is empty.");

const output = resolve(root, "release-assets/latest");
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(output)) rmSync(resolve(output, entry), { recursive: true, force: true });

const updaterName = `OpenKiwi_${version}_${tauriArch}.app.tar.gz`;
const dmgName = `OpenKiwi_${version}_${tauriArch}.dmg`;
copyFileSync(updaterSource, resolve(output, updaterName));
copyFileSync(dmgSource, resolve(output, dmgName));
copyFileSync(windowsInstallerSource, resolve(output, windowsInstallerName));
copyFileSync(windowsBuildInfoSource, resolve(output, "windows-build-info.json"));
copyFileSync(resolve(root, "src-tauri/icons/openkiwi-ok-master.png"), resolve(output, "OpenKiwi-icon.png"));

const notesPath = resolve(root, "release-assets/release-notes.md");
let notes = `OpenKiwi ${version}`;
if (existsSync(notesPath)) {
  notes = readFileSync(notesPath, "utf8").trim();
  // Guard against silently shipping the previous release's notes.
  if (!notes.includes(version) && !process.argv.includes("--allow-stale-notes")) {
    throw new Error(`release-assets/release-notes.md never mentions ${version}; it looks like stale notes left over from a previous release.\nUpdate the notes for ${version}, or pass --allow-stale-notes to use them anyway.`);
  }
}
const signature = readFileSync(signatureSource, "utf8").trim();
const updaterUrl = `https://github.com/m17h/OpenKiwi/releases/download/v${version}/${updaterName}`;
const windowsUpdaterUrl = `https://github.com/m17h/OpenKiwi/releases/download/v${version}/${windowsInstallerName}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: { signature, url: updaterUrl },
    [windowsPlatform]: { signature: windowsSignature, url: windowsUpdaterUrl },
  },
};
writeFileSync(resolve(output, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
writeFileSync(resolve(output, "release-notes.md"), `${notes}\n`);

// Record the digests for the download-verification step of the runbook, so
// the recorded evidence always matches the staged artifacts.
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const shaLines = [updaterName, dmgName, windowsInstallerName].map((name) => `${digest(resolve(output, name))}  ${name}`);
writeFileSync(resolve(root, "release-assets/local-sha256.txt"), `${shaLines.join("\n")}\n`);

console.log(`Prepared OpenKiwi ${version} release assets in ${output}`);
for (const entry of readdirSync(output).sort()) console.log(`- ${basename(entry)}`);
