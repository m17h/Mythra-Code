import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { previewGitWorkspaceRevertAll, revertGitWorkspaceAll } from "./gitWorkspace";

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
