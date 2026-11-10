import type { Thread } from "../../../types";
import { childLifecycleForLink, type ChildAgentLink } from "../../childAgents";
import { nativeArchiveActivity } from "../../subAgentArchive";
import type { NativeAgentLink } from "../../nativeAgentLinks";
import { isSubAgentWorkerActive, workerStatusFromLifecycle } from "../../subAgentActivity";
import { activeThreadRemovalBlockedReason } from "../../threadArchive";
import { providerFromThread } from "../../threadProvider";
import type { ThreadWorktreeRecord } from "../../worktrees";
import { useTaskStore } from "../../taskStore";
import type { ThreadEffectOperation, ThreadRowChange, ThreadRowLifecycle } from "./threadRows";
import { HostReadError } from "./scope";

/** Live refs/functions shared with the sidebar. None is a replacement provider
 * mutation or a persistence setter. Local callers keep their existing path. */
export interface ThreadLifecycleSources {
  evidence(threadId: string): {
    deleted: boolean; archived: boolean; worktree?: ThreadWorktreeRecord; worktreeBusy?: boolean;
    childLinks: Record<string, ChildAgentLink>; nativeLinks: Record<string, NativeAgentLink>; childStartInFlight: boolean;
  };
  /** Joins the same local removal/row ownership, returning an exact-token guard. */
  reserve(op: ThreadEffectOperation, threadId: string): { assertOwned(): void; release(): void };
  cancelTitle(threadId: string): Promise<unknown>;
  joinRenames(threadId: string): Promise<unknown>;
  waitPreparation(threadId: string): Promise<unknown>;
  flushTranscript(threadId: string): Promise<unknown>;
  cancelTranscriptSave(threadId: string): void;
  /** Raw refs + selected/list presentation and resource cleanup, NO blind saves. */
  committed(change: ThreadRowChange): void | Promise<void>;
}
/** This is the sidebar's actual policy composition: native unknown activity,
 * managed children awaiting settlement, pending child starts, workflows and
 * isolated deletion/fork guards all remain effective for a background target. */
export function threadRowBlockedReason(op: ThreadEffectOperation, thread: Thread, sources: ThreadLifecycleSources): string | null {
  const id = thread.id, evidence = sources.evidence(id), state = useTaskStore.getState(), task = state.tasks[id];
  if (evidence.deleted) throw new HostReadError("stale_target", "This conversation was deleted.");
  if (op === "thread.restore" ? !evidence.archived : evidence.archived) throw new HostReadError("stale_target", "This conversation's archive state changed.");
  if (op === "thread.rename") return null;
  if ((op === "thread.delete" || op === "thread.fork") && evidence.worktree && evidence.worktree.status !== "removed") return "Remove this conversation's isolated worktree before deleting or forking it.";
  if (evidence.worktreeBusy) return "Wait for this conversation's checkout operation to finish.";
  const native = nativeArchiveActivity({ threadId: id, nativeLinks: evidence.nativeLinks, statuses: state.statuses,
    agentRecordsByThread: Object.fromEntries(Object.entries(state.tasks).map(([key, value]) => [key, value.agents])) });
  const link = evidence.childLinks[id];
  if (native.activeSelf || link && isSubAgentWorkerActive(workerStatusFromLifecycle(childLifecycleForLink(link, state.statuses[id] ?? "idle")))) return "Finish or stop this sub-agent; its last turn has not been confirmed to have settled.";
  return activeThreadRemovalBlockedReason(
    { status: state.statuses[id] ?? task?.status ?? "idle", agents: task?.agents ?? [] },
    op === "thread.delete" ? "delete" : "archive",
    native.activeDescendants || evidence.childStartInFlight || Object.values(evidence.childLinks).some((entry) => entry.rootThreadId === id
      && isSubAgentWorkerActive(workerStatusFromLifecycle(childLifecycleForLink(entry, state.statuses[entry.childThreadId] ?? "idle")))),
    Boolean(state.workflowOwners[id]),
    op === "thread.archive" || op === "thread.delete" ? state.parentRuns[id] : undefined,
  );
}
export function createThreadRowLifecycle(sources: ThreadLifecycleSources): ThreadRowLifecycle {
  return { begin(op, thread) {
    const ownership = sources.reserve(op, thread.id);
    const check = () => { ownership.assertOwned(); const reason = threadRowBlockedReason(op, thread, sources); if (reason) throw new HostReadError("busy", reason); };
    return {
      assertAllowed: check,
      async prepare() {
        check();
        if (op === "thread.rename" || op === "thread.archive" || op === "thread.delete") { await sources.cancelTitle(thread.id); check(); }
        await sources.joinRenames(thread.id); check();
        if (op === "thread.fork" || op === "thread.restore" || op === "thread.compact" || op === "thread.rollback") { await sources.waitPreparation(thread.id); check(); }
        const provider = providerFromThread(thread, "openai");
        if ((provider === "claude" || provider === "cursor") && useTaskStore.getState().tasks[thread.id]?.transcriptDirty) { await sources.flushTranscript(thread.id); check(); }
        if (op === "thread.delete") sources.cancelTranscriptSave(thread.id);
      },
      committed: (change) => sources.committed(change), release: () => ownership.release(),
    };
  } };
}
