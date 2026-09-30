import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachGitHubRemote,
  gitActionUnavailableReason,
  githubCliCommand,
  gitPushCompletionNote,
  gitPushCommand,
  normalizeGitHubRemoteUrl,
  parseGitHubCloneTarget,
} from "./github";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("GitHub remote connection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes pasted browser URLs before passing them to the native bridge", async () => {
    vi.mocked(invoke).mockResolvedValue({ isRepo: true, repository: "owner/repo" });
    await attachGitHubRemote("/project", "  http://github.com/owner/repo.git/?tab=readme#top  ");
    expect(invoke).toHaveBeenCalledWith("github_attach_remote", {
      cwd: "/project", url: "https://github.com/owner/repo.git",
    });
  });

  it.each([
    "https://github.com/owner/..", "https://github.com/owner/.",
    "https://github.com/ow ner/repo", "https://github.com/owner/repo%2Fother",
    "https://github.com/owner/repo\nother", "https://github.com/owner/repo?tab=readme\ninvalid",
    "https://github.com/owner/repo/tree/main", "https://github.com/owner/.git",
  ])("rejects malformed addresses without a native mutation: %s", async (url) => {
    expect(normalizeGitHubRemoteUrl(url)).toBeNull();
    await expect(attachGitHubRemote("/project", url)).rejects.toThrow(/GitHub repository URL/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps SSH addresses and allows existing repository names that cannot be Windows folders", () => {
    expect(normalizeGitHubRemoteUrl(" ssh://git@github.com/owner/repo.git/ "))
      .toBe("git@github.com:owner/repo.git");
    expect(normalizeGitHubRemoteUrl("https://github.com/owner/CON"))
      .toBe("https://github.com/owner/CON.git");
    expect(parseGitHubCloneTarget("https://github.com/owner/CON")).toBeNull();
  });

  it("preserves GitHub's official SSH over port 443 transport", async () => {
    const url = "ssh://git@ssh.github.com:443/owner/repo.git";
    expect(normalizeGitHubRemoteUrl(`${url}?tab=readme`)).toBe(url);
    expect(parseGitHubCloneTarget(url)).toEqual({ name: "repo", url });
    await attachGitHubRemote("/project", url);
    expect(invoke).toHaveBeenCalledWith("github_attach_remote", { cwd: "/project", url });
    expect(normalizeGitHubRemoteUrl("ssh://git@ssh.github.com:22/owner/repo.git")).toBeNull();
    expect(normalizeGitHubRemoteUrl("ssh://git@ssh.github.com:443.example.com/owner/repo.git")).toBeNull();
  });
});

describe("GitHub clone destinations", () => {
  it.each([
    "https://github.com/owner/repo", "https://github.com/owner/repo.git/",
    "http://github.com/owner/repo", "https://github.com/owner/repo?tab=readme#top",
  ])("derives a repository name and canonical HTTPS URL from %s", (url) => {
    expect(parseGitHubCloneTarget(url)).toEqual({ name: "repo", url: "https://github.com/owner/repo.git" });
  });
  it.each(["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"]) ("preserves SSH transport: %s", (url) => {
    expect(parseGitHubCloneTarget(url)).toEqual({ name: "repo", url: "git@github.com:owner/repo.git" });
  });
  it.each([
    "", "owner/repo", "https://gitlab.com/owner/repo", "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/..", "https://github.com/owner/repo.", "https://github.com/owner/CON",
    "https://github.com/owner/nul.txt", "https://github.com/owner/LPT1", "https://github.com/owner/a%2Fb",
    "https://github.com/owner/a\\b", "https://github.com/ow ner/repo", "https://github.com/owner/na:me",
    "https://github.com/owner/" + "a".repeat(101), "https://github.com/../repo",
  ])("rejects unsafe or non-repository input: %s", (url) => {
    expect(parseGitHubCloneTarget(url)).toBeNull();
  });
});

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
    expect(githubCliCommand("/opt/homebrew/bin/gh", "comments", undefined, "owner/repo"))
      .toEqual(["/opt/homebrew/bin/gh", "pr", "view", "--repo", "github.com/owner/repo", "--comments"]);
    expect(githubCliCommand("/opt/homebrew/bin/gh", "ci", undefined, "owner/repo"))
      .toEqual(["/opt/homebrew/bin/gh", "pr", "checks", "--repo", "github.com/owner/repo"]);
    expect(githubCliCommand("/opt/homebrew/bin/gh", "pr", undefined, "owner/repo"))
      .toEqual(["/opt/homebrew/bin/gh", "pr", "create", "--repo", "github.com/owner/repo", "--draft", "--fill"]);
  });

  it("targets attached PR comments even when the checkout is on another branch", () => {
    expect(githubCliCommand("gh", "comments", { repository: "upstream/project", number: 42 }))
      .toEqual(["gh", "pr", "view", "42", "--repo", "github.com/upstream/project", "--comments"]);
  });

  it("targets attached PR checks even when the checkout is on another branch", () => {
    expect(githubCliCommand("gh", "ci", { repository: "upstream/project", number: 42 }))
      .toEqual(["gh", "pr", "checks", "42", "--repo", "github.com/upstream/project"]);
  });

  it("refuses to infer an app-owned PR target from inherited CLI defaults", () => {
    for (const action of ["comments", "ci", "pr"] as const) {
      expect(() => githubCliCommand("gh", action)).toThrow(/Connect.*GitHub repository/);
      for (const repository of ["owner/repo/extra", "owner/repo?x=1", "--owner/repo", "owner/..", "enterprise.invalid/owner/repo"]) {
        expect(() => githubCliCommand("gh", action, undefined, repository)).toThrow(/valid GitHub repository/);
      }
    }
    expect(() => githubCliCommand("gh", "comments", { repository: "owner/repo", number: 0 })).toThrow(/valid pull request number/);
  });

  it("explains that push only sends committed changes", () => {
    expect(gitPushCompletionNote("")).toBe("Push succeeded. This branch's committed changes are on GitHub.");
    expect(gitPushCompletionNote(" M src/App.tsx\n?? src/new.ts\n"))
      .toBe("Push succeeded, but 2 uncommitted entries remain local. Stage and commit before pushing again.");
  });
});
