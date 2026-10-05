import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeClaudeEvent, resetClaudeEventUsageState, type ClaudeEventContext } from "./claudeEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { useClaudeContinuationStore } from "./claudeContinuation";

const context: ClaudeEventContext = {
  bindingFor: () => "/tmp/project",
  onStatus: vi.fn(), onError: vi.fn(), onTurnCompleted: vi.fn(),
  onApprovalRequested: vi.fn(), onTranscriptChanged: vi.fn(),
  onUnsupportedControlRequest: vi.fn(),
};
const send = (message: Record<string, unknown>, turnId = "turn") => routeClaudeEvent({ threadId: "thread", turnId, message }, context);

describe("Claude usage-limit refusal diagnostics", () => {
  beforeEach(() => {
    resetClaudeEventUsageState();
    resetTaskStore();
    useTaskStore.setState({ activeThreadId: "thread" });
    useClaudeContinuationStore.setState({ byThread: {} });
    vi.clearAllMocks();
    send({ type: "system", subtype: "init" });
  });

  it("explains an explicit runtime refusal without stopping the process or losing the reset message", () => {
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } });
    const refusal = "You've hit your session limit · resets 5:20am (America/New_York)";
    const message = { type: "assistant", error: "rate_limit", message: { id: "refusal", content: [{ type: "text", text: refusal }] } };
    send(message);
    send(message);
    const task = useTaskStore.getState().tasks.thread;
    expect(task.status).toBe("running");
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(useClaudeContinuationStore.getState().byThread.thread).toBeUndefined();
    const diagnostics = task.activities.filter((row) => row.id === "claude-usage-limit-turn");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].title).toBe("Claude usage limit reached");
    expect(diagnostics[0].detail).toContain(refusal);
    expect(diagnostics[0].detail).toContain("not guaranteed");
    expect(diagnostics[0].detail).toContain("rollout");
    expect(diagnostics[0].detail).toContain("has not enabled paid usage");
    expect(task.messages.find((entry) => entry.id === "refusal")?.text).toBe(refusal);
  });

  it("does not treat ordinary model text about limits as a refusal", () => {
    send({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: "You can discuss the session limit and wrap-up here." }] } });
    expect(useTaskStore.getState().tasks.thread.activities).toHaveLength(0);
  });

  it("preserves structured terminal error strings when Claude supplies no result text", () => {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["You've hit your session limit · resets 5:20am", { token: "not an error string" }, "Second runtime detail"] });
    expect(context.onError).toHaveBeenCalledWith("You've hit your session limit · resets 5:20am\nSecond runtime detail");
    expect(useTaskStore.getState().tasks.thread.error).toBe("You've hit your session limit · resets 5:20am\nSecond runtime detail");
  });

  it("prefers the runtime result text and keeps malformed errors on the existing generic fallback", () => {
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "Original runtime error", errors: ["Secondary"] });
    expect(context.onError).toHaveBeenLastCalledWith("Original runtime error");
    send({ type: "system", subtype: "init" }, "next");
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: [{ secret: "must not stringify" }, 123, " "] }, "next");
    expect(context.onError).toHaveBeenLastCalledWith("Claude could not complete this request.");
  });
});
