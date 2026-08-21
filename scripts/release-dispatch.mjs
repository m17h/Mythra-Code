import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const action = process.argv[2];
if (action !== "build" && action !== "publish") {
  throw new Error("Usage: node scripts/release-dispatch.mjs <build|publish>");
}
const root = resolve(import.meta.dirname, "..");
const target = process.platform === "darwin"
  ? resolve(root, "scripts", action === "build" ? "build-release.mjs" : "publish-release.mjs")
  : process.platform === "win32"
    ? resolve(root, "Windows", action === "build" ? "build.ps1" : "publish-release.mjs")
    : null;
if (!target) throw new Error("OpenKiwi releases are supported only on macOS and Windows.");
const command = process.platform === "win32" && action === "build" ? "powershell.exe" : process.execPath;
const args = process.platform === "win32" && action === "build"
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target]
  : [target];
const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
