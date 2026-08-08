import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_DOCK_EXIT_MS, StudioDock } from "./StudioDock";

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

function dockProps(open: boolean): Parameters<typeof StudioDock>[0] {
  return {
    open,
    tab: "review",
    activeThread: false,
    diff: "",
    agents: [],
    terminalOutput: {} as never,
    terminalCommand: "",
    terminalRunning: false,
    checkpoints: [],
    attachments: [],
    usage: null,
    accountUsage: { label: "OpenAI subscription", summary: "25% used" },
    skills: [],
    mcpServers: [],
    gitOutput: "",
    gitCommitMessage: "",
    githubAuthenticated: false,
    githubRepoStatus: null,
    githubRepoError: "",
    gitActionsReadOnly: false,
    githubRemoteInput: "",
    githubRepoName: "",
    githubRepoVisibility: "private",
    promptAudit: [],
    projectActions: [],
    workflows: [],
    workflowRuns: [],
    onTab: vi.fn(),
    onClose: vi.fn(),
    onRefreshDiff: vi.fn(),
    onReview: vi.fn(),
    onOpenAgent: vi.fn(),
    onStopAgent: vi.fn(),
    onTerminalCommand: vi.fn(),
    onRunTerminal: vi.fn(),
    onStopTerminal: vi.fn(),
    onTerminalInput: vi.fn(),
    onTerminalResize: vi.fn(),
    onCheckpoint: vi.fn(),
    onFork: vi.fn(),
    onCheckpointRestore: vi.fn(),
    onCheckpointAccept: vi.fn(),
    onCheckpointPreview: vi.fn(),
    onCheckpointDelete: vi.fn(),
    onRollback: vi.fn(),
    onWorktreeReview: vi.fn(),
    onWorktreeApply: vi.fn(),
    onWorktreeMerge: vi.fn(),
    onWorktreeReveal: vi.fn(),
    onWorktreeRefresh: vi.fn(),
    onWorktreeRemove: vi.fn(),
    onWorktreeRecreate: vi.fn(),
    onWorktreeContinueShared: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRefreshUsage: vi.fn(),
    onCompact: vi.fn(),
    onRefreshTools: vi.fn(),
    onGitAction: vi.fn(),
    onGitCommitMessage: vi.fn(),
    onGitHubRemoteInput: vi.fn(),
    onGitHubRepoName: vi.fn(),
    onGitHubRepoVisibility: vi.fn(),
    onGitHubAttach: vi.fn(),
    onGitHubCreate: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    onGitPathAction: vi.fn(),
    onAttachPath: vi.fn(),
    onProjectAction: vi.fn(),
    onRunWorkflow: vi.fn(),
    onStopWorkflow: vi.fn(),
    onOpenWorkflowRun: vi.fn(),
    onToggleSkill: vi.fn(),
    onConnectMcp: vi.fn(),
  };
}

describe("StudioDock", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps its contents mounted while the close animation runs", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<StudioDock {...dockProps(true)} />);
    expect(screen.getByText("Review center")).toBeInTheDocument();

    rerender(<StudioDock {...dockProps(false)} />);
    const dock = container.querySelector(".studio-dock");
    expect(dock).toHaveClass("closed");
    expect(dock).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Review center")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(STUDIO_DOCK_EXIT_MS));
    expect(screen.queryByText("Review center")).not.toBeInTheDocument();
  });

  it("cancels the pending unmount when reopened during the exit", () => {
    vi.useFakeTimers();
    const { rerender } = render(<StudioDock {...dockProps(true)} />);
    rerender(<StudioDock {...dockProps(false)} />);
    act(() => vi.advanceTimersByTime(STUDIO_DOCK_EXIT_MS / 2));
    rerender(<StudioDock {...dockProps(true)} />);
    act(() => vi.advanceTimersByTime(STUDIO_DOCK_EXIT_MS));

    expect(screen.getByText("Review center")).toBeInTheDocument();
    expect(screen.getByLabelText("Project workspace tools")).toHaveClass("open");
  });

  it("shows the usage summary for the active provider", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="usage"
        accountUsage={{ label: "Claude subscription", summary: "Max plan connected · live limits are managed by Claude Code" }}
      />,
    );

    expect(screen.getByText("Claude subscription")).toBeInTheDocument();
    expect(screen.getByText(/Max plan connected/)).toBeInTheDocument();
    expect(screen.queryByText("25% used")).not.toBeInTheDocument();
  });

  it("uses current context pressure instead of cumulative thread history", () => {
    const { container } = render(
      <StudioDock
        {...dockProps(true)}
        tab="usage"
        usage={{
          totalTokens: 180_000,
          contextTokens: 20_000,
          inputTokens: 160_000,
          cachedInputTokens: 0,
          outputTokens: 20_000,
          reasoningOutputTokens: 0,
          contextWindow: 200_000,
        }}
      />,
    );

    expect(screen.getByText(/10% of context/)).toBeInTheDocument();
    expect(screen.queryByText(/Compact before the limit/)).not.toBeInTheDocument();
    const metrics = container.querySelector(".usage-token-metrics");
    expect(metrics).toBeInTheDocument();
    expect(metrics?.lastElementChild).toHaveClass("usage-reasoning-metric");
    expect(metrics?.lastElementChild).toHaveTextContent("Reasoning");
  });

  it("offers reversible full-state actions for an automatic checkpoint", () => {
    const onCheckpointRestore = vi.fn();
    const onCheckpointAccept = vi.fn();
    const onCheckpointPreview = vi.fn();
    const checkpoint = {
      id: "checkpoint-1",
      threadId: "thread-1",
      workspacePath: "/project",
      label: "Run: repair the sidebar",
      createdAt: Date.now(),
      completedAt: Date.now(),
      status: "restored-before" as const,
      beforeCommit: "before",
      afterCommit: "after",
      changedFiles: 3,
      additions: 12,
      deletions: 4,
    };

    render(
      <StudioDock
        {...dockProps(true)}
        tab="checkpoints"
        activeThread
        checkpoints={[checkpoint]}
        checkpointHead={{ checkpointId: checkpoint.id, position: "before" }}
        onCheckpointRestore={onCheckpointRestore}
        onCheckpointAccept={onCheckpointAccept}
        onCheckpointPreview={onCheckpointPreview}
      />,
    );

    expect(screen.getByText(/current before state/)).toBeInTheDocument();
    expect(screen.getByText("3 files · +12 −4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore before" }));
    fireEvent.click(screen.getByRole("button", { name: "Reapply run" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(onCheckpointRestore).toHaveBeenNthCalledWith(1, checkpoint, "before");
    expect(onCheckpointRestore).toHaveBeenNthCalledWith(2, checkpoint, "after");
    expect(onCheckpointAccept).toHaveBeenCalledWith(checkpoint);
    expect(onCheckpointPreview).toHaveBeenCalledWith(checkpoint);
  });

  it("shows the complete action set for an isolated thread", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="worktrees"
        activeThread
        worktree={{
          threadId: "thread-1",
          projectId: "project-1",
          projectPath: "/project",
          path: "/worktrees/thread-1",
          branch: "openkiwi/thread-1",
          baseCommit: "base",
          gitDir: "/project/.git",
          createdAt: 1,
          status: "active",
        }}
        worktreeStatus={{
          exists: true,
          registered: true,
          branch: "openkiwi/thread-1",
          baseCommit: "base",
          changedFiles: 2,
          untrackedFiles: 1,
          ignoredFiles: [],
          ahead: 1,
          behind: 0,
          clean: false,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge branch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove worktree…" })).toBeInTheDocument();
    expect(screen.getByText(/Worktrees and their branches stay local/)).toBeInTheDocument();
  });

  it("keeps worktree management out of the Checkpoints tab", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="checkpoints"
        activeThread
        worktree={{
          threadId: "thread-1",
          projectId: "project-1",
          projectPath: "/project",
          path: "/worktrees/thread-1",
          branch: "openkiwi/thread-1",
          baseCommit: "base",
          gitDir: "/project/.git",
          createdAt: 1,
          status: "active",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Checkpoints" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply to project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Worktrees workspace tool" })).toBeInTheDocument();
  });

  it("keeps Git inspection available but gates mutations in read-only mode", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="git"
        gitActionsReadOnly
        diff={"diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n+change"}
        githubAuthenticated
        githubRepoStatus={{ isRepo: true, repository: "owner/repo", branch: "main", upstream: "origin/main", ahead: 0, behind: 0 }}
      />,
    );

    expect(screen.getByRole("button", { name: "Status" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Diff" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByText(/Read only allows Status and Diff/)).toBeInTheDocument();
  });
});
