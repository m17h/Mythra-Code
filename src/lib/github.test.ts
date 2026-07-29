import { describe, expect, it } from "vitest";
import {
  gitActionUnavailableReason,
  githubCliCommand,
  gitPushCommand,
} from "./github";

describe("GitHub workspace commands", () => {
  it("allows inspection but blocks mutations and network actions in read-only mode", () => {
    expect(gitActionUnavailableReason("status", "read-only")).toBeNull();
    expect(gitActionUnavailableReason("diff", "read-only")).toBeNull();
    expect(gitActionUnavailableReason("commitPush", "read-only")).toMatch(/Switch this thread/);
    expect(gitActionUnavailableReason("comments", "read-only")).toMatch(/contacting GitHub/);
    expect(gitActionUnavailableReason("push", "ask")).toBeNull();
  });

  it("requires a named branch and establishes an upstream only once", () => {
    expect(gitPushCommand(null)).toBeNull();
    expect(gitPushCommand({ isRepo: true, repository: "owner/repo", branch: null, upstream: null, ahead: 0, behind: 0 })).toBeNull();
    expect(gitPushCommand({ isRepo: true, repository: "owner/repo", branch: "feature", upstream: null, ahead: 1, behind: 0 }))
      .toEqual(["git", "push", "--set-upstream", "origin", "feature"]);
    expect(gitPushCommand({ isRepo: true, repository: "owner/repo", branch: "feature", upstream: "origin/feature", ahead: 1, behind: 0 }))
      .toEqual(["git", "push"]);
  });

  it("uses the resolved GitHub CLI path for PR actions", () => {
    expect(githubCliCommand("/opt/homebrew/bin/gh", "comments"))
      .toEqual(["/opt/homebrew/bin/gh", "pr", "view", "--comments"]);
    expect(githubCliCommand("/opt/homebrew/bin/gh", "pr"))
      .toEqual(["/opt/homebrew/bin/gh", "pr", "create", "--draft", "--fill"]);
  });
});
