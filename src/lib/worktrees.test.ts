import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { executionPathForThread, removeThreadWorktree, type ThreadWorktreeRecord } from "./worktrees";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

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

  it("preserves completed removal and retained-branch details from the native result", async () => {
    const result = {
      folderRemoved: true,
      branchDeleted: false,
      retainedBranch: "mythra/isolated",
      retainedBranchOid: "a".repeat(40),
      branchDeleteError: "The branch is not fully merged into its upstream.",
    };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(removeThreadWorktree("thread-1", "/project", "/worktrees/thread-1", "mythra/isolated", false, true))
      .resolves.toEqual(result);
  });

  it("passes the recorded retained tip for an explicit safe cleanup retry", async () => {
    const oid = "b".repeat(40);
    vi.mocked(invoke).mockResolvedValue({ folderRemoved: true, branchDeleted: true, retainedBranch: null, retainedBranchOid: null, branchDeleteError: null });
    await removeThreadWorktree("thread-1", "/project", "/worktrees/thread-1", "mythra/isolated", false, true, oid);
    expect(invoke).toHaveBeenCalledWith("worktree_remove", {
      threadId: "thread-1", projectPath: "/project", worktreePath: "/worktrees/thread-1", branch: "mythra/isolated", force: false, deleteBranch: true, expectedRetainedBranchOid: oid,
    });
  });

  it("keeps failures before folder removal rejected", async () => {
    vi.mocked(invoke).mockRejectedValue("The isolated worktree contains uncommitted files");
    await expect(removeThreadWorktree("thread-1", "/project", "/worktrees/thread-1", "mythra/isolated", false, true))
      .rejects.toBe("The isolated worktree contains uncommitted files");
  });
});
