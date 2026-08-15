import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const tauriConfigPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoManifestPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");
const requested = process.argv[2] ?? "patch";

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const current = packageJson.version;

function nextVersion(version, request) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request)) return request;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Cannot automatically bump nonstandard version ${version}`);
  let [, major, minor, patch] = match.map(Number);
  if (request === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (request === "minor") [minor, patch] = [minor + 1, 0];
  else if (request === "patch") patch += 1;
  else throw new Error("Use patch, minor, major, or an exact semantic version such as 1.2.3");
  return `${major}.${minor}.${patch}`;
}

const version = nextVersion(current, requested);
if (version === current) throw new Error(`OpenKiwi is already version ${version}`);

packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
packageLock.version = version;
packageLock.packages[""].version = version;
writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

// Rewrites that rely on a regex must prove the regex actually matched, or a
// drifting file format would silently leave the old version in place.
function rewriteVersion(path, pattern) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, `$1${version}$2`);
  if (after === before || !after.includes(version)) {
    throw new Error(`Could not update the version in ${path}: the expected version line was not found. Update it to ${version} manually or fix the pattern in scripts/bump-version.mjs.`);
  }
  writeFileSync(path, after);
}

rewriteVersion(cargoManifestPath, /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("$)/m);
rewriteVersion(cargoLockPath, /(\[\[package\]\]\r?\nname = "openkiwi"\r?\nversion = ")[^"]+("\r?\n)/);

console.log(`OpenKiwi ${current} → ${version}`);
console.log("Updated package.json, package-lock.json, tauri.conf.json, Cargo.toml, and Cargo.lock.");
