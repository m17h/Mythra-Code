// Frontend tsconfig omits Node types; Vitest executes this focused shell check in Node.
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { spawnSync } from "node:child_process";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { tmpdir } from "node:os";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectRunExecCommand, projectRunShellCommand, runButtonInstructions, runCommandTitle, sanitizeProjectRunCommand, sanitizeProjectRunOverrides } from "./projectRun";
import type { Project } from "../types";

describe("sanitizeProjectRunCommand", () => {
  it("keeps a trimmed command and a tidy optional label", () => {
    expect(sanitizeProjectRunCommand({ command: "  npm run dev  ", label: "  Dev   server ", updatedAt: 5 }))
      .toEqual({ command: "npm run dev", label: "Dev server", updatedAt: 5 });
    expect(sanitizeProjectRunCommand({ command: "make", label: "" }, 42)).toEqual({ command: "make", updatedAt: 42 });
    expect(sanitizeProjectRunCommand({ command: "npm run dev", setupCommand: "  npm install  " }, 42))
      .toEqual({ command: "npm run dev", setupCommand: "npm install", updatedAt: 42 });
  });

  it("rejects anything that is not a usable command", () => {
    expect(sanitizeProjectRunCommand(undefined)).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "   " })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: 12 })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "x".repeat(4_001) })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "make", setupCommand: "x".repeat(4_001) })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "make", label: "l".repeat(200) })?.label).toHaveLength(80);
  });
});

describe("projectRunShellCommand", () => {
  it("runs saved setup before launch in the same shell and leaves legacy recipes unchanged", () => {
    expect(projectRunShellCommand({ setupCommand: "npm install", command: "npm run dev", updatedAt: 1 }))
      .toBe("npm install && (npm run dev)");
    expect(projectRunShellCommand({ setupCommand: "npm install", command: "node -p process.cwd() || echo fallback", updatedAt: 1 }, "Win32"))
      .toBe("npm install & if not errorlevel 0 (exit /b) else if errorlevel 1 (exit /b) else node -p process.cwd() || echo fallback");
    expect(projectRunShellCommand({ command: "npm run dev", updatedAt: 1 })).toBe("npm run dev");
  });

  it("stops before launch when setup exits unsuccessfully", () => {
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    const shellPlatform = platform === "win32" ? "Win32" : "MacIntel";
    const run = { setupCommand: "node -e \"process.exit(7)\"", command: "echo launched || echo fallback", updatedAt: 1 };
    const [program, ...args] = projectRunExecCommand(run, shellPlatform);
    const result = spawnSync(program, args, { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("launched");
    expect(result.stdout).not.toContain("fallback");
    if (platform === "win32") {
      const negative = projectRunExecCommand({ ...run, setupCommand: "node -e \"process.exit(-1)\"" }, shellPlatform);
      const negativeResult = spawnSync(negative[0], negative.slice(1), { encoding: "utf8", timeout: 10_000 });
      // Node exposes a Windows process exit status as an unsigned DWORD.
      expect(negativeResult.status).toBe(0xffffffff);
      expect(negativeResult.stdout).not.toContain("launched");
    }
  }, 25_000);

  it("passes setup environment to launch and accepts parenthesized commands", () => {
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    const shellPlatform = platform === "win32" ? "Win32" : "MacIntel";
    const expression = platform === "win32" ? "process.cwd()" : "'process.cwd()'";
    const setup = platform === "win32" ? "set MYTHRA_RUN_TEST=ready" : "export MYTHRA_RUN_TEST=ready";
    const run = {
      setupCommand: `node -p ${expression} && ${setup}`,
      command: `node -p ${expression} && node -p process.env.MYTHRA_RUN_TEST`,
      updatedAt: 1,
    };
    const [program, ...args] = projectRunExecCommand(run, shellPlatform);
    const result = spawnSync(program, args, { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ready");
  });

  it("runs a quoted command on Windows even without a setup step", () => {
    const argv = projectRunExecCommand({ command: "node -p \"1+2\"", updatedAt: 1 }, "Win32");
    expect(argv[0]).toBe("powershell.exe");
    expect(argv[4].length).toBeLessThan(30_001);
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    if (platform !== "win32") return;
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });

  it("runs a quoted executable path in setup and blocks launch on its failure", () => {
    const platform = (globalThis as unknown as { process: { platform: string } }).process.platform;
    if (platform !== "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "mythra run "));
    const script = join(directory, "fail.cmd");
    try {
      writeFileSync(script, "@echo off\r\nexit /b 7\r\n");
      const argv = projectRunExecCommand({ setupCommand: `"${script}"`, command: "echo launched", updatedAt: 1 }, "Win32");
      const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.stdout).not.toContain("launched");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("sanitizeProjectRunOverrides", () => {
  it("drops a malformed stored command and leaves other overrides alone", () => {
    const projects: Project[] = [
      { id: "a", name: "A", path: "/a", overrides: { run: { command: "", updatedAt: 1 }, systemPrompt: "Keep it short." } },
      { id: "b", name: "B", path: "/b", overrides: { run: { command: "npm test", updatedAt: 2 } } },
      { id: "c", name: "C", path: "/c" },
    ];
    const sanitized = sanitizeProjectRunOverrides(projects);
    expect(sanitized[0].overrides).toEqual({ systemPrompt: "Keep it short." });
    expect(sanitized[1].overrides?.run).toEqual({ command: "npm test", updatedAt: 2 });
    expect(sanitized[2]).toBe(projects[2]);
  });
});

describe("runCommandTitle", () => {
  it("prefers the label and truncates long commands", () => {
    expect(runCommandTitle({ command: "npm run dev", label: "Dev server", updatedAt: 1 })).toBe("Dev server");
    expect(runCommandTitle({ command: "cargo build --release && ./target/release/app --serve", updatedAt: 1 }, 20)).toBe("cargo build --relea…");
    expect(runCommandTitle(undefined)).toBe("");
  });
});

describe("runButtonInstructions", () => {
  it("tells the model the current command and how to change it", () => {
    const text = runButtonInstructions({ command: "npm run dev", label: "Dev server", updatedAt: 1 });
    expect(text).toContain("`npm run dev`");
    expect(text).toContain("“Dev server”");
    expect(text).toContain("set_project_run_command");
    expect(text).toContain("Saving alone does not run anything");
    // "Run the project" requests go through the button, not the model's shell.
    expect(text).toContain("run: true");
    expect(text).toContain("Terminal panel");
    expect(runButtonInstructions({ command: "npm run dev", setupCommand: "npm install", updatedAt: 1 })).toContain("after setup `npm install`");
    expect(runButtonInstructions(null)).toContain("pushd app && npm install && popd");
  });

  it("explains the greyed-out state when nothing is saved", () => {
    expect(runButtonInstructions(null)).toContain("greyed out");
  });
});
