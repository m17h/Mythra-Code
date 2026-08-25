import type { Thread } from "../types";
import type { TaskStatus } from "./taskStore";
import { ownsChildren, type OwnershipLinks } from "./nativeAgentLinks";

export type ThreadSidebarIndex = Record<string, Thread>;

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function threadBelongsToWorkspace(
  thread: Thread,
  workspacePath: string,
  bindings: Record<string, string>,
): boolean {
  return normalizedPath(bindings[thread.id] || thread.cwd) === normalizedPath(workspacePath);
}

export function filterThreadsForWorkspace(
  threads: Thread[],
  workspacePath: string,
  bindings: Record<string, string>,
): Thread[] {
  return threads.filter((thread) => threadBelongsToWorkspace(thread, workspacePath, bindings));
}

export type ThreadKindView = "main" | "subagents";

/**
 * Remove child-only metadata from a thread that the durable graph proves is a
 * root. Persisting this repair matters: otherwise deleting its final child can
 * expose the old poisoned `parentThreadId` and move the root back into the
 * Sub-agents inbox.
 */
export function repairRootThreadMetadata(thread: Thread, childLinks: OwnershipLinks): Thread {
  if (!ownsChildren(childLinks, thread.id)) return thread;
  const hasChildMetadata = Boolean(
    thread.parentThreadId
    || thread.threadSource === "subagent"
    || thread.agentNickname
    || thread.agentRole
    || thread.agentPath,
  );
  if (!hasChildMetadata) return thread;
  const {
    parentThreadId: _parentThreadId,
    agentNickname: _agentNickname,
    agentRole: _agentRole,
    agentPath: _agentPath,
    ...withoutAgentMetadata
  } = thread;
  if (withoutAgentMetadata.threadSource !== "subagent") return withoutAgentMetadata;
  const { threadSource: _threadSource, ...root } = withoutAgentMetadata;
  return root;
}

/**
 * Which inbox a conversation belongs in.
 *
 * Mythra Code's own durable ownership records outrank whatever a provider reports
 * on the thread itself: a conversation that owns children is a root, full stop,
 * and depth is capped at one. Without that precedence a single reversed or
 * self-referential runtime event could move the user's main conversation into
 * the Sub-agents inbox permanently, because `parentThreadId` is persisted on
 * the thread record and would keep answering yes forever after.
 */
export function isSubAgentThread(thread: Thread, childLinks: OwnershipLinks): boolean {
  if (ownsChildren(childLinks, thread.id)) return false;
  if (childLinks[thread.id]) return true;
  // A thread reported as its own parent is a runtime artifact, not a child.
  if (thread.parentThreadId && thread.parentThreadId !== thread.id) return true;
  return thread.threadSource === "subagent";
}

/** Keep Mythra Code child work browsable without mixing it into the user's main inbox. */
export function filterThreadsByKind(
  threads: Thread[],
  childLinks: OwnershipLinks,
  kind: ThreadKindView,
): Thread[] {
  const wantsChild = kind === "subagents";
  return threads.filter((thread) => isSubAgentThread(thread, childLinks) === wantsChild);
}

/** Bulk archive never stops a live task. Split the selected inbox snapshot so
 * the UI can archive every idle thread while clearly reporting active skips. */
export function partitionBulkArchiveThreads(
  threads: Thread[],
  statuses: Record<string, TaskStatus | undefined>,
): { ready: Thread[]; active: Thread[] } {
  const ready: Thread[] = [];
  const active: Thread[] = [];
  for (const thread of threads) {
    const status = statuses[thread.id];
    (status === "starting" || status === "running" ? active : ready).push(thread);
  }
  return { ready, active };
}

export function countActiveThreadsByWorkspace(
  index: ThreadSidebarIndex,
  bindings: Record<string, string>,
  statuses: Record<string, TaskStatus | undefined>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [threadId, status] of Object.entries(statuses)) {
    if (status !== "starting" && status !== "running") continue;
    const pathValue = bindings[threadId] || index[threadId]?.cwd;
    if (!pathValue) continue;
    const path = normalizedPath(pathValue);
    counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}

export function sidebarThread(thread: Thread): Thread {
  const { turns: _turns, ...summary } = thread;
  return summary;
}

/** The remembered index is rewritten on every turn — keep it bounded. */
export const MAX_REMEMBERED_THREADS = 500;

export function pruneSidebarIndex(index: ThreadSidebarIndex, max = MAX_REMEMBERED_THREADS): ThreadSidebarIndex {
  const entries = Object.values(index);
  if (entries.length <= max) return index;
  const kept = entries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, max);
  const next: ThreadSidebarIndex = {};
  for (const thread of kept) next[thread.id] = thread;
  return next;
}

export function rememberSidebarThread(index: ThreadSidebarIndex, thread: Thread): ThreadSidebarIndex {
  return pruneSidebarIndex({ ...index, [thread.id]: sidebarThread(thread) });
}

export function forgetSidebarThread(index: ThreadSidebarIndex, threadId: string): ThreadSidebarIndex {
  if (!index[threadId]) return index;
  const next = { ...index };
  delete next[threadId];
  return next;
}

export function reconcileWorkspaceThreads(
  runtimeThreads: Thread[],
  rememberedThreads: ThreadSidebarIndex,
  workspacePath: string,
  bindings: Record<string, string>,
): Thread[] {
  const merged = new Map<string, Thread>();
  for (const thread of Object.values(rememberedThreads)) {
    if (threadBelongsToWorkspace(thread, workspacePath, bindings)) merged.set(thread.id, thread);
  }
  for (const thread of runtimeThreads) {
    if (threadBelongsToWorkspace(thread, workspacePath, bindings)) merged.set(thread.id, sidebarThread(thread));
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const index = threads.findIndex((entry) => entry.id === thread.id);
  if (index === -1) return [...threads, thread];
  return threads.map((entry, entryIndex) => entryIndex === index ? thread : entry);
}

export function optimisticStartedThread(thread: Thread, firstMessage: string, nowSeconds = Math.floor(Date.now() / 1000)): Thread {
  return {
    ...thread,
    preview: thread.preview || firstMessage,
    updatedAt: Math.max(thread.updatedAt || 0, nowSeconds),
  };
}
