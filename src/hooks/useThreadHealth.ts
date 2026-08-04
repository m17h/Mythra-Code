import { useEffect, useRef } from "react";
import { rpc } from "../lib/codex";
import { isClaudeTurnActive } from "../lib/claude";
import { isCursorTurnActive } from "../lib/cursor";
import { isClaudeThread, isCursorThread } from "../lib/threadProvider";
import { useTaskStore, type TaskStatus, type ThreadTaskState } from "../lib/taskStore";
import type { Thread, Turn } from "../types";

export const THREAD_HEALTH_INTERVAL_MS = 30_000;
export const THREAD_HEALTH_STALE_MS = 45_000;

export function terminalTurnStatus(turn: Turn | undefined): TaskStatus | null {
  if (!turn || !turn.status || turn.status === "inProgress") return null;
  if (turn.status === "interrupted") return "interrupted";
  if (turn.status === "failed") return "error";
  return "completed";
}

function recordRecoveredStatus(threadId: string, task: ThreadTaskState, status: TaskStatus): void {
  const store = useTaskStore.getState();
  store.completeTurn(threadId, task.activeTurnId, status);
  store.upsertActivity(threadId, {
    id: `thread-health-${Date.now()}`,
    kind: "warning",
    title: "Thread status recovered",
    detail: "OpenKiwi reconciled this thread after its final provider event was missed.",
  });
}

export interface ThreadHealthContext {
  runtimeAvailable: boolean;
  threadFor: (threadId: string) => Thread | undefined;
}

/** Periodically repairs a working status whose provider process already ended. */
export function useThreadHealth(context: ThreadHealthContext): void {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking || disposed) return;
      checking = true;
      try {
        const snapshot = useTaskStore.getState();
        const candidates = Object.values(snapshot.tasks).filter((task) => (
          (task.status === "starting" || task.status === "running")
          && Date.now() - task.updatedAt >= THREAD_HEALTH_STALE_MS
        ));
        for (const task of candidates) {
          if (disposed) return;
          const thread = contextRef.current.threadFor(task.threadId);
          if (!thread) continue;
          try {
            if (isClaudeThread(thread)) {
              if (!await isClaudeTurnActive(task.threadId)) recordRecoveredStatus(task.threadId, task, "completed");
              continue;
            }
            if (isCursorThread(thread)) {
              if (!await isCursorTurnActive(task.threadId)) recordRecoveredStatus(task.threadId, task, "completed");
              continue;
            }
            if (!contextRef.current.runtimeAvailable) continue;
            const result = await rpc<{ thread: Thread }>("thread/read", { threadId: task.threadId, includeTurns: true });
            const latest = result.thread.turns?.at(-1);
            const status = terminalTurnStatus(latest);
            if (status) recordRecoveredStatus(task.threadId, task, status);
          } catch {
            // A transient health-check failure must not overwrite live state.
          }
        }
      } finally {
        checking = false;
      }
    };
    const interval = window.setInterval(() => void check(), THREAD_HEALTH_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
}
