import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { previewGitWorkspaceRevertAll, revertGitWorkspaceAll, pullGitWorkspace } from "./gitWorkspace";

describe("native bulk Git revert", () => {
  beforeEach(() => { mocks.invoke.mockReset(); });

  it("previews exact restored and preserved paths without executing a restore", async () => {
    const preview = { token: "frozen-token", restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" };
    mocks.invoke.mockResolvedValue(preview);
    expect(await previewGitWorkspaceRevertAll("/project")).toEqual(preview);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("git_workspace_revert_all_preview", { cwd: "/project" });
  });

  it("executes only the originating checkout's frozen native confirmation", async () => {
    mocks.invoke.mockResolvedValue({ stdout: "", stderr: "" });
    await revertGitWorkspaceAll("C:\\project", "exact-token");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("git_workspace_revert_all", { cwd: "C:\\project", expectedToken: "exact-token" });
  });

  it("does not fall back to destructive shell commands after a stale refusal", async () => {
    const failure = new Error("Files changed during confirmation. Nothing was reverted.");
    mocks.invoke.mockRejectedValue(failure);
    await expect(revertGitWorkspaceAll("/project", "stale-token")).rejects.toBe(failure);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("native guarded Git Pull", () => {
  beforeEach(() => { mocks.invoke.mockReset(); });

  it("passes the originating checkout and visible destination to a single native transaction", async () => {
    mocks.invoke.mockResolvedValue({ stdout: "Already up to date.", stderr: "" });
    await pullGitWorkspace("C:\\project", "a".repeat(40), "feature/work", "https://github.com/owner/repo.git", "owner/repo");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("git_workspace_pull", {
      cwd: "C:\\project", expectedHeadOid: "a".repeat(40), expectedBranch: "feature/work",
      expectedRemoteUrl: "https://github.com/owner/repo.git", expectedRepository: "owner/repo",
    });
  });

  it("preserves a native safety refusal without falling back to git pull", async () => {
    const refusal = new Error("Ignored files would be overwritten. Files were kept.");
    mocks.invoke.mockRejectedValue(refusal);
    await expect(pullGitWorkspace("/project", "a".repeat(40), "main", "https://github.com/owner/repo.git", "owner/repo")).rejects.toBe(refusal);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
