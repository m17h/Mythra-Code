import type { UsageProvider } from "./usageLedger";
import { shiftDayKey, type UsageBucket } from "./usageHistory";
import { weekStart, type UsageRange } from "./usageSummary";

/**
 * The Settings usage calendar: one square per local day over the trailing
 * year. It reads dated detail only. A day's figure is the sum of its buckets'
 * recorded `totalTokens`. Reasoning and cache counts are subsets, never
 * added on top of that recorded total; a total-only receipt stays intact.
 * Undated ledger usage is not placed on any day.
 */

/** 52 full weeks plus the current one, Monday-first like the weekly trend. */
export const USAGE_CALENDAR_WEEKS = 53;

export interface CalendarModelUsage { model: string; totalTokens: number }
export interface CalendarProviderUsage { provider: UsageProvider; totalTokens: number; models: CalendarModelUsage[] }

export type CalendarLevel = 0 | 1 | 2 | 3 | 4;

export interface CalendarDay {
  day: string;
  /**
   * `unavailable`: no dated detail can exist for this day (before tracking
   * began, or pruned from retention). `empty`: tracked, with no recorded
   * tokens. `active`: tracked, with recorded tokens.
   */
  state: "unavailable" | "empty" | "active";
  unavailableReason?: "before-tracking" | "past-retention";
  totalTokens: number;
  level: CalendarLevel;
  /** Most tokens first; models likewise within each provider. */
  providers: CalendarProviderUsage[];
}

export interface UsageCalendar {
  range: UsageRange;
  /** Columns of Monday…Sunday; null for days after `range.to`. */
  weeks: Array<Array<CalendarDay | null>>;
  days: Map<string, CalendarDay>;
  maxTokens: number;
  totalTokens: number;
  activeDays: number;
  /** First day dated detail can exist for, or null before any tracking. */
  trackedFrom: string | null;
}

/** The calendar's inclusive days: whole weeks back from the week of `today`. */
export function usageCalendarRange(today: string, weeks = USAGE_CALENDAR_WEEKS): UsageRange {
  return { from: shiftDayKey(weekStart(today), -(weeks - 1) * 7), to: today };
}

/**
 * Four steps relative to the busiest day shown. The square root keeps
 * ordinary days visible next to one very large day; any recorded usage is at
 * least step 1, so it is never drawn like an empty day.
 */
export function usageCalendarLevel(tokens: number, maxTokens: number): CalendarLevel {
  if (!(tokens > 0) || !(maxTokens > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil(4 * Math.sqrt(Math.min(1, tokens / maxTokens))))) as CalendarLevel;
}

/**
 * A part of a day's total tokens, to one decimal. A real but tiny part is
 * never shown as 0.0%, and a part short of the whole never as 100.0%.
 */
export function formatDayShare(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return "0.0%";
  if (part >= total) return "100.0%";
  const share = part / total * 100;
  if (share < 0.05) return "<0.1%";
  if (share >= 99.95) return ">99.9%";
  return `${share.toFixed(1)}%`;
}

const tokensOf = (bucket: UsageBucket) => (Number.isFinite(bucket.totalTokens) && bucket.totalTokens > 0 ? bucket.totalTokens : 0);
const byTokens = <T extends { totalTokens: number }>(key: (item: T) => string) => (left: T, right: T) =>
  right.totalTokens - left.totalTokens || key(left).localeCompare(key(right));

/**
 * Pure: groups dated buckets into calendar days by provider and model.
 * `trackedFrom` is when dated detail began (`startedDay`), and
 * `retainedFrom` the earliest day kept after pruning, if any was pruned.
 */
export function buildUsageCalendar(
  buckets: Iterable<UsageBucket>,
  today: string,
  history: { startedDay: string | null; retainedFrom?: string },
  weeks = USAGE_CALENDAR_WEEKS,
): UsageCalendar {
  const range = usageCalendarRange(today, weeks);
  const grouped = new Map<string, Map<UsageProvider, Map<string, number>>>();
  for (const bucket of buckets) {
    if (bucket.day < range.from || bucket.day > range.to) continue;
    let providers = grouped.get(bucket.day);
    if (!providers) { providers = new Map(); grouped.set(bucket.day, providers); }
    let models = providers.get(bucket.provider);
    if (!models) { models = new Map(); providers.set(bucket.provider, models); }
    models.set(bucket.model, (models.get(bucket.model) ?? 0) + tokensOf(bucket));
  }

  const { startedDay, retainedFrom } = history;
  const trackedFrom = startedDay && retainedFrom && retainedFrom > startedDay ? retainedFrom : startedDay;
  const days = new Map<string, CalendarDay>();
  let maxTokens = 0; let totalTokens = 0; let activeDays = 0;
  for (let day = range.from; day <= range.to; day = shiftDayKey(day, 1)) {
    const providers: CalendarProviderUsage[] = [];
    for (const [provider, models] of grouped.get(day) ?? []) {
      const list = [...models].filter(([, tokens]) => tokens > 0).map(([model, tokens]) => ({ model, totalTokens: tokens }))
        .sort(byTokens<CalendarModelUsage>((item) => item.model));
      if (list.length) providers.push({ provider, totalTokens: list.reduce((sum, item) => sum + item.totalTokens, 0), models: list });
    }
    providers.sort(byTokens<CalendarProviderUsage>((item) => item.provider));
    const tokens = providers.reduce((sum, item) => sum + item.totalTokens, 0);
    // Recorded detail is always shown, even on a day the metadata calls untracked.
    const tracked = grouped.has(day) || (trackedFrom !== null && day >= trackedFrom);
    const entry: CalendarDay = {
      day, totalTokens: tokens, level: 0, providers,
      state: tokens > 0 ? "active" : tracked ? "empty" : "unavailable",
    };
    if (!tracked) entry.unavailableReason = startedDay && day >= startedDay ? "past-retention" : "before-tracking";
    days.set(day, entry);
    if (tokens > 0) { activeDays += 1; totalTokens += tokens; maxTokens = Math.max(maxTokens, tokens); }
  }
  for (const entry of days.values()) entry.level = usageCalendarLevel(entry.totalTokens, maxTokens);

  const columns: Array<Array<CalendarDay | null>> = [];
  for (let start = range.from; start <= range.to; start = shiftDayKey(start, 7)) {
    columns.push(Array.from({ length: 7 }, (_, offset) => days.get(shiftDayKey(start, offset)) ?? null));
  }
  return { range, weeks: columns, days, maxTokens, totalTokens, activeDays, trackedFrom };
}
