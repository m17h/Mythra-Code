import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { getProjectGitChanges, getProjectGitDiff, getProjectGitFileDiff, getProjectGitHistory } from "./gitInspection";

describe("native project Git inspection", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("reads project Review directly without a thread or runtime", async () => {
    mocks.invoke.mockResolvedValue({ text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false });
    const result = await getProjectGitDiff("/project");
    expect(result.source).toBe("repository");
    expect(mocks.invoke).toHaveBeenCalledWith("git_project_diff", { cwd: "/project" });
  });

  it("keeps selected filenames literal including pathspec magic and line breaks", async () => {
    const path = ":(glob) café\nfile.txt";
    await getProjectGitFileDiff("/project", path, "staged");
    expect(mocks.invoke).toHaveBeenCalledWith("git_project_file_diff", { cwd: "/project", path, area: "staged" });
  });

  it("requests bounded changes and pins subsequent history pages to an OID", async () => {
    await getProjectGitChanges("/project");
    await getProjectGitHistory("/project", 30, 30, "a".repeat(40));
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "git_project_changes", { cwd: "/project", limit: 500 });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "git_project_history", { cwd: "/project", offset: 30, limit: 30, headOid: "a".repeat(40) });
  });
});
