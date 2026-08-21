import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const canonicalRepo = "m17h/OpenKiwi";
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
const packageScripts = pkg.scripts || {};

assert(pkg.version === base.version, "package.json and the base Tauri config must have the same version.");
assert(cargo.includes(`version = "${pkg.version}"`), "Cargo.toml must have the same version as package.json.");
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

const paths = ["src", "scripts", "Windows", "README.md", "SECURITY.md", "AGENTS.md"];
for (const path of paths) {
  for (const file of filesUnder(path)) {
    const text = readFileSync(file, "utf8");
    assert(!/m17h\/OpenKiwi-Windows/i.test(text), `${file} still references the retired Windows repository.`);
  }
}

console.log("Unified macOS/Windows release configuration verified.");
