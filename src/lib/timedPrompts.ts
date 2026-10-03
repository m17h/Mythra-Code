import type { QueuedTurn } from "./taskStore";

/**
 * Timed prompts are ordinary durable queue entries with a `deliverAt` time.
 *
 * Until the local clock releases one, it is invisible to the FIFO: regular
 * prompts never wait behind it and nothing can start it early. Release is an
 * explicit, persisted transition (`releasedAt`) made only when this renderer
 * observed the delivery time within narrow timer jitter, detected no clock
 * interruption, and held a delivery context for the entry. Anything else — the time passed while the
 * app was closed, before this session's first clock check, while the machine
 * slept, or while no safe context existed — is persisted as missed
 * (`missedAt`) and is only sent after the user explicitly asks. Reopening
 * overdue prompts has no grace period. Clock heuristics cannot distinguish
 * every sub-second sleep from timer jitter without native power signals.
 */

/**
 * Upper bound on a single timer. Timers are measured on a clock that can stop
 * while the machine sleeps, so a long wait could otherwise fire far too late
 * after wake even though the window never lost focus. One re-arm per minute
 * exists only while timed prompts are pending.
 */
export const TIMED_PROMPT_MAX_TIMER_MS = 60_000;

/**
 * Two consecutive clock checks further apart than one maximum timer plus this
 * allowance mean the renderer was suspended (sleep, or a frozen/throttled
 * window) between them. Ordinary timer jitter is milliseconds; anything due
 * inside a suspended gap is treated as missed rather than sent late.
 */
export const TIMED_PROMPT_CONTINUITY_TOLERANCE_MS = 30_000;

/** A timer may arrive slightly late; larger delays require explicit approval. */
export const TIMED_PROMPT_TIMER_JITTER_MS = 1_000;

export type TimedPromptState = "scheduled" | "due" | "missed";

export type TimedClockDecision = "wait" | "release" | "miss";

/**
 * Decide what one clock check at `now` may do with a pending entry, given the
 * previous check in this session (`null` for the first check after launch or
 * reload). An entry is released only if it became due inside a continuously
 * uninterrupted clock interval and within timer jitter; otherwise it is missed.
 */
export function timedClockDecision(
  deliverAt: number,
  now: number,
  previousCheckAt: number | null,
  maxGapMs = TIMED_PROMPT_MAX_TIMER_MS + TIMED_PROMPT_CONTINUITY_TOLERANCE_MS,
  elapsedAwakeMs?: number,
): TimedClockDecision {
  if (deliverAt > now) return "wait";
  if (previousCheckAt === null || now - previousCheckAt > maxGapMs) return "miss";
  if (now - deliverAt > TIMED_PROMPT_TIMER_JITTER_MS) return "miss";
  // Some platforms pause performance.now during sleep. A wall/monotonic
  // disagreement adds conservative evidence of suspension or a clock change.
  // Other platforms advance both clocks during sleep, so this is not an exact
  // power-state detector; the narrow deadline bound remains necessary.
  if (elapsedAwakeMs !== undefined && Math.abs(now - previousCheckAt - elapsedAwakeMs) > TIMED_PROMPT_TIMER_JITTER_MS) return "miss";
  return deliverAt > previousCheckAt ? "release" : "miss";
}

/** Waiting for its time (or for the user, if missed); not part of the FIFO. */
export function isPendingTimedTurn(entry: Pick<QueuedTurn, "deliverAt" | "releasedAt">): boolean {
  return entry.deliverAt !== undefined && entry.releasedAt === undefined;
}

/** Ordinary entries and released timed entries form the FIFO queue. */
export function isEligibleQueuedTurn(entry: Pick<QueuedTurn, "deliverAt" | "releasedAt">): boolean {
  return !isPendingTimedTurn(entry);
}

/**
 * The FIFO the pump walks. A released timed prompt joins at the moment it
 * became due, so it runs after work that was already waiting and before
 * anything queued later. Array order breaks ties, preserving existing order.
 */
export function eligibleQueuedTurns(entries: readonly QueuedTurn[]): QueuedTurn[] {
  const eligible: Array<{ entry: QueuedTurn; index: number }> = [];
  entries.forEach((entry, index) => { if (isEligibleQueuedTurn(entry)) eligible.push({ entry, index }); });
  // Ordinary queues (the common case) are already in order; skip the sort.
  if (!eligible.some(({ entry }) => entry.releasedAt !== undefined)) return eligible.map(({ entry }) => entry);
  return eligible
    .sort((left, right) => eligibleSince(left.entry) - eligibleSince(right.entry) || left.index - right.index)
    .map(({ entry }) => entry);
}

function eligibleSince(entry: QueuedTurn): number {
  return entry.releasedAt ?? entry.createdAt;
}

/** The single entry allowed to start next, or undefined for an empty FIFO. */
export function eligibleQueueHead(entries: readonly QueuedTurn[]): QueuedTurn | undefined {
  return eligibleQueuedTurns(entries)[0];
}

export function hasEligibleQueuedTurns(entries: readonly QueuedTurn[] | undefined): boolean {
  return Boolean(entries?.some(isEligibleQueuedTurn));
}

/** Pending timed prompts, soonest first. */
export function pendingTimedTurns(entries: readonly QueuedTurn[]): QueuedTurn[] {
  return entries.filter(isPendingTimedTurn).sort((left, right) => left.deliverAt! - right.deliverAt! || left.createdAt - right.createdAt);
}

/** "due" is transient: the next clock check either releases or misses it. */
export function timedPromptState(entry: Pick<QueuedTurn, "deliverAt" | "missedAt">, now = Date.now()): TimedPromptState {
  if (entry.missedAt !== undefined) return "missed";
  return (entry.deliverAt ?? now) > now ? "scheduled" : "due";
}

/** Delay until the next visible row reaches its delivery time. */
export function nextTimedStateChangeDelay(entries: readonly Pick<QueuedTurn, "deliverAt" | "missedAt">[], now = Date.now()): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.deliverAt !== undefined && entry.missedAt === undefined && entry.deliverAt > now) next = Math.min(next, entry.deliverAt);
  }
  return Number.isFinite(next) ? Math.min(TIMED_PROMPT_MAX_TIMER_MS, Math.max(1, next - now + 5)) : null;
}

export type LocalDateTimeResult =
  | { ok: true; deliverAt: number }
  | { ok: false; reason: "invalid" | "nonexistent" | "ambiguous" | "past"; message: string };

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_INPUT = /^(\d{2}):(\d{2})$/;
/** Must stay wider than any single DST shift and narrower than two transitions. */
const TRANSITION_PROBE_MS = 6 * 60 * 60_000;

function localParts(epoch: number) {
  const date = new Date(epoch);
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
}

/**
 * Turn a native date/time input pair into one exact instant in the user's
 * local time zone. Wall-clock times skipped by a daylight-saving change do not
 * exist, and times repeated by one are ambiguous; both are rejected instead of
 * silently picking an instant the user may not have meant.
 */
export function parseLocalDateTime(date: string, time: string, now = Date.now()): LocalDateTimeResult {
  const dateMatch = DATE_INPUT.exec(date.trim());
  const timeMatch = TIME_INPUT.exec(time.trim());
  if (!dateMatch || !timeMatch) return { ok: false, reason: "invalid", message: "Choose a valid date and time." };
  const [year, month, day, hour, minute] = [Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2])];
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { ok: false, reason: "invalid", message: "Choose a valid date and time." };
  }
  const wanted = [year, month, day, hour, minute];
  const calendarCheck = new Date(Date.UTC(year, month, day));
  if (calendarCheck.getUTCFullYear() !== year || calendarCheck.getUTCMonth() !== month || calendarCheck.getUTCDate() !== day) {
    return { ok: false, reason: "invalid", message: "That date does not exist." };
  }
  // Each UTC offset in effect around this wall time yields one candidate
  // instant; keep only the ones that really display as the chosen time.
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const rough = new Date(year, month, day, hour, minute).getTime();
  const offsets = new Set([rough - TRANSITION_PROBE_MS, rough, rough + TRANSITION_PROBE_MS].map((epoch) => new Date(epoch).getTimezoneOffset()));
  const candidates = [...new Set([...offsets].map((offset) => asUtc + offset * 60_000))]
    .filter((epoch) => localParts(epoch).every((part, index) => part === wanted[index]))
    .sort((left, right) => left - right);
  if (candidates.length === 0) {
    return { ok: false, reason: "nonexistent", message: "That time is skipped by a daylight-saving change. Choose another time." };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: "ambiguous", message: "That time happens twice because of a daylight-saving change. Choose a time outside the repeated hour." };
  }
  // Minute precision: anything in the current minute or earlier is not a
  // future delivery and would run immediately.
  if (candidates[0] <= now) return { ok: false, reason: "past", message: "Choose a time in the future." };
  return { ok: true, deliverAt: candidates[0] };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function dateInputValue(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function timeInputValue(epoch: number): string {
  const date = new Date(epoch);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A sensible starting point: the top of the next hour, at least 30 minutes out. */
export function defaultDeliveryTime(now = Date.now()): number {
  const date = new Date(now + 30 * 60_000);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date.getTime();
}

/** Tomorrow at 09:00 local time, the most common "first thing" schedule. */
export function tomorrowMorning(now = Date.now()): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

export function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

function shortZone(epoch: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date(epoch))
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

/** "Today 9:00 AM GMT+1", "Tomorrow …", or "Fri, Oct 10, 9:00 AM …". */
export function formatDeliveryTime(epoch: number, now = Date.now()): string {
  const target = new Date(epoch);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const time = target.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const zone = shortZone(epoch);
  const day = sameLocalDay(target, today)
    ? "Today"
    : sameLocalDay(target, tomorrow)
      ? "Tomorrow"
      : sameLocalDay(target, yesterday)
        ? "Yesterday"
        : target.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          ...(target.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
        });
  return `${day} ${time}${zone ? ` ${zone}` : ""}`;
}

/** Full, unambiguous wording for tooltips and accessible names. */
export function formatDeliveryTimeLong(epoch: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(new Date(epoch))
      + ` (${localTimeZoneName()})`;
  } catch {
    return new Date(epoch).toString();
  }
}
