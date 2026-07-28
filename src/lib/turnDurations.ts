import { loadStored, storeValue } from "./storage";

const TURN_DURATIONS_KEY = "kiwi.turnDurations";
const MAX_THREADS = 200;
const MAX_TURNS_PER_THREAD = 200;

type StoredTurnDurations = Record<string, Record<string, number>>;

let durationCache: StoredTurnDurations | null = null;

function durations(): StoredTurnDurations {
  if (durationCache === null) durationCache = loadStored<StoredTurnDurations>(TURN_DURATIONS_KEY, {});
  return durationCache;
}

export function durationForTurn(threadId: string, turnId?: string): number | undefined {
  if (!turnId) return undefined;
  const duration = durations()[threadId]?.[turnId];
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function recordTurnDuration(threadId: string, turnId: string, durationMs: number): number {
  const normalized = Math.max(0, Math.round(durationMs));
  const all = durations();
  const threadDurations = { ...(all[threadId] ?? {}), [turnId]: normalized };
  const turnIds = Object.keys(threadDurations);
  while (turnIds.length > MAX_TURNS_PER_THREAD) {
    delete threadDurations[turnIds.shift()!];
  }
  all[threadId] = threadDurations;

  const threadIds = Object.keys(all);
  while (threadIds.length > MAX_THREADS) {
    delete all[threadIds.shift()!];
  }
  storeValue(TURN_DURATIONS_KEY, all);
  return normalized;
}

export function deleteThreadTurnDurations(threadId: string): void {
  const all = durations();
  if (!(threadId in all)) return;
  delete all[threadId];
  storeValue(TURN_DURATIONS_KEY, all);
}

export function resetTurnDurationsForTests(): void {
  durationCache = null;
}
