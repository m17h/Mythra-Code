// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { spawn, spawnSync } from "node:child_process";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { kill, platform } from "node:process";

// Hosted Windows needed 14.6s for the quoted-recipe integration test. Keep
// native launches separate from Vitest's 5s unit budget, with bounded cleanup.
const NATIVE_COMMAND_TIMEOUT_MS = 30_000;
const NATIVE_CLEANUP_TIMEOUT_MS = 5_000;
export const NATIVE_SHELL_TEST_TIMEOUT_MS = NATIVE_COMMAND_TIMEOUT_MS + NATIVE_CLEANUP_TIMEOUT_MS + 5_000;

interface NativeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  cleanupSucceeded: boolean;
}

/** Test-only execution: drain normal output, or stop the exact process tree. */
export function runNativeShellCommand(argv: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<NativeCommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? NATIVE_COMMAND_TIMEOUT_MS;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd, windowsHide: true, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { stdout += data; });
    child.stderr.on("data", (data: string) => { stderr += data; });
    const finish = (status: number | null, error?: Error, cleanupSucceeded = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ status, stdout, stderr, error, cleanupSucceeded });
    };
    const deadline = setTimeout(() => {
      let cleanupSucceeded = false;
      let cleanupDetails = "";
      if (typeof child.pid === "number") {
        if (platform === "win32" && child.exitCode === null && child.signalCode === null) {
          // Killing PowerShell alone leaves CMD/Node descendants holding pipes.
          const killed = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            encoding: "utf8", timeout: NATIVE_CLEANUP_TIMEOUT_MS, windowsHide: true,
          });
          cleanupSucceeded = killed.status === 0 && !killed.error;
          cleanupDetails = killed.error?.message ?? killed.stderr;
        } else if (platform !== "win32") {
          try {
            // The detached child owns this group; never target the test runner.
            kill(-child.pid, "SIGKILL");
            cleanupSucceeded = true;
          } catch (error) {
            cleanupDetails = String(error);
          }
        } else {
          // The parent exited while a descendant kept its output open. Its PID
          // may already be reused, so never send taskkill to that former PID.
          cleanupDetails = "parent already exited; descendant cleanup unconfirmed";
        }
      }
      if (!cleanupSucceeded && child.exitCode === null && child.signalCode === null) child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(null, new Error(`Native command exceeded ${timeoutMs}ms. stdout: ${stdout}; stderr: ${stderr}; cleanup: ${cleanupSucceeded ? "process tree stopped" : cleanupDetails || "unconfirmed"}${!cleanupSucceeded && options.cwd ? `; preserve fixture: ${options.cwd}` : ""}`), cleanupSucceeded);
    }, timeoutMs);
    child.once("error", (error: Error) => finish(null, error));
    // close waits for process exit and complete stdout/stderr drainage.
    child.once("close", (status: number | null) => finish(status));
  });
}
