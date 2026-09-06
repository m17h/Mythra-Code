import { describe, expect, it } from "vitest";
import { runButtonInstructions, runCommandTitle, sanitizeProjectRunCommand, sanitizeProjectRunOverrides } from "./projectRun";
import type { Project } from "../types";

describe("sanitizeProjectRunCommand", () => {
  it("keeps a trimmed command and a tidy optional label", () => {
    expect(sanitizeProjectRunCommand({ command: "  npm run dev  ", label: "  Dev   server ", updatedAt: 5 }))
      .toEqual({ command: "npm run dev", label: "Dev server", updatedAt: 5 });
    expect(sanitizeProjectRunCommand({ command: "make", label: "" }, 42)).toEqual({ command: "make", updatedAt: 42 });
  });

  it("rejects anything that is not a usable command", () => {
    expect(sanitizeProjectRunCommand(undefined)).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "   " })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: 12 })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "x".repeat(4_001) })).toBeUndefined();
    expect(sanitizeProjectRunCommand({ command: "make", label: "l".repeat(200) })?.label).toHaveLength(80);
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
  });

  it("explains the greyed-out state when nothing is saved", () => {
    expect(runButtonInstructions(null)).toContain("greyed out");
  });
});
