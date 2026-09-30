import { describe, expect, it } from "vitest";
import type { UsageProvider } from "./usageLedger";
import { emptyComponentAmounts, shiftDayKey, type UsageBucket } from "./usageHistory";
import { buildUsageCalendar, formatDayShare, usageCalendarLevel, usageCalendarRange, USAGE_CALENDAR_WEEKS } from "./usageCalendar";

// Synthetic buckets only. 2026-09-29 is a Tuesday.
const TODAY = "2026-09-29";
function bucket(day: string, provider: UsageProvider, model: string, totalTokens: number, extra: Partial<UsageBucket> = {}): UsageBucket {
  return { ...emptyComponentAmounts(), day, provider, model, totalTokens, uncachedInputTokens: totalTokens, ...extra };
}

describe("usage calendar aggregation", () => {
  it("spans 53 Monday-first weeks ending today, with no days after today", () => {
    const calendar = buildUsageCalendar([], TODAY, { startedDay: "2026-01-01" });
    expect(calendar.range).toEqual({ from: "2025-09-29", to: TODAY });
    expect(calendar.weeks).toHaveLength(USAGE_CALENDAR_WEEKS);
    expect(calendar.weeks[0][0]!.day).toBe("2025-09-29");
    expect(new Date(2025, 8, 29, 12).getDay()).toBe(1);
    const last = calendar.weeks[calendar.weeks.length - 1];
    expect(last.map((day) => day?.day ?? null)).toEqual(["2026-09-28", TODAY, null, null, null, null, null]);
    expect(calendar.days.size).toBe(52 * 7 + 2);
    // Local-midnight rollover on a Monday starts a new column with one day.
    const monday = buildUsageCalendar([], "2026-10-05", { startedDay: "2026-01-01" });
    expect(monday.weeks[monday.weeks.length - 1].filter(Boolean)).toHaveLength(1);
    expect(monday.range.from).toBe("2025-10-06");
    expect(usageCalendarRange("2026-10-04").from).toBe("2025-09-29");
  });

  it("sums each day's recorded totalTokens by provider and model without re-adding reasoning or cache parts", () => {
    const day = shiftDayKey(TODAY, -3);
    const calendar = buildUsageCalendar([
      // totalTokens already includes cache and reasoning; those fields must not be added again.
      bucket(day, "openai", "gpt-6-sol", 6_000, { cacheReadTokens: 4_000, cacheWriteTokens: 500, reasoningOutputTokens: 900, outputTokens: 1_000 }),
      bucket(day, "openai", "gpt-6-luna", 1_000),
      bucket(day, "claude", "claude-opus-5-5", 2_500),
      bucket(day, "cursor", "auto", 400),
      bucket(day, "openrouter", "vendor/model", 90),
      bucket(day, "lmstudio", "local-model", 10),
    ], TODAY, { startedDay: "2026-01-01" });
    const entry = calendar.days.get(day)!;
    expect(entry.state).toBe("active");
    expect(entry.totalTokens).toBe(10_000);
    expect(entry.providers.map((provider) => [provider.provider, provider.totalTokens])).toEqual([
      ["openai", 7_000], ["claude", 2_500], ["cursor", 400], ["openrouter", 90], ["lmstudio", 10],
    ]);
    expect(entry.providers[0].models).toEqual([{ model: "gpt-6-sol", totalTokens: 6_000 }, { model: "gpt-6-luna", totalTokens: 1_000 }]);
    // Shares are of the day's total, not of the provider.
    expect(formatDayShare(entry.providers[0].models[1].totalTokens, entry.totalTokens)).toBe("10.0%");
    expect(formatDayShare(entry.providers[4].totalTokens, entry.totalTokens)).toBe("0.1%");
    expect(calendar.totalTokens).toBe(10_000);
    expect(calendar.activeDays).toBe(1);
  });

  it("keeps unknown providers and unreported models as their own explicit rows", () => {
    const calendar = buildUsageCalendar([
      bucket(TODAY, "unknown", "", 300),
      bucket(TODAY, "claude", "unattributed", 700),
      bucket(TODAY, "claude", "", 0),
    ], TODAY, { startedDay: TODAY });
    const entry = calendar.days.get(TODAY)!;
    expect(entry.providers).toEqual([
      { provider: "claude", totalTokens: 700, models: [{ model: "unattributed", totalTokens: 700 }] },
      { provider: "unknown", totalTokens: 300, models: [{ model: "", totalTokens: 300 }] },
    ]);
  });

  it("distinguishes untracked days (before tracking, pruned) from tracked days with no tokens", () => {
    const started = shiftDayKey(TODAY, -20);
    const calendar = buildUsageCalendar([bucket(shiftDayKey(TODAY, -2), "openai", "gpt-6-sol", 50)], TODAY, { startedDay: started });
    expect(calendar.trackedFrom).toBe(started);
    expect(calendar.days.get(shiftDayKey(started, -1))).toMatchObject({ state: "unavailable", unavailableReason: "before-tracking", totalTokens: 0, level: 0 });
    expect(calendar.days.get(started)).toMatchObject({ state: "empty", totalTokens: 0, level: 0 });
    expect(calendar.days.get(TODAY)).toMatchObject({ state: "empty" });
    expect(calendar.days.get(TODAY)!.unavailableReason).toBeUndefined();

    const pruned = buildUsageCalendar([], TODAY, { startedDay: "2025-01-01", retainedFrom: "2026-06-01" });
    expect(pruned.trackedFrom).toBe("2026-06-01");
    expect(pruned.days.get("2026-05-31")).toMatchObject({ state: "unavailable", unavailableReason: "past-retention" });
    expect(pruned.days.get("2026-06-01")!.state).toBe("empty");

    const never = buildUsageCalendar([], TODAY, { startedDay: null });
    expect(never.trackedFrom).toBeNull();
    expect([...never.days.values()].every((day) => day.state === "unavailable" && day.unavailableReason === "before-tracking")).toBe(true);
  });

  it("never hides recorded detail, and ignores buckets outside the calendar", () => {
    const early = shiftDayKey(TODAY, -30);
    const calendar = buildUsageCalendar([
      bucket(early, "claude", "claude-sonnet-5", 80),
      bucket("2024-01-01", "openai", "gpt-6-sol", 9_999_999),
      bucket(shiftDayKey(TODAY, 1), "openai", "gpt-6-sol", 9_999_999),
    ], TODAY, { startedDay: shiftDayKey(TODAY, -5) });
    expect(calendar.days.get(early)).toMatchObject({ state: "active", totalTokens: 80, level: 4 });
    expect(calendar.totalTokens).toBe(80);
    expect(calendar.maxTokens).toBe(80);
  });

  it("scales intensity to the busiest day shown: sparse days stay light, busy days darkest", () => {
    expect(usageCalendarLevel(0, 100)).toBe(0);
    expect(usageCalendarLevel(5, 0)).toBe(0);
    expect(usageCalendarLevel(1, 1_000_000)).toBe(1);
    expect(usageCalendarLevel(62_500, 1_000_000)).toBe(1);
    expect(usageCalendarLevel(62_501, 1_000_000)).toBe(2);
    expect(usageCalendarLevel(250_001, 1_000_000)).toBe(3);
    expect(usageCalendarLevel(562_501, 1_000_000)).toBe(4);
    expect(usageCalendarLevel(1_000_000, 1_000_000)).toBe(4);

    const days = [1, 2, 3, 4].map((ago) => shiftDayKey(TODAY, -ago));
    const calendar = buildUsageCalendar([
      bucket(days[0], "openai", "gpt-6-sol", 1_000_000), bucket(days[1], "openai", "gpt-6-sol", 300_000),
      bucket(days[2], "claude", "claude-opus-5-5", 100_000), bucket(days[3], "cursor", "auto", 10),
    ], TODAY, { startedDay: shiftDayKey(TODAY, -10) });
    expect(days.map((day) => calendar.days.get(day)!.level)).toEqual([4, 3, 2, 1]);
    expect(calendar.days.get(TODAY)!.level).toBe(0);
  });

  it("formats shares of the daily total to one decimal without rounding usage away", () => {
    expect(formatDayShare(127, 1_000)).toBe("12.7%");
    expect(formatDayShare(1, 3)).toBe("33.3%");
    expect(formatDayShare(1, 10_000)).toBe("<0.1%");
    expect(formatDayShare(5, 10_000)).toBe("0.1%");
    expect(formatDayShare(99_999, 100_000)).toBe(">99.9%");
    expect(formatDayShare(10, 10)).toBe("100.0%");
    expect(formatDayShare(0, 10)).toBe("0.0%");
    expect(formatDayShare(5, 0)).toBe("0.0%");
  });
});
