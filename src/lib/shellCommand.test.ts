// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { tmpdir } from "node:os";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellCommand, shellCommandWithWindowsQuotes, shellLabel } from "./shellCommand";
import { NATIVE_SHELL_TEST_TIMEOUT_MS, runNativeShellCommand } from "./nativeShell.testHelpers";

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

  it("encodes quoted recipes unchanged and bounds their Windows transport", () => {
    const command = 'cd /d "folder with spaces" && "C:\\it\'s here\\verify.cmd"';
    const argv = shellCommandWithWindowsQuotes(command, "Win32");
    expect(argv.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const bytes = Uint8Array.from(atob(argv[4]), (character) => character.charCodeAt(0));
    const script = new TextDecoder("utf-16le").decode(bytes);
    expect(script).toContain(`$command='${command.replace(/'/g, "''")}'`);
    expect(script).toContain("$start.Arguments='/d /s /c \"'+$command+'\"'");
    expect(script).toContain("exit $process.ExitCode");
    expect(shellCommandWithWindowsQuotes(command, "MacIntel")).toEqual(shellCommand(command, "MacIntel"));
    expect(() => shellCommandWithWindowsQuotes("echo \0", "Win32")).toThrow("null character");
    expect(() => shellCommandWithWindowsQuotes("x".repeat(30_000), "Win32")).toThrow("too long");
  });

  it("runs saved Windows recipes with quoted folders and executables", async () => {
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    if (platform !== "win32") {
      expect(shellCommandWithWindowsQuotes('cd /d "folder with spaces"', "Win32")[0]).toBe("powershell.exe");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "mythra checks "));
    const folder = join(root, "folder with spaces");
    let cleanupSafe = true;
    try {
      mkdirSync(folder);
      const script = join(folder, "verify.cmd");
      writeFileSync(script, "@echo off\r\necho CHECK_OK\r\n");
      const command = `cd /d "folder with spaces" && "${script}"`;
      const argv = shellCommandWithWindowsQuotes(command, "Win32");
      expect(argv[0]).toBe("powershell.exe");
      const result = await runNativeShellCommand(argv, { cwd: root });
      cleanupSafe = result.cleanupSucceeded;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("CHECK_OK");
      expect(result.stderr).toBe("");
    } finally {
      if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_SHELL_TEST_TIMEOUT_MS);
});
