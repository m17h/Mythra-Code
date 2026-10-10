import { useTaskStore } from "./taskStore";

/** A pending turn/start cutoff is only confirmed when its owned start settles. */
export function waitForRootCutoff(threadId: string, timeoutMs = 30_000): Promise<void> {
  const stopped = () => {
    const store = useTaskStore.getState();
    const status = store.statuses[threadId];
    return status !== "starting" && status !== "running" && !store.workflowOwners[threadId];
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
