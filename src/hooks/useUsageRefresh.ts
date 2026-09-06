import { useCallback, useEffect, useRef } from "react";
import { auditEvent } from "../lib/codex";

/**
 * How often a visible window re-reads the active provider's quota.
 *
 * Providers only report usage when they are asked, so an app left open on one
 * screen used to show whatever the last finished turn happened to report —
 * often minutes or hours old, and never reflecting work done in another client
 * or a window that rolled over on its own.
 */
export const USAGE_POLL_MS = 60_000;

/**
 * Floor between two reads. Focus, visibility and turn completions all arrive in
 * bursts (alt-tabbing, several threads finishing together), and every read is a
 * provider round trip, so bursts collapse into one.
 */
export const USAGE_MIN_GAP_MS = 15_000;

/** A rollover is only trustworthy once the provider has seen it too. */
const RESET_GRACE_MS = 5_000;

/** `setTimeout` silently fires immediately past this, so long waits re-arm. */
const MAX_TIMEOUT_MS = 21_600_000;

export interface UsageRefreshOptions {
  /**
   * Identifies the account being watched. A change (switching provider, signing
   * in) reads immediately, because the previous provider's snapshot says
   * nothing about this one.
   */
  key: string;
  /** False when the provider reports no live quota, or is not connected yet. */
  enabled: boolean;
  /** Reads the provider and stores the result. Rejections are absorbed. */
  refresh: () => Promise<unknown>;
  /**
   * Unix seconds of the soonest window rollover, when one is known. The quota
   * jumps at that instant with no turn to notice it, so schedule a read.
   */
  resetsAt?: number | null;
  pollMs?: number;
  minGapMs?: number;
  onStatus?: (status: string) => void;
}

/**
 * Keeps one provider quota reading fresh while the app is on screen, and
 * returns a request function for the moments a poll would miss: a finished
 * turn, an opened usage panel, a manual refresh.
 *
 * `force` skips the burst floor but never the in-flight guard, so a deliberate
 * refresh is always honoured while overlapping reads still collapse into one.
 */
export function useUsageRefresh({
  key,
  enabled,
  refresh,
  resetsAt,
  pollMs = USAGE_POLL_MS,
  minGapMs = USAGE_MIN_GAP_MS,
  onStatus,
}: UsageRefreshOptions): (options?: { force?: boolean }) => void {
  const latestRef = useRef({ key, enabled, refresh, minGapMs, onStatus });
  latestRef.current = { key, enabled, refresh, minGapMs, onStatus };
  const inFlightRef = useRef<Record<string, true>>({});
  const lastReadRef = useRef(0);

  const request = useCallback((options: { force?: boolean } = {}) => {
    const current = latestRef.current;
    if (!current.enabled || inFlightRef.current[current.key]) return;
    if (!options.force && Date.now() - lastReadRef.current < current.minGapMs) return;
    const identity = current.key;
    inFlightRef.current[identity] = true;
    current.onStatus?.("Refreshing usage…");
    const complete = (failed = false) => {
      const active = latestRef.current;
      if (active.enabled && active.key === identity) {
        active.onStatus?.(failed ? "Refresh unavailable · last reading" : "Updated");
        lastReadRef.current = Date.now();
      }
      void auditEvent("usage.read", { provider: identity.split(":")[0], outcome: failed ? "unavailable" : "success" }).catch(() => {});
      delete inFlightRef.current[identity];
    };
    void Promise.resolve()
      .then(current.refresh)
      .then(() => complete(), () => complete(true));
  }, []);

  // Switching provider or account puts a quota on screen that nothing has read
  // yet, so it ignores the burst floor. The first account this hook ever sees is
  // the exception: connecting it is what read it in the first place, and a
  // second read on launch would only duplicate that one.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    request({ force: true });
  }, [enabled, key, request]);

  useEffect(() => {
    if (!enabled) return;
    const poll = () => {
      if (!document.hidden) request();
    };
    const timer = window.setInterval(poll, pollMs);
    // Returning to the app is the moment a stale number is most visible, and
    // also the moment a background window's skipped polls have to be made up.
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [enabled, key, pollMs, request]);

  useEffect(() => {
    if (!enabled || !resetsAt || !Number.isFinite(resetsAt)) return;
    const delay = resetsAt * 1000 + RESET_GRACE_MS - Date.now();
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return;
    const timer = window.setTimeout(() => request({ force: true }), delay);
    return () => window.clearTimeout(timer);
  }, [enabled, request, resetsAt]);

  return request;
}

/** Soonest rollover across a provider's windows, in unix seconds. */
export function nextUsageReset(windows: Array<{ resetsAt?: number | null }>, now = Date.now()): number | null {
  const upcoming = windows
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value * 1000 > now);
  return upcoming.length ? Math.min(...upcoming) : null;
}
