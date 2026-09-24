import { describe, expect, it } from "vitest";
import { buildCheckFeedback, CHECK_OUTPUT_TAIL_LENGTH, checkOutputTail, sanitizeProjectCheckCommand, sanitizeProjectCheckOverrides, type ProjectCheckResult } from "./projectChecks";
import type { Project } from "../types";

describe("saved project check command", () => {
  it("normalizes a valid command and rejects malformed values", () => {
    expect(sanitizeProjectCheckCommand({ command: "  npm run verify  ", updatedAt: 12 }))
      .toEqual({ command: "npm run verify", updatedAt: 12 });
    expect(sanitizeProjectCheckCommand({ command: "make test" }, 42))
      .toEqual({ command: "make test", updatedAt: 42 });
    expect(sanitizeProjectCheckCommand({ command: "   " })).toBeUndefined();
    expect(sanitizeProjectCheckCommand({ command: 7 })).toBeUndefined();
    expect(sanitizeProjectCheckCommand({ command: "x".repeat(4_001) })).toBeUndefined();
  });

  it("drops malformed stored checks while preserving other overrides", () => {
    const projects: Project[] = [
      { id: "a", name: "A", path: "/a", overrides: { check: { command: "", updatedAt: 1 }, systemPrompt: "Keep it short." } },
      { id: "b", name: "B", path: "/b", overrides: { check: { command: " npm test ", updatedAt: 2 } } },
      { id: "c", name: "C", path: "/c" },
    ];
    const sanitized = sanitizeProjectCheckOverrides(projects);
    expect(sanitized[0].overrides).toEqual({ systemPrompt: "Keep it short." });
    expect(sanitized[1].overrides?.check).toEqual({ command: "npm test", updatedAt: 2 });
    expect(sanitized[2]).toBe(projects[2]);
  });

  it("keeps only bounded diagnostic output", () => {
    const output = checkOutputTail("a".repeat(20_000), "last failure");
    expect(output.output).toHaveLength(CHECK_OUTPUT_TAIL_LENGTH);
    expect(output.output).toContain("last failure");
    expect(output.outputTruncated).toBe(true);
    expect(checkOutputTail("ok", "")).toEqual({ output: "stdout:\nok", outputTruncated: false });
  });

  it("includes scope, revision, result, and untrusted output in a fix request", () => {
    const result: ProjectCheckResult = {
      id: "run-1", projectId: "project", threadId: "thread", cwd: "/worktree",
      command: "npm test", head: "abc123", startedAt: 1_000, finishedAt: 2_000,
      status: "failed", exitCode: 2, output: "test failed", outputTruncated: false,
    };
    const feedback = buildCheckFeedback(result);
    expect(feedback).toContain("manual run");
    expect(feedback).toContain("untrusted diagnostic data");
    expect(feedback).toContain('"cwd": "/worktree"');
    expect(feedback).toContain('"head": "abc123"');
    expect(feedback).toContain('"exitCode": 2');
    expect(feedback).toContain("test failed");
  });
});
