import { useTaskStore } from "../../taskStore";
import { hasRemoteWork } from "./engineOwners";

/** The thread says so, because a skipped checkpoint must never pass for a saved one. */
export function noteCheckpointSkipped(threadId: string): void {
  useTaskStore.getState().upsertActivity(threadId, {
    id: `remote-checkpoint-preparation-${threadId}`, kind: "warning", title: "Automatic checkpoint not created",
    detail: "This step was started from another device without its own checkpoint permission, so nothing was saved before it ran. You can save one yourself from Checkpoints if Terminal is turned on for that device.",
  });
}

/** An ordinary checkpoint runs Git, which can run a project's own filters, with no
 * check of what the other device may still do. Work that device started skips it
 * until a native step can run under its grant. Everything else is untouched. */
export function checkpointUnlessRemote<T>(threadIds: readonly string[], noticeThreadId: string | null, begin: () => Promise<T>): Promise<T | undefined> {
  if (!threadIds.some(hasRemoteWork)) return begin();
  if (noticeThreadId) noteCheckpointSkipped(noticeThreadId);
  return Promise.resolve(undefined);
}
