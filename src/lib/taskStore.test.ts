import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { durationForTurn, resetTurnDurationsForTests } from "./turnDurations";

describe("task store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTurnDurationsForTests();
    resetTaskStore();
  });

  it("routes streamed output to the correct thread", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/a");
    store.ensureTask("thread-b", "/b");
    store.setActiveThread("thread-a");
    store.queueAssistantDelta("thread-b", "message-1", "hello");
    store.queueAssistantDelta("thread-b", "message-1", " world");
    store.flushDeltas();

    const state = useTaskStore.getState();
    expect(state.tasks["thread-a"].messages).toEqual([]);
    expect(state.tasks["thread-b"].messages[0].text).toBe("hello world");
    expect(state.tasks["thread-b"].unread).toBe(true);
  });

  it("batches reasoning deltas and keeps them separate by thread", () => {
    const store = useTaskStore.getState();
    store.queueReasoningDelta("thread-a", "reasoning", "summary", "summary");
    store.queueReasoningDelta("thread-b", "reasoning", "private ", "content");
    store.queueReasoningDelta("thread-b", "reasoning", "details", "content");
    store.flushDeltas();

    expect(useTaskStore.getState().tasks["thread-a"].activities[0].detail).toBe("summary");
    expect(useTaskStore.getState().tasks["thread-b"].activities[0].detail).toBe("private details");
  });

  it("queues concurrent approvals without replacing them", () => {
    const store = useTaskStore.getState();
    store.enqueueApproval({ id: 1, method: "item/commandExecution/requestApproval", params: {}, threadId: "thread-a", receivedAt: 1 });
    store.enqueueApproval({ id: 2, method: "item/fileChange/requestApproval", params: {}, threadId: "thread-a", receivedAt: 2 });

    expect(useTaskStore.getState().tasks["thread-a"].approvals).toHaveLength(2);
    useTaskStore.getState().resolveApproval("thread-a", 1);
    expect(useTaskStore.getState().tasks["thread-a"].approvals.map((entry) => entry.id)).toEqual([2]);
  });

  it("clears every queued approval for a thread at once", () => {
    const store = useTaskStore.getState();
    store.enqueueApproval({ id: 1, method: "item/commandExecution/requestApproval", params: {}, threadId: "thread-a", receivedAt: 1 });
    store.enqueueApproval({ id: 2, method: "item/fileChange/requestApproval", params: {}, threadId: "thread-a", receivedAt: 2 });
    store.enqueueApproval({ id: 3, method: "item/commandExecution/requestApproval", params: {}, threadId: "thread-b", receivedAt: 3 });

    store.clearApprovals("thread-a");
    expect(useTaskStore.getState().tasks["thread-a"].approvals).toEqual([]);
    expect(useTaskStore.getState().tasks["thread-b"].approvals).toHaveLength(1);
    // Clearing a thread without approvals (or without a task) is a no-op.
    store.clearApprovals("thread-a");
    store.clearApprovals("thread-missing");
    expect(useTaskStore.getState().tasks["thread-missing"]).toBeUndefined();
  });

  it("tracks per-thread status independently", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "running");
    store.setTaskStatus("thread-b", "completed");
    expect(useTaskStore.getState().statuses).toEqual({ "thread-a": "running", "thread-b": "completed" });
  });

  it("anchors one working duration across starting and running, then clears it", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "starting");
    const startedAt = useTaskStore.getState().tasks["thread-a"].workingStartedAt;
    expect(startedAt).toEqual(expect.any(Number));

    store.setTaskStatus("thread-a", "running");
    expect(useTaskStore.getState().tasks["thread-a"].workingStartedAt).toBe(startedAt);

    store.setTaskStatus("thread-a", "completed");
    expect(useTaskStore.getState().tasks["thread-a"].workingStartedAt).toBeUndefined();
  });

  it("tracks the active runtime turn independently for each thread", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-a");
    store.setActiveTurn("thread-b", "turn-b");
    store.setActiveTurn("thread-a", undefined);

    expect(useTaskStore.getState().tasks["thread-a"].activeTurnId).toBeUndefined();
    expect(useTaskStore.getState().tasks["thread-b"].activeTurnId).toBe("turn-b");
  });

  it("tags optimistic input and subsequent steering with the runtime turn id", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "starting");
    store.appendUserMessage("thread-a", { id: "initial", role: "user", text: "Fix it" });
    store.setActiveTurn("thread-a", "turn-a");
    store.setTaskStatus("thread-a", "running");
    store.appendUserMessage("thread-a", { id: "steer", role: "user", text: "Also test it" });
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "npm test" });
    store.completeMessage("thread-a", { id: "answer", role: "assistant", text: "Done" });

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages.map((message) => message.turnId)).toEqual(["turn-a", "turn-a", "turn-a"]);
    expect(task.activities[0].turnId).toBe("turn-a");
  });

  it("finds optimistic input when callers mark the turn starting after appending", () => {
    const store = useTaskStore.getState();
    store.appendUserMessage("thread-a", { id: "scheduled", role: "user", text: "Run the schedule" });
    store.setTaskStatus("thread-a", "starting");
    store.setActiveTurn("thread-a", "turn-scheduled");

    expect(useTaskStore.getState().tasks["thread-a"].messages[0].turnId).toBe("turn-scheduled");
  });

  it("does not carry a failed optimistic turn boundary into a retry", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "starting");
    store.appendUserMessage("thread-a", { id: "failed", role: "user", text: "First attempt" });
    store.removeMessage("thread-a", "failed");
    store.setTaskStatus("thread-a", "error");
    store.appendUserMessage("thread-a", { id: "retry", role: "user", text: "Retry" });
    store.setTaskStatus("thread-a", "starting");
    store.setActiveTurn("thread-a", "turn-retry");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0]).toMatchObject({ id: "retry", turnId: "turn-retry" });
  });

  it("records exact turn completion without clearing a newer active turn", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-new");
    store.completeTurn("thread-a", "turn-old", "completed");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.activeTurnId).toBe("turn-new");
    expect(task.lastCompletedTurnId).toBe("turn-old");
    expect(task.lastCompletedTurnStatus).toBe("completed");
  });

  it("preserves the last completed turn when a completion arrives without a turn id", () => {
    const store = useTaskStore.getState();
    store.completeTurn("thread-a", "turn-1", "completed");
    store.completeTurn("thread-a", undefined, "error");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.lastCompletedTurnId).toBe("turn-1");
    expect(task.lastCompletedTurnStatus).toBe("completed");
    expect(task.status).toBe("error");
  });

  it("records the active turn as completed when the completion omits its id", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-live");
    store.completeTurn("thread-a", undefined, "completed");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.lastCompletedTurnId).toBe("turn-live");
    expect(task.lastCompletedTurnStatus).toBe("completed");
  });

  it("persists the exact completion status on every entry in a turn", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "starting");
    store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Fix it" });
    store.setActiveTurn("thread-a", "turn-a");
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "npm test" });
    store.completeMessage("thread-a", { id: "partial", role: "assistant", text: "I started" });
    store.completeTurn("thread-a", "turn-a", "interrupted");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages.map((message) => message.turnStatus)).toEqual(["interrupted", "interrupted"]);
    expect(task.activities[0].turnStatus).toBe("interrupted");
  });

  it("records a completed turn duration and restores it with hydrated history", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
      const store = useTaskStore.getState();
      store.setTaskStatus("thread-a", "starting");
      store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Fix it" });
      store.setActiveTurn("thread-a", "turn-a");
      store.upsertActivity("thread-a", { id: "command", kind: "command", title: "npm test" });
      store.completeMessage("thread-a", { id: "answer", role: "assistant", text: "Done" });

      vi.advanceTimersByTime(10 * 60_000);
      store.completeTurn("thread-a", "turn-a", "completed");

      const completed = useTaskStore.getState().tasks["thread-a"];
      expect(completed.messages.map((message) => message.turnDurationMs)).toEqual([600_000, 600_000]);
      expect(completed.activities[0].turnDurationMs).toBe(600_000);
      expect(durationForTurn("thread-a", "turn-a")).toBe(600_000);

      resetTaskStore();
      useTaskStore.getState().hydrateTask(
        "thread-a",
        [{ id: "user", role: "user", text: "Fix it", turnId: "turn-a", turnStatus: "completed" }],
        [{ id: "command", kind: "command", title: "npm test", turnId: "turn-a", turnStatus: "completed" }],
      );
      const hydrated = useTaskStore.getState().tasks["thread-a"];
      expect(hydrated.messages[0].turnDurationMs).toBe(600_000);
      expect(hydrated.activities[0].turnDurationMs).toBe(600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains elapsed time when an idle status arrives before turn completion", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
      const store = useTaskStore.getState();
      store.setTaskStatus("thread-a", "starting");
      store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Fix it" });
      store.setActiveTurn("thread-a", "turn-a");
      store.upsertActivity("thread-a", { id: "command", kind: "command", title: "npm test" });

      vi.advanceTimersByTime(90_000);
      store.setTaskStatus("thread-a", "idle");
      store.completeTurn("thread-a", "turn-a", "completed");

      expect(useTaskStore.getState().tasks["thread-a"].activities[0].turnDurationMs).toBe(90_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns chronology once and preserves it when activity completes", () => {
    const store = useTaskStore.getState();
    store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Check it" });
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "git status", status: "inProgress" });
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "git status", detail: "clean", status: "completed" });
    store.completeMessage("thread-a", { id: "assistant", role: "assistant", text: "Done" });

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages[0].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
    expect(task.activities[0].timelineOrder).toBeLessThan(task.messages[1].timelineOrder!);
  });
});
