import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_DOCK_EXIT_MS, StudioDock } from "./StudioDock";
import { providerAccountUsage } from "../lib/providerUsage";
import { EMPTY_REVIEW_DIFF, type ReviewDiff } from "../lib/gitDiff";
import type { UsageDisplayMode } from "../types";

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

function reviewDiff(text: string, overrides: Partial<ReviewDiff> = {}): ReviewDiff {
  return { ...EMPTY_REVIEW_DIFF, text, ...overrides };
}

function dockProps(open: boolean): Parameters<typeof StudioDock>[0] {
  return {
    open,
    tab: "review",
    activeThread: false,
    reviewDiff: EMPTY_REVIEW_DIFF,
    agents: [],
    terminalOutput: {} as never,
    terminalRunning: false,
    terminalRunningCommand: "",
    terminalRunningElsewhere: [],
    commandsReadOnly: false,
    checkpoints: [],
    attachments: [],
    usage: null,
    accountUsage: { label: "OpenAI subscription", summary: "25% used" },
    skills: [],
    mcpServers: [],
    gitOutput: "",
    gitCommitSuccess: "",
    gitCommitBusy: false,
    gitRepositoryState: "ready",
    gitInitializing: false,
    githubAuthenticated: false,
    githubRepoStatus: null,
    githubRepoError: "",
    gitActionsReadOnly: false,
    defaultRepositoryName: "",
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
    onRunTerminal: vi.fn(),
    onStopTerminal: vi.fn(),
    onClearTerminal: vi.fn(),
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
    onInitializeGit: vi.fn(),
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

  it("exposes the surfaces as a keyboard-navigable tablist", () => {
    const onTab = vi.fn();
    render(<StudioDock {...dockProps(true)} onTab={onTab} />);

    const tablist = screen.getByRole("tablist", { name: "Workspace tools" });
    expect(tablist).toHaveAttribute("aria-orientation", "vertical");
    const review = screen.getByRole("tab", { name: "Review workspace tool" });
    expect(review).toHaveAttribute("aria-selected", "true");
    expect(review).toHaveAttribute("tabindex", "0");
    // Unselected tabs are out of the tab order: one stop for the whole list.
    expect(screen.getByRole("tab", { name: "Files workspace tool" })).toHaveAttribute("tabindex", "-1");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", review.id);
    expect(review).toHaveAttribute("aria-controls", panel.id);

    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    expect(onTab).toHaveBeenLastCalledWith("agents");
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    expect(onTab).toHaveBeenLastCalledWith("files");
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onTab).toHaveBeenLastCalledWith("git");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onTab).toHaveBeenLastCalledWith("files");
  });

  it("says what the Review diff is taken against and names untracked files", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="review"
        reviewDiff={reviewDiff(
          "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n+change",
          { source: "repository", baseline: "HEAD", untrackedPaths: ["src/new.ts"] },
        )}
      />,
    );

    expect(screen.getByText("Repository changes")).toBeInTheDocument();
    expect(screen.getByText("1 file changed · against HEAD")).toBeInTheDocument();
    expect(screen.getByText(/1 untracked file is not part of this diff: src\/new\.ts/)).toBeInTheDocument();
  });

  it("explains why AI review is unavailable instead of accepting a rejected click", () => {
    const onReview = vi.fn();
    render(
      <StudioDock
        {...dockProps(true)}
        tab="review"
        activeThread
        reviewDisabledReason="Inline review is available for OpenAI, OpenRouter, and LM Studio threads."
        onReview={onReview}
      />,
    );

    const button = screen.getByRole("button", { name: "AI review" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Inline review is available for OpenAI, OpenRouter, and LM Studio threads.");
    fireEvent.click(button);
    expect(onReview).not.toHaveBeenCalled();
  });

  it("withholds per-file Git actions for a path it could not decode", () => {
    const onGitPathAction = vi.fn();
    render(
      <StudioDock
        {...dockProps(true)}
        tab="review"
        reviewDiff={reviewDiff('diff --git "a/broken\\q" "b/broken\\q"\nold mode 100644\nnew mode 100755')}
        onGitPathAction={onGitPathAction}
      />,
    );

    expect(screen.getByText("Name unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stage" })).not.toBeInTheDocument();
    expect(onGitPathAction).not.toHaveBeenCalled();
  });

  it("does not mount collapsed diff bodies and caps a very large expansion", () => {
    const hugeFile = (name: string) => [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -0,0 +1,900 @@",
      ...Array.from({ length: 900 }, (_, index) => `+${name} line ${index}`),
    ].join("\n");
    const { container } = render(
      <StudioDock
        {...dockProps(true)}
        tab="review"
        reviewDiff={reviewDiff(`${hugeFile("one.ts")}\n${hugeFile("two.ts")}`)}
      />,
    );

    // Two files: both collapsed, so no diff body exists in the document.
    expect(container.querySelectorAll(".diff-body")).toHaveLength(0);
    expect(screen.queryByText(/one\.ts line 0/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("one.ts"));
    expect(container.querySelectorAll(".diff-body")).toHaveLength(1);
    // The expansion is capped, and the rest stays reachable.
    expect(screen.getByText(/one\.ts line 0/)).toBeInTheDocument();
    expect(screen.queryByText(/one\.ts line 800/)).not.toBeInTheDocument();
    expect(screen.getByText(/more lines not shown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show \d/ }));
    expect(screen.getByText(/one\.ts line 800/)).toBeInTheDocument();
    expect(screen.queryByText(/more lines not shown/)).not.toBeInTheDocument();
  });

  it("offers Clear and names the project a command is running in", () => {
    const onClearTerminal = vi.fn();
    render(
      <StudioDock
        {...dockProps(true)}
        tab="terminal"
        projectName="Alpha"
        projectPath="/alpha"
        terminalRunning
        terminalRunningCommand="npm test"
        terminalRunningElsewhere={[{ scope: "/beta", command: "npm run build" }]}
        onClearTerminal={onClearTerminal}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Running in Alpha · npm test");
    expect(screen.getByText(/Still running in/)).toHaveTextContent("Still running in beta · npm run build");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearTerminal).toHaveBeenCalledOnce();
  });

  it("explains the read-only restriction on commands rather than waiting for a sandbox failure", () => {
    render(<StudioDock {...dockProps(true)} tab="terminal" projectName="Alpha" projectPath="/alpha" commandsReadOnly />);
    expect(screen.getByText(/commands run without permission to write inside Alpha/)).toBeInTheDocument();
  });

  it("shows an empty state on the Context surface", () => {
    render(<StudioDock {...dockProps(true)} tab="context" />);
    expect(screen.getByText("Nothing attached yet")).toBeInTheDocument();
  });

  it("does not make historical checkpoints look busy while a manual save runs", () => {
    const checkpoint = {
      id: "checkpoint-1",
      threadId: "thread-1",
      workspacePath: "/project",
      label: "Run: repair the sidebar",
      createdAt: Date.now(),
      completedAt: Date.now(),
      status: "ready" as const,
      beforeCommit: "before",
      afterCommit: "after",
    };
    const { container } = render(
      <StudioDock {...dockProps(true)} tab="checkpoints" activeThread checkpoints={[checkpoint]} checkpointBusyId="manual" />,
    );

    expect(container.querySelector(".checkpoint-state-icon .spin")).toBeNull();
    expect(screen.getByRole("button", { name: "Saving current state…" })).toBeDisabled();
  });

  it("names statuses instead of printing runtime enum values", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="agents"
        agents={[{ id: "agent-12345678", prompt: "Audit the dock", status: "inProgress" }]}
      />,
    );
    expect(screen.getByText("Working · agent-12")).toBeInTheDocument();
    expect(screen.queryByText(/inProgress/)).not.toBeInTheDocument();
  });

  it("names MCP auth states and hides Connect for a server that has one", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="tools"
        mcpServers={[
          { name: "linear", status: "oAuth", tools: 4 },
          { name: "stalled", status: "needsAuth", tools: 0 },
        ]}
      />,
    );
    expect(screen.getByText("Connected · OAuth · 4 tools")).toBeInTheDocument();
    expect(screen.getByText("Sign-in required · 0 tools")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect server" })).toHaveLength(1);
  });

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

  it("renders the active provider quota in whichever direction the user chose", () => {
    const limits = { windows: [{ label: "5h", usedPercent: 42, resetsAt: null }] };
    const view = (usageDisplay: UsageDisplayMode) => providerAccountUsage("openai", {
      openAiRateLimits: limits,
      openAiRateLimitsRead: true,
      claudeStatus: null,
      openRouterReady: false,
      usageDisplay,
    });

    const { rerender } = render(<StudioDock {...dockProps(true)} tab="usage" accountUsage={view("remaining")} />);
    expect(screen.getByText("58% left")).toBeInTheDocument();
    expect(screen.queryByText("42% used")).not.toBeInTheDocument();

    rerender(<StudioDock {...dockProps(true)} tab="usage" accountUsage={view("consumed")} />);
    expect(screen.getByText("42% used")).toBeInTheDocument();
    expect(screen.queryByText("58% left")).not.toBeInTheDocument();
  });

  it("renders provider windows as separate scannable rows", () => {
    const accountUsage = providerAccountUsage("claude", {
      openAiRateLimits: null,
      claudeStatus: {
        available: true,
        path: "/bin/claude",
        version: "2.1.238",
        loggedIn: true,
        authMethod: "claude.ai",
        email: null,
        subscriptionType: "max",
        warning: null,
      },
      claudeRateLimits: {
        windows: [
          { label: "5h", usedPercent: 6, resetsAt: null, resetLabel: "Aug 21 at 11:30pm (America/New_York)" },
          { label: "Weekly", usedPercent: 29, resetsAt: null, resetLabel: "Aug 23 at 6pm (America/New_York)" },
        ],
      },
      openRouterReady: false,
      usageDisplay: "remaining",
    });

    render(<StudioDock {...dockProps(true)} tab="usage" accountUsage={accountUsage} />);

    expect(screen.getByText("Max plan")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "5h 94% left" })).toHaveAttribute("aria-valuenow", "94");
    expect(screen.getByRole("progressbar", { name: "Weekly 71% left" })).toHaveAttribute("aria-valuenow", "71");
    expect(screen.getByText("Resets Aug 21 · 11:30 PM")).toBeInTheDocument();
    expect(screen.getByText("Resets Aug 23 · 6 PM")).toBeInTheDocument();
    expect(screen.queryByText(accountUsage.summary)).not.toBeInTheDocument();
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

  it("does not present cumulative tokens as context pressure when a provider omits current occupancy", () => {
    const { container } = render(
      <StudioDock
        {...dockProps(true)}
        tab="usage"
        usage={{
          totalTokens: 180_000,
          inputTokens: 160_000,
          cachedInputTokens: 0,
          outputTokens: 20_000,
          reasoningOutputTokens: 0,
          contextWindow: 200_000,
        }}
      />,
    );

    expect(screen.queryByText(/% of context/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Compact before the limit/)).not.toBeInTheDocument();
    expect(container.querySelector(".usage-hero > i")).not.toBeInTheDocument();
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
          ignoredFileCount: 0,
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
    expect(screen.getByRole("tab", { name: "Worktrees workspace tool" })).toBeInTheDocument();
  });

  it("keeps Git inspection available but gates mutations in read-only mode", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="git"
        gitActionsReadOnly
        githubAuthenticated
        githubRepoStatus={{ isRepo: true, repository: "owner/repo", branch: "main", upstream: "origin/main", ahead: 0, behind: 0 }}
      />,
    );

    expect(screen.getByRole("button", { name: "Status" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Diff" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByText(/Read only allows Status and Diff/)).toBeInTheDocument();
  });

  it("gates per-file Review actions in read-only mode", () => {
    render(
      <StudioDock
        {...dockProps(true)}
        tab="review"
        gitActionsReadOnly
        reviewDiff={reviewDiff("diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n+change")}
      />,
    );

    expect(screen.getByRole("button", { name: "Stage" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert src/file.ts" })).toBeDisabled();
  });

  it("makes local commits prominent, keeps the message optional, and confirms success", () => {
    const onGitAction = vi.fn();
    render(
      <StudioDock
        {...dockProps(true)}
        tab="git"
        onGitAction={onGitAction}
        gitCommitSuccess="“Polish the Git panel” was saved to this repository."
      />,
    );

    expect(screen.getByRole("heading", { name: "Git workspace" })).toBeInTheDocument();
    expect(screen.getByText("Commit changes locally")).toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message/i)).toHaveAttribute("placeholder", "Update project files");
    const commit = screen.getByRole("button", { name: "Commit all changes locally" });
    expect(commit).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Polish the Git panel" } });
    fireEvent.click(commit);
    expect(onGitAction).toHaveBeenCalledWith("commit", "Polish the Git panel");
    expect(screen.getByText("Committed successfully")).toBeInTheDocument();
    expect(screen.getByText(/Polish the Git panel/)).toBeInTheDocument();
  });

  it("offers Git initialization and disables local mutations when the project is not a repository", () => {
    const onInitializeGit = vi.fn();
    render(
      <StudioDock
        {...dockProps(true)}
        tab="git"
        gitRepositoryState="absent"
        onInitializeGit={onInitializeGit}
        githubAuthenticated
        defaultRepositoryName="repo"
      />,
    );

    expect(screen.getByText("This project is not a Git repository yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Initialize Git" }));
    expect(onInitializeGit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert all Git changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("keeps local Git actions available when only the repository probe failed", () => {
    // A failed GitHub/status probe says nothing about whether the folder is a
    // repository, so it must not disable every local action.
    render(
      <StudioDock
        {...dockProps(true)}
        tab="git"
        gitRepositoryState="unknown"
        gitRepositoryStateDetail="Could not reach GitHub"
        githubRepoError="Could not reach GitHub"
      />,
    );

    expect(screen.queryByText("This project is not a Git repository yet")).not.toBeInTheDocument();
    expect(screen.getByText(/Local Git actions stay available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  });
});
