import { describe, expect, it } from "vitest";
import { executionPathForThread, type ThreadWorktreeRecord } from "./worktrees";

const record: ThreadWorktreeRecord = {
  threadId: "thread-1",
  projectId: "project-1",
  projectPath: "/project",
  path: "/worktrees/thread-1",
  branch: "openkiwi/thread-1",
  baseCommit: "abc123",
  gitDir: "/project/.git",
  createdAt: 1,
  status: "active",
};

describe("thread worktrees", () => {
  it("uses the isolated execution path while preserving the logical project path", () => {
    expect(executionPathForThread("thread-1", "/project", { "thread-1": record }))
      .toBe("/worktrees/thread-1");
    expect(record.projectPath).toBe("/project");
  });

  it("does not silently fall back to the shared project for removed or missing worktrees", () => {
    expect(executionPathForThread("thread-1", "/project", {
      "thread-1": { ...record, status: "removed" },
    })).toBe("/worktrees/thread-1");
    expect(executionPathForThread("thread-1", "/project", {
      "thread-1": { ...record, status: "missing" },
    })).toBe("/worktrees/thread-1");
  });
});
