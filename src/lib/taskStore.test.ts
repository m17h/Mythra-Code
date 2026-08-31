import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateTranscriptBytes,
  isAssistantOutputActive,
  resetTaskStore,
  sanitizeStoredQueuedTurns,
  setTranscriptCacheByteBudgetForTests,
  useTaskStore,
} from "./taskStore";
import { durationForTurn, resetTurnDurationsForTests } from "./turnDurations";

describe("task store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTurnDurationsForTests();
    resetTaskStore();
  });

  it("clears terminal child activity for a new run but keeps active workers stoppable", () => {
    useTaskStore.getState().upsertAgent("root", { id: "working", prompt: "Work", status: "inProgress" });
    useTaskStore.getState().upsertAgent("root", { id: "failed", prompt: "Old", status: "failed" });
    useTaskStore.getState().beginAgentRun("root", 123);
    expect(useTaskStore.getState().tasks.root.agents).toEqual([
      expect.objectContaining({ id: "working" }),
    ]);
    expect(useTaskStore.getState().tasks.root.agentRunStartedAt).toBe(123);
  });

  it("evicts the coldest idle transcripts beyond the working set on thread switch", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    for (let index = 0; index < 14; index += 1) {
      const threadId = `thread-${index}`;
      store.hydrateTask(threadId, [{ id: `m-${index}`, role: "user", text: "hi" }], [], "/p");
    }
    store.setHistory("thread-1", { paginated: true, hasMore: true, nextCursor: "older" });
    // Age every hydrated task past the save-debounce safety window, and make
    // one of the coldest ineligible by marking it running.
    useTaskStore.setState((state) => ({
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([threadId, task], index) => [
        threadId,
        { ...task, updatedAt: old + index },
      ])),
      statuses: { ...state.statuses, "thread-0": "running" },
    }));
    useTaskStore.getState().setActiveThread("thread-13");
    const tasks = useTaskStore.getState().tasks;
    const hydrated = Object.values(tasks).filter((task) => task.messages.length > 0).map((task) => task.threadId);
    // 14 hydrated, cap 12 → the two coldest eligible (thread-1, thread-2) are
    // evicted; running thread-0 keeps its transcript.
    expect(hydrated).toHaveLength(12);
    expect(tasks["thread-0"].messages).toHaveLength(1);
    expect(tasks["thread-1"].messages).toHaveLength(0);
    expect(tasks["thread-2"].messages).toHaveLength(0);
    expect(tasks["thread-1"].history).toMatchObject({ paginated: false, hasMore: false, nextCursor: null });
    // The shell survives eviction so approvals/queues/agents would too.
    expect(tasks["thread-1"]).toBeDefined();
  });

  it("never evicts a local transcript whose durable save is still pending", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    for (let index = 0; index < 14; index += 1) {
      store.hydrateTask(`thread-${index}`, [{ id: `m-${index}`, role: "user", text: "hi" }], [], "/p");
    }
    useTaskStore.setState((state) => ({
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([threadId, task], index) => [
        threadId,
        { ...task, updatedAt: old + index },
      ])),
      statuses: { ...state.statuses, "thread-0": "running" },
    }));
    useTaskStore.getState().setTranscriptDirty("thread-1", true);

    useTaskStore.getState().setActiveThread("thread-13");

    const tasks = useTaskStore.getState().tasks;
    expect(tasks["thread-1"].messages).toHaveLength(1);
    expect(tasks["thread-1"].transcriptDirty).toBe(true);
    expect(tasks["thread-2"].messages).toHaveLength(0);
    expect(tasks["thread-3"].messages).toHaveLength(0);
  });

  it("evicts cold transcripts by estimated bytes even below the count cap", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    for (let index = 0; index < 3; index += 1) {
      store.hydrateTask(`thread-${index}`, [{
        id: `message-${index}`,
        role: "assistant",
        text: `${index}`.repeat(1_000),
      }], [], "/p");
    }
    useTaskStore.setState((state) => ({
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([threadId, task], index) => [
        threadId,
        { ...task, updatedAt: old + index },
      ])),
    }));
    const before = useTaskStore.getState().tasks;
    const totalBytes = Object.values(before).reduce((total, task) => total + task.estimatedTranscriptBytes, 0);
    const firstBytes = before["thread-0"].estimatedTranscriptBytes;
    setTranscriptCacheByteBudgetForTests(totalBytes - 1, totalBytes - firstBytes);

    useTaskStore.getState().setActiveThread("thread-2");

    const tasks = useTaskStore.getState().tasks;
    expect(tasks["thread-0"].messages).toHaveLength(0);
    expect(tasks["thread-0"].estimatedTranscriptBytes).toBe(0);
    expect(tasks["thread-1"].messages).toHaveLength(1);
    expect(tasks["thread-2"].messages).toHaveLength(1);

    useTaskStore.getState().hydrateTask("thread-0", [{ id: "again", role: "assistant", text: "rehydrated" }], [], "/p");
    const rehydrated = useTaskStore.getState().tasks["thread-0"];
    expect(rehydrated.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(rehydrated.messages, rehydrated.activities));
  });

  it("can evict an unread transcript while preserving its shell flag", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    store.hydrateTask("unread", [{ id: "background", role: "assistant", text: "finished in the background" }], [], "/p");
    store.hydrateTask("active", [{ id: "foreground", role: "assistant", text: "visible" }], [], "/p");
    useTaskStore.setState((state) => ({
      tasks: {
        ...state.tasks,
        unread: { ...state.tasks.unread, unread: true, updatedAt: old },
        active: { ...state.tasks.active, updatedAt: old + 1 },
      },
    }));
    const total = Object.values(useTaskStore.getState().tasks).reduce((sum, task) => sum + task.estimatedTranscriptBytes, 0);
    setTranscriptCacheByteBudgetForTests(total - 1, useTaskStore.getState().tasks.active.estimatedTranscriptBytes);

    useTaskStore.getState().setActiveThread("active");

    expect(useTaskStore.getState().tasks.unread.messages).toHaveLength(0);
    expect(useTaskStore.getState().tasks.unread.unread).toBe(true);
  });

  it("allows protected transcripts to exceed the byte budget", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    store.hydrateTask("dirty", [{ id: "dirty-message", role: "user", text: "unsaved" }], [], "/p");
    store.hydrateTask("running", [{ id: "running-message", role: "assistant", text: "working" }], [], "/p");
    useTaskStore.setState((state) => ({
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([threadId, task]) => [
        threadId,
        { ...task, updatedAt: old },
      ])),
      statuses: { ...state.statuses, running: "running" },
    }));
    useTaskStore.getState().setTranscriptDirty("dirty", true);
    setTranscriptCacheByteBudgetForTests(1);

    useTaskStore.getState().setActiveThread(null);

    expect(useTaskStore.getState().tasks.dirty.messages).toHaveLength(1);
    expect(useTaskStore.getState().tasks.running.messages).toHaveLength(1);
  });

  it("does not drain cold transcripts when protected bytes already exceed high water", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    store.hydrateTask("protected", [{ id: "large", role: "assistant", text: "x".repeat(2_000) }], [], "/p");
    store.hydrateTask("cold", [{ id: "small", role: "assistant", text: "keep warm" }], [], "/p");
    useTaskStore.setState((state) => ({
      tasks: {
        ...state.tasks,
        protected: { ...state.tasks.protected, updatedAt: old },
        cold: { ...state.tasks.cold, updatedAt: old + 1 },
      },
    }));
    store.setTranscriptDirty("protected", true);
    setTranscriptCacheByteBudgetForTests(
      useTaskStore.getState().tasks.protected.estimatedTranscriptBytes - 1,
      1,
    );

    useTaskStore.getState().setActiveThread(null);

    expect(useTaskStore.getState().tasks.cold.messages).toHaveLength(1);
  });

  it("does not evict while estimated bytes remain in the hysteresis band", () => {
    const store = useTaskStore.getState();
    const old = Date.now() - 10 * 60_000;
    store.hydrateTask("cold", [{ id: "message", role: "assistant", text: "cached" }], [], "/p");
    useTaskStore.setState((state) => ({
      tasks: { ...state.tasks, cold: { ...state.tasks.cold, updatedAt: old } },
    }));
    const bytes = useTaskStore.getState().tasks.cold.estimatedTranscriptBytes;
    setTranscriptCacheByteBudgetForTests(bytes + 1, 1);

    useTaskStore.getState().setActiveThread(null);

    expect(useTaskStore.getState().tasks.cold.messages).toHaveLength(1);
  });

  it("keeps incremental transcript byte accounting reconciled", () => {
    const store = useTaskStore.getState();
    const expectReconciled = () => {
      const task = useTaskStore.getState().tasks["thread-a"];
      expect(task.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(task.messages, task.activities));
    };

    store.hydrateTask(
      "thread-a",
      [{ id: "recent", role: "assistant", text: "recent answer" }],
      [{ id: "tool", kind: "command", title: "npm test", detail: "running", status: "inProgress" }],
      "/p",
    );
    expectReconciled();
    store.prependHistory("thread-a", [{ id: "old", role: "user", text: "older prompt" }], [], {});
    expectReconciled();
    store.appendUserMessage("thread-a", { id: "optimistic", role: "user", text: "new prompt" });
    store.setMessageSteerStatus("thread-a", "optimistic", "sending");
    expectReconciled();
    store.removeMessage("thread-a", "old");
    expectReconciled();
    store.setTaskStatus("thread-a", "starting");
    store.setActiveTurn("thread-a", "turn-a");
    store.queueAssistantDelta("thread-a", "answer", "draft that will be shortened");
    store.queueReasoningDelta("thread-a", "reasoning", "summary", "summary");
    store.flushDeltas();
    expectReconciled();
    store.queueReasoningDelta("thread-a", "reasoning", "private detail", "content");
    store.flushDeltas();
    expectReconciled();
    store.completeMessage("thread-a", { id: "answer", role: "assistant", text: "Done" });
    store.upsertActivity("thread-a", { id: "tool", kind: "command", title: "npm test", detail: "passed", status: "completed" });
    expectReconciled();
    store.completeTurn("thread-a", "turn-a", "completed");
    expectReconciled();
  });

  it("prepends an older page without disturbing live order or duplicate items", () => {
    const store = useTaskStore.getState();
    store.hydrateTask("thread-a", [{ id: "current", role: "assistant", text: "current" }], [], "/p", {
      nextCursor: "older",
      hasMore: true,
      loading: false,
      paginated: true,
    });
    store.prependHistory("thread-a", [
      { id: "old", role: "user", text: "old", timelineOrder: 1 },
      { id: "current", role: "assistant", text: "duplicate", timelineOrder: 2 },
    ], [], { nextCursor: null, hasMore: false, loading: false });

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages.map((message) => message.id)).toEqual(["old", "current"]);
    expect(task.messages[0].timelineOrder).toBeLessThan(task.messages[1].timelineOrder!);
    expect(task.history).toMatchObject({ nextCursor: null, hasMore: false, paginated: true });
  });

  it("keeps an optimistic user message appended while paged hydration is in flight", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/p");
    store.appendUserMessage("thread-a", { id: "optimistic", role: "user", text: "send this now" });
    store.hydrateTask("thread-a", [{ id: "loaded", role: "assistant", text: "recent answer" }], [], "/p");

    expect(useTaskStore.getState().tasks["thread-a"].messages.map((message) => message.id)).toEqual(["loaded", "optimistic"]);
  });

  it("keeps assigned active-turn messages and tools while paged hydration is in flight", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/p");
    store.setActiveTurn("thread-a", "live-turn");
    store.appendUserMessage("thread-a", { id: "live-user", role: "user", text: "do this", turnId: "live-turn" });
    store.upsertActivity("thread-a", { id: "live-tool", kind: "command", title: "npm test", status: "inProgress", turnId: "live-turn" });
    store.completeMessage("thread-a", { id: "live-answer", role: "assistant", text: "partial", turnId: "live-turn" });

    store.hydrateTask("thread-a", [{ id: "loaded", role: "assistant", text: "recent answer", turnId: "older-turn" }], [], "/p");

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages.map((message) => message.id)).toEqual(["loaded", "live-user", "live-answer"]);
    expect(task.activities.map((activity) => activity.id)).toEqual(["live-tool"]);
    expect(task.messages[1].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
    expect(task.activities[0].timelineOrder).toBeLessThan(task.messages[2].timelineOrder!);
  });

  it("does not erase a known workspace path when a history refresh omits it", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/known/project");
    store.hydrateTask("thread-a", [{ id: "loaded", role: "assistant", text: "answer" }], [], undefined);

    expect(useTaskStore.getState().tasks["thread-a"].workspacePath).toBe("/known/project");
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

  it("leaves the statuses map untouched while streaming deltas", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/a");
    store.setActiveThread("thread-a");
    store.setTaskStatus("thread-a", "running");
    const statuses = useTaskStore.getState().statuses;

    store.queueAssistantDelta("thread-a", "message-1", "hello");
    store.flushDeltas();
    store.queueReasoningDelta("thread-a", "reasoning-1", "thinking", "content");
    store.flushDeltas();
    store.upsertActivity("thread-a", { id: "cmd-1", kind: "command", title: "npm test", status: "inProgress" });

    // Streaming must not rewrite `statuses`. App's shell selectors and the
    // queued-turn pump both key off this map's identity to stay out of the
    // per-frame delta path; a rewrite here would re-render the whole app and
    // rescan every thread's queue on every animation frame.
    expect(useTaskStore.getState().statuses).toBe(statuses);

    store.completeTurn("thread-a", undefined, "completed");
    expect(useTaskStore.getState().statuses).not.toBe(statuses);
    expect(useTaskStore.getState().statuses["thread-a"]).toBe("completed");
  });

  it("locks steering synchronously through final message completion and releases it at real work or turn completion", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/a");
    store.setActiveTurn("thread-a", "turn-a");
    store.setTaskStatus("thread-a", "running");
    store.upsertActivity("thread-a", { id: "earlier-tool", kind: "command", title: "npm test", status: "inProgress" });
    store.queueReasoningDelta("thread-a", "earlier-reasoning", "Initial thought", "content");
    store.flushDeltas();

    store.queueAssistantDelta("thread-a", "answer", "Writing the final answer");
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);
    expect(useTaskStore.getState().tasks["thread-a"].messages).toEqual([]);

    store.flushDeltas();
    store.completeMessage("thread-a", { id: "answer", role: "assistant", text: "Writing the final answer" });
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);

    // A late update to work that began before the response is not a new work
    // boundary and must not flash Steer back on over the final answer.
    store.upsertActivity("thread-a", { id: "earlier-tool", kind: "command", title: "npm test", status: "completed" });
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);
    store.queueReasoningDelta("thread-a", "earlier-reasoning", " late detail", "content");
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);
    store.upsertActivity("thread-a", { id: "late-warning", kind: "warning", title: "Runtime warning" });
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);

    store.upsertActivity("thread-a", { id: "later-tool", kind: "command", title: "npm run build", status: "inProgress" });
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(false);

    store.queueAssistantDelta("thread-a", "answer-2", "Now actually finishing");
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(true);
    store.completeTurn("thread-a", "turn-a", "completed");
    expect(isAssistantOutputActive(useTaskStore.getState().tasks["thread-a"])).toBe(false);
  });

  it("terminalizes an unfinished tool card when its provider turn ends", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a");
    store.setActiveTurn("thread-a", "turn-a");
    store.upsertActivity("thread-a", { id: "collect", kind: "command", title: "collect_agent", status: "inProgress" });

    store.completeTurn("thread-a", "turn-a", "error");

    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({
      status: "failed",
      turnStatus: "failed",
    });
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

  it("persists queued turns with attachments and removes them after delivery", () => {
    const store = useTaskStore.getState();
    const queued = store.enqueueTurn("thread-a", "Run the follow-up", [
      { name: "notes.md", path: "/tmp/notes.md", kind: "file" },
    ]);

    expect(useTaskStore.getState().tasks["thread-a"].queuedTurns[0]).toMatchObject({
      id: queued.id,
      text: "Run the follow-up",
      status: "queued",
      attachments: [{ name: "notes.md", path: "/tmp/notes.md" }],
    });
    expect(JSON.parse(localStorage.getItem("kiwi.queuedTurns") ?? "{}")["thread-a"][0].id).toBe(queued.id);

    store.setQueuedTurnStatus("thread-a", queued.id, "failed", "Try again");
    expect(useTaskStore.getState().tasks["thread-a"].queuedTurns[0]).toMatchObject({ status: "failed", error: "Try again" });

    store.removeQueuedTurn("thread-a", queued.id);
    expect(useTaskStore.getState().tasks["thread-a"].queuedTurns).toEqual([]);
    expect(JSON.parse(localStorage.getItem("kiwi.queuedTurns") ?? "{}")["thread-a"]).toBeUndefined();
  });

  it("restores a durable queue without half-written entries or undeliverable statuses", () => {
    const restored = sanitizeStoredQueuedTurns({
      "thread-a": [
        { id: "q1", text: "still queued", attachments: [{ name: "a.ts", path: "/a.ts", kind: "file" }, { name: "bad.ts", path: "/bad.ts", kind: "other" }, { name: "broken" }], createdAt: 5, status: "sending" },
        { id: "q2", text: "kept as failed", attachments: "nope", createdAt: "later", status: "failed" },
        { id: "q3", text: "unknown status", attachments: [], createdAt: 7, status: "in-orbit" },
        { id: "q1", text: "duplicate id", attachments: [], createdAt: 8, status: "queued" },
        { id: "blank", text: "   ", attachments: [], createdAt: 9, status: "queued" },
        { id: "q4" },
        null,
      ],
      "thread-b": "not an array",
      "thread-c": [],
    });

    // A restart cannot leave a turn mid-delivery, and an unrecognised status
    // would be an entry the queue pump silently never picks up again.
    expect(restored["thread-a"].map((entry) => [entry.id, entry.status])).toEqual([
      ["q1", "queued"],
      ["q2", "failed"],
      ["q3", "queued"],
    ]);
    expect(restored["thread-a"][0].attachments).toEqual([{ name: "a.ts", path: "/a.ts", kind: "file" }]);
    expect(restored["thread-a"][0].threadId).toBe("thread-a");
    expect(restored["thread-a"][1].attachments).toEqual([]);
    expect(restored["thread-a"][1].createdAt).toEqual(expect.any(Number));
    expect(restored["thread-b"]).toBeUndefined();
    expect(restored["thread-c"]).toBeUndefined();
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

  it("updates steering delivery feedback without changing timeline identity", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-a");
    store.appendUserMessage("thread-a", { id: "steer", role: "user", text: "Change direction", steerStatus: "sending" });
    const order = useTaskStore.getState().tasks["thread-a"].messages[0].timelineOrder;

    store.setMessageSteerStatus("thread-a", "steer", "accepted");

    expect(useTaskStore.getState().tasks["thread-a"].messages[0]).toMatchObject({
      id: "steer",
      turnId: "turn-a",
      timelineOrder: order,
      steerStatus: "accepted",
    });
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

  it("seals streaming assistant output when its turn completes", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "starting");
    store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Fix it" });
    store.setActiveTurn("thread-a", "turn-a");
    store.queueAssistantDelta("thread-a", "answer", "Done");
    store.flushDeltas();

    expect(useTaskStore.getState().tasks["thread-a"].messages[1].streaming).toBe(true);

    store.completeTurn("thread-a", "turn-a", "completed");

    expect(useTaskStore.getState().tasks["thread-a"].messages[1]).toMatchObject({
      streaming: false,
      turnStatus: "completed",
    });
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

  it("does not mark a still-running child complete when its parent turn ends", () => {
    const store = useTaskStore.getState();
    store.ensureTask("child-a");
    store.setTaskStatus("child-a", "running");
    store.setActiveTurn("thread-a", "turn-a");
    store.upsertAgent("thread-a", { id: "child-a", prompt: "Audit the bridge", status: "inProgress" });
    store.upsertActivity("thread-a", {
      id: "spawn",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      status: "inProgress",
      agent: { action: "spawn", provider: "claude", task: "Audit the bridge", threadIds: ["child-a"] },
    });

    store.completeTurn("thread-a", "turn-a", "completed");

    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({
      status: "inProgress",
      turnStatus: "completed",
      agent: { action: "spawn", task: "Audit the bridge" },
    });
    expect(useTaskStore.getState().tasks["thread-a"].agents[0].status).toBe("inProgress");
  });

  it("settles a stale native child and Relay card when the parent finishes", () => {
    const store = useTaskStore.getState();
    store.ensureTask("native-child");
    store.setActiveTurn("thread-a", "turn-a");
    store.upsertAgent("thread-a", { id: "native-child", prompt: "Delegated task", status: "started" });
    store.upsertActivity("thread-a", {
      id: "native-spawn",
      kind: "agent",
      title: "Sub-agent started",
      status: "started",
      agent: { action: "spawn", provider: "openai", task: "Audit audio", threadIds: ["native-child"] },
    });

    store.completeTurn("thread-a", "turn-a", "completed");

    expect(useTaskStore.getState().tasks["thread-a"].agents[0].status).toBe("completed");
    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({
      status: "completed",
      turnStatus: "completed",
      agent: { action: "spawn", threadIds: ["native-child"] },
    });
  });

  it("does not let a late provider event restart a stopped Relay card", () => {
    const store = useTaskStore.getState();
    store.ensureTask("child-a");
    store.setTaskStatus("child-a", "interrupted");
    store.upsertAgent("thread-a", { id: "child-a", prompt: "Audit routing", status: "interrupted" });
    store.upsertActivity("thread-a", {
      id: "spawn",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      status: "cancelled",
      agent: { action: "spawn", provider: "claude", threadIds: ["child-a"] },
    });
    store.upsertAgent("thread-a", { id: "child-a", prompt: "Audit routing", status: "completed" });
    store.upsertActivity("thread-a", {
      id: "spawn",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      detail: "late terminal event",
      status: "completed",
      agent: { action: "spawn", provider: "claude", threadIds: ["child-a"] },
    });

    store.upsertAgent("thread-a", { id: "child-a", prompt: "Audit routing", status: "inProgress" });
    store.upsertActivity("thread-a", {
      id: "spawn",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      detail: "late terminal event",
      status: "inProgress",
      agent: { action: "spawn", provider: "claude", threadIds: ["child-a"] },
    });

    expect(useTaskStore.getState().tasks["thread-a"].agents[0].status).toBe("interrupted");
    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({
      status: "cancelled",
      detail: "late terminal event",
    });
  });
});
