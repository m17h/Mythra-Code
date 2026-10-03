import { create } from "zustand";

export type ClaudeContinuationKind = "grace" | "paid";
export interface ClaudeContinuation {
  turnId: string;
  kind: ClaudeContinuationKind;
  /** The CLI's reset boundary, not an invented countdown for the allowance. */
  expiresAt?: number;
}

/**
 * Claude Code 2.1.288 emits rateLimitGraceActive in SDK rate_limit_event.
 * The CLI negotiates the allowance itself; Mythra must not inject experimental
 * headers, reset allowances, retry an exhausted task, or enable usage credits.
 * A rejected event can retain the grace flag: it is NOT evidence of permission
 * to continue. overageStatus alone only describes availability, not spending.
 */
export function parseClaudeContinuation(payload: unknown, now = Date.now()): Omit<ClaudeContinuation, "turnId"> | null | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const event = payload as Record<string, unknown>;
  const candidate = event.rate_limit_info;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const info = candidate as Record<string, unknown>;
  if (info.status === "rejected") return null;
  if (info.status !== "allowed" && info.status !== "allowed_warning") return undefined;

  // A model's included "overage" window (e.g. Fable) is still subscription
  // usage. Only explicit spending telemetry identifies paid usage credits.
  const paid = info.overageInUse === true
    || (info.isUsingOverage === true && info.rateLimitType !== "seven_day_overage_included");
  if (paid) return { kind: "paid" };
  if (info.rateLimitGraceActive !== true) return null;
  const reset = info.resetsAt;
  const expiresAt = typeof reset === "number" && Number.isFinite(reset) && reset > 0
    ? reset * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= now) return null;
  return { kind: "grace", ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

interface ClaudeContinuationStore {
  byThread: Record<string, ClaudeContinuation>;
  update: (threadId: string, turnId: string, continuation: ReturnType<typeof parseClaudeContinuation>) => void;
  clear: (threadId: string, turnId?: string) => void;
}

/** Ephemeral, turn-scoped telemetry. Never restore a live allowance from disk. */
export const useClaudeContinuationStore = create<ClaudeContinuationStore>((set) => ({
  byThread: {},
  update: (threadId, turnId, continuation) => set((state) => {
    if (continuation === undefined) return state;
    const previous = state.byThread[threadId];
    if (continuation === null) {
      if (!previous || previous.turnId !== turnId) return state;
      const next = { ...state.byThread };
      delete next[threadId];
      return { byThread: next };
    }
    if (previous?.turnId === turnId && previous.kind === continuation.kind && previous.expiresAt === continuation.expiresAt) return state;
    return { byThread: { ...state.byThread, [threadId]: { ...continuation, turnId } } };
  }),
  clear: (threadId, turnId) => set((state) => {
    const previous = state.byThread[threadId];
    if (!previous || (turnId !== undefined && previous.turnId !== turnId)) return state;
    const next = { ...state.byThread };
    delete next[threadId];
    return { byThread: next };
  }),
}));
