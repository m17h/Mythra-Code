import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { GitChangeArea, ProjectGitChanges } from "../lib/gitInspection";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import { GitPanel, type GitPanelProps } from "./GitPanel";

it("keeps a trusted-click preview fresh from the owner's status without a second status read", async () => {
  const rows: ProjectGitChanges = { rootPath: "/browser/shared-status", rows: [{ path: "current.ts", area: "unstaged", originalPath: null, status: "M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
  const workflow: GitWorkflowControls = {
    snapshot: { rootPath: rows.rootPath, branch: "topic", headOid: "a".repeat(40), branches: [], stagedFiles: 0, unstagedFiles: 1, changedFiles: 1, stagedPaths: [], changes: rows },
    readRevision: 1, busy: false, isolated: false, onBranch: vi.fn(), onRefresh: vi.fn(),
  };
  let content = "+original contents";
  const inspection = {
    cwd: rows.rootPath, getChanges: vi.fn(), getHistory: vi.fn(),
    getFileDiff: vi.fn(async (_cwd: string, path: string, area: GitChangeArea) => ({ path, area, text: content, binary: false, truncated: false })),
  };
  const input: GitPanelProps = {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: false, githubRepoStatus: null, readOnly: false, defaultRepositoryName: "project",
    onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
    inspection, workflow,
  };
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark"><div className="studio-panel" style={{ width: 500 }}><GitPanel {...input} /></div></div>);
  await page.getByRole("button", { name: "current.ts, Modified, not staged" }).click();
  await waitFor(() => expect(screen.getByRole("region", { name: "Diff preview for current.ts" })).toHaveTextContent("original contents"));
  expect(inspection.getChanges).not.toHaveBeenCalled();
  content = "+new contents with identical file counts";
  view.rerender(<div className="app-shell" data-theme="mythra" data-color-scheme="dark"><div className="studio-panel" style={{ width: 500 }}><GitPanel {...input} workflow={{ ...workflow, readRevision: 2 }} /></div></div>);
  await waitFor(() => expect(screen.getByRole("region", { name: "Diff preview for current.ts" })).toHaveTextContent("new contents with identical file counts"));
  await page.getByRole("button", { name: "Refresh changes" }).click();
  expect(workflow.onRefresh).toHaveBeenCalledOnce();
  expect(inspection.getFileDiff).toHaveBeenCalledTimes(2);
  expect(inspection.getChanges).not.toHaveBeenCalled();
});

it("reports unsupported filenames, removes cached file actions, and keeps branch controls usable", async () => {
  const rows: ProjectGitChanges = { rootPath: "/browser/unsupported-path", rows: [{ path: "previous.ts", area: "unstaged", originalPath: null, status: "M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
  const workflow: GitWorkflowControls = {
    snapshot: { rootPath: rows.rootPath, branch: "topic", headOid: "a".repeat(40), branches: [{ name: "main", current: false, worktreePath: null }], stagedFiles: 0, unstagedFiles: 1, changedFiles: 1, stagedPaths: [], changes: rows },
    readRevision: 1, busy: false, isolated: false, onBranch: vi.fn(), onRefresh: vi.fn(),
  };
  const inspection = { cwd: rows.rootPath, getChanges: vi.fn(), getFileDiff: vi.fn(), getHistory: vi.fn() };
  const input: GitPanelProps = {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: false, githubRepoStatus: null, readOnly: false, defaultRepositoryName: "project",
    onAction: vi.fn(), onPathAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
    inspection, workflow,
  };
  const shell = (controls: GitWorkflowControls) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark"><div className="studio-panel" style={{ width: 500 }}><GitPanel {...input} workflow={controls} /></div></div>;
  const view = render(shell(workflow));
  expect(await screen.findByRole("button", { name: "Stage previous.ts" })).toBeEnabled();
  const changesError = "A Git filename is not valid UTF-8 and cannot be selected safely";
  view.rerender(shell({ ...workflow, readRevision: 2, snapshot: { ...workflow.snapshot!, changes: null, changesError } }));
  expect(await screen.findByRole("alert")).toHaveTextContent(changesError);
  expect(screen.queryByRole("button", { name: "Stage previous.ts" })).not.toBeInTheDocument();
  expect(inspection.getChanges).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Try again" }).click();
  expect(workflow.onRefresh).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Switch or create a branch" }).click();
  await page.getByRole("menuitem", { name: /^main/ }).click();
  expect(workflow.onBranch).toHaveBeenCalledWith("main", false);
  expect(inspection.getChanges).not.toHaveBeenCalled();
});
