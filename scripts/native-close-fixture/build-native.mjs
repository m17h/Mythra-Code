import { copyFileSync, readFileSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = dirname(fileURLToPath(import.meta.url));
const repository = resolve(fixture, "../..");
const core = ["tauri", "tauri-runtime", "tauri-runtime-wry", "wry", "tauri-plugin-dialog", "webview2-com"];

export function coreVersions(lock) {
  const versions = new Map();
  for (const section of lock.split("[[package]]")) {
    const match = section.match(/\bname = "([^"]+)"\s+version = "([^"]+)"/);
    if (match && core.includes(match[1])) {
      const previous = versions.get(match[1]) || [];
      versions.set(match[1], [...previous, match[2]].sort());
    }
  }
  return versions;
}

export function assertCoreLockMatches(productionLock, fixtureLock, windows = process.platform === "win32") {
  const production = coreVersions(productionLock);
  const candidate = coreVersions(fixtureLock);
  for (const name of core) {
    if (name === "webview2-com" && !windows) continue;
    const expected = production.get(name);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(candidate.get(name))) {
      throw new Error(`Fixture ${name} lock differs from production (${expected} vs ${candidate.get(name)})`);
    }
  }
}

function main() {
  const productionLock = readFileSync(resolve(repository, "src-tauri/Cargo.lock"), "utf8");
  const filesystem = statfsSync(fixture, { bigint: true });
  const free = filesystem.bavail * filesystem.bsize;
  if (free < 1500n * 1024n * 1024n) throw new Error(`Insufficient disk for isolated compile: ${free} bytes`);
  // Generated fixture lock is mechanically seeded; never hand-edit dependency versions.
  copyFileSync(resolve(repository, "src-tauri/Cargo.lock"), resolve(fixture, "Cargo.lock"));
  const env = { ...process.env, CARGO_BUILD_JOBS: "4", TAURI_CONFIG: process.platform === "win32"
    ? readFileSync(resolve(repository, "src-tauri/tauri.windows.conf.json"), "utf8") : "{}" };
  const result = spawnSync(process.platform === "win32" ? "cargo.exe" : "cargo", [
    "build", "--release", "--offline", "--bins", "--jobs", "4", "--manifest-path", resolve(fixture, "Cargo.toml"),
  ], { cwd: fixture, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Fixture compile failed (${result.status})`);
  assertCoreLockMatches(productionLock, readFileSync(resolve(fixture, "Cargo.lock"), "utf8"));
  console.log("Isolated native bins built; production core lock versions match. No app launched or bundled.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node scripts/native-close-fixture/build-native.mjs\nBuild three isolated native bins offline with production-seeded lock and four jobs.\nOptional CARGO_TARGET_DIR reuses an existing cache. No app is launched or bundled.");
  } else if (args.length) {
    throw new Error("Unknown arguments; use --help. No build started.");
  } else main();
}
