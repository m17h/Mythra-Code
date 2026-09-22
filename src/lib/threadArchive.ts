import type { ArchivedThread, Provider } from "../types";
import type { OwnershipLinks } from "./nativeAgentLinks";
import { normalizedProjectPath } from "./paths";
import type { ThreadKindView } from "./threadList";
import type { ThreadTaskState } from "./taskStore";
import { isActiveAgentRecord } from "./subAgentActivity";

/** Finishing a PR must never discard queued work or hide work awaiting a reply. */
export function finishThreadBlockedReason(
  task: Pick<ThreadTaskState, "status" | "approvals" | "queuedTurns" | "agents"> | undefined,
  activeChildren = false,
): string | null {
  if (task?.status === "starting" || task?.status === "running") return "Finish or stop this thread before archiving it.";
  if (activeChildren || task?.agents.some((agent) => isActiveAgentRecord(agent.status))) return "Finish or stop this thread’s sub-agents before archiving it.";
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
