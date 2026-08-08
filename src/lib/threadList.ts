import type { Thread } from "../types";
import type { TaskStatus } from "./taskStore";

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

/** Keep OpenKiwi child work browsable without mixing it into the user's main inbox. */
export function filterThreadsByKind(
  threads: Thread[],
  childLinks: Record<string, unknown>,
  kind: ThreadKindView,
): Thread[] {
  const wantsChild = kind === "subagents";
  return threads.filter((thread) => Boolean(childLinks[thread.id]) === wantsChild);
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
