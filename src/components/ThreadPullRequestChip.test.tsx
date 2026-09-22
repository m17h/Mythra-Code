import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadPullRequestChip } from "./ThreadPullRequestChip";
import type { PullRequest } from "../lib/pullRequests";

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: "m17h/Mythra-Code",
    number: 123,
    url: "https://github.com/m17h/Mythra-Code/pull/123",
    title: "Thread pull request workflow",
    body: "",
    state: "OPEN",
    isDraft: false,
    headRefName: "codex/pr-workflow",
    baseRefName: "main",
    headOid: "abc1234",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    checks: [],
    updatedAt: "2026-09-22T10:00:00Z",
    canMerge: true,
    mergeMethods: ["squash"],
    ...overrides,
  };
}

describe("ThreadPullRequestChip", () => {
  it("shows the number and describes the pull request for screen readers", () => {
    render(<ThreadPullRequestChip repository="m17h/Mythra-Code" pullRequest={pullRequest()} linked onClick={vi.fn()} />);

    const chip = screen.getByRole("button");
    expect(chip).toHaveTextContent("#123");
    // The header has no room for the title, so it lives in the description.
    expect(chip).toHaveAccessibleName("Open pull request m17h/Mythra-Code #123: Thread pull request workflow. Open the pull request panel.");
    expect(chip).toHaveAttribute("title", expect.stringContaining("Thread pull request workflow"));
  });

  it("marks a discovered pull request as not yet attached", () => {
    render(<ThreadPullRequestChip repository="m17h/Mythra-Code" pullRequest={pullRequest()} linked={false} onClick={vi.fn()} />);

    const chip = screen.getByRole("button");
    expect(chip).toHaveAttribute("data-linked", "false");
    expect(chip.className).toContain("candidate");
    expect(chip).toHaveAccessibleName(/was found for this branch\. Open the panel to attach it/i);
  });

  it("reads each state back in GitHub's own words", () => {
    const cases: [Partial<PullRequest>, string][] = [
      [{ isDraft: true }, "Draft"],
      [{ state: "MERGED" }, "Merged"],
      [{ state: "CLOSED" }, "Closed"],
      [{}, "Open"],
    ];
    for (const [overrides, label] of cases) {
      const { unmount } = render(<ThreadPullRequestChip pullRequest={pullRequest(overrides)} linked onClick={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAccessibleName(new RegExp(`^${label} pull request`));
      unmount();
    }
  });

  it("still offers a way in when no pull request exists yet", () => {
    const onClick = vi.fn();
    render(<ThreadPullRequestChip repository="m17h/Mythra-Code" pullRequest={null} linked={false} onClick={onClick} />);

    const chip = screen.getByRole("button", { name: /no pull request is linked to this thread yet/i });
    expect(chip).toHaveTextContent("GitHub");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });

  it("copes with a thread that has no repository at all", () => {
    render(<ThreadPullRequestChip pullRequest={null} linked={false} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Pull requests. No pull request is linked to this thread yet.");
  });
});
