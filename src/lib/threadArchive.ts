import type { ArchivedThread, Provider } from "../types";
import type { OwnershipLinks } from "./nativeAgentLinks";
import { normalizedProjectPath } from "./paths";
import type { ThreadKindView } from "./threadList";
import type { ThreadTaskState } from "./taskStore";
import { isActiveAgentRecord } from "./subAgentActivity";
import { parentRunHoldsThread, type ParentRun } from "./parentRun";

export function activeThreadRemovalBlockedReason(
  task: Pick<ThreadTaskState, "status" | "agents"> | undefined,
  action: "archive" | "delete",
  activeChildren = false,
  activeWorkflow = false,
  parentRun?: Pick<ParentRun, "phase" | "autoResume" | "pause">,
): string | null {
  const operation = action === "archive" ? "archiving" : "deleting";
  if (activeWorkflow) return `Stop this workflow before ${operation} its thread.`;
  if (task?.status === "starting" || task?.status === "running") return `Stop this thread before ${operation} it.`;
  if (activeChildren || task?.agents.some((agent) => isActiveAgentRecord(agent.status))) {
    return `Stop this thread’s sub-agents, and confirm any whose status is unknown, before ${operation} it.`;
  }
  if (parentRunHoldsThread(parentRun)) {
    return `Stop this thread and confirm its work has stopped before ${operation} it.`;
  }
  return null;
}

/** Activity that makes any archive unsafe, including activity that began while
 * an earlier asynchronous archive preparation step was still finishing. */
export function activeThreadArchiveBlockedReason(
  task: Pick<ThreadTaskState, "status" | "agents"> | undefined,
  activeChildren = false,
  activeWorkflow = false,
): string | null {
  return activeThreadRemovalBlockedReason(task, "archive", activeChildren, activeWorkflow);
}

/** Keep the final activity check adjacent to the archive side effect: title
 * cancellation may wait for a name write while the user starts another turn. */
export async function archiveAfterTitleCancellation(
  cancelTitle: () => Promise<void>,
  blockedReason: () => string | null,
  archive: () => Promise<void>,
): Promise<void> {
  await cancelTitle();
  const blocked = blockedReason();
  if (blocked) throw new Error(blocked);
  await archive();
}

/** Finishing a PR must never discard queued work or hide work awaiting a reply. */
export function finishThreadBlockedReason(
  task: Pick<ThreadTaskState, "status" | "approvals" | "queuedTurns" | "agents"> | undefined,
  activeChildren = false,
  activeWorkflow = false,
): string | null {
  const active = activeThreadArchiveBlockedReason(task, activeChildren, activeWorkflow);
  if (active) return active;
  if (task?.approvals.length) return "Respond to this thread’s pending questions or approvals before archiving it.";
  if (task?.queuedTurns.length) return "Send or remove this thread’s queued messages before archiving it.";
  return null;
}

/**
 * Archives created before provider metadata was added can still be identified
 * by the presence of Mythra Code's locally persisted Claude transcript.
 */
export function providerForArchivedThread(
  record: Pick<ArchivedThread, "provider">,
  hasClaudeTranscript: boolean,
): Provider {
  return record.provider ?? (hasClaudeTranscript ? "claude" : "openai");
}

/** Archived lists mirror the selected Main/Sub-agents inbox and workspace.
 * Bulk deletion must use that exact visible scope rather than crossing into a
 * different project or silently deleting the other inbox's history. */
export function archivedThreadsForInbox(
  records: ArchivedThread[],
  workspacePath: string,
  childLinks: OwnershipLinks,
  kind: ThreadKindView,
): ArchivedThread[] {
  const path = normalizedProjectPath(workspacePath);
  const wantsChild = kind === "subagents";
  return records.filter((record) => (
    normalizedProjectPath(record.path) === path
    && Boolean(childLinks[record.id]) === wantsChild
  ));
}
