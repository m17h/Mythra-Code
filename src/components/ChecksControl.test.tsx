import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChecksControl } from "./ChecksControl";
import type { ProjectCheckResult } from "../lib/projectChecks";

const failed: ProjectCheckResult = {
  id: "check-1", projectId: "project", threadId: "thread", cwd: "/project/worktree",
  command: "npm test", head: "abc123", startedAt: Date.now() - 1_000, finishedAt: Date.now(),
  status: "failed", exitCode: 2, output: "stderr:\nfailed test", outputTruncated: true,
};

function renderControl(result: ProjectCheckResult | null = failed, overrides: Partial<React.ComponentProps<typeof ChecksControl>> = {}) {
  const onAddFeedback = vi.fn(() => true);
  const props: React.ComponentProps<typeof ChecksControl> = {
    command: "npm test", running: false, result, onRun: vi.fn(), onStop: vi.fn(),
    onSave: vi.fn(), onAddFeedback, ...overrides,
  };
  const view = render(<ChecksControl {...props} />);
  return { ...view, props, onAddFeedback };
}

describe("ChecksControl", () => {
  it("finds and saves checks without running them, then runs only on the next click", () => {
    const onDiscovered = vi.fn();
    const discovery = { pending: false, suggestion: null, error: "", cancel: vi.fn(), clearSuggestion: vi.fn(), discover: vi.fn() };
    const { props, rerender } = renderControl(null, { command: undefined, discovery, onDiscovered });
    fireEvent.click(screen.getByRole("button", { name: "Find checks" }));
    expect(discovery.discover).toHaveBeenCalledOnce();
    const save = discovery.discover.mock.calls[0][1];
    save({ command: "npm test", explanation: "Existing package script" });
    expect(onDiscovered).toHaveBeenCalledWith("npm test");
    expect(props.onRun).not.toHaveBeenCalled();
    rerender(<ChecksControl {...props} command="npm test" />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect(props.onRun).toHaveBeenCalledOnce();
  });

  it("offers Stop during discovery and keeps an empty result distinct from success", () => {
    const discovery = { pending: true, suggestion: null, error: "", cancel: vi.fn(), clearSuggestion: vi.fn(), discover: vi.fn() };
    const { props, rerender } = renderControl(null, { command: undefined, discovery });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(discovery.cancel).toHaveBeenCalledOnce();
    rerender(<ChecksControl {...props} discovery={{ ...discovery, pending: false, suggestion: { command: "", explanation: "No tests exist in this project." } }} />);
    expect(screen.getByText("No check command found")).toBeInTheDocument();
    expect(screen.queryByText("Check command saved")).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("dismisses the previous discovery success when the saved command is cleared manually", () => {
    const discovery = { pending: false, suggestion: { command: "npm test", explanation: "Found tests" }, error: "", cancel: vi.fn(), clearSuggestion: vi.fn(), discover: vi.fn() };
    const { props } = renderControl(null, { discovery });
    fireEvent.click(screen.getByRole("button", { name: "Edit check command" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(props.onSave).toHaveBeenCalledWith("");
    expect(discovery.clearSuggestion).toHaveBeenCalledOnce();
  });

  it("marks a passed result as the last run snapshot", () => {
    renderControl({ ...failed, status: "passed", exitCode: 0, output: "passed", outputTruncated: false });
    expect(screen.getByText("Checks passed")).toBeInTheDocument();
    expect(screen.getByText(/Last run ·/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask agent to fix" })).not.toBeInTheDocument();
  });

  it("stages failures and becomes available again when feedback is removed", () => {
    const { rerender, props, onAddFeedback } = renderControl();
    const fix = screen.getByRole("button", { name: "Ask agent to fix" });
    fireEvent.click(fix);
    expect(onAddFeedback).toHaveBeenCalledWith(failed);
    rerender(<ChecksControl {...props} stagedResultId="check-1" />);
    expect(screen.getByRole("button", { name: "Added to feedback" })).toBeDisabled();
    rerender(<ChecksControl {...props} stagedResultId={null} />);
    expect(screen.getByRole("button", { name: "Ask agent to fix" })).toBeEnabled();
  });

  it("can stage an execution error even without command output", () => {
    const error: ProjectCheckResult = { ...failed, status: "error", exitCode: null, error: "runtime unavailable", output: "" };
    const { onAddFeedback } = renderControl(error);
    expect(screen.getByText("Checks couldn’t run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
    expect(onAddFeedback).toHaveBeenCalledWith(error);
  });

  it("describes truncated output as an excerpt", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Output" }));
    expect(screen.getByLabelText("Check output")).toHaveTextContent("Bounded output excerpt; some lines were omitted");
    expect(screen.getByLabelText("Check output")).not.toHaveTextContent("Showing the end of the output");
  });

  it("keeps Stop available and shows the captured command during a saved-command change", () => {
    const onStop = vi.fn();
    renderControl(null, {
      command: "npm run lint", running: true, runningCommand: "npm test",
      startedAt: Date.now() - 3_000, disabledReason: "Project is busy", onStop,
    });
    const stop = screen.getByRole("button", { name: "Stop checks" });
    expect(stop).toBeEnabled();
    expect(stop).toHaveAttribute("title", "Stop npm test");
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText(/3s/)).toBeInTheDocument();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
  });
});
