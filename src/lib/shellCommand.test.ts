// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { spawn, spawnSync } from "node:child_process";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { tmpdir } from "node:os";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellCommand, shellCommandWithWindowsQuotes, shellLabel } from "./shellCommand";

const nativeProcess = (globalThis as unknown as { process: {
  platform: string; execPath: string; env: Record<string, string | undefined>;
} }).process;

class NativeCommandFailure extends Error {
  constructor(message: string, readonly cleanupComplete = true) {
    super(message);
  }
}

function runNativeCommand(argv: string[], cwd: string, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true });
  let stdout = "";
  let stderr = "";
  let launchError: Error | undefined;
  let timeoutFailure: string | undefined;
  let treeCleanupConfirmed = true;
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  const diagnostic = () => JSON.stringify({ cwd, elapsedMs: Date.now() - startedAt, stdout, stderr });
  return new Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Keep useful trailing diagnostics without allowing an errant recipe to
    // allocate unlimited memory in the test runner.
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-65_536); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
    const deadline = setTimeout(() => {
      timeoutFailure = `Native command exceeded ${timeoutMs} ms`;
      treeCleanupConfirmed = false;
      // Kill the owned parent while it is still alive so taskkill can discover
      // PowerShell's CMD descendants. An exited PID must never be retargeted.
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const systemRoot = nativeProcess.env.SystemRoot;
        const cleanup = systemRoot ? spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
          encoding: "utf8", timeout: 5_000, windowsHide: true,
        }) : { status: null, error: new Error("SystemRoot is unavailable") };
        timeoutFailure += `; tree cleanup: ${JSON.stringify({
          status: cleanup.status, error: cleanup.error?.message,
          stdout: "stdout" in cleanup ? cleanup.stdout : undefined,
          stderr: "stderr" in cleanup ? cleanup.stderr : undefined,
        })}`;
        treeCleanupConfirmed = cleanup.status === 0;
        if (cleanup.status !== 0) child.kill();
      }
      shutdownDeadline = setTimeout(() => {
        reject(new NativeCommandFailure(`${timeoutFailure}; child pipes did not close; fixture retained: ${diagnostic()}`, false));
      }, 5_000);
    }, timeoutMs);
    child.once("error", (error: Error) => { launchError = error; });
    child.once("close", (status: number | null, signal: string | null) => {
      clearTimeout(deadline);
      clearTimeout(shutdownDeadline);
      if (launchError || timeoutFailure) {
        // Closed parent pipes do not prove redirected grandchildren exited.
        // Retain the fixture when tree termination was not confirmed.
        const cleanupDiagnostic = treeCleanupConfirmed ? "" : "; tree termination unconfirmed; fixture retained";
        reject(new NativeCommandFailure(`${timeoutFailure ?? `Native command failed to launch: ${launchError?.message}`}${cleanupDiagnostic}; ${diagnostic()}`, treeCleanupConfirmed));
      } else {
        resolve({ status, signal, stdout, stderr });
      }
    });
  });
}

describe("shellCommand", () => {
  it("runs through a macOS login shell", () => {
    expect(shellCommand("npm test", "MacIntel")).toEqual(["/bin/zsh", "-lc", "npm test"]);
    expect(shellLabel("MacIntel")).toBe("zsh");
  });

  it("runs through cmd.exe on Windows", () => {
    expect(shellCommand("npm test", "Win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "npm test"]);
    expect(shellLabel("Win32")).toBe("Command Prompt");
  });

  it("keeps the command string intact on both platforms", () => {
    const command = 'echo "a b" && npm run build -- --flag=1';
    expect(shellCommand(command, "MacIntel").at(-1)).toBe(command);
    expect(shellCommand(command, "Win32").at(-1)).toBe(command);
  });

  it("treats an unknown platform as POSIX", () => {
    expect(shellCommand("ls", "")[0]).toBe("/bin/zsh");
  });

  it("runs saved Windows recipes with quoted folders and executables", async () => {
    if (nativeProcess.platform !== "win32") {
      expect(shellCommandWithWindowsQuotes('cd /d "folder with spaces"', "Win32")[0]).toBe("powershell.exe");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "mythra checks "));
    const folder = join(root, "folder with spaces");
    let failure: unknown;
    try {
      mkdirSync(folder);
      const script = join(folder, "verify.cmd");
      writeFileSync(script, "@echo off\r\necho CHECK_OK\r\n");
      const command = `cd /d "folder with spaces" && "${script}"`;
      const argv = shellCommandWithWindowsQuotes(command, "Win32");
      expect(argv[0]).toBe("powershell.exe");
      // Hosted Windows startup took 11 seconds. The helper bounds native
      // execution at 30 seconds, with a separate allowance for tree cleanup.
      const result = await runNativeCommand(argv, root);
      const diagnostic = JSON.stringify(result);
      expect(result.status, diagnostic).toBe(0);
      expect(result.signal, diagnostic).toBeNull();
      expect(result.stdout, diagnostic).toContain("CHECK_OK");
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (!(failure instanceof NativeCommandFailure && !failure.cleanupComplete)) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError(failure ? [failure, cleanupError] : [cleanupError], `Failed to remove shell fixture ${root}`);
        }
      }
    }
  }, 45_000);

  it("bounds a hung native Windows command and waits for cleanup", async () => {
    if (nativeProcess.platform !== "win32") return;
    // Use the current Node executable, avoiding another shell or PATH lookup.
    // This child never exits itself; the deadline must terminate it and await
    // closed stdio before the command promise rejects.
    try {
      await runNativeCommand([nativeProcess.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), 250);
      expect.fail("The hung native command unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeCommandFailure);
      expect((error as NativeCommandFailure).message).toContain("Native command exceeded 250 ms");
      expect((error as NativeCommandFailure).cleanupComplete).toBe(true);
      expect((error as NativeCommandFailure).message).toContain('"status":0');
    }
  }, 15_000);
});
