import { useTaskStore } from "./taskStore";

/** A confirmed cutoff seals its exact history, including buffered output.
 * A provider result or a replacement activation can win while Stop awaits. */
export function sealStoppedTurn(threadId: string, turnId: string): boolean {
  const store = useTaskStore.getState();
  const task = store.tasks[threadId];
  if (task?.lastCompletedTurnId === turnId) {
    return task.lastCompletedTurnStatus === "interrupted" && task.status === "interrupted"
      && !task.activeTurnId && !task.pendingNativeActivationId;
  }
  const recordedTerminal = task?.messages.some((message) => message.role !== "user" && message.turnId === turnId
    && (message.turnStatus === "completed" || message.turnStatus === "failed" || message.turnStatus === "interrupted"))
    || task?.activities.some((activity) => activity.turnId === turnId
      && (activity.turnStatus === "completed" || activity.turnStatus === "failed" || activity.turnStatus === "interrupted"));
  // The last receipt can already belong to a later turn; the target's own
  // terminal rows still prove it ended naturally (or was already sealed).
  if (recordedTerminal) return false;
  const newerActivation = Boolean(task && task.activeTurnId !== turnId
    && (task.activeTurnId || task.pendingNativeActivationId || task.status === "starting" || task.status === "running"
      || task.lastCompletedTurnId && task.lastCompletedTurnId !== turnId));
  // completeTurn drains assistant deltas, but reasoning deltas must be painted
  // before that boundary clears their streaming buffers.
  store.flushDeltas();
  return store.completeTurn(threadId, turnId, "interrupted", newerActivation) && !newerActivation;
}
