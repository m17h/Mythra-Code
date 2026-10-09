import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactCompletedTurns, orderedTimelineEntries } from "../components/ChatTimeline";
import { resetCursorEventStateForTests, routeCursorEvent, type CursorEventContext } from "./cursorEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { markProviderStopIntent } from "./providerStopIntent";
import { acceptCursorTurnStart, beginCursorTurnStart } from "./cursorTurnOwnership";

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

function acceptReplacement(turnId: string) {
  const attempt = beginCursorTurnStart("thread-1", useTaskStore.getState().tasks["thread-1"]?.activeTurnId);
  acceptCursorTurnStart("thread-1", attempt, turnId);
  useTaskStore.getState().setActiveTurn("thread-1", turnId);
  useTaskStore.getState().setTaskStatus("thread-1", "running");
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

  it("uses a conservative category for unknown native kinds instead of their arbitrary title", () => {
    sessionUpdate({ sessionUpdate: "tool_call", toolCallId: "unknown", kind: "other", title: "Read", status: "in_progress" });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ workType: "commands" });
  });

  it.each([
    ["read", "research"], ["search", "research"], ["fetch", "research"],
    ["edit", "files"], ["delete", "files"], ["move", "files"], ["execute", "commands"],
  ])("attributes ACP %s by its kind and retains it through kindless update/reload", (kind, workType) => {
    sessionUpdate({ sessionUpdate: "tool_call", toolCallId: "tool", kind, title: "An arbitrary operation title", status: "in_progress" });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ workType, status: "inProgress" });
    sessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", rawOutput: "done" });
    const activity = useTaskStore.getState().tasks["thread-1"].activities[0];
    expect(activity).toMatchObject({ workType, status: "completed" });
    const snapshot = JSON.parse(JSON.stringify([activity]));
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", [], snapshot);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ workType, status: "completed" });
  });

  it("updates running state only on the first streaming event and stays quiet in the background", () => {
    useTaskStore.getState().ensureTask("foreground");
    useTaskStore.getState().setActiveThread("foreground");
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } });
    const statusesAfterFirst = useTaskStore.getState().statuses;
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } });

    expect(useTaskStore.getState().statuses).toBe(statusesAfterFirst);
    expect(context.onStatus).not.toHaveBeenCalled();
  });

  it("honors explicit stop intent when Cursor exit races ahead of the stopped status write", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "openkiwi_exit", message: "process ended during kill" });

    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("interrupted");
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenCalledWith("Stopped");
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
    // ACP does not report message phase; only the terminal turn may choose
    // its last text segment as a compatibility answer.
    expect(assistants.map((message) => message.phase)).toEqual([undefined, undefined]);
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
    expect(task.activities.some((activity) => activity.id === "late-tool")).toBe(false);
    // The stray chunk must not open a streaming bubble nothing will finalize.
    expect(task.messages.filter((message) => message.streaming)).toHaveLength(0);
    // A new turn still runs normally afterwards.
    acceptReplacement("turn-2");
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Next turn" },
    }, "turn-2");
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it("attaches an early Cursor plan notification to its turn", () => {
    send({
      type: "notification",
      method: "cursor/create_plan",
      params: { name: "Review plan", plan: "Inspect then report" },
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activeTurnId).toBe("turn-1");
    expect(task.status).toBe("running");
    expect(task.activities[0]).toMatchObject({
      id: "cursor-plan-turn-1",
      turnId: "turn-1",
      detail: "Inspect then report",
    });
  });

  it("retains every settled prompt's result usage without counting the last result twice", () => {
    send({ type: "result", result: { usage: { inputTokens: 50, outputTokens: 10 } }, promptResults: [
      { usage: { inputTokens: 100, outputTokens: 40 } },
      { usage: { inputTokens: 50, outputTokens: 10 } },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 150, outputTokens: 50 });
    send({ type: "result", result: { usage: { inputTokens: 50, outputTokens: 10 } }, promptResults: [
      { usage: { inputTokens: 100, outputTokens: 40 } },
      { usage: { inputTokens: 50, outputTokens: 10 } },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 150, outputTokens: 50 });
  });

  it("retains a successful prompt's usage when another admitted prompt fails", () => {
    send({ type: "openkiwi_error", message: "Added instructions failed", promptResults: [
      { usage: { inputTokens: 100, outputTokens: 40 } },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("error");
  });

  it("does not add prompt result totals over cumulative in-turn usage snapshots", () => {
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 150, outputTokens: 50 } });
    send({ type: "result", result: { usage: { inputTokens: 50, outputTokens: 10 } }, promptResults: [
      { usage: { inputTokens: 100, outputTokens: 40 } },
      { usage: { inputTokens: 50, outputTokens: 10 } },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 150, outputTokens: 50 });
  });

  it("retains a cancellation even when another prompt settles successfully last", () => {
    send({ type: "result", result: { stopReason: "end_turn" }, promptResults: [
      { stopReason: "cancelled" }, { stopReason: "end_turn" },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("interrupted");
  });

  it.each(["result", "openkiwi_error"])("does not let an old %s interrupt a newer turn", (type) => {
    useTaskStore.getState().setActiveThread("thread-1");
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New work" } }, "turn-2");
    vi.clearAllMocks();
    send({ type, message: "Old process exited", result: {}, promptResults: [{ usage: { inputTokens: 100, outputTokens: 40 } }] });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "turn-2", status: "running", usage: { inputTokens: 100, outputTokens: 40 } });
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onStatus).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("does not pump queued work twice for duplicate terminal events", () => {
    send({ type: "openkiwi_error", message: "Failed" });
    send({ type: "result", result: {} });
    send({ type: "openkiwi_exit", message: "Exited" });
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["assistant", { type: "notification", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old final text" } } } }],
    ["reasoning", { type: "notification", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Old thought" } } } }],
    ["tool", { type: "notification", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Old tool", status: "in_progress" } } }],
    ["plan", { type: "notification", method: "session/update", params: { update: { sessionUpdate: "plan", plan: { entries: [{ content: "Old plan", status: "in_progress" }] } } } }],
    ["create plan", { type: "notification", method: "cursor/create_plan", params: { name: "Old plan", plan: "Old plan" } }],
    ["todos", { type: "notification", method: "cursor/update_todos", params: { todos: [{ content: "Old todo", status: "in_progress" }] } }],
  ])("retains late %s output under its old turn without replacing the accepted successor", (_kind, message) => {
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Original work" } });
    useTaskStore.getState().flushDeltas();
    acceptReplacement("turn-2");
    vi.clearAllMocks();
    send(message);
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ activeTurnId: "turn-2", status: "running" });
    expect(task.assistantOutputTurnId).toBeUndefined();
    expect(task.messages.filter((entry) => entry.role === "assistant").every((entry) => entry.turnId === "turn-1")).toBe(true);
    expect(task.activities.every((entry) => entry.turnId === "turn-1")).toBe(true);
    expect(context.onStatus).not.toHaveBeenCalled();
    send({ type: "result", result: {} });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "turn-2", status: "running" });
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
  });

  it("accepts the first new-turn notification while startup is awaiting its acknowledgment", () => {
    useTaskStore.getState().setActiveTurn("thread-1", "prior-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Early response" } }, "new-turn");
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ activeTurnId: "new-turn", status: "running" });
    expect(task.messages.at(-1)).toMatchObject({ text: "Early response", turnId: "new-turn" });
  });

  it.each([
    { type: "permission_request", requestId: "early-permission", params: {} },
    { type: "cursor_request", method: "cursor/ask_question", requestId: "early-question", params: { questions: [{ question: "Which file?", options: [] }] } },
  ])("accepts an early $type before startup acknowledges the new identity", (message) => {
    useTaskStore.getState().setActiveTurn("thread-1", "prior-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    send(message, "new-turn");
    expect(context.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "new-turn", status: "running" });
    // An old process's later request cannot reclaim the identity just adopted.
    send({ ...message, requestId: "stale" }, "prior-turn");
    expect(context.onApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("ignores interactive requests from completed or superseded turns", () => {
    send({ type: "result", result: {} });
    send({ type: "permission_request", requestId: "finished", params: {} });
    acceptReplacement("turn-2");
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New work" } }, "turn-2");
    send({ type: "permission_request", requestId: "old", params: {} }, "older-turn");
    send({ type: "cursor_request", method: "cursor/ask_question", requestId: "question", params: { questions: [] } }, "older-turn");
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
    send({ type: "permission_request", requestId: "current", params: {} }, "turn-2");
    expect(context.onApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("preserves prompt usage regardless of settlement order", () => {
    send({ type: "result", result: { usage: { inputTokens: 100, outputTokens: 40 } }, promptResults: [
      { usage: { inputTokens: 50, outputTokens: 10 } },
      { usage: { inputTokens: 100, outputTokens: 40 } },
    ] });
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 150, outputTokens: 50 });
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

  it.each([true, false])("keeps a superseded snapshot from regressing the successor's usage baseline (prior snapshot: %s)", (priorSnapshot) => {
    sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Original work" } });
    if (priorSnapshot) sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 40 } });
    acceptReplacement("turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 150, outputTokens: 60 } }, "turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 125, outputTokens: 50 } });
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 175, outputTokens: 70 } }, "turn-2");
    send({ type: "result", result: { usage: { inputTokens: 125, outputTokens: 50 } } });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "turn-2", status: "running", usage: { inputTokens: 175, outputTokens: 70 } });
  });

  it("retains an older turn's snapshot until its successor supplies a cumulative baseline", () => {
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 40 } });
    acceptReplacement("turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 125, outputTokens: 50 } });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "turn-2", status: "running", usage: { inputTokens: 125, outputTokens: 50 } });
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 150, outputTokens: 60 } }, "turn-2");
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 150, outputTokens: 60 });
  });

  it("keeps the existing reset baseline when a resumed current turn reports lower counters", () => {
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 40 } });
    send({ type: "result", result: {} });
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    acceptReplacement("turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 20, outputTokens: 8 } }, "turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 30, outputTokens: 12 } }, "turn-2");
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ activeTurnId: "turn-2", status: "running", usage: { inputTokens: 110, outputTokens: 44 } });
  });

  it("does not regress a completed successor's cumulative baseline before another turn starts", () => {
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 40 } });
    acceptReplacement("turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 150, outputTokens: 60 } }, "turn-2");
    send({ type: "result", result: {} }, "turn-2");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 125, outputTokens: 50 } });
    acceptReplacement("turn-3");
    sessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 175, outputTokens: 70 } }, "turn-3");
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 175, outputTokens: 70 });
  });

  it("retains the latest owner's terminal receipt beyond unrelated historical cache churn", () => {
    send({ type: "result", result: { usage: { inputTokens: 12, outputTokens: 4 } } });
    for (let index = 0; index < 205; index += 1) send({ type: "result", result: {} }, `other-${index}`, `thread-${index + 2}`);
    vi.clearAllMocks();
    send({ type: "result", result: { usage: { inputTokens: 12, outputTokens: 4 } } });
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onTranscriptChanged).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
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
