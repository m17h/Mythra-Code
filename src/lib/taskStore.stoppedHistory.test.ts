import { beforeEach, expect, it } from "vitest";
import { captureHistoryReadBoundary, estimateTranscriptBytes, resetTaskStore, useTaskStore } from "./taskStore";

beforeEach(() => { resetTaskStore(); });

function stopTurn() {
  const store = useTaskStore.getState();
  store.hydrateTask("thread", [{ id: "older-answer", role: "assistant", text: "Superseded old page", turnId: "older-turn", turnStatus: "completed" }], []);
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-user", role: "user", text: "First prompt" });
  store.setActiveTurn("thread", "stopped-turn");
  store.upsertActivity("thread", { id: "reasoning", kind: "reasoning", title: "Thinking", detail: "Observed reasoning", status: "completed", turnId: "stopped-turn" });
  store.upsertActivity("thread", { id: "tool", kind: "command", title: "Tool", detail: "Observed output", status: "inProgress", turnId: "stopped-turn" });
  store.startAssistantMessage("thread", { id: "answer", role: "assistant", text: "Observed partial answer", turnId: "stopped-turn" });
  store.completeTurn("thread", "stopped-turn", "interrupted");
  return store;
}

it.each([false, true])("restores omitted stopped work at its durable prompt before later turns (read boundary: %s)", (withBoundary) => {
  const store = stopTurn();
  const boundary = withBoundary ? captureHistoryReadBoundary(useTaskStore.getState().tasks.thread) : undefined;
  store.hydrateTask("thread", [
    // Providers may mark the user echo completed before its turn completes.
    { id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", turnStatus: "completed", timelineOrder: 1 },
    { id: "later-user", role: "user", text: "Later prompt", turnId: "later-turn", timelineOrder: 2 },
    { id: "later-answer", role: "assistant", text: "Later answer", turnId: "later-turn", timelineOrder: 3 },
  ], [], "/fixture", { nextCursor: null, hasMore: false, loading: false, paginated: true }, boundary);
  const task = useTaskStore.getState().tasks.thread;
  const chronological = [...task.messages, ...task.activities].sort((left, right) => left.timelineOrder! - right.timelineOrder!);
  expect(chronological.map((entry) => entry.id)).toEqual(["runtime-user", "reasoning", "tool", "answer", "later-user", "later-answer"]);
  expect(task.messages.filter((entry) => entry.turnId === "stopped-turn")).toEqual([
    expect.objectContaining({ id: "runtime-user", turnStatus: "interrupted" }),
    expect.objectContaining({ id: "answer", text: "Observed partial answer", streaming: false, turnStatus: "interrupted" }),
  ]);
  expect(task.activities).toEqual([
    expect.objectContaining({ id: "reasoning", detail: "Observed reasoning", status: "completed", turnStatus: "interrupted" }),
    expect.objectContaining({ id: "tool", detail: "Observed output", status: "interrupted", turnStatus: "interrupted" }),
  ]);
  expect(task.messages.some((entry) => entry.id === "older-answer")).toBe(false);
  expect(task.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(task.messages, task.activities));
});

it("keeps stopped same-ID snapshots when a new history read returns stale streaming rows", () => {
  const store = stopTurn();
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", [
    { id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", timelineOrder: 1 },
    { id: "answer", role: "assistant", text: "Older partial", streaming: true, turnId: "stopped-turn", turnStatus: "inProgress", timelineOrder: 3 },
  ], [{ id: "tool", kind: "command", title: "Tool", detail: "Older output", status: "inProgress", turnId: "stopped-turn", turnStatus: "inProgress", timelineOrder: 2 }], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect(task.messages[1]).toMatchObject({ text: "Observed partial answer", streaming: false, turnStatus: "interrupted" });
  expect(task.activities.find((entry) => entry.id === "tool")).toMatchObject({ detail: "Observed output", status: "interrupted", turnStatus: "interrupted" });
});

it("seals a newly restored in-progress activity inside a locally stopped turn", () => {
  const store = stopTurn();
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", [{ id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", timelineOrder: 1 }], [
    { id: "unseen-tool", kind: "command", title: "Unseen tool", status: "inProgress", turnId: "stopped-turn", timelineOrder: 2 },
  ], "/fixture", undefined, boundary);
  expect(useTaskStore.getState().tasks.thread.activities.find((entry) => entry.id === "unseen-tool"))
    .toMatchObject({ status: "interrupted", turnStatus: "interrupted" });
});

it("does not falsely settle a restored spawn while its represented child is still running", () => {
  const store = stopTurn();
  store.setTaskStatus("child", "running");
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", [{ id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", timelineOrder: 1 }], [
    { id: "spawn", kind: "agent", title: "Child", status: "inProgress", turnId: "stopped-turn", timelineOrder: 2,
      agent: { action: "spawn", threadIds: ["child"] } },
  ], "/fixture", undefined, boundary);
  expect(useTaskStore.getState().tasks.thread.activities.find((entry) => entry.id === "spawn"))
    .toMatchObject({ status: "inProgress", turnStatus: "interrupted" });
});

it.each(["completed", "failed"] as const)("accepts authoritative %s history after the stopped snapshot", (turnStatus) => {
  const store = stopTurn();
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", [
    { id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", turnStatus, timelineOrder: 1 },
    { id: "answer", role: "assistant", text: "Durable terminal answer", streaming: false, turnId: "stopped-turn", turnStatus, timelineOrder: 3 },
  ], [{ id: "tool", kind: "command", title: "Tool", detail: "Durable terminal output", status: turnStatus, turnId: "stopped-turn", turnStatus, timelineOrder: 2 }], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect(task.messages[1]).toMatchObject({ text: "Durable terminal answer", streaming: false, turnStatus });
  expect(task.activities).toEqual([expect.objectContaining({ id: "tool", detail: "Durable terminal output", status: turnStatus, turnStatus })]);
});

it("places omitted work from each stopped turn before intervening completed turns", () => {
  const store = stopTurn();
  store.appendUserMessage("thread", { id: "middle-user", role: "user", text: "Middle prompt", turnId: "middle-turn" });
  store.completeMessage("thread", { id: "middle-answer", role: "assistant", text: "Middle answer", turnId: "middle-turn" });
  store.setTaskStatus("thread", "starting");
  store.appendUserMessage("thread", { id: "local-next-user", role: "user", text: "Next prompt" });
  store.setActiveTurn("thread", "next-stopped-turn");
  store.startAssistantMessage("thread", { id: "next-answer", role: "assistant", text: "Next partial", turnId: "next-stopped-turn" });
  store.completeTurn("thread", "next-stopped-turn", "interrupted");
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", [
    { id: "runtime-user", role: "user", text: "First prompt", turnId: "stopped-turn", timelineOrder: 1 },
    { id: "middle-user", role: "user", text: "Middle prompt", turnId: "middle-turn", timelineOrder: 2 },
    { id: "middle-answer", role: "assistant", text: "Middle answer", turnId: "middle-turn", timelineOrder: 3 },
    { id: "runtime-next-user", role: "user", text: "Next prompt", turnId: "next-stopped-turn", timelineOrder: 4 },
  ], [], "/fixture", undefined, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect([...task.messages, ...task.activities].sort((left, right) => left.timelineOrder! - right.timelineOrder!).map((entry) => entry.id))
    .toEqual(["runtime-user", "reasoning", "tool", "answer", "middle-user", "middle-answer", "runtime-next-user", "next-answer"]);
});

it.each([false, true])("does not retain a stopped turn absent from the returned history window (empty history: %s)", (empty) => {
  const store = stopTurn();
  const boundary = captureHistoryReadBoundary(useTaskStore.getState().tasks.thread);
  store.hydrateTask("thread", empty ? [] : [{ id: "newer", role: "assistant", text: "Recent page", turnId: "newer-turn" }], [], "/fixture", {
    nextCursor: empty ? null : "older", hasMore: !empty, loading: false, paginated: true,
  }, boundary);
  const task = useTaskStore.getState().tasks.thread;
  expect(task.messages.map((entry) => entry.id)).toEqual(empty ? [] : ["newer"]);
  expect(task.activities).toEqual([]);
});
