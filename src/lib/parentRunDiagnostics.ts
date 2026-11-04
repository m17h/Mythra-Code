import { auditEvent } from "./codex";
import {
  MAX_AUTOMATIC_PARENT_RESUMES,
  parentExecutionChange,
  type ParentExecutionChange,
  type ParentRun,
  type ParentRunPauseReason,
  type ParentRunPhase,
} from "./parentRun";
import { takeParentRunRetirement, type ParentRunRetirement } from "./taskStore";

/**
 * Local records of what a parent run did, so a failed or surprising follow-up
 * can be diagnosed from the app's existing audit log.
 *
 * Only identifiers and finite categories appear here. There is deliberately no
 * field that could carry a prompt, child output, a title, a path, an account
 * detail or a provider's error text. A paused run's free-text detail is never
 * read, except through `parentExecutionChange`, which maps it to a category.
 */

export const PARENT_RUN_AUDIT_KIND = "parentRun.transition";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES: readonly ParentRunPhase[] = ["active", "waiting", "continuing", "paused"];
const PAUSE_REASONS: readonly ParentRunPauseReason[] = [
  "restart", "start_uncertain", "parent_failed", "delivery_failed", "no_progress", "budget", "execution_changed",
];
const RETIREMENTS: readonly ParentRunRetirement[] = ["stop", "dont_continue", "dismiss", "conversation_removed"];

// Saved state is not a runtime type guarantee, especially its pause object.
function pauseReason(value: unknown): ParentRunPauseReason | undefined {
  return PAUSE_REASONS.includes(value as ParentRunPauseReason) ? value as ParentRunPauseReason : undefined;
}

export type ParentRunOutcome = "resolved" | "retired" | "failed" | "uncertain" | "unknown";

export interface ParentRunDiagnostic {
  runId: string;
  from: ParentRunPhase | "none";
  to: ParentRunPhase | "closed";
  resumesUsed: number;
  budget: number;
  followUpId?: string;
  trigger?: "automatic" | "explicit";
  pauseReason?: ParentRunPauseReason;
  executionChange?: ParentExecutionChange;
  outcome?: ParentRunOutcome;
  retiredBy?: ParentRunRetirement | "new_turn";
}

export interface ParentRunClosure {
  retirement?: ParentRunRetirement;
  /** A new root run replaced this one in the same transaction. */
  newTurn: boolean;
  /** The conversation itself went away, so nothing proves how this run ended. */
  taskRemoved: boolean;
}

/** "resolved" states only that nothing was left owed, however that came about. */
function closedOutcome(closure: ParentRunClosure): Pick<ParentRunDiagnostic, "outcome" | "retiredBy"> {
  if (closure.retirement && RETIREMENTS.includes(closure.retirement)) return { outcome: "retired", retiredBy: closure.retirement };
  if (closure.newTurn) return { outcome: "retired", retiredBy: "new_turn" };
  return { outcome: closure.taskRemoved ? "unknown" : "resolved" };
}

function pausedOutcome(reason: ParentRunPauseReason | undefined): ParentRunOutcome | undefined {
  if (reason === "delivery_failed" || reason === "parent_failed") return "failed";
  return reason === "start_uncertain" ? "uncertain" : undefined;
}

/**
 * One record for one meaningful transition, or null. Pure. A run that only ever
 * resolved inside its own turn never needed following. Explicit retirement,
 * replacement and missing-conversation closures still matter. The same phase
 * with new fields is an internal update and is not recorded.
 */
export function parentRunDiagnostic(previous: ParentRun | undefined, next: ParentRun | undefined, closure: ParentRunClosure): ParentRunDiagnostic | null {
  const run = next ?? previous;
  if (!run || previous === next) return null;
  if (!UUID.test(run.id) || !Number.isSafeInteger(run.resumesUsed) || run.resumesUsed < 0
    || (previous && !PHASES.includes(previous.phase)) || (next && !PHASES.includes(next.phase))) return null;
  if (!previous && next?.phase === "active") return null;
  if (!next && previous?.phase === "active" && !previous.yieldedTurnId
    && !closure.retirement && !closure.newTurn && !closure.taskRemoved) return null;
  if (previous && next && previous.phase === next.phase && previous.pause?.reason === next.pause?.reason) return null;
  const pause = next?.phase === "paused" ? next.pause : previous?.phase === "paused" ? previous.pause : undefined;
  const reason = pauseReason(pause?.reason);
  const followUpId = next?.phase === "continuing" ? next.dispatchId : previous?.phase === "continuing" ? previous.dispatchId : undefined;
  const execution = reason === "execution_changed" ? parentExecutionChange(pause?.detail) : undefined;
  // A refused start can restore an earlier pause, either from no record or
  // from the new owner's active record. Neither observes a new parent failure.
  // Real failure/uncertain-start transitions preserve the owner they pause.
  const failure = next?.phase === "paused" && previous && previous.ownerRunId === next.ownerRunId
    ? pausedOutcome(reason) : undefined;
  const outcome = next ? (failure ? { outcome: failure } : {}) : closedOutcome(closure);
  return {
    runId: run.id,
    from: previous?.phase ?? "none",
    to: next?.phase ?? "closed",
    resumesUsed: run.resumesUsed,
    budget: MAX_AUTOMATIC_PARENT_RESUMES,
    ...(followUpId && UUID.test(followUpId) ? { followUpId } : {}),
    ...(next?.phase === "continuing" && (previous?.phase === "waiting" || previous?.phase === "paused")
      ? { trigger: previous.phase === "waiting" ? "automatic" as const : "explicit" as const } : {}),
    ...(reason ? { pauseReason: reason } : {}),
    ...(execution ? { executionChange: execution } : {}),
    ...outcome,
  };
}

interface ParentRunState {
  parentRuns: Record<string, ParentRun>;
  tasks: Record<string, { agentRunId?: string } | undefined>;
}

function record(threadId: string, diagnostic: ParentRunDiagnostic | null): void {
  if (!diagnostic) return;
  try {
    void auditEvent(PARENT_RUN_AUDIT_KIND, { ...diagnostic }, threadId).catch(() => undefined);
  } catch {
    // Isolate each write too: one logger failure must not skip other runs.
  }
}

/**
 * Called after a store update that changed parent runs, never inside one.
 * Logging is fire and forget: nothing waits on it, and it cannot fail a turn.
 */
export function recordParentRunTransitions(state: ParentRunState, previous: ParentRunState): void {
  if (state.parentRuns === previous.parentRuns) return;
  try {
    for (const threadId of new Set([...Object.keys(previous.parentRuns), ...Object.keys(state.parentRuns)])) {
      const before = previous.parentRuns[threadId];
      const after = state.parentRuns[threadId];
      if (before === after) continue;
      const closure: ParentRunClosure = {
        retirement: after ? undefined : takeParentRunRetirement(threadId),
        newTurn: Boolean(before && after && before.id !== after.id)
          || Boolean(state.tasks[threadId]) && state.tasks[threadId]?.agentRunId !== previous.tasks[threadId]?.agentRunId,
        taskRemoved: !state.tasks[threadId],
      };
      if (before && after && before.id !== after.id) {
        record(threadId, parentRunDiagnostic(before, undefined, closure));
        record(threadId, parentRunDiagnostic(undefined, after, closure));
      } else {
        record(threadId, parentRunDiagnostic(before, after, closure));
      }
    }
  } catch {
    // Diagnostics never get to interrupt the transition they describe.
  }
}
