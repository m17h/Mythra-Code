import { useTaskStore } from "./taskStore";

/** The root activation one Stop targeted, captured before any cutoff is requested. */
export interface RootCutoffSnapshot {
  turnId?: string;
  lastCompletedTurnId?: string;
  /** Start identity of the stopped run; a newer user run replaces it. */
  runStartedAt?: number;
  workflowId?: string;
  workflowRunId?: string;
}

export function captureRootCutoff(threadId: string): RootCutoffSnapshot {
  const store = useTaskStore.getState();
  const task = store.tasks[threadId];
  const owner = store.workflowOwners[threadId];
  return {
    ...(task?.activeTurnId ? { turnId: task.activeTurnId } : {}),
    ...(task?.lastCompletedTurnId ? { lastCompletedTurnId: task.lastCompletedTurnId } : {}),
    ...(task?.agentRunStartedAt !== undefined ? { runStartedAt: task.agentRunStartedAt } : {}),
    ...(owner?.workflowId ? { workflowId: owner.workflowId, workflowRunId: owner.runId } : {}),
  };
}

/**
 * A pending turn/start cutoff is only confirmed when its owned start settles.
 * With a snapshot, only the captured activation is awaited: a newer root turn
 * the user started after Stop is not this Stop's work and is never waited on.
 */
export function waitForRootCutoff(threadId: string, timeoutMs = 30_000, snapshot?: RootCutoffSnapshot): Promise<void> {
  const stopped = () => {
    const store = useTaskStore.getState();
    const status = store.statuses[threadId];
    if (status !== "starting" && status !== "running" && !store.workflowOwners[threadId]) return true;
    if (!snapshot) return false;
    const owner = store.workflowOwners[threadId];
    // A rerun of the same workflow is a new run, not the one this Stop targeted.
    if (snapshot.workflowId && (owner?.workflowId !== snapshot.workflowId || owner.runId !== snapshot.workflowRunId)) return true;
    if (snapshot.workflowId && owner) return false;
    const task = store.tasks[threadId];
    // A newer user run started (its own start identity): the stopped one is over.
    if (task?.agentRunStartedAt !== snapshot.runStartedAt && task?.agentRunStartedAt !== undefined) return true;
    if (snapshot.turnId) return task?.activeTurnId !== snapshot.turnId;
    // The captured start had no turn yet: a newer completed turn proves it settled.
    return task?.lastCompletedTurnId !== snapshot.lastCompletedTurnId;
  };
  if (stopped()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const unsubscribe = useTaskStore.subscribe(() => {
      if (!stopped()) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("The parent turn is still stopping. Its final sub-agent cutoff could not be confirmed."));
    }, timeoutMs);
  });
}

/** Stop all visible work promptly, then catch children discovered during root cutoff. */
export async function stopWithChildren(
  stopRoot: () => Promise<void | boolean>,
  cancelChildren: () => Promise<void>,
  confirmRootCutoff: () => Promise<void>,
): Promise<unknown[]> {
  const initial = await Promise.allSettled([stopRoot(), cancelChildren()]);
  const failures: unknown[] = initial.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  const root = initial[0];
  if (root.status !== "fulfilled") return failures;
  if (root.value === false) return [...failures, new Error("The parent turn's stop was not confirmed.")];
  try {
    await confirmRootCutoff();
    await cancelChildren();
  } catch (reason) {
    failures.push(reason);
  }
  return failures;
}
