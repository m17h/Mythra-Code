import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { getGitPublishSnapshot, publishGitCommit, type GitPublishBinding } from "./gitPublishing";

describe("automatic Git publication bridge", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("requests the native all-branch snapshot", async () => {
    mocks.invoke.mockResolvedValue({ binding: {}, branches: [] });
    await getGitPublishSnapshot("/project");
    expect(mocks.invoke).toHaveBeenCalledWith("git_publish_snapshot", { cwd: "/project" });
  });

  it("passes the pinned binding and immutable ancestry floor without translating them", async () => {
    const binding: GitPublishBinding = {
      repository: "owner/repo", remote: "origin", remoteUrl: "git@github.com:owner/repo.git", commonDir: "/project/.git",
    };
    mocks.invoke.mockResolvedValue({ publishedOid: "b".repeat(40) });
    await publishGitCommit("/project", binding, "topic", "b".repeat(40), "topic", "a".repeat(40), "a".repeat(40));
    expect(mocks.invoke).toHaveBeenCalledWith("git_publish_commit", {
      cwd: "/project", binding, branch: "topic", headOid: "b".repeat(40), remoteBranch: "topic", lastPublishedOid: "a".repeat(40), expectedRemoteOid: "a".repeat(40),
    });
  });
});
