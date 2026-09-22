import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
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
function mount(input: GitPanelProps, width: number, scheme = "dark") {
  return render(<div className="app-shell" data-color-scheme={scheme} data-theme="mythra" style={{ display: "block", padding: 16 }}>
    <aside className="studio-dock" style={{ width, height: 850 }}>
      <nav className="studio-tabs" aria-label="Workspace tools"><button className="active" type="button">Git</button></nav>
      <div className="studio-panel"><GitPanel {...input} /></div>
    </aside>
  </div>);
}

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
