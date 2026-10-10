import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import type { GitChangeArea } from "../lib/gitInspection";

function panelProps(overrides: Partial<GitPanelProps> = {}): GitPanelProps {
  return {
    repositoryState: "ready",
    gitInitializing: false,
    gitOutput: "",
    gitCommitSuccess: "",
    gitCommitBusy: false,
    githubAuthenticated: false,
    githubRepoStatus: null,
    readOnly: false,
    defaultRepositoryName: "project",
    onAction: vi.fn(),
    onInitializeGit: vi.fn(),
    onGitHubAttach: vi.fn(),
    onGitHubCreate: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

const attached = {
  isRepo: true,
  repository: "m17h/Mythra-Code",
  branch: "feature/ui-polish",
  upstream: "origin/feature/ui-polish",
  ahead: 2,
  behind: 1,
};

/** A workspace snapshot shaped like the one `src/lib/gitWorkspace.ts` returns. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    branch: "feature/ui-polish",
    headOid: "abc123",
    branches: [
      { name: "feature/ui-polish", current: true, worktreePath: null },
      { name: "main", current: false, worktreePath: null },
      { name: "mythra/held", current: false, worktreePath: "/worktrees/held" },
    ],
    stagedFiles: 0,
    unstagedFiles: 3,
    changedFiles: 3,
    stagedPaths: [],
    rootPath: "/project",
    isRoot: true,
    ...overrides,
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: snapshot(),
    busy: false,
    isolated: false,
    onBranch: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn(),
    ...overrides,
  } as unknown as NonNullable<GitPanelProps["workflow"]>;
}

describe("GitPanel commit controls", () => {
  it("shows an authoritative filename error without rescanning or disabling branch controls", async () => {
    const changesError = "A Git filename is not valid UTF-8 and cannot be selected safely";
    const inspection = { cwd: "/unsupported-path", getChanges: vi.fn(), getFileDiff: vi.fn(), getHistory: vi.fn() };
    const controls = workflow({ snapshot: snapshot({ rootPath: inspection.cwd, changes: null, changesError }) });
    render(<GitPanel {...panelProps({ inspection, workflow: controls, onPathAction: vi.fn() })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(changesError);
    expect(inspection.getChanges).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Stage .+\./ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch or create a branch" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    expect(screen.getByRole("menuitem", { name: /^main/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /^main/ }));
    expect(controls.onBranch).toHaveBeenCalledWith("main", false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(controls.onRefresh).toHaveBeenCalledOnce();
    expect(inspection.getChanges).not.toHaveBeenCalled();
  });

  it("reuses workspace status while refreshing a same-count selected diff", async () => {
    const changes = { rootPath: "/shared-status", rows: [{ path: "pending.ts", originalPath: null, area: "unstaged" as const, status: "M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
    let content = "+first contents";
    const inspection = {
      cwd: changes.rootPath,
      getChanges: vi.fn().mockResolvedValue(changes),
      getFileDiff: vi.fn(async (_cwd: string, path: string, area: GitChangeArea) => ({ path, area, text: content, binary: false, truncated: false })),
      getHistory: vi.fn(),
    };
    const input = panelProps({ inspection, workflow: workflow({ readRevision: 1, snapshot: snapshot({ rootPath: changes.rootPath, changes, changedFiles: 1, unstagedFiles: 1 }) }) });
    const view = render(<GitPanel {...input} />);
    await vi.waitFor(() => expect(screen.getAllByText("pending.ts").length).toBeGreaterThan(0));
    expect(inspection.getChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /pending.ts.*not staged/i }));
    await vi.waitFor(() => expect(inspection.getFileDiff).toHaveBeenCalledTimes(1));
    content = "+edited contents";
    view.rerender(<GitPanel {...input} workflow={workflow({ readRevision: 2, snapshot: snapshot({ rootPath: changes.rootPath, changes, changedFiles: 1, unstagedFiles: 1 }) })} />);
    await vi.waitFor(() => expect(inspection.getFileDiff).toHaveBeenCalledTimes(2));
    expect(inspection.getChanges).not.toHaveBeenCalled();
  });

  it("changes the primary actions from dirty to committed ahead to fully synced", () => {
    const input = panelProps({ githubRepoStatus: { ...attached, ahead: 0, behind: 0 }, workflow: workflow() });
    const view = render(<GitPanel {...input} />);
    const message = screen.getByLabelText(/Commit message/i);
    fireEvent.change(message, { target: { value: "Save the current edits" } });
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    expect(input.onAction).toHaveBeenLastCalledWith("commitPush", "Save the current edits");

    const clean = workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) });
    view.rerender(<GitPanel {...input} workflow={clean} githubRepoStatus={{ ...attached, ahead: 1, behind: 0 }} gitCommitSuccess="Saved the current edits." />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    expect(message).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Commit & push" })).not.toBeInTheDocument();
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toBeEnabled();
    fireEvent.click(push);
    expect(input.onAction).toHaveBeenLastCalledWith("push");

    view.rerender(<GitPanel {...input} workflow={clean} githubRepoStatus={{ ...attached, ahead: 0, behind: 0 }} gitCommitSuccess="Saved the current edits." />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    const synced = screen.getByRole("button", { name: "Nothing to commit and push" });
    expect(synced).toBeDisabled();
    const count = vi.mocked(input.onAction).mock.calls.length;
    fireEvent.click(synced);
    fireEvent.submit(synced.closest("form")!);
    expect(input.onAction).toHaveBeenCalledTimes(count);
  });

  it("blocks local clean form submissions while keeping a new commit draft", () => {
    const input = panelProps({ workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }) });
    render(<GitPanel {...input} />);
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Next edit's message" } });
    const clean = screen.getByRole("button", { name: "Nothing to commit" });
    expect(clean).toBeDisabled();
    expect(clean).toHaveAttribute("title", expect.stringMatching(/nothing|no.*changes|clean/i));
    fireEvent.submit(clean.closest("form")!);
    expect(input.onAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Next edit's message");
  });

  it("pushes existing commits without consuming the next commit message", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: attached,
      gitCommitSuccess: "An earlier commit was saved.",
      gitCommitSuccessRevision: 2,
    });
    const view = render(<GitPanel {...input} />);
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Keep for the next commit" } });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
    view.rerender(<GitPanel {...input} gitOperationBusy />);
    view.rerender(<GitPanel {...input} gitCommitSuccess="Push completed." gitCommitSuccessRevision={3} githubRepoStatus={{ ...attached, ahead: 0, behind: 0 }} />);
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Keep for the next commit");
    expect(screen.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
  });

  it("keeps Push available for a clean named branch without an upstream", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: { ...attached, upstream: undefined, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toBeEnabled();
    fireEvent.click(push);
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
  });

  it("does not mistake remote commits left to pull for local commits to push", () => {
    render(<GitPanel {...panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 2 },
    })} />);
    expect(screen.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  });

  it.each([
    { readOnly: true },
    { gitCommitBusy: true },
    { gitOperationBusy: true },
    { githubBusy: true },
    { gitInitializing: true },
    { workflow: workflow({ busy: true, snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }) },
  ])("guards the clean push-only action while mutations are unavailable: %j", (overrides) => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: attached,
      ...overrides,
    });
    render(<GitPanel {...input} />);
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toBeDisabled();
    fireEvent.click(push);
    fireEvent.submit(push.closest("form")!);
    expect(input.onAction).not.toHaveBeenCalled();
  });

  it("preserves mutation guards when a clean checkout cannot push its branch", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ branch: null, stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: attached,
    });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute("title", expect.stringMatching(/named branch/i));
    fireEvent.click(push);
    expect(input.onAction).not.toHaveBeenCalled();
  });

  it.each([
    { workflow: undefined },
    { workflow: workflow({ snapshot: null }) },
    { repositoryState: "unknown" as const, workflow: undefined },
  ])("does not present unknown local change counts as a clean checkout: %j", (overrides) => {
    const input = panelProps({ githubRepoStatus: { ...attached, ahead: 0, behind: 0 }, ...overrides });
    render(<GitPanel {...input} />);
    expect(screen.queryByRole("button", { name: /^Nothing to commit/ })).not.toBeInTheDocument();
    const commit = screen.getByRole("button", { name: "Commit all changes locally" });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("commit", "");
  });

  it.each([
    { localAhead: 0, githubAhead: 2, label: "Nothing to commit and push", disabled: true },
    { localAhead: 1, githubAhead: 0, label: "Push", disabled: false },
  ])("uses fresh checkout tracking counts instead of an earlier GitHub probe: %j", ({ localAhead, githubAhead, label, disabled }) => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, ahead: localAhead, behind: 0 }) }),
      githubRepoStatus: { ...attached, ahead: githubAhead, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.getByText(/Compared with origin:/)).toHaveTextContent(`${localAhead} to push, 0 to pull`);
    expect(screen.getByLabelText(`${localAhead} to push`)).toBeInTheDocument();
    expect(screen.queryByLabelText("2 to push")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push commits" })).toHaveTextContent(localAhead > 0 ? /^Push1$/ : /^Push$/);
    const action = screen.getByRole("button", { name: label });
    if (disabled) expect(action).toBeDisabled();
    else {
      expect(action).toBeEnabled();
      fireEvent.click(action);
      expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
    }
  });

  it("does not apply an earlier branch's synced GitHub counts to the current branch", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ branch: "feature/new-branch", stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.queryByRole("button", { name: "Nothing to commit and push" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
  });

  it("keeps unknown native tracking counts distinct from zero", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, ahead: null, behind: null }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.queryByRole("button", { name: "Nothing to commit and push" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
  });

  it("keeps a clean synced checkout settled after an unrelated Git operation fails", () => {
    const input = panelProps({
      workflow: workflow({
        snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, upstreamRemote: "origin", ahead: 0, behind: 0 }),
        error: "Fetch failed", readError: "",
      }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Fetch failed");
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Commit all changes locally" })).not.toBeInTheDocument();
  });

  it("keeps commit actions available when the snapshot's status read failed", () => {
    const input = panelProps({
      workflow: workflow({
        snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, upstreamRemote: "origin", ahead: 0, behind: 0 }),
        error: "Status failed", readError: "Status failed",
      }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.queryByRole("button", { name: /^Nothing to commit/ })).not.toBeInTheDocument();
    const commit = screen.getByRole("button", { name: "Commit all changes locally" });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("commit", "");
  });

  it("does not treat a local upstream named like an origin branch as proof the remote is synced", () => {
    const input = panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: "origin/local-baseline", upstreamRemote: ".", ahead: 0, behind: 0 }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Nothing to commit and push" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
  });

  it("uses a differently named tracked origin branch as the configured push baseline", () => {
    render(<GitPanel {...panelProps({
      workflow: workflow({ snapshot: snapshot({ stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: "origin/release/next", upstreamRemote: "origin", ahead: 0, behind: 0 }) }),
      githubRepoStatus: attached,
    })} />);
    expect(screen.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByText(/Compared with origin\/release\/next:/)).toHaveTextContent("0 to push, 0 to pull");
  });

  it.each(["unstaged", "staged"] as const)("settles commit availability from the fresh snapshot while the older %s Changes list refreshes", async (area) => {
    const stagedFiles = area === "staged" ? 1 : 0;
    const unstagedFiles = area === "unstaged" ? 1 : 0;
    const dirtyChanges = {
      rootPath: `/project/git-button-refresh-${area}`, rows: [{ path: "pending.ts", originalPath: null, area, status: "M" }],
      stagedFiles, unstagedFiles, untrackedFiles: 0, changedFiles: 1, truncated: false,
    };
    let finishRefresh!: (changes: typeof dirtyChanges) => void;
    const inspection = {
      cwd: dirtyChanges.rootPath,
      getChanges: vi.fn().mockResolvedValueOnce(dirtyChanges).mockImplementation(() => new Promise<typeof dirtyChanges>((resolve) => { finishRefresh = resolve; })),
      getFileDiff: vi.fn(),
      getHistory: vi.fn(),
    };
    const input = panelProps({
      inspection,
      workflow: workflow({ snapshot: snapshot({ stagedFiles, unstagedFiles, changedFiles: 1 }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    const view = render(<GitPanel {...input} />);
    await vi.waitFor(() => expect(screen.getAllByText("pending.ts").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: area === "staged" ? "Commit staged (1)" : "Commit all changes locally" })).toBeEnabled();
    view.rerender(<GitPanel {...input} workflow={workflow({ snapshot: snapshot({ headOid: "next-commit", stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, ahead: 1, behind: 0 }) })} />);
    await vi.waitFor(() => expect(inspection.getChanges).toHaveBeenCalledTimes(2));
    try {
      expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
    } finally {
      finishRefresh({ ...dirtyChanges, rows: [], stagedFiles: 0, unstagedFiles: 0, changedFiles: 0 });
      await vi.waitFor(() => expect(screen.queryAllByText("pending.ts")).toHaveLength(0));
    }
  });

  it("keeps the clean snapshot authoritative when an earlier dirty Changes request finishes late", async () => {
    const dirtyChanges = {
      rootPath: "/project/git-button-late-dirty-response",
      rows: [{ path: "earlier-edit.ts", originalPath: null, area: "unstaged" as const, status: "M" }],
      stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false,
    };
    let finishInitial!: (changes: typeof dirtyChanges) => void;
    let finishFresh!: (changes: typeof dirtyChanges) => void;
    const inspection = {
      cwd: dirtyChanges.rootPath,
      getChanges: vi.fn()
        .mockImplementationOnce(() => new Promise<typeof dirtyChanges>((resolve) => { finishInitial = resolve; }))
        .mockImplementationOnce(() => new Promise<typeof dirtyChanges>((resolve) => { finishFresh = resolve; })),
      getFileDiff: vi.fn(),
      getHistory: vi.fn(),
    };
    const input = panelProps({
      inspection,
      workflow: workflow({ snapshot: snapshot({ changedFiles: 1, unstagedFiles: 1, upstream: attached.upstream, ahead: 0, behind: 0 }) }),
      githubRepoStatus: { ...attached, ahead: 0, behind: 0 },
    });
    const clock = vi.spyOn(Date, "now");
    const startedAt = Date.now();
    const view = render(<GitPanel {...input} />);
    await vi.waitFor(() => expect(inspection.getChanges).toHaveBeenCalledTimes(1));
    const cleanSnapshot = snapshot({ headOid: "late-response-commit", stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, upstream: attached.upstream, ahead: 1, behind: 0 });
    clock.mockReturnValue(startedAt + 1_000);
    view.rerender(<GitPanel {...input} workflow={workflow({ busy: true, snapshot: cleanSnapshot })} />);
    expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    view.rerender(<GitPanel {...input} workflow={workflow({ snapshot: cleanSnapshot })} />);
    clock.mockReturnValue(startedAt + 2_000);
    await act(async () => finishInitial(dirtyChanges));
    await vi.waitFor(() => expect(inspection.getChanges).toHaveBeenCalledTimes(2));
    try {
      // Its completion time is later than the clean snapshot, but its data
      // was requested before the commit and must not re-enable committing.
      expect(screen.getAllByText("earlier-edit.ts").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled();
      const push = screen.getByRole("button", { name: "Push" });
      expect(push).toBeEnabled();
      fireEvent.click(push);
      expect(input.onAction).toHaveBeenCalledExactlyOnceWith("push");
    } finally {
      clock.mockRestore();
      await act(async () => finishFresh({ ...dirtyChanges, rows: [], unstagedFiles: 0, changedFiles: 0 }));
      await vi.waitFor(() => expect(screen.queryAllByText("earlier-edit.ts")).toHaveLength(0));
    }
  });

  it("makes bulk revert's added-file preservation contract explicit", () => {
    const props = panelProps();
    render(<GitPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More local Git actions" }));
    const revert = screen.getByRole("menuitem", { name: /Revert all changes/ });
    expect(revert).toHaveTextContent("Added and new files are kept");
    expect(revert).toHaveAttribute("title", "Restore committed files; keep added, renamed-destination and untracked file contents");
    fireEvent.click(revert);
    expect(props.onAction).toHaveBeenCalledWith("revert");
  });

  it("consumes a confirmed repeated message even without an intermediate busy render", () => {
    const input = panelProps({ gitCommitSuccess: "Repeat was saved.", gitCommitSuccessRevision: 4 });
    const view = render(<GitPanel {...input} />);
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Repeat" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitSuccessRevision={5} />);
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");
  });

  it("does not consume a rejected commit draft using an earlier success notification", () => {
    function Owner() {
      const [draft, setDraft] = useState({ commitMessage: "Keep this next draft", remoteInput: "", repositoryName: "project", visibility: "private" as const });
      const [output, setOutput] = useState("");
      return <GitPanel {...panelProps({ gitCommitSuccess: "Earlier commit was saved", gitOutput: output, draft, onAction: () => setOutput("Wait for agents in this folder to finish.") })} onDraftChange={(next) => setDraft({ ...next, visibility: "private" })} />;
    }
    render(<Owner />);
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Keep this next draft");
    expect(screen.getByText(/Wait for agents/)).toBeInTheDocument();
  });

  it("requires the repository root before changing a nested selected project folder", () => {
    const input = panelProps({ selectedFolder: "/project/packages/app", workflow: workflow({ snapshot: snapshot({ isRoot: false }) }), githubAuthenticated: true, githubRepoStatus: attached });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("alert")).toHaveTextContent("/project");
    const commitButton = screen.getByRole("button", { name: "Commit all changes locally" });
    expect(commitButton).toBeDisabled();
    expect(commitButton).toHaveAttribute("title", expect.stringContaining("repository root"));
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More local Git actions" }));
    expect(screen.getByRole("menuitem", { name: /Show git status output/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Show full diff output/ })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.submit(commitButton.closest("form")!);
    expect(input.onAction).not.toHaveBeenCalled();
  });

  it("accepts a selected root with different native slash conventions", () => {
    render(<GitPanel {...panelProps({ selectedFolder: "C:\\project\\", workflow: workflow({ snapshot: snapshot({ rootPath: "C:/project", isRoot: true }) }) })} />);
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { selectedFolder: "C:\\project", rootPath: "\\\\?\\C:\\Project" },
    { selectedFolder: "\\\\server\\share\\project", rootPath: "\\\\?\\UNC\\server\\share\\project" },
    { selectedFolder: "/projects/symlink", rootPath: "/projects/canonical" },
  ])("accepts the native root identity despite canonical path differences: %j", ({ selectedFolder, rootPath }) => {
    render(<GitPanel {...panelProps({ selectedFolder, workflow: workflow({ snapshot: snapshot({ rootPath, isRoot: true }) }) })} />);
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a new draft when an earlier commit completes", () => {
    const input = panelProps();
    const view = render(<GitPanel {...input} />);
    const message = screen.getByLabelText(/Commit message/i);
    fireEvent.change(message, { target: { value: "First commit" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitBusy />);
    fireEvent.change(message, { target: { value: "Next commit draft" } });
    view.rerender(<GitPanel {...input} gitCommitSuccess="First commit was saved." />);
    expect(message).toHaveValue("Next commit draft");
  });

  it("clears only the submitted message after a successful commit and keeps it on failure", () => {
    const input = panelProps();
    const view = render(<GitPanel {...input} />);
    const message = screen.getByLabelText(/Commit message/i);
    fireEvent.change(message, { target: { value: "Keep on failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitBusy />);
    view.rerender(<GitPanel {...input} gitOutput="Commit hook rejected the change" />);
    expect(message).toHaveValue("Keep on failure");
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitSuccess="Keep on failure was saved." />);
    expect(message).toHaveValue("");
  });

  it("uses the checkout's retained draft and reports edits back to its owner", () => {
    const onDraftChange = vi.fn();
    const draft = { commitMessage: "Stored commit", remoteInput: "https://github.com/m17h/existing", repositoryName: "stored-repo", visibility: "public" as const };
    render(<GitPanel {...panelProps({ draft, onDraftChange, githubAuthenticated: true })} />);
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Stored commit");
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Next stored draft" } });
    expect(onDraftChange).toHaveBeenCalledWith({ ...draft, commitMessage: "Next stored draft" });
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    expect(screen.getByLabelText("Existing repository URL")).toHaveValue(draft.remoteInput);
    expect(screen.getByLabelText("New GitHub repository name")).toHaveValue(draft.repositoryName);
    expect(screen.getByRole("button", { name: "Repository visibility" })).toHaveTextContent("Public");
  });

  it.each([{ readOnly: true }, { gitCommitBusy: true }, { gitOperationBusy: true }, { githubBusy: true }, { repositoryState: "absent" as const }])(
    "guards form submission while the commit is unavailable: %j", (overrides) => {
      const input = panelProps(overrides);
      const view = render(<GitPanel {...input} />);
      fireEvent.submit(view.container.querySelector(".git-commit-card")!);
      expect(input.onAction).not.toHaveBeenCalled();
    },
  );

  it("sends the message the person can see to Commit & push", () => {
    // The reported bug: the button committed under a default message while
    // the text they had typed sat in the field directly above it.
    const onAction = vi.fn();
    render(<GitPanel {...panelProps({ onAction, githubRepoStatus: attached })} />);

    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Tighten the merge copy" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));

    expect(onAction).toHaveBeenCalledWith("commitPush", "Tighten the merge copy");
  });

  it("offers staged and everything as separate commits, sharing one message", () => {
    const onAction = vi.fn();
    render(
      <GitPanel
        {...panelProps({
          onAction,
          githubRepoStatus: attached,
          workflow: workflow({ snapshot: snapshot({ stagedFiles: 2, unstagedFiles: 1, changedFiles: 3, stagedPaths: ["a.ts", "b.ts"] }) }),
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Just the staged two" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit staged (2)" }));
    expect(onAction).toHaveBeenCalledWith("commitStaged", "Just the staged two");

    fireEvent.click(screen.getByRole("button", { name: "Commit all changes (3)" }));
    expect(onAction).toHaveBeenCalledWith("commit", "Just the staged two");

    // The push variant follows whichever commit is the primary one, so it can
    // never quietly push more than the button above it promised.
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onAction).toHaveBeenCalledWith("commitStagedPush", "Just the staged two");
  });

  it("keeps the single plain commit button when nothing is staged", () => {
    const onAction = vi.fn();
    render(<GitPanel {...panelProps({ onAction, workflow: workflow() })} />);

    expect(screen.queryByRole("button", { name: /Commit staged/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    expect(onAction).toHaveBeenCalledWith("commit", "");
  });
});

describe("GitPanel local branch", () => {
  it("uses a detached local snapshot instead of a stale named GitHub branch", () => {
    render(<GitPanel {...panelProps({ githubRepoStatus: attached, workflow: workflow({ snapshot: snapshot({ branch: null }) }) })} />);
    expect(screen.getByText("No branch checked out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit & push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  });

  it("switches branches through the app's own menu, and refuses one held by another worktree", () => {
    const controls = workflow();
    render(<GitPanel {...panelProps({ workflow: controls })} />);

    expect(screen.getByText("feature/ui-polish")).toBeInTheDocument();
    expect(screen.getByText(/Shared project folder/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    // Never an OS drop-down: the menu is the app's own, with real menu roles.
    expect(screen.getByRole("menu", { name: "Switch or create a branch" })).toBeInTheDocument();

    const held = screen.getByRole("menuitem", { name: /mythra\/held/ });
    expect(held).toBeDisabled();
    expect(held).toHaveAttribute("title", expect.stringContaining("checked out in /worktrees/held"));

    fireEvent.click(screen.getByRole("menuitem", { name: /^main/ }));
    expect(controls.onBranch).toHaveBeenCalledWith("main", false);
  });

  it("creates a branch without GitHub, and says who else moves with it", async () => {
    const controls = workflow();
    render(<GitPanel {...panelProps({ workflow: controls, githubAuthenticated: false })} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch…/ }));

    expect(screen.getByText(/Every thread using this folder moves to the new branch too/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent to GitHub/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/next" } });
    fireEvent.click(screen.getByRole("button", { name: /Create branch/ }));
    expect(controls.onBranch).toHaveBeenCalledWith("feature/next", true);
  });

  it("keeps the branch draft visible when its owner rejects the operation", async () => {
    const controls = workflow({ onBranch: vi.fn().mockResolvedValue(false) });
    render(<GitPanel {...panelProps({ workflow: controls })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch/ }));
    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/keep-me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await vi.waitFor(() => expect(controls.onBranch).toHaveBeenCalled());
    expect(screen.getByLabelText("New branch name")).toHaveValue("feature/keep-me");
  });

  it("keeps managed isolated work on its assigned branch", () => {
    render(<GitPanel {...panelProps({ workflow: workflow({ isolated: true }) })} />);

    expect(screen.getByText(/Isolated worktree/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    const create = screen.getByRole("menuitem", { name: /New branch…/ });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("title", expect.stringContaining("keeps its isolated branch"));
  });

  it("closes a shared-folder branch draft when the checkout becomes isolated", () => {
    const shared = workflow();
    const view = render(<GitPanel {...panelProps({ workflow: shared, selectedFolder: "/project" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch/ }));
    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/from-shared" } });

    const isolated = workflow({ isolated: true });
    view.rerender(<GitPanel {...panelProps({ workflow: isolated, selectedFolder: "/project" })} />);
    expect(screen.queryByLabelText("New branch name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    expect(screen.getByRole("menuitem", { name: /New branch/ })).toBeDisabled();
    expect(shared.onBranch).not.toHaveBeenCalled();
    expect(isolated.onBranch).not.toHaveBeenCalled();
  });
});

describe("GitPanel GitHub section", () => {
  it("allows signed-out users to attach an existing remote and connects an account only for creation", () => {
    const input = panelProps();
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    fireEvent.change(screen.getByLabelText("Existing repository URL"), { target: { value: "https://github.com/m17h/existing" } });
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/existing");
    expect(screen.queryByRole("form", { name: "Create a GitHub repository" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub account" }));
    expect(input.onOpenGitHubSettings).toHaveBeenCalledOnce();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
  });

  it("shows connection progress, blocks repeated submission, and preserves fields on failure", () => {
    const input = panelProps({ githubAuthenticated: true });
    const view = render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    const url = screen.getByLabelText("Existing repository URL");
    fireEvent.change(url, { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach remote" }));
    view.rerender(<GitPanel {...input} githubBusy />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting this project to GitHub");
    expect(screen.getByRole("button", { name: "Attaching…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Repository visibility" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    fireEvent.submit(screen.getByRole("form", { name: "Create a GitHub repository" }));
    expect(input.onGitHubAttach).toHaveBeenCalledOnce();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
    view.rerender(<GitPanel {...input} githubOperationError="GitHub rejected this repository address." />);
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub rejected this repository address.");
    expect(url).toHaveValue("https://github.com/m17h/example.git");
    expect(screen.getByLabelText("New GitHub repository name")).toHaveValue("project");
    expect(screen.getByRole("button", { name: "Attach remote" })).toBeEnabled();
  });

  it("guards both publishing forms in a read-only thread", () => {
    const input = panelProps({ githubAuthenticated: true, readOnly: true });
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    fireEvent.change(screen.getByLabelText("Existing repository URL"), { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    fireEvent.submit(screen.getByRole("form", { name: "Create a GitHub repository" }));
    expect(input.onGitHubAttach).not.toHaveBeenCalled();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("keeps the remote URL for retry when attaching does not establish a repository", () => {
    const input = panelProps({ githubAuthenticated: true });
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    const url = screen.getByLabelText("Existing repository URL");
    fireEvent.change(url, { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach remote" }));
    expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/example.git");
    expect(url).toHaveValue("https://github.com/m17h/example.git");
  });

  it("reports ahead and behind as last known, against the branch they were measured from", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: attached,
          workflow: workflow({ lastFetchedAt: Date.now() - 4 * 60_000 }),
        })}
      />,
    );

    // The tracked branch has this branch's name, so the remote alone names it;
    // the full upstream stays available on the line itself.
    const line = screen.getByText(/Compared with origin:/);
    expect(line).toHaveAttribute("title", "Tracking origin/feature/ui-polish");
    expect(line).toHaveTextContent("2 to push");
    expect(line).toHaveTextContent("1 to pull");
    expect(line).toHaveTextContent("fetched 4 min ago");
    // The counts sit beside the branch too, where a long name cannot hide them.
    expect(screen.getByLabelText("2 to push")).toBeInTheDocument();
    expect(screen.getByLabelText("1 to pull")).toBeInTheDocument();
  });

  it("spells out an upstream whose name differs from the local branch", () => {
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: { ...attached, upstream: "origin/release/next" } })} />);
    expect(screen.getByText(/Compared with origin\/release\/next: 2 to push, 1 to pull/)).toBeInTheDocument();
  });

  it("does not read a missing upstream as proof that nothing was ever published", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: { ...attached, upstream: undefined, ahead: 0, behind: 0 },
        })}
      />,
    );

    expect(screen.queryByText(/not pushed yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has no tracked branch here yet/)).toBeInTheDocument();
  });

  it("shows the console only once there is output in it", () => {
    const { rerender } = render(<GitPanel {...panelProps()} />);
    expect(screen.queryByText(/Choose an action to inspect/)).not.toBeInTheDocument();
    expect(screen.queryByText("Git output")).not.toBeInTheDocument();

    rerender(<GitPanel {...panelProps({ gitOutput: "$ git status\nnothing to commit" })} />);
    expect(screen.getByText("Git output")).toBeInTheDocument();
    expect(screen.getByText(/nothing to commit/)).toBeInTheDocument();
  });
});

describe("GitPanel automatic publishing", () => {
  const autoPublish = (overrides: Record<string, unknown> = {}) => workflow({
    autoPublish: {
      enabled: false,
      status: "idle",
      message: "",
      repository: "m17h/Mythra-Code",
      onToggle: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    },
  });

  it("is off until it is switched on and confirmed, and names the repository it would push to", () => {
    const controls = autoPublish();
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: attached, workflow: controls })} />);

    const toggle = screen.getByRole("switch", { name: /Automatically publish branches and commits/ });
    expect(toggle).not.toBeChecked();

    const scope = screen.getByText(/including work from agents, the terminal/);
    expect(scope).toHaveTextContent("m17h/Mythra-Code");
    expect(scope).toHaveTextContent("Uncommitted files stay local");
    expect(scope).toHaveTextContent("overwrites remote history");
    // Compact while off: the consequences are folded away, but still describe the switch.
    expect(scope).not.toBeVisible();
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining("including work from agents"));

    // No status line while it is off: there is nothing being watched.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    // Turning it on shows every consequence first and waits for a decision.
    expect(controls.autoPublish?.onToggle).not.toHaveBeenCalled();
    expect(scope).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep it off" }));
    expect(controls.autoPublish?.onToggle).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Turn on and publish/ }));
    expect(controls.autoPublish?.onToggle).toHaveBeenCalledWith(true);
  });

  it("surfaces a paused state with the reason and destination review instructions", () => {
    const controls = autoPublish({
      enabled: true,
      status: "paused",
      message: "Paused — main was rejected by GitHub (protected branch). 3 commits waiting.",
    });
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: attached, workflow: controls })} />);

    expect(screen.getByRole("switch", { name: /Automatically publish branches and commits/ })).toBeChecked();
    expect(screen.getByText(/protected branch/)).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText(/off and on to review the destination/)).toBeInTheDocument();
  });

  it("offers no retry while it is simply publishing", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: attached,
          workflow: autoPublish({ enabled: true, status: "publishing", message: "Publishing feature/ui-polish…" }),
        })}
      />,
    );

    expect(screen.getByText("Publishing feature/ui-polish…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("allows turning off a paused configuration after its remote is removed", () => {
    const controls = autoPublish({ enabled: true, status: "paused", message: "Publishing remote changed." });
    render(<GitPanel {...panelProps({ workflow: controls })} />);
    fireEvent.click(screen.getByRole("switch", { name: /Automatically publish/ }));
    expect(controls.autoPublish?.onToggle).toHaveBeenCalledWith(false);
  });

  it("retries a waiting network failure without resetting the destination", () => {
    const controls = autoPublish({ enabled: true, status: "waiting", message: "GitHub is unavailable." });
    render(<GitPanel {...panelProps({ githubRepoStatus: attached, workflow: controls })} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(controls.autoPublish?.onRetry).toHaveBeenCalledOnce();
  });

  it("stays hidden entirely where there is no repository to publish to", () => {
    render(<GitPanel {...panelProps({ githubAuthenticated: true, workflow: autoPublish() })} />);
    expect(screen.queryByRole("switch", { name: /Automatically publish branches and commits/ })).not.toBeInTheDocument();
  });
});
