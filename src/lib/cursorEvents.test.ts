import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactCompletedTurns, orderedTimelineEntries } from "../components/ChatTimeline";
import { resetCursorEventStateForTests, routeCursorEvent, type CursorEventContext } from "./cursorEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";

const context: CursorEventContext = {
  bindingFor: () => "/tmp/project",
  onStatus: vi.fn(),
  onError: vi.fn(),
  onTurnCompleted: vi.fn(),
  onApprovalRequested: vi.fn(),
  onTranscriptChanged: vi.fn(),
};

function send(message: Record<string, unknown>, turnId = "turn-1", threadId = "thread-1") {
  routeCursorEvent({ threadId, turnId, message }, context);
}

function sessionUpdate(update: Record<string, unknown>, turnId = "turn-1", threadId = "thread-1") {
  send({ type: "notification", method: "session/update", params: { update } }, turnId, threadId);
}

describe("Cursor event routing", () => {
  beforeEach(() => {
    resetCursorEventStateForTests();
    resetTaskStore();
    vi.clearAllMocks();
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-1", "starting");
    store.appendUserMessage("thread-1", { id: "user", role: "user", text: "Review the game" });
  });

  it("finalizes Markdown and places the final answer after tool activity", () => {
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I’ll inspect the project first." },
    });
    useTaskStore.getState().flushDeltas();

    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "find-files",
      kind: "search",
      title: "Find",
      status: "in_progress",
      rawInput: { pattern: "*.gd" },
    });
    sessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "find-files",
      status: "completed",
      rawOutput: { totalFiles: 71 },
    });
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Start with **talents** next." },
    });
    send({ type: "result", result: { stopReason: "end_turn" } });

    const task = useTaskStore.getState().tasks["thread-1"];
    const assistants = task.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.map((message) => message.streaming)).toEqual([false, false]);
    expect(assistants[1]).toMatchObject({ text: "Start with **talents** next.", turnStatus: "completed" });
    expect(assistants[0].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
    expect(task.activities[0].timelineOrder).toBeLessThan(assistants[1].timelineOrder!);

    const compacted = compactCompletedTurns(orderedTimelineEntries(task.messages, task.activities), false);
    expect(compacted.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
    expect(compacted.at(-1)).toMatchObject({
      kind: "message",
      value: { text: "Start with **talents** next.", streaming: false },
    });
  });

  it("keeps late tool status updates from splitting the final answer", () => {
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "grep",
      kind: "search",
      title: "grep",
      status: "in_progress",
    });
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The best next step " },
    });
    sessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "grep",
      status: "completed",
      rawOutput: { totalMatches: 12 },
    });
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "is talents." },
    });
    send({ type: "result", result: {} });

    const assistants = useTaskStore.getState().tasks["thread-1"].messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "The best next step is talents.", streaming: false });
  });

  it("finalizes the streaming answer when the agent stops with an error", () => {
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Partial answer" },
    });
    send({ type: "openkiwi_error", message: "cursor-agent crashed" });

    const assistants = useTaskStore.getState().tasks["thread-1"].messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "Partial answer", streaming: false, turnStatus: "failed" });
  });

  it("completes the thinking activity even when its deltas are still queued at the result", () => {
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Considering the layout." },
    });
    send({ type: "result", result: {} });

    const thinking = useTaskStore.getState().tasks["thread-1"].activities.find((activity) => activity.id === "thinking-turn-1");
    expect(thinking).toMatchObject({ detail: "Considering the layout.", status: "completed" });
  });

  it("does not create an empty assistant bubble from non-text chunks", () => {
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "…" },
    });
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "ls",
      title: "List",
      status: "in_progress",
    });
    send({ type: "result", result: {} });

    const assistants = useTaskStore.getState().tasks["thread-1"].messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("keeps a late session/update from resurrecting a completed turn", () => {
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "All done." },
    });
    send({ type: "result", result: { stopReason: "end_turn" } });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("completed");

    sessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "late-tool",
      status: "completed",
      rawOutput: { totalMatches: 2 },
    });
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "stray chunk" },
    });
    useTaskStore.getState().flushDeltas();

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("completed");
    expect(task.activeTurnId).toBeUndefined();
    // The stray chunk must not open a streaming bubble nothing will finalize.
    expect(task.messages.filter((message) => message.streaming)).toHaveLength(0);
    // A new turn still runs normally afterwards.
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Next turn" },
    }, "turn-2");
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it("counts usage once when a turn emits both usage snapshots and a result total", () => {
    sessionUpdate({
      sessionUpdate: "usage_update",
      usage: { inputTokens: 100, outputTokens: 40 },
    });
    sessionUpdate({
      sessionUpdate: "usage_update",
      usage: { inputTokens: 200, outputTokens: 80 },
    });
    send({ type: "result", result: { usage: { inputTokens: 200, outputTokens: 80 } } });

    const usage = useTaskStore.getState().tasks["thread-1"].usage;
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 80 });

    // A turn without in-turn snapshots still records its result total.
    send({ type: "result", result: { usage: { inputTokens: 50, outputTokens: 10 } } }, "turn-2");
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 250, outputTokens: 90 });
  });

  it("keeps one thread's tool boundary from finalizing another thread's stream", () => {
    useTaskStore.getState().setTaskStatus("thread-2", "starting");
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Thread two is still talking" },
    }, "turn-2", "thread-2");
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "grep",
      title: "grep",
      status: "in_progress",
    });

    const other = useTaskStore.getState().tasks["thread-2"].messages.filter((message) => message.role === "assistant");
    expect(other).toHaveLength(1);
    expect(other[0].streaming).toBe(true);

    send({ type: "result", result: {} }, "turn-2", "thread-2");
    const finished = useTaskStore.getState().tasks["thread-2"].messages.filter((message) => message.role === "assistant");
    expect(finished[0]).toMatchObject({ text: "Thread two is still talking", streaming: false, turnStatus: "completed" });
  });
});
