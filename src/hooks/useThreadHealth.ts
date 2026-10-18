import { useEffect, useRef } from "react";
import { rpc } from "../lib/codex";
import { claudeTurnTerminalReceipt, isClaudeTurnActive, type ClaudeEvent } from "../lib/claude";
import { isCursorTurnActive } from "../lib/cursor";
import { hasProviderStopIntent } from "../lib/providerStopIntent";
import { isClaudeThread, isCursorThread } from "../lib/threadProvider";
import { isPaginatedHistoryUnsupported, normalizeThreadTurnsPage } from "../lib/threadHistory";
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
  const current = store.tasks[threadId];
  if (!current || current.activeTurnId !== task.activeTurnId
    || current.updatedAt !== task.updatedAt
    || (current.status !== "starting" && current.status !== "running")) return;
  // Completion clears activeTurnId. Retain the probed owner so the recovery
  // warning remains part of that turn's history, even after it is sealed.
  const turnId = current.activeTurnId;
  if (!store.completeTurn(threadId, turnId, status)) return;
  const localExit = status === "error";
  const detail = localExit
    ? "The local provider process ended without a final response. Mythra Code closed the unfinished turn so it can be retried instead of leaving a false running state."
    : "Mythra Code reconciled this thread after its final provider event was missed.";
  if (localExit) store.setTaskStatus(threadId, "error", detail);
  store.upsertActivity(threadId, {
    id: `thread-health-${Date.now()}`,
    turnId,
    kind: "warning",
    title: "Thread status recovered",
    detail,
    ...(localExit ? { status: "failed" } : {}),
  });
}

/** A health probe needs one status record, not a potentially multi-megabyte
 * transcript. Retain the full read only for app-server compatibility. */
export async function latestCodexTurn(threadId: string): Promise<Turn | undefined> {
  try {
    const page = normalizeThreadTurnsPage(await rpc<unknown>("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    }));
    if (page) return page.data[0];
  } catch (reason) {
    if (!isPaginatedHistoryUnsupported(reason)) throw reason;
  }
  const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
  return result.thread.turns?.at(-1);
}

export interface ThreadHealthContext {
  runtimeAvailable: boolean;
  threadFor: (threadId: string) => Thread | undefined;
  /** The normal Claude event route, for a terminal event the process
   * recorded before releasing the thread but the renderer has not handled. */
  deliverClaudeEvent?: (event: ClaudeEvent) => void;
}

/** The probed snapshot still describes the task: same owner, still working,
 * untouched since, and no replacement activation pending. */
function unchangedSince(task: ThreadTaskState): boolean {
  const current = useTaskStore.getState().tasks[task.threadId];
  return current !== undefined && current.activeTurnId === task.activeTurnId && current.updatedAt === task.updatedAt
    && (current.status === "starting" || current.status === "running") && !current.pendingNativeActivationId;
}

/**
 * Reconcile an inactive Claude process. Returns without sealing whenever the
 * outcome is not yet known:
 * - a Stop for this exact turn is still settling (the kill clears liveness
 *   before its exit is published; Stop's own handler classifies it);
 * - the process recorded its exact ending, possibly still queued for the
 *   renderer: it is delivered through the normal handler, with its own
 *   retired-turn and Stop guards, instead of sealing a finished turn failed;
 * - the task changed during a probe.
 * A receipt read failure propagates to the caller, which leaves live state.
 */
async function reconcileInactiveClaudeTurn(task: ThreadTaskState, deliver?: (event: ClaudeEvent) => void): Promise<void> {
  const turnId = task.activeTurnId;
  if (turnId && hasProviderStopIntent(task.threadId, turnId)) return;
  if (turnId && deliver) {
    const message = await claudeTurnTerminalReceipt(task.threadId, turnId);
    if (!unchangedSince(task) || hasProviderStopIntent(task.threadId, turnId)) return;
    if (message) {
      deliver({ threadId: task.threadId, turnId, message });
      return;
    }
  }
  recordRecoveredStatus(task.threadId, task, "error");
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
              if (await isClaudeTurnActive(task.threadId)) continue;
              if (!unchangedSince(task)) continue;
              await reconcileInactiveClaudeTurn(task, contextRef.current.deliverClaudeEvent);
              continue;
            }
            if (isCursorThread(thread)) {
              if (!await isCursorTurnActive(task.threadId)) recordRecoveredStatus(task.threadId, task, "error");
              continue;
            }
            if (!contextRef.current.runtimeAvailable) continue;
            const latest = await latestCodexTurn(task.threadId);
            if (task.activeTurnId && latest?.id !== task.activeTurnId) continue;
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
    void check();
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
