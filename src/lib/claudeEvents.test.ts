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

  it("surfaces a successful Claude result that produced no response", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "result", subtype: "success", is_error: false, result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({
      status: "error",
      lastCompletedTurnId: "turn-1",
      lastCompletedTurnStatus: "error",
      error: expect.stringContaining("finished without returning a response"),
    });
    expect(task.activities).toMatchObject([{
      id: "claude-empty-result-turn-1",
      kind: "warning",
      title: "Claude Code returned no response",
      status: "failed",
      turnId: "turn-1",
      turnStatus: "failed",
    }]);
    expect(context.onError).toHaveBeenCalledWith(expect.stringContaining("Your prompt was saved"));
    expect(context.onStatus).toHaveBeenCalledWith("Task failed");
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");

    send({ type: "result", subtype: "success", is_error: false, result: "" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(1);
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);

    const savedMessages = JSON.parse(JSON.stringify(task.messages));
    const savedActivities = JSON.parse(JSON.stringify(task.activities));
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", savedMessages, savedActivities);
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{
      id: "claude-empty-result-turn-1",
      turnStatus: "failed",
    }]);
  });

  it("recovers result text when Claude's assistant event was lost", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "result", subtype: "success", is_error: false, result: "Recovered answer" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.messages).toMatchObject([{
      id: "claude-turn-1",
      role: "assistant",
      text: "Recovered answer",
      turnId: "turn-1",
      turnStatus: "completed",
    }]);
    expect(task.activities).toHaveLength(0);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("does not duplicate assistant text repeated in the result payload", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: { id: "message-1", content: [{ type: "text", text: "One answer" }] },
    });
    send({ type: "result", subtype: "success", result: "One answer" });

    expect(useTaskStore.getState().tasks["thread-1"].messages).toMatchObject([{
      id: "message-1",
      text: "One answer",
      turnStatus: "completed",
    }]);
    expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(1);
  });

  it("accepts a tool-only Claude turn as meaningful output", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: {
        id: "tool-only-message",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } }],
      },
    });
    send({ type: "result", subtype: "success", is_error: false, result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      id: "tool-1",
      kind: "command",
      title: "/tmp/a",
      turnStatus: "completed",
    }]);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("does not mistake an unrendered thinking-only message for a visible response", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: {
        id: "thinking-only-message",
        content: [{ type: "thinking", thinking: "Internal thought" }],
      },
    });
    send({ type: "result", subtype: "success", is_error: false, result: "   " });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("error");
    expect(task.messages).toHaveLength(0);
    expect(task.activities[0].title).toBe("Claude Code returned no response");
    expect(context.onError).toHaveBeenCalledOnce();
  });

  it("accepts a streamed reasoning-only turn because its activity is visible", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Visible reasoning" },
      },
    });
    send({ type: "result", subtype: "success", result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      kind: "reasoning",
      detail: "Visible reasoning",
      turnStatus: "completed",
    }]);
    expect(task.activities.find((entry) => entry.kind === "warning")).toBeUndefined();
  });

  it("keeps empty-result detection isolated between concurrent threads", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: { id: "message-1", content: [{ type: "text", text: "Thread one answer" }] },
    });
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "system", subtype: "init" } },
      context,
    );
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "result", subtype: "success", result: "" } },
      context,
    );

    expect(useTaskStore.getState().tasks["thread-2"].status).toBe("error");
    expect(useTaskStore.getState().tasks["thread-2"].activities[0].title).toBe("Claude Code returned no response");
    send({ type: "result", subtype: "success", result: "" });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("completed");
    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(0);
  });

  it("recovers result text without overwriting a prior turn after a delayed result", () => {
    send({ type: "system", subtype: "init" }, "turn-a");
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-a" } },
    }, "turn-a");
    send({
      type: "assistant",
      message: { id: "message-a", content: [{ type: "text", text: "Answer A" }] },
    }, "turn-a");

    send({ type: "system", subtype: "init" }, "turn-b");
    send({ type: "result", subtype: "success", result: "" }, "turn-a");
    send({ type: "result", subtype: "success", result: "Recovered B" }, "turn-b");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.messages).toMatchObject([
      { id: "message-a", text: "Answer A", turnId: "turn-a" },
      { id: "claude-turn-b", text: "Recovered B", turnId: "turn-b", turnStatus: "completed" },
    ]);
  });

  it("accepts a compaction-only Claude turn as visible output", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start-1" });
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 1234 },
    });
    send({ type: "result", subtype: "success", result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      kind: "compaction",
      status: "completed",
      turnStatus: "completed",
    }]);
    expect(context.onError).not.toHaveBeenCalled();
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

  it("honors explicit stop intent when Claude returns an empty success", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "result", subtype: "success", is_error: false, result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("interrupted");
    expect(task.activities).toHaveLength(0);
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

  it("places a compact boundary after earlier text even before the next frame flush", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } } });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 100 } });
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("animates a Claude compaction from the status message and never speaks in the status bar", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      kind: "compaction",
      title: "Compacting context",
      detail: "Claude Code",
      status: "inProgress",
      turnId: "turn-1",
    }]);
    expect(context.onTranscriptChanged).toHaveBeenCalledWith("thread-1");
    expect(context.onStatus).not.toHaveBeenCalledWith(expect.stringContaining("ompact"));
    expect(context.onStatus).toHaveBeenCalledWith("Working");
  });

  it("folds the boundary into the animating row instead of adding a second marker", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    const started = useTaskStore.getState().tasks["thread-1"].activities[0];
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 154_231 },
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Context compacted",
      detail: "Claude Code · Automatic · 154K tokens before",
      status: "completed",
      turnId: "turn-1",
    }]);
    expect(task.activities[0].timelineOrder).toBe(started.timelineOrder);
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("keeps a merged boundary deduplicated when it is replayed", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 900 },
    };
    send(boundary);
    send(boundary);
    send({ type: "system", subtype: "status", status: null, uuid: "status-2" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toHaveLength(1);
    // The closing status is not evidence either way once the boundary landed.
    expect(task.activities[0]).toMatchObject({ id: "claude-compaction-status-1", status: "completed" });
  });

  it("stops the animation on a null status without claiming the compaction finished", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: null, uuid: "status-2" });

    const settled = useTaskStore.getState().tasks["thread-1"].activities;
    expect(settled).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Compaction ended",
      status: "unconfirmed",
    }]);

    // A boundary arriving after the close is still the proof of success, and
    // it belongs on the same row at the same timeline position.
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "manual", pre_tokens: 2_000 },
    });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Context compacted",
      detail: "Claude Code · Manual · 2.0K tokens before",
      status: "completed",
    }]);
    expect(task.activities[0].timelineOrder).toBe(settled[0].timelineOrder);
  });

  it("uses an explicit successful reset before the boundary without flashing a failure", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "end" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "completed", title: "Context compacted" }]);
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary", compact_metadata: { trigger: "manual", pre_tokens: 12320 } });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{
      id: "claude-compaction-start", status: "completed", detail: "Claude Code · Manual · 12K tokens before",
      compaction: { boundaryId: "boundary", endStatusId: "end" },
    }]);
  });

  it("binds the live turn when compaction begins before system/init", () => {
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ activeTurnId: "turn-1", status: "running" });
    useTaskStore.getState().hydrateTask("thread-1", [], task.activities);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].status).toBe("inProgress");
  });

  it.each([{ compact_result: "failed" }, { compact_error: "too_few_groups" }])("honors an explicit failed reset: %j", (outcome) => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status: null, uuid: "end", ...outcome });
    send({ type: "system", subtype: "status", status: null, uuid: "later-reset" });
    send({ type: "result", subtype: "success" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "failed" }]);
  });

  it("retains replay identities through a saved transcript reload while another compaction is active", () => {
    send({ type: "system", subtype: "init" });
    const start = { type: "system", subtype: "status", status: "compacting", uuid: "start" };
    const end = { type: "system", subtype: "status", status: null, compact_result: "success", uuid: "end" };
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary" };
    send(start); send(end); send(boundary);
    const saved = JSON.parse(JSON.stringify(useTaskStore.getState().tasks["thread-1"].activities));
    resetTaskStore(); resetClaudeEventUsageState();
    useTaskStore.getState().hydrateTask("thread-1", [], saved);
    useTaskStore.getState().setActiveTurn("thread-1", "turn-1");
    send({ ...start, uuid: "next-start" });
    send(start); send(end); send(boundary);
    expect(useTaskStore.getState().tasks["thread-1"].activities.map((entry) => entry.status)).toEqual(["completed", "inProgress"]);
  });

  it("does not overwrite a failed attempt with a later completion-only boundary", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "failed-start" });
    send({ type: "system", subtype: "status", status: null, compact_error: "failed", uuid: "failed-end" });
    send({ type: "system", subtype: "compact_boundary", uuid: "later-boundary" });
    expect(useTaskStore.getState().tasks["thread-1"].activities.map((entry) => entry.status)).toEqual(["failed", "completed"]);
  });

  it.each([undefined, "", "requesting"])("ignores malformed or unrelated status %s", (status) => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status, uuid: "other" });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].status).toBe("inProgress");
  });

  it("gives each compaction in a turn its own row", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 1_000 } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-2" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-2", compact_metadata: { trigger: "auto", pre_tokens: 2_000 } });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities.map((activity) => activity.id)).toEqual([
      "claude-compaction-status-1",
      "claude-compaction-status-2",
    ]);
    expect(task.activities.map((activity) => activity.detail)).toEqual([
      "Claude Code · Automatic · 1.0K tokens before",
      "Claude Code · Automatic · 2.0K tokens before",
    ]);
  });

  it("repeats a start status onto the row it already opened", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-2" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{ id: "claude-compaction-status-1", status: "inProgress" }]);
  });

  it("does not let a completed turn promote an unfinished compaction", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "result", subtype: "success", usage: { input_tokens: 5, output_tokens: 5 } });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      title: "Context compaction did not finish",
      status: "interrupted",
    }]);
    expect(task.status).toBe("completed");
    expect(context.onStatus).toHaveBeenCalledWith("Ready");
  });

  it("settles a compaction left animating by a provider exit", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "openkiwi_exit", code: 1, message: "Authentication expired" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities[0]).toMatchObject({
      id: "claude-compaction-status-1",
      title: "Context compaction did not finish",
      status: "failed",
    });
  });

  it("ignores compaction events replayed after the turn is retired", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "Done" }] } });
    send({ type: "result", subtype: "success" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-late" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-late", compact_metadata: { trigger: "auto", pre_tokens: 100 } });

    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(0);
  });

  it("keeps one thread's compaction out of another thread's timeline", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "stream_event", event: { type: "message_start", message: { id: "message-2" } } } },
      context,
    );
    routeClaudeEvent(
      {
        threadId: "thread-2",
        turnId: "turn-2",
        message: { type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 300 } },
      },
      context,
    );

    const tasks = useTaskStore.getState().tasks;
    expect(tasks["thread-1"].activities).toMatchObject([{ id: "claude-compaction-status-1", status: "inProgress" }]);
    expect(tasks["thread-2"].activities).toMatchObject([{ id: "claude-compaction-boundary-1", status: "completed", turnId: "turn-2" }]);
  });

  it("leaves an unrecognised status message alone", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: "some_future_phase", uuid: "status-2" });

    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "inProgress" }]);
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
