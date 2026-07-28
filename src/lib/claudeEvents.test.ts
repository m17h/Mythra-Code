import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeClaudeEvent, type ClaudeEventContext } from "./claudeEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";

const context: ClaudeEventContext = {
  bindingFor: () => "/tmp/project",
  onStatus: vi.fn(),
  onError: vi.fn(),
  onTurnCompleted: vi.fn(),
  onApprovalRequested: vi.fn(),
  onTranscriptChanged: vi.fn(),
  onUnsupportedControlRequest: vi.fn(),
};

function send(message: Record<string, unknown>) {
  routeClaudeEvent(
    { threadId: "thread-1", turnId: "turn-1", message },
    context,
  );
}

describe("Claude event routing", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.clearAllMocks();
  });

  it("streams thinking and answer text into the compact timeline", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Checking files" },
      },
    });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Done." },
      },
    });
    useTaskStore.getState().flushDeltas();

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0]).toMatchObject({
      id: "message-1",
      text: "Done.",
      streaming: true,
    });
    expect(task.activities[0]).toMatchObject({
      id: "thinking-turn-1",
      kind: "reasoning",
      detail: "Checking files",
    });
  });

  it("turns Claude permission callbacks into normal OpenKiwi approvals", () => {
    send({
      type: "control_request",
      request_id: "request-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm test" },
        permission_suggestions: [{ type: "addRules" }],
      },
    });
    expect(
      useTaskStore.getState().tasks["thread-1"].approvals[0],
    ).toMatchObject({
      id: "request-1",
      method: "claude/can_use_tool",
      threadId: "thread-1",
    });
    expect(context.onApprovalRequested).toHaveBeenCalledWith("thread-1");
  });

  it("completes the turn after final output", () => {
    send({
      type: "assistant",
      message: {
        id: "message-1",
        content: [{ type: "text", text: "Finished" }],
      },
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 12, cache_read_input_tokens: 4, output_tokens: 8 },
    });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0]).toMatchObject({
      text: "Finished",
      streaming: false,
    });
    expect(task.status).toBe("completed");
    expect(task.usage).toMatchObject({
      totalTokens: 24,
      inputTokens: 16,
      cachedInputTokens: 4,
      outputTokens: 8,
    });
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");
  });

  it("does not turn a user interruption into a failed or completed task", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    useTaskStore.getState().setTaskStatus("thread-1", "interrupted");
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Interrupted by user",
    });

    expect(useTaskStore.getState().tasks["thread-1"].status).toBe(
      "interrupted",
    );
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenCalledWith("Stopped");
  });

  it("closes a running task when Claude exits without a result", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "openkiwi_exit",
      code: 1,
      message: "Authentication expired",
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("error");
    expect(task.error).toBe("Authentication expired");
    expect(task.activities.at(-1)).toMatchObject({
      title: "Claude Code stopped unexpectedly",
      status: "failed",
    });
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");
  });

  it("answers unknown control requests with an error instead of stalling", () => {
    send({
      type: "control_request",
      request_id: "request-9",
      request: { subtype: "hook_callback", data: {} },
    });

    expect(context.onUnsupportedControlRequest).toHaveBeenCalledWith(
      "thread-1",
      "request-9",
      "hook_callback",
    );
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks["thread-1"].activities.at(-1)).toMatchObject({
      kind: "warning",
      title: "Unsupported Claude Code request",
    });
  });
});
