import type { Thread } from "../types";

/** Durable ownership for provider-native children (Codex collaboration agents). */
export interface NativeAgentLink {
  childThreadId: string;
  rootThreadId: string;
  title: string;
  path?: string;
  createdAt: number;
}

export function sanitizeNativeAgentLinks(value: unknown): Record<string, NativeAgentLink> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, NativeAgentLink> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const link = candidate as Partial<NativeAgentLink>;
    const childThreadId = typeof link.childThreadId === "string" ? link.childThreadId.trim() : "";
    const rootThreadId = typeof link.rootThreadId === "string" ? link.rootThreadId.trim() : "";
    if (!childThreadId || childThreadId !== key || !rootThreadId || childThreadId === rootThreadId) continue;
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
