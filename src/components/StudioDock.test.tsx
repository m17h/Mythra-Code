import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_DOCK_EXIT_MS, StudioDock } from "./StudioDock";

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

function dockProps(open: boolean): Parameters<typeof StudioDock>[0] {
  return {
    open,
    width: 430,
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
    onRollback: vi.fn(),
    onWorktree: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRefreshUsage: vi.fn(),
    onCompact: vi.fn(),
    onRefreshTools: vi.fn(),
    onGitAction: vi.fn(),
    onGitCommitMessage: vi.fn(),
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
});
