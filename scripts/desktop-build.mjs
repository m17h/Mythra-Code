import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tauri = resolve(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

const bundleArgs = process.platform === "darwin"
  ? ["--bundles", "app"]
  : process.platform === "win32"
    ? ["--no-bundle"]
    : null;

if (!bundleArgs) {
  throw new Error("Mythra Code desktop builds are supported only on macOS and Windows.");
}

const result = spawnSync(process.execPath, [
  tauri,
  "build",
  ...bundleArgs,
  "--config",
  "src-tauri/tauri.local.conf.json",
], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform === "darwin") {
  const appBundle = resolve(root, "src-tauri", "target", "release", "bundle", "macos", "Mythra Code.app");
  const verifyArgs = ["--verify", "--deep", "--strict", appBundle];
  const initialVerification = spawnSync("codesign", verifyArgs, { cwd: root, stdio: "ignore" });

  // Rust's linker signs the Mach-O executable but does not seal the surrounding
  // app resources. Give local-only bundles a complete ad-hoc signature so
  // macOS can validate and launch the generated .app normally.
  if (initialVerification.status !== 0) {
    const sign = spawnSync("codesign", ["--force", "--sign", "-", appBundle], {
      cwd: root,
      stdio: "inherit",
    });
    if (sign.error) throw sign.error;
    if (sign.status !== 0) process.exit(sign.status ?? 1);

    const verification = spawnSync("codesign", verifyArgs, { cwd: root, stdio: "inherit" });
    if (verification.error) throw verification.error;
    if (verification.status !== 0) process.exit(verification.status ?? 1);
  }
}
