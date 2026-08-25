import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const canonicalRepo = "m17h/Mythra-Code";
const releaseEndpoint = `https://github.com/${canonicalRepo}/releases/latest/download/latest.json`;
const pricingUrl = `https://raw.githubusercontent.com/${canonicalRepo}/main/model-pricing.json`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function filesUnder(path) {
  const absolute = resolve(root, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

const pkg = readJson("package.json");
const cargo = readText("src-tauri/Cargo.toml");
const base = readJson("src-tauri/tauri.conf.json");
const windows = readJson("src-tauri/tauri.windows.conf.json");
const windowsBuild = readText("Windows/build.ps1");
const windowsPublish = readText("Windows/publish-release.mjs");
const usageLedger = readText("src/lib/usageLedger.ts");
const appConfig = readText("src/lib/appConfig.ts");
const desktopBuild = readText("scripts/desktop-build.mjs");
const prepareRelease = readText("scripts/prepare-release.mjs");
const macPublish = readText("scripts/publish-release.mjs");
const finalizeRelease = readText("scripts/finalize-release.mjs");
const packageScripts = pkg.scripts || {};
const retiredProductName = new RegExp(["Open", "Kiwi"].join(""));

assert(pkg.name === "mythra-code", "package.json must use the Mythra Code package identity.");
assert(pkg.version === base.version, "package.json and the base Tauri config must have the same version.");
assert(cargo.includes('name = "mythra-code"'), "Cargo.toml must use the Mythra Code executable identity.");
assert(cargo.includes('name = "mythra_code_lib"'), "Cargo.toml must use the Mythra Code library identity.");
assert(cargo.includes(`version = "${pkg.version}"`), "Cargo.toml must have the same version as package.json.");
assert(base.productName === "Mythra Code", "The packaged product name must be Mythra Code.");
assert(base.identifier === "com.kiwi.harness", "The released bundle identifier is a compatibility boundary and must remain stable.");
assert(base.plugins?.updater?.endpoints?.includes(releaseEndpoint), "The macOS updater must use the canonical release endpoint.");
assert(windows.plugins?.updater?.endpoints?.includes(releaseEndpoint), "The Windows updater must use the canonical release endpoint.");
assert(base.plugins?.updater?.pubkey, "The macOS updater public key is missing.");
assert(windows.plugins?.updater?.pubkey, "The Windows updater public key is missing.");
assert(base.plugins.updater.pubkey !== windows.plugins.updater.pubkey, "Platform updater keys must remain distinct.");
assert(base.app?.security?.csp?.includes(`https://raw.githubusercontent.com/${canonicalRepo}/`), "The CSP must allow the canonical pricing source.");
assert(windowsBuild.includes(`$releaseRepository = "${canonicalRepo}"`), "The Windows builder targets the wrong repository.");
assert(windowsBuild.includes('"--config", "src-tauri/tauri.windows.conf.json"'), "The Windows builder must apply its Tauri override.");
assert(windowsPublish.includes(`const REPOSITORY = "${canonicalRepo}"`), "The Windows publisher targets the wrong repository.");
assert(usageLedger.includes(pricingUrl), "The usage ledger pricing catalog must use the canonical repository.");
assert(appConfig.includes(`github.com/${canonicalRepo}`), "Application release links must use the canonical repository.");
assert(packageScripts["release:finalize"] === "node scripts/finalize-release.mjs", "The combined release finalizer is not configured.");
assert(packageScripts["desktop:build"] === "node scripts/desktop-build.mjs", "The cross-platform local desktop builder is not configured.");
assert(desktopBuild.includes('["--bundles", "app"]'), "The local macOS builder must produce an app bundle.");
assert(desktopBuild.includes('["--no-bundle"]'), "The local Windows builder must produce an unbundled executable.");
assert(desktopBuild.includes('spawnSync("codesign"'), "The local macOS app bundle must receive a complete code signature.");
assert(prepareRelease.includes('src-tauri/icons/mythra-code-master.png'), "The macOS release must use the Mythra Code icon master.");
assert(prepareRelease.includes('`MythraCode_${version}_${tauriArch}.app.tar.gz`'), "The staged macOS updater artifact must use the URL-safe MythraCode name.");
assert(macPublish.includes('"MythraCode-icon.png"'), "The macOS publisher must require the Mythra Code icon asset.");
assert(finalizeRelease.includes('`MythraCode_${version}_x64-setup.exe`'), "The release finalizer must require the Mythra Code Windows installer.");
assert(windowsBuild.includes('$sourceInstallerName = "Mythra Code_${version}_x64-setup.exe"'), "The Windows builder must locate Tauri's space-preserving installer name.");
assert(windowsBuild.includes('$installerName = "MythraCode_${version}_x64-setup.exe"'), "The staged Windows installer must use the URL-safe MythraCode name.");

const paths = ["src", "src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/tauri.dev.conf.json", "src-tauri/tauri.windows.conf.json", "scripts", "Windows", "README.md", "SECURITY.md", "AGENTS.md"];
for (const path of paths) {
  for (const file of filesUnder(path)) {
    const text = readFileSync(file, "utf8");
    assert(!retiredProductName.test(text), `${file} still contains the retired product name.`);
    assert(!/m17h\/openkiwi-windows/i.test(text), `${file} still references the retired Windows repository.`);
  }
}

console.log("Unified macOS/Windows release configuration verified.");
