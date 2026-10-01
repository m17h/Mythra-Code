import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import { themeColorScheme } from "../lib/appConfig";
import "../styles.css";

function props(changedFiles: number, ahead: number): GitPanelProps {
  return {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: true, readOnly: false, defaultRepositoryName: "repo",
    githubRepoStatus: { isRepo: true, repository: "owner/repo", branch: "feature/test", upstream: "origin/feature/test", ahead, behind: 0 },
    workflow: {
      snapshot: {
        branch: "feature/test", headOid: "a".repeat(40), rootPath: "/test", isRoot: true,
        upstream: "origin/feature/test", upstreamRemote: "origin", ahead, behind: 0,
        branches: [], changedFiles, stagedFiles: 0, unstagedFiles: changedFiles, stagedPaths: [],
      },
      busy: false, isolated: false, onBranch: vi.fn(), onRefresh: vi.fn(),
    },
    onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
  };
}

function shell(input: GitPanelProps, theme: "mythra" | "light-mythra") {
  return <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", padding: 16 }}>
    <aside className="studio-dock" style={{ width: 360, height: 860 }}>
      <nav className="studio-tabs" aria-label="Workspace tools"><button className="active" type="button">Git</button></nav>
      <div className="studio-panel"><GitPanel {...input} /></div>
    </aside>
  </div>;
}

it.each(["mythra", "light-mythra"] as const)("shows actionable commit / push / synchronized states in %s without narrow-dock overflow", async (theme) => {
  const input = props(1, 0);
  const view = render(shell(input, theme));
  await expect.element(page.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  await page.getByRole("textbox", { name: /Commit message/ }).fill("Keep this next draft");
  view.rerender(shell({ ...input, workflow: props(0, 1).workflow, githubRepoStatus: props(0, 1).githubRepoStatus }, theme));
  await expect.element(page.getByRole("button", { name: /^Nothing to commit$/ })).toBeDisabled();
  await page.getByRole("button", { name: /^Push$/ }).click();
  expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
  expect(screen.getByRole("textbox", { name: /Commit message/ })).toHaveValue("Keep this next draft");
  view.rerender(shell({ ...input, workflow: props(0, 0).workflow, githubRepoStatus: props(0, 0).githubRepoStatus }, theme));
  await expect.element(page.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
  const commit = screen.getByRole("button", { name: /^Nothing to commit$/ });
  const push = screen.getByRole("button", { name: "Nothing to commit and push" });
  await waitFor(() => expect(getComputedStyle(commit).color).toBe(getComputedStyle(push).color));
  const dock = view.container.querySelector(".studio-dock")!.getBoundingClientRect();
  const panel = view.container.querySelector(".studio-panel")!.getBoundingClientRect();
  expect(panel.width).toBeGreaterThan(250);
  for (const button of [commit, push]) {
    expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(dock.right + 1);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  }
  await page.screenshot({ path: `../../test-results/pr-screenshots/git-commit-synced-${theme}.png` });
});

it("disables Push after a custom-mapped origin upstream becomes synchronized", async () => {
  const input = props(0, 1);
  const customWorkflow = (ahead: number) => {
    const workflow = props(0, ahead).workflow!;
    return { ...workflow, snapshot: { ...workflow.snapshot!, upstream: "custom-origin/main" } };
  };
  const view = render(shell({ ...input, workflow: customWorkflow(1) }, "mythra"));
  await page.getByRole("button", { name: /^Push$/ }).click();
  expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
  // The native refreshed snapshot is authoritative even if an older GitHub
  // status read still reports one commit ahead.
  view.rerender(shell({ ...input, workflow: customWorkflow(0) }, "mythra"));
  await expect.element(page.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: /^Nothing to commit$/ })).toBeDisabled();
});
