// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { spawnSync } from "node:child_process";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { tmpdir } from "node:os";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellCommand, shellCommandWithWindowsQuotes, shellLabel } from "./shellCommand";

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

  it("runs saved Windows recipes with quoted folders and executables", () => {
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    if (platform !== "win32") {
      expect(shellCommandWithWindowsQuotes('cd /d "folder with spaces"', "Win32")[0]).toBe("powershell.exe");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "mythra checks "));
    const folder = join(root, "folder with spaces");
    try {
      mkdirSync(folder);
      const script = join(folder, "verify.cmd");
      writeFileSync(script, "@echo off\r\necho CHECK_OK\r\n");
      const command = `cd /d "folder with spaces" && "${script}"`;
      const argv = shellCommandWithWindowsQuotes(command, "Win32");
      expect(argv[0]).toBe("powershell.exe");
      const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("CHECK_OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
