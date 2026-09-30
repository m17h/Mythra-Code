import { describe, expect, it } from "vitest";
import { buildUsageCalendar, USAGE_CALENDAR_WEEKS } from "./usageCalendar";
import { emptyComponentAmounts, shiftDayKey, type UsageBucket } from "./usageHistory";

describe("usage calendar bounded history", () => {
  it("reads a 4,000-bucket history once and produces only the 53 displayed weeks", () => {
    const today = "2026-09-29";
    const buckets: UsageBucket[] = Array.from({ length: 4_000 }, (_, index) => ({
      ...emptyComponentAmounts(),
      day: shiftDayKey(today, -Math.floor(index / 10)),
      provider: index % 2 ? "claude" : "openai",
      model: `model-${index % 10}`,
      totalTokens: index % 10 + 1,
    }));
    let iterations = 0;
    let visits = 0;
    const singlePassHistory: Iterable<UsageBucket> = {
      *[Symbol.iterator]() {
        iterations += 1;
        if (iterations > 1) throw new Error("The calendar reread its full history");
        for (const bucket of buckets) {
          visits += 1;
          yield bucket;
        }
      },
    };

    const result = buildUsageCalendar(singlePassHistory, today, { startedDay: "2020-01-01" });

    expect(iterations).toBe(1);
    expect(visits).toBe(4_000);
    expect(result.weeks).toHaveLength(USAGE_CALENDAR_WEEKS);
    expect(result.weeks.every((week) => week.length === 7)).toBe(true);
    // Tuesday ends the current week after two days: 52 * 7 + 2.
    expect(result.days.size).toBe(366);
    expect(result.activeDays).toBe(366);
    expect(result.totalTokens).toBe(366 * 55);
    expect(result.maxTokens).toBe(55);
    expect(result.days.get(today)?.providers.reduce((sum, provider) => sum + provider.totalTokens, 0)).toBe(55);
    expect(result.weeks.at(-1)?.slice(2)).toEqual([null, null, null, null, null]);
  });

  it.each([
    ["2024-03-11", "2024-02-29"],
    ["2026-03-09", "2026-03-08"],
    ["2026-11-02", "2026-11-01"],
    ["2027-01-04", "2026-12-31"],
  ])("keeps calendar keys consecutive across the boundary before %s", (today, boundary) => {
    const result = buildUsageCalendar([], today, { startedDay: "2020-01-01" });
    const keys = [...result.days.keys()];
    expect(keys).toHaveLength(365);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.days.has(boundary)).toBe(true);
    expect(result.weeks).toHaveLength(53);
    expect(result.weeks.at(-1)?.[0]?.day).toBe(today);
    for (let index = 1; index < keys.length; index += 1) {
      expect(keys[index]).toBe(shiftDayKey(keys[index - 1], 1));
    }
  });

  it("bounds old tracking metadata to the displayed year and preserves retention gaps", () => {
    const result = buildUsageCalendar([], "2026-09-29", {
      startedDay: "1970-01-01",
      retainedFrom: "2026-09-01",
    });
    expect(result.days.size).toBe(366);
    expect(result.days.get("2026-08-31")).toMatchObject({
      state: "unavailable", unavailableReason: "past-retention", totalTokens: 0,
    });
    expect(result.days.get("2026-09-01")).toMatchObject({ state: "empty", totalTokens: 0 });
    expect(result.totalTokens).toBe(0);
  });
});
