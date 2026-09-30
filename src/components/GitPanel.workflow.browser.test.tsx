import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import { THEMES, themeColorScheme } from "../lib/appConfig";
import "../styles.css";

const controls = (): GitWorkflowControls => ({
  snapshot: {
    branch: "feature/local-workflow", headOid: "a".repeat(40), rootPath: "/project",
    stagedFiles: 2, unstagedFiles: 1, changedFiles: 3, stagedPaths: ["a.ts", "b.ts"],
    branches: Array.from({ length: 18 }, (_, i) => ({ name: `feature/branch-${i}`, current: false, worktreePath: null })),
  },
  busy: false, isolated: false,
  onBranch: vi.fn().mockResolvedValue(true), onRefresh: vi.fn(),
});
function props(workflow: GitWorkflowControls, connected = false): GitPanelProps {
  return {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: connected, readOnly: false, defaultRepositoryName: "Mythra-Code",
    githubRepoStatus: connected ? { isRepo: true, repository: "m17h/Mythra-Code", branch: "feature/local-workflow", upstream: "origin/feature/local-workflow", ahead: 2, behind: 0 } : null,
    workflow, onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
  };
}
function mount(input: GitPanelProps, width: number, scheme = "dark", theme = "mythra", zoom = 1) {
  return render(<div className="app-shell" data-color-scheme={scheme} data-theme={theme} style={{ display: "block", padding: 16, zoom }}>
    <aside className="studio-dock" style={{ width, height: 850 }}>
      <nav className="studio-tabs" aria-label="Workspace tools"><button className="active" type="button">Git</button></nav>
      <div className="studio-panel"><GitPanel {...input} /></div>
    </aside>
  </div>);
}

it("submits an existing remote from the URL field with Enter and preserves it after failure", async () => {
  const input = props(controls());
  input.githubAuthenticated = true;
  const view = mount(input, 360);
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  await page.getByRole("textbox", { name: "Existing repository URL" }).fill("https://github.com/m17h/remote.git");
  await userEvent.keyboard("{Enter}");
  expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/remote.git");
  expect(screen.getByLabelText("Existing repository URL")).toHaveValue("https://github.com/m17h/remote.git");
  await page.screenshot({ path: "../../test-results/pr-screenshots/git-publish-narrow.png" });
  const row = view.container.querySelector(".github-create-row")!.getBoundingClientRect();
  const name = screen.getByRole("textbox", { name: "New GitHub repository name" }).getBoundingClientRect();
  expect(name.width).toBeGreaterThan(row.width * .75);
});

it("keeps the GitHub synchronization summary and counts readable beside a very long branch", async () => {
  const workflow = controls();
  const longBranch = "feature/an-extremely-long-branch-name-that-would-otherwise-hide-its-sync-counts";
  workflow.snapshot = { ...workflow.snapshot!, branch: longBranch };
  const input = props(workflow, true);
  input.githubRepoStatus = { ...input.githubRepoStatus!, branch: longBranch, upstream: `origin/${longBranch}`, ahead: 12, behind: 3 };
  const view = mount(input, 360);
  const summary = view.container.querySelector<HTMLElement>(".git-sync-line")!;
  await page.screenshot({ path: "../../test-results/pr-screenshots/git-connected-narrow.png" });
  expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
  const header = view.container.querySelector<HTMLElement>(".git-checkout")!.getBoundingClientRect();
  for (const label of ["12 to push", "3 to pull"]) {
    const count = screen.getByLabelText(label).getBoundingClientRect();
    expect(count.width).toBeGreaterThan(0);
    expect(count.right).toBeLessThanOrEqual(header.right + 1);
  }
  const trigger = screen.getByRole("button", { name: "Switch or create a branch" });
  expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(screen.getByLabelText("12 to push").getBoundingClientRect().left);
});

it("attaches an existing repository while signed out and offers account connection for creation", async () => {
  const input = props(controls());
  mount(input, 360);
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  await page.getByRole("textbox", { name: "Existing repository URL" }).fill("https://github.com/m17h/existing.git");
  await userEvent.keyboard("{Enter}");
  expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/existing.git");
  expect(screen.queryByRole("textbox", { name: "New GitHub repository name" })).toBeNull();
  await page.getByRole("button", { name: "Connect GitHub account" }).click();
  expect(input.onOpenGitHubSettings).toHaveBeenCalledOnce();
});

it("keeps a later commit draft while the submitted commit finishes", async () => {
  const input = props(controls());
  const view = mount(input, 360);
  await page.getByRole("textbox", { name: /Commit message/ }).fill("Staged change");
  await userEvent.keyboard("{Enter}");
  expect(input.onAction).toHaveBeenCalledWith("commitStaged", "Staged change");
  // Preserve the same shell while changing only the owner's operation state.
  const rerender = (next: GitPanelProps) => view.rerender(<div className="app-shell" data-color-scheme="dark" data-theme="mythra" style={{ display: "block", padding: 16 }}><aside className="studio-dock" style={{ width: 360, height: 850 }}><nav className="studio-tabs"><button className="active" type="button">Git</button></nav><div className="studio-panel"><GitPanel {...next} /></div></aside></div>);
  rerender({ ...input, gitCommitBusy: true });
  expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
  await page.getByRole("textbox", { name: /Commit message/ }).fill("Next staged change");
  rerender({ ...input, gitCommitSuccess: "Staged change was saved." });
  expect(screen.getByLabelText(/Commit message/)).toHaveValue("Next staged change");
});

it.each(THEMES)("supports creation and visibility at 150% in the narrow $name dock", async ({ id }) => {
  const input = props(controls());
  input.githubAuthenticated = true;
  const view = mount(input, 360, themeColorScheme(id), id, 1.5);
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  await page.getByRole("textbox", { name: "New GitHub repository name" }).fill("a-readable-repository-name");
  await userEvent.keyboard("{Enter}");
  expect(input.onGitHubCreate).toHaveBeenCalledWith("a-readable-repository-name", "private");
  await page.getByRole("button", { name: "Repository visibility" }).click();
  const menu = screen.getByRole("menu", { name: "Repository visibility choices" }).getBoundingClientRect();
  expect(menu.top).toBeGreaterThanOrEqual(0);
  expect(menu.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  await page.getByRole("menuitemradio", { name: "Public" }).click();
  await page.getByRole("textbox", { name: "New GitHub repository name" }).click();
  await userEvent.keyboard("{Enter}");
  expect(input.onGitHubCreate).toHaveBeenLastCalledWith("a-readable-repository-name", "public");
  const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  if (id === "atari" || id === "monochrome") await page.screenshot({ path: `../../test-results/pr-screenshots/git-publish-${id}-150.png` });
});

for (const width of [360, 520]) {
  it(`supports an offline branch and staged commit at ${width}px`, async () => {
    const workflow = controls();
    const input = props(workflow);
    const view = mount(input, width);
    await page.getByRole("button", { name: "Switch or create a branch" }).click();
    const menu = screen.getByRole("menu", { name: "Switch or create a branch" }).getBoundingClientRect();
    const bounds = view.container.querySelector(".studio-dock")!.getBoundingClientRect();
    expect(menu.left).toBeGreaterThanOrEqual(bounds.left);
    expect(menu.right).toBeLessThanOrEqual(bounds.right + 1);
    const last = screen.getByRole("menuitem", { name: /^feature\/branch-17/ });
    last.scrollIntoView({ block: "nearest" });
    await page.getByRole("menuitem", { name: /^feature\/branch-17/ }).click();
    expect(workflow.onBranch).toHaveBeenCalledWith("feature/branch-17", false);
    await page.getByRole("button", { name: "Switch or create a branch" }).click();
    await page.getByRole("menuitem", { name: /New branch/ }).click();
    fireEvent.change(screen.getByRole("textbox", { name: "New branch name" }), { target: { value: "feature/new-local" } });
    await page.getByRole("button", { name: /Create branch/ }).click();
    await waitFor(() => expect(workflow.onBranch).toHaveBeenCalledWith("feature/new-local", true));
    fireEvent.change(screen.getByLabelText(/Commit message/), { target: { value: "Just these files" } });
    await page.getByRole("button", { name: "Commit staged (2)" }).click();
    expect(input.onAction).toHaveBeenCalledWith("commitStaged", "Just these files");
    expect(screen.queryByRole("button", { name: /Push commits/ })).toBeNull();
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await page.screenshot({ path: `../../test-results/pr-screenshots/workflow-local-${width}.png` });
  });
}

describe("connected project publishing", () => {
  it("fits the complete opt-in scope and waiting recovery in the narrow light dock", async () => {
    const workflow = controls();
    workflow.autoPublish = {
      enabled: true, status: "waiting", message: "Waiting for GitHub. Your commits are saved locally.", repository: "m17h/Mythra-Code",
      onToggle: vi.fn(), onRetry: vi.fn(),
    };
    const view = mount(props(workflow, true), 360, "light");
    const toggle = screen.getByRole("switch", { name: /Automatically publish/ });
    expect(toggle).toBeChecked();
    await page.getByRole("button", { name: "Retry" }).click();
    expect(workflow.autoPublish.onRetry).toHaveBeenCalledOnce();
    await page.getByRole("switch", { name: /Automatically publish/ }).click();
    expect(workflow.autoPublish.onToggle).toHaveBeenCalledWith(false);
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await page.screenshot({ path: "../../test-results/pr-screenshots/workflow-publishing-light.png" });
  });
});
