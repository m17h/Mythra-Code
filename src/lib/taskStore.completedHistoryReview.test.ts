import { beforeEach, expect, it } from "vitest";
import { captureHistoryReadBoundary, resetTaskStore, useTaskStore } from "./taskStore";

beforeEach(() => { resetTaskStore(); });

it("keeps a newly accepted first turn when a history read captured before its send returns after completion", () => {
  const store = useTaskStore.getState();
  store.ensureTask("new-thread", "/fixture/project");
  // Selection starts an empty history read while the checkpoint is pending.
  const capturedMessages: [] = [];
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks["new-thread"]);
  store.setTaskStatus("new-thread", "starting");
  store.appendUserMessage("new-thread", { id: "local-first", role: "user", text: "Do not vanish after acceptance" });
  store.setActiveTurn("new-thread", "first-turn");
  store.completeMessage("new-thread", { id: "first-answer", role: "assistant", text: "Completed", turnId: "first-turn" });
  store.completeTurn("new-thread", "first-turn", "completed");
  store.hydrateTask("new-thread", capturedMessages, [], "/fixture/project", {
    nextCursor: null, hasMore: false, loading: false, paginated: true,
  }, boundary);
  expect(useTaskStore.getState().tasks["new-thread"].messages.map((message) => message.text))
    .toEqual(["Do not vanish after acceptance", "Completed"]);
});

it("keeps the turn live at read start if it finishes while history is loading, without retaining superseded old history", () => {
  const store = useTaskStore.getState();
  store.hydrateTask("thread", [{ id: "older", role: "assistant", text: "Older text", turnId: "older-turn" }], []);
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "live-user", role: "user", text: "Live prompt" });
  store.setActiveTurn("thread", "live-turn");
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.upsertActivity("thread", { id: "live-tool", kind: "command", title: "Live tool", turnId: "live-turn" });
  store.completeMessage("thread", { id: "live-answer", role: "assistant", text: "Live answer", turnId: "live-turn" });
  store.completeTurn("thread", "live-turn", "completed");
  store.hydrateTask("thread", [{ id: "older", role: "assistant", text: "Updated older text", turnId: "older-turn" }], [], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect(task.messages.map((message) => message.text)).toEqual(["Updated older text", "Live prompt", "Live answer"]);
  expect(task.activities.map((activity) => activity.title)).toEqual(["Live tool"]);
  expect(task.messages[0].timelineOrder).toBeLessThan(task.messages[1].timelineOrder!);
  expect(task.messages[1].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
  expect(task.activities[0].timelineOrder).toBeLessThan(task.messages[2].timelineOrder!);
});

it("reconciles a durable echo of the new completed prompt instead of retaining a duplicate", () => {
  const store = useTaskStore.getState();
  const boundary = captureHistoryReadBoundary(undefined);
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-user", role: "user", text: "Echoed prompt" });
  store.setActiveTurn("thread", "turn");
  store.completeTurn("thread", "turn", "completed");
  store.hydrateTask("thread", [{ id: "runtime-user", role: "user", text: "Echoed prompt", turnId: "turn" }], [], "/fixture", undefined, boundary);
  expect(useTaskStore.getState().tasks.thread.messages).toEqual([expect.objectContaining({ text: "Echoed prompt", turnId: "turn" })]);
});

it("keeps same-ID assistant and tool updates made after the read began, with the completed live order", () => {
  const store = useTaskStore.getState();
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-user", role: "user", text: "Live prompt" });
  store.setActiveTurn("thread", "turn");
  store.upsertActivity("thread", { id: "tool", kind: "command", title: "Tool", detail: "partial output", status: "inProgress", turnId: "turn" });
  store.startAssistantMessage("thread", { id: "answer", role: "assistant", text: "partial answer", turnId: "turn" });
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.upsertActivity("thread", { id: "tool", kind: "command", title: "Tool", detail: "final output", status: "completed", turnId: "turn" });
  store.completeMessage("thread", { id: "answer", role: "assistant", text: "final answer", turnId: "turn" });
  store.completeTurn("thread", "turn", "completed");
  store.hydrateTask("thread", [
    { id: "runtime-user", role: "user", text: "Live prompt", turnId: "turn", timelineOrder: 1 },
    { id: "answer", role: "assistant", text: "partial answer", turnId: "turn", timelineOrder: 3 },
  ], [{ id: "tool", kind: "command", title: "Tool", detail: "partial output", status: "inProgress", turnId: "turn", timelineOrder: 2 }], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect(task.messages).toHaveLength(2);
  expect(task.messages[1]).toMatchObject({ text: "final answer", streaming: false, turnStatus: "completed" });
  expect(task.activities[0]).toMatchObject({ detail: "final output", status: "completed", turnStatus: "completed" });
  expect(task.messages[0].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
  expect(task.activities[0].timelineOrder).toBeLessThan(task.messages[1].timelineOrder!);
});

it.each([false, true])("keeps updated rows at durable anchors before later turns and places an omitted tool before its assistant (tool included: %s)", (includeTool) => {
  const store = useTaskStore.getState();
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-user", role: "user", text: "First prompt" });
  store.setActiveTurn("thread", "first-turn");
  store.upsertActivity("thread", { id: "first-tool", kind: "command", title: "First tool", detail: "partial", status: "inProgress", turnId: "first-turn" });
  store.startAssistantMessage("thread", { id: "first-answer", role: "assistant", text: "partial", turnId: "first-turn" });
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.upsertActivity("thread", { id: "first-tool", kind: "command", title: "First tool", detail: "final", status: "completed", turnId: "first-turn" });
  store.completeMessage("thread", { id: "first-answer", role: "assistant", text: "Final first answer", turnId: "first-turn" });
  store.completeTurn("thread", "first-turn", "completed");
  store.hydrateTask("thread", [
    { id: "runtime-user", role: "user", text: "First prompt", turnId: "first-turn", timelineOrder: 1 },
    { id: "first-answer", role: "assistant", text: "partial", turnId: "first-turn", timelineOrder: 3 },
    { id: "later-user", role: "user", text: "Later prompt", turnId: "later-turn", timelineOrder: 4 },
    { id: "later-answer", role: "assistant", text: "Later answer", turnId: "later-turn", timelineOrder: 5 },
  ], includeTool ? [{ id: "first-tool", kind: "command", title: "First tool", detail: "partial", status: "inProgress", turnId: "first-turn", timelineOrder: 2 }] : [], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  const chronological = [...task.messages.map((entry) => ({ order: entry.timelineOrder!, text: entry.text })), ...task.activities.map((entry) => ({ order: entry.timelineOrder!, text: entry.title }))]
    .sort((left, right) => left.order - right.order).map((entry) => entry.text);
  expect(chronological).toEqual(["First prompt", "First tool", "Final first answer", "Later prompt", "Later answer"]);
  expect(task.activities[0]).toMatchObject({ detail: "final", status: "completed" });
});

it("can insert an unmatched prompt before the first known assistant anchor", () => {
  const store = useTaskStore.getState();
  const boundary = captureHistoryReadBoundary(undefined);
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-user", role: "user", text: "Prompt missing from read" });
  store.setActiveTurn("thread", "turn");
  store.completeMessage("thread", { id: "answer", role: "assistant", text: "Final answer", turnId: "turn" });
  store.completeTurn("thread", "turn", "completed");
  store.hydrateTask("thread", [{ id: "answer", role: "assistant", text: "stale answer", turnId: "turn", timelineOrder: 1 }], [], "/fixture", undefined, boundary);
  expect(useTaskStore.getState().tasks.thread.messages.map((entry) => entry.text)).toEqual(["Prompt missing from read", "Final answer"]);
});
