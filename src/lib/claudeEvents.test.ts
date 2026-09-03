import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetClaudeEventUsageState, routeClaudeEvent, type ClaudeEventContext } from "./claudeEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { markProviderStopIntent } from "./providerStopIntent";

const context: ClaudeEventContext = {
  bindingFor: () => "/tmp/project",
  onStatus: vi.fn(),
  onError: vi.fn(),
  onTurnCompleted: vi.fn(),
  onApprovalRequested: vi.fn(),
  onTranscriptChanged: vi.fn(),
  onUnsupportedControlRequest: vi.fn(),
};

function send(message: Record<string, unknown>, turnId = "turn-1") {
  routeClaudeEvent(
    { threadId: "thread-1", turnId, message },
    context,
  );
}

describe("Claude event routing", () => {
  beforeEach(() => {
    resetClaudeEventUsageState();
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

  it("turns Claude permission callbacks into normal Mythra Code approvals", () => {
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

  it("keeps Claude spawn identity when its tool result completes", () => {
    send({
      type: "assistant",
      message: {
        id: "message-1",
        content: [{
          type: "tool_use",
          id: "spawn-1",
          name: "Task",
          input: {
            description: "Audit the Rust bridge",
            prompt: "Inspect the bridge and report risks.",
            model: "claude-opus-5",
          },
        }],
      },
    });
    send({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "Audit complete" }],
      },
    });

    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({
      id: "spawn-1",
      kind: "agent",
      status: "completed",
      detail: "Audit complete",
      agent: {
        action: "spawn",
        provider: "claude",
        model: "claude-opus-5",
        task: "Audit the Rust bridge",
        count: 1,
      },
    });
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
      usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 8 },
    });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0]).toMatchObject({
      text: "Finished",
      streaming: false,
    });
    expect(task.status).toBe("completed");
    expect(task.usage).toMatchObject({
      totalTokens: 27,
      inputTokens: 19,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      outputTokens: 8,
    });
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");
  });

  it("ignores late output from a completed Claude process", () => {
    useTaskStore.getState().setActiveTurn("thread-1", "turn-old");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    send({
      type: "assistant",
      message: { id: "old-final", content: [{ type: "text", text: "Finished" }] },
    }, "turn-old");
    send({ type: "result", subtype: "success", is_error: false }, "turn-old");

    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "late-message" } },
    }, "turn-old");
    send({
      type: "assistant",
      message: { id: "late-message", content: [{ type: "text", text: "Late output" }] },
    }, "turn-old");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages.map((message) => message.text)).toEqual(["Finished"]);
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it("does not let an older Claude process replace a newer active turn", () => {
    useTaskStore.getState().setActiveTurn("thread-1", "turn-new");
    useTaskStore.getState().setTaskStatus("thread-1", "running");

    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "old-message" } },
    }, "turn-old");
    send({ type: "result", subtype: "success", is_error: false }, "turn-old");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("running");
    expect(task.activeTurnId).toBe("turn-new");
    expect(task.messages).toEqual([]);
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onStatus).not.toHaveBeenCalledWith("Ready");
  });

  it("keeps accumulating input and output usage across Claude runs", () => {
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
    }, "turn-1");
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 80, cache_read_input_tokens: 10, output_tokens: 45 },
    }, "turn-2");

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      totalTokens: 285,
      inputTokens: 210,
      cachedInputTokens: 30,
      outputTokens: 75,
    });
  });

  it("counts assistant usage once when the final result repeats the turn total", () => {
    send({
      type: "assistant",
      message: {
        id: "message-usage",
        content: [{ type: "text", text: "Working" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
      },
    });
    send({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
    });

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it("retains usage from an interrupted run even when no result usage arrives", () => {
    send({
      type: "assistant",
      message: {
        id: "message-interrupted",
        content: [{ type: "text", text: "Partial work" }],
        usage: { input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 15 },
      },
    }, "turn-interrupted");

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      inputTokens: 80,
      cacheWriteInputTokens: 10,
      outputTokens: 15,
      totalTokens: 95,
    });
  });

  it("does not turn a user interruption into a failed or completed task", () => {
    useTaskStore.getState().setActiveThread("thread-1");
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

  it("honors explicit stop intent when exit races ahead of the stopped status write", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "openkiwi_exit", message: "process ended during kill" });

    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("interrupted");
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenCalledWith("Stopped");
  });

  it("does not disguise a recovered provider exit as a user stop", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    useTaskStore.getState().setTaskStatus("thread-1", "interrupted");
    send({ type: "openkiwi_exit", message: "MCP request ended unexpectedly" });

    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({
      status: "error",
      error: "MCP request ended unexpectedly",
    });
    expect(context.onError).toHaveBeenCalledWith("MCP request ended unexpectedly");
    expect(context.onStatus).toHaveBeenCalledWith("Task failed");
  });

  it("does not let a background thread overwrite the foreground status", () => {
    useTaskStore.getState().ensureTask("foreground");
    useTaskStore.getState().setActiveThread("foreground");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });

    expect(context.onStatus).not.toHaveBeenCalled();
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

  it("marks a Claude compact boundary in place and asks for a transcript save", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 154_231 },
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-boundary-1",
      kind: "compaction",
      title: "Context compacted",
      detail: "Claude Code · Automatic · 154K tokens before",
      status: "completed",
      turnId: "turn-1",
    }]);
    expect(context.onTranscriptChanged).toHaveBeenCalledWith("thread-1");
    // Status-bar copy is Ready/Working only; compaction never speaks there.
    expect(context.onStatus).not.toHaveBeenCalledWith(expect.stringContaining("ompact"));
  });

  it("keeps a replayed boundary on one row and leaves the transcript intact", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } },
    });
    useTaskStore.getState().flushDeltas();
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "manual", pre_tokens: 900 },
    };
    send(boundary);
    send(boundary);

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toHaveLength(1);
    expect(task.activities[0].detail).toBe("Claude Code · Manual · 900 tokens before");
    expect(task.messages.map((message) => message.text)).toEqual(["Before"]);
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
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
