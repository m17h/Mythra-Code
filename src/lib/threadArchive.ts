import type { ArchivedThread, Provider } from "../types";
import type { OwnershipLinks } from "./nativeAgentLinks";
import { normalizedProjectPath } from "./paths";
import type { ThreadKindView } from "./threadList";

/**
 * Archives created before provider metadata was added can still be identified
 * by the presence of OpenKiwi's locally persisted Claude transcript.
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
