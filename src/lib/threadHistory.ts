import type { Turn } from "../types";

/** Recent turns are enough to make a reopened thread useful immediately. */
export const INITIAL_THREAD_TURN_LIMIT = 10;
/** Older pages are larger because they are requested deliberately by the user. */
export const OLDER_THREAD_TURN_LIMIT = 24;

export interface ThreadTurnsPage {
  data: Turn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadHistoryState {
  /** Cursor for the next older page in descending server order. */
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  /** False means the transcript came from the compatibility full-read path. */
  paginated: boolean;
}

export const EMPTY_THREAD_HISTORY: ThreadHistoryState = {
  nextCursor: null,
  hasMore: false,
  loading: false,
  paginated: false,
};

/**
 * The app-server returns descending pages by default. The renderer timeline is
 * ascending, so reverse a copy and never mutate the RPC response.
 */
export function turnsFromDescendingPage(page: ThreadTurnsPage): Turn[] {
  return [...page.data].reverse();
}

/**
 * Keep the bridge tolerant of an older app-server that returns a partial error
 * or a shape from an early pagination build. Invalid pages fail closed so the
 * caller can use the established full-history fallback.
 */
export function normalizeThreadTurnsPage(value: unknown): ThreadTurnsPage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { data?: unknown; nextCursor?: unknown; backwardsCursor?: unknown };
  if (!Array.isArray(candidate.data)) return null;
  const validTurn = (turn: unknown): turn is Turn => (
    Boolean(turn)
    && typeof turn === "object"
    && typeof (turn as { id?: unknown }).id === "string"
    && Array.isArray((turn as { items?: unknown }).items)
  );
  // Dropping one malformed turn would advance the opaque cursor past data the
  // UI never received, creating a permanent hole in the transcript.
  if (!candidate.data.every(validTurn)) return null;
  return {
    data: candidate.data,
    nextCursor: typeof candidate.nextCursor === "string" ? candidate.nextCursor : null,
    backwardsCursor: typeof candidate.backwardsCursor === "string" ? candidate.backwardsCursor : null,
  };
}

export function isPaginatedHistoryUnsupported(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason);
  // RPC wrappers commonly prefix every failure with the method name. The
  // name alone is not evidence of an old runtime: latching on a transient
  // connection error would force a full-history fallback that true paginated
  // stores intentionally reject.
  return /initialTurnsPage|exclude[_ ]?turns|itemsView|sortDirection|unknown method|method not found|unknown field|unknown variant|not supported|unsupported|unrecognized|invalid (?:field|parameter|params)|additional propert/i.test(text);
}

/** Only this field proves a metadata-only resume/fork itself is too new. */
export function isExcludeTurnsUnsupported(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason);
  return /exclude[_ ]?turns/i.test(text)
    && /unknown|not supported|unsupported|unrecognized|invalid|additional propert/i.test(text);
}
