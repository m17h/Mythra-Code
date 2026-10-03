import type { NewThreadTimedPrompt } from "./newThreadTimedPrompts";
import { normalizedProjectPath } from "./paths";
import type { QueuedTurn } from "./taskStore";
import { isPendingTimedTurn } from "./timedPrompts";

export interface WorkspaceScheduledCounts {
  newConversations: number;
  threadPrompts: number;
}

export interface ScheduledPromptCounts {
  workspaces: Record<string, WorkspaceScheduledCounts>;
  threads: Record<string, number>;
}

/**
 * Pending schedules from the durable queue, including unopened threads.
 * Do not also count task shells: they hold the very same durable entries.
 * Logical project bindings take priority over an isolated execution folder.
 * Missed and failed prompts still need the user; released FIFO work does not.
 */
export function countScheduledPrompts(
  pendingTurns: readonly QueuedTurn[],
  newThreadPrompts: Readonly<Record<string, readonly NewThreadTimedPrompt[]>>,
  context: {
    bindings: Readonly<Record<string, string>>;
    knownThreads: Readonly<Record<string, { cwd?: string }>>;
    worktrees: Readonly<Record<string, { projectPath: string }>>;
    tasks: Readonly<Record<string, { workspacePath?: string }>>;
    archivedThreads?: readonly { id: string; path: string }[];
  },
): ScheduledPromptCounts {
  const workspaces: ScheduledPromptCounts["workspaces"] = {};
  const threads: ScheduledPromptCounts["threads"] = {};
  const archivedPaths = new Map(context.archivedThreads?.map((record) => [record.id, record.path]));
  const workspaceCounts = (path: string) => {
    const key = normalizedProjectPath(path);
    return workspaces[key] ??= { newConversations: 0, threadPrompts: 0 };
  };
  for (const [path, prompts] of Object.entries(newThreadPrompts)) {
    const count = prompts.filter((entry) => entry.status !== "sending").length;
    if (count) workspaceCounts(path).newConversations += count;
  }
  for (const entry of pendingTurns) {
    if (!isPendingTimedTurn(entry)) continue;
    threads[entry.threadId] = (threads[entry.threadId] ?? 0) + 1;
    const path = context.bindings[entry.threadId]
      || context.worktrees[entry.threadId]?.projectPath
      || archivedPaths.get(entry.threadId)
      || context.knownThreads[entry.threadId]?.cwd
      || context.tasks[entry.threadId]?.workspacePath;
    // An unknown workspace is not the workspace currently open in the UI.
    if (path) workspaceCounts(path).threadPrompts += 1;
  }
  return { workspaces, threads };
}

export function scheduledCountsLabel({ newConversations, threadPrompts }: WorkspaceScheduledCounts): string {
  return [
    newConversations > 0 ? `${newConversations} scheduled new conversation${newConversations === 1 ? "" : "s"}` : "",
    threadPrompts > 0 ? scheduledThreadCountLabel(threadPrompts) : "",
  ].filter(Boolean).join(", ");
}

export function scheduledThreadCountLabel(count: number): string {
  return `${count} scheduled prompt${count === 1 ? "" : "s"} in existing threads`;
}
