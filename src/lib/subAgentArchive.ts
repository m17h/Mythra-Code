import type { OwnershipLinks } from "./nativeAgentLinks";
import type { TaskStatus } from "./taskStore";

function active(status: TaskStatus | undefined): boolean {
  return status === "starting" || status === "running";
}

/**
 * Child conversations safe to auto-archive at one completion boundary.
 *
 * A parent completion archives children that have already settled. A child
 * that legitimately outlives its parent is skipped then and becomes eligible
 * when its own completion arrives. This function is deliberately independent
 * of provider: native Codex children and OpenKiwi-managed Claude/Cursor/OpenAI
 * children share the same durable ownership graph.
 */
export function autoArchiveSubagentCandidates(input: {
  completedThreadId: string;
  links: OwnershipLinks;
  statuses: Record<string, TaskStatus>;
  archivedThreadIds?: Iterable<string>;
}): string[] {
  const archived = new Set(input.archivedThreadIds ?? []);
  const ownership = input.links[input.completedThreadId];
  if (ownership && active(input.statuses[ownership.rootThreadId])) return [];
  const candidates = ownership
    ? [input.completedThreadId]
    : Object.entries(input.links)
      .filter(([, link]) => link.rootThreadId === input.completedThreadId)
      .map(([childThreadId]) => childThreadId);
  return [...new Set(candidates)].filter((childThreadId) => (
    !active(input.statuses[childThreadId]) && !archived.has(childThreadId)
  ));
}
