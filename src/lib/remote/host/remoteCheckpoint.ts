import { useTaskStore } from "../../taskStore";
import { hasRemoteWork } from "./engineOwners";

/** The thread says so, because a skipped checkpoint must never pass for a saved one. */
export function noteCheckpointSkipped(threadId: string): void {
  useTaskStore.getState().upsertActivity(threadId, {
    id: `remote-checkpoint-preparation-${threadId}`, kind: "warning", title: "Automatic checkpoint not created",
    detail: "Remote prompts do not run local Git preparation. Use the explicit checkpoint action when Terminal access is enabled.",
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
