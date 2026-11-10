export interface PendingTurnStart {
  cancelRequested: boolean;
}

// Shared evidence survives view navigation, but intentionally not renderer
// replacement. A restored UI 'starting' flag is not a live JS preparation.
const activeStarts = new Map<string, Set<PendingTurnStart>>();
const startRevisions = new Map<string, number>();

export function hasPendingTurnStart(threadId: string): boolean {
  return Boolean(activeStarts.get(threadId)?.size);
}

export function pendingTurnStartRevision(threadId: string): number {
  return startRevisions.get(threadId) ?? 0;
}

/**
 * Registry of turn-start RPCs that are still in flight, keyed by thread id.
 *
 * Pressing Stop during the start window flags the specific pending start, and
 * sendMessage consumes that flag when its own RPC settles. Because an intent
 * can only be recorded against an existing in-flight start, pressing Stop
 * while looking at a thread that is not starting records nothing — a stale
 * intent can never cancel a later, unrelated turn after navigating between
 * threads.
 */
export class PendingTurnStarts {
  private readonly starts = new Map<string, PendingTurnStart>();

  /** Register a turn start whose RPC is about to be issued. */
  begin(threadId: string): PendingTurnStart {
    const pending: PendingTurnStart = { cancelRequested: false };
    this.starts.set(threadId, pending);
    const active = activeStarts.get(threadId) ?? new Set<PendingTurnStart>();
    active.add(pending);
    activeStarts.set(threadId, active);
    startRevisions.set(threadId, pendingTurnStartRevision(threadId) + 1);
    return pending;
  }

  /**
   * Flag the in-flight start for this thread for cancellation.
   * Returns false when the thread has no start in flight.
   */
  requestCancel(threadId: string): boolean {
    const pending = this.starts.get(threadId);
    if (!pending) return false;
    pending.cancelRequested = true;
    return true;
  }

  /**
   * Settle a start begun earlier and report whether cancellation was
   * requested while it was in flight. Only removes the registry entry when it
   * still belongs to this exact start, so an overlapping newer start for the
   * same thread is unaffected.
   */
  finish(threadId: string, pending: PendingTurnStart): boolean {
    if (this.starts.get(threadId) === pending) this.starts.delete(threadId);
    const active = activeStarts.get(threadId);
    if (active?.delete(pending)) {
      if (!active.size) activeStarts.delete(threadId);
      startRevisions.set(threadId, pendingTurnStartRevision(threadId) + 1);
    }
    return pending.cancelRequested;
  }
}
