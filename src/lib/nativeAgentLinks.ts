import type { Thread } from "../types";

/** Durable ownership for provider-native children (Codex collaboration agents). */
export interface NativeAgentLink {
  childThreadId: string;
  rootThreadId: string;
  title: string;
  path?: string;
  createdAt: number;
}

/**
 * The durable ownership graph, as any link map keyed by child thread id.
 *
 * Both link generations participate: Mythra Code's own {@link ChildAgentLink}
 * records and the provider-native ones below. Ownership questions have to be
 * asked of the whole graph or a root proved by one generation could be
 * reclassified by the other.
 */
export type OwnershipLinks = Record<string, { rootThreadId: string }>;

/** A thread that owns children is a root; depth is capped at one by design. */
export function ownsChildren(links: OwnershipLinks, threadId: string): boolean {
  if (!threadId) return false;
  return Object.values(links).some((link) => link.rootThreadId === threadId);
}

/**
 * Whether `rootThreadId` may be recorded as the owner of `childThreadId`.
 *
 * Ownership is durable and it decides which inbox a conversation lives in, so
 * a late or malformed runtime event must never be able to move a conversation
 * between owners or turn an established root into somebody's child. The graph
 * is bounded to a forest of depth one, and every claim that would break that
 * shape is refused rather than repaired:
 *
 * - self ownership, where a thread is reported as its own child;
 * - a second owner, where a child that already belongs to one root is claimed
 *   by another (the first durable record wins; re-asserting it is fine);
 * - a child that is itself a root, which would nest delegation two deep;
 * - a root that is itself somebody's child, which would nest it two deep the
 *   other way round (and covers every reversed claim and cycle).
 */
export function canOwnThread(links: OwnershipLinks, rootThreadId: string, childThreadId: string): boolean {
  if (!rootThreadId || !childThreadId || rootThreadId === childThreadId) return false;
  const existing = links[childThreadId];
  if (existing && existing.rootThreadId !== rootThreadId) return false;
  if (ownsChildren(links, childThreadId)) return false;
  return !links[rootThreadId];
}

export function sanitizeNativeAgentLinks(value: unknown): Record<string, NativeAgentLink> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, NativeAgentLink> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const link = candidate as Partial<NativeAgentLink>;
    const childThreadId = typeof link.childThreadId === "string" ? link.childThreadId.trim() : "";
    const rootThreadId = typeof link.rootThreadId === "string" ? link.rootThreadId.trim() : "";
    if (!childThreadId || childThreadId !== key || !rootThreadId) continue;
    // Hand-edited or partially written storage can contain a cycle. Accepting
    // entries against what has already been accepted keeps the restored graph
    // acyclic instead of trusting whatever order the file happened to hold.
    if (!canOwnThread(result, rootThreadId, childThreadId)) continue;
    result[key] = {
      childThreadId,
      rootThreadId,
      title: typeof link.title === "string" && link.title.trim() ? link.title.trim() : "Delegated task",
      ...(typeof link.path === "string" && link.path.trim() ? { path: link.path.trim() } : {}),
      createdAt: Number.isFinite(link.createdAt) && Number(link.createdAt) > 0 ? Number(link.createdAt) : Date.now(),
    };
  }
  return result;
}

export function nativeAgentLinkFromThread(thread: Thread): NativeAgentLink | null {
  if (!thread.parentThreadId || thread.parentThreadId === thread.id) return null;
  return {
    childThreadId: thread.id,
    rootThreadId: thread.parentThreadId,
    title: thread.agentNickname || thread.agentRole || thread.preview || "Delegated task",
    ...(thread.agentPath ? { path: thread.agentPath } : {}),
    createdAt: Math.max(1, thread.updatedAt * 1000),
  };
}

/** Deleting a root does not erase its surviving children from the child inbox. */
export function nativeAgentLinksAfterThreadDeletion(
  links: Record<string, NativeAgentLink>,
  deletedThreadId: string,
): Record<string, NativeAgentLink> {
  if (!links[deletedThreadId]) return links;
  const next = { ...links };
  delete next[deletedThreadId];
  return next;
}
