import type { AgentRecord } from "../components/StudioDock";
import { nativeDescendantIds, type NativeAgentLink, type OwnershipLinks } from "./nativeAgentLinks";
import { isActiveAgentRecord } from "./subAgentActivity";
import type { TaskStatus } from "./taskStore";

function active(status: TaskStatus | undefined): boolean {
  return status === "starting" || status === "running";
}

export interface NativeArchiveEvidence {
  nativeLinks?: Record<string, NativeAgentLink>;
  agentRecordsByThread?: Record<string, readonly AgentRecord[]>;
}

/** A seeded idle task does not prove that its provider-native worker stopped. */
export function nativeArchiveActivity(input: NativeArchiveEvidence & {
  threadId: string;
  statuses: Record<string, TaskStatus>;
}): { activeSelf: boolean; activeDescendants: boolean } {
  const nativeLinks = input.nativeLinks ?? {};
  const childActive = (threadId: string): boolean => {
    const link = nativeLinks[threadId];
    if (!link) return false;
    const taskStatus = input.statuses[threadId];
    if (taskStatus && taskStatus !== "idle") return active(taskStatus);
    const record = input.agentRecordsByThread?.[link.rootThreadId]?.find((agent) => agent.id === threadId);
    return isActiveAgentRecord(record?.status ?? link.status ?? "unknown");
  };
  return {
    activeSelf: childActive(input.threadId),
    activeDescendants: nativeDescendantIds(nativeLinks, input.threadId).some(childActive),
  };
}

/**
 * Child conversations safe to auto-archive at one completion boundary.
 *
 * A parent completion archives children that have already settled. A child
 * that legitimately outlives its parent is skipped then and becomes eligible
 * when its own completion arrives. This function is deliberately independent
 * of provider: native Codex children and Mythra Code-managed Claude/Cursor/OpenAI
 * children share the same durable ownership graph.
 *
 * Managed children created with parent conversations additionally wait for
 * explicit sign-off: a finished turn (the child's or the parent's) is only
 * "awaiting review". `requiresSignoff` reports exactly those children; native
 * and legacy children are unaffected.
 */
export function autoArchiveSubagentCandidates(input: NativeArchiveEvidence & {
  completedThreadId: string;
  links: OwnershipLinks;
  statuses: Record<string, TaskStatus>;
  archivedThreadIds?: Iterable<string>;
  requiresSignoff?: (childThreadId: string) => boolean;
}): string[] {
  const archived = new Set(input.archivedThreadIds ?? []);
  const ownership = input.links[input.completedThreadId];
  // A nested native parent can be seeded idle after reload while its own
  // roster/link still proves (or cannot rule out) active work.
  if (ownership && (active(input.statuses[ownership.rootThreadId])
    || nativeArchiveActivity({ ...input, threadId: ownership.rootThreadId }).activeSelf)) return [];
  const candidates = ownership
    ? [input.completedThreadId]
    : Object.entries(input.links)
      .filter(([, link]) => link.rootThreadId === input.completedThreadId)
      .map(([childThreadId]) => childThreadId);
  if (!ownership) candidates.push(...nativeDescendantIds(input.nativeLinks ?? {}, input.completedThreadId));
  return [...new Set(candidates)].filter((childThreadId) => {
    const nativeActivity = nativeArchiveActivity({ ...input, threadId: childThreadId });
    return !active(input.statuses[childThreadId]) && !archived.has(childThreadId)
      && !nativeActivity.activeSelf && !nativeActivity.activeDescendants
      && !input.requiresSignoff?.(childThreadId);
  });
}
