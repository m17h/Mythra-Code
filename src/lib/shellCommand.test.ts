import { describe, expect, it } from "vitest";
import { shellCommand, shellLabel } from "./shellCommand";

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
});
