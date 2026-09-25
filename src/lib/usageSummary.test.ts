import { describe, expect, it } from "vitest";
import { emptyComponentAmounts, type UsageBucket, type UsageComponentAmounts } from "./usageHistory";
import { componentBreakdown, promptAverages, usagePeriods, weekStart, type UsageSelectionTotals } from "./usageSummary";

function bucket(day: string, model: string, amounts: Partial<UsageComponentAmounts>): UsageBucket {
  const value = { day, provider: "claude" as const, model, ...emptyComponentAmounts(), ...amounts };
  value.totalTokens = value.uncachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens;
  return value;
}

const priced = (day: string, model: string, turns: number, scale = 1) => bucket(day, model, {
  uncachedInputTokens: 100 * scale, cacheReadTokens: 400 * scale, cacheWriteTokens: 50 * scale, outputTokens: 20 * scale,
  uncachedInputCost: 1 * scale, cacheReadCost: 0.4 * scale, cacheWriteCost: 0.5 * scale, outputCost: 2 * scale,
  pricedTokens: 570 * scale, turns, modelTurns: turns,
});

describe("per-prompt averages", () => {
  it("averages every billable part's tokens and cost over the prompts they came from", () => {
    const averages = promptAverages([priced("2026-09-20", "opus", 2), priced("2026-09-21", "opus", 2, 3)], "turns");
    expect(averages.prompts).toBe(4);
    expect(averages.pricedPrompts).toBe(4);
    expect(averages.tokens).toEqual({ input: 100, cacheRead: 400, cacheWrite: 50, output: 20, total: 570 });
    expect(averages.cost!.cacheRead).toBeCloseTo(0.4);
    expect(averages.cost!.cacheWrite).toBeCloseTo(0.5);
    expect(averages.cost!.total).toBeCloseTo(3.9);
  });

  it("never divides priced cost by prompts whose usage has no rate, or tokens by prompts without an id", () => {
    const unpriced = bucket("2026-09-20", "auto", { uncachedInputTokens: 1_000, outputTokens: 100, unpricedTokens: 1_100, turns: 2, modelTurns: 2 });
    const unidentified = bucket("2026-09-20", "sol", { uncachedInputTokens: 9_000, outputTokens: 900, pricedTokens: 9_900, uncachedInputCost: 9, unturnedTokens: 9_900 });
    const averages = promptAverages([priced("2026-09-20", "opus", 2), unpriced, unidentified], "turns");
    // Tokens: the priced and unpriced model-days, over their four prompts.
    expect(averages.prompts).toBe(4);
    expect(averages.tokens!.total).toBe((570 + 1_100) / 4);
    // Cost: only the fully priced model-day, over its own two prompts.
    expect(averages.pricedPrompts).toBe(2);
    expect(averages.cost!.total).toBeCloseTo(3.9 / 2);
    expect(averages.excludedTokens).toBe(9_900);
  });

  it("does not call a switched-model prompt fully priced when its second model is unpriced", () => {
    const first = priced("2026-09-20", "opus", 1);
    const second = bucket("2026-09-20", "preview", {
      uncachedInputTokens: 100, outputTokens: 10, unpricedTokens: 110,
      turns: 0, modelTurns: 1,
    });
    const averages = promptAverages([first, second], "turns");
    expect(averages.prompts).toBe(1);
    expect(averages.tokens?.total).toBe(680);
    expect(averages.cost).toBeNull();
    expect(averages.pricedPrompts).toBe(0);
  });
});

describe("cost by billable part", () => {
  it("counts earlier usage's known tokens per part without inventing a cost split", () => {
    const earlier: UsageSelectionTotals = {
      ...emptyComponentAmounts(), uncachedInputTokens: 1_000, cacheReadTokens: 3_000, cacheWriteTokens: 0, outputTokens: 500,
      totalTokens: 4_500, pricedTokens: 4_500, estimatedCost: 12,
    };
    const breakdown = componentBreakdown([priced("2026-09-20", "opus", 1)], earlier);
    const cacheRead = breakdown.rows.find((row) => row.id === "cacheRead")!;
    expect(cacheRead).toMatchObject({ tokens: 3_400, costedTokens: 400, partlyCostedTokens: 0 });
    expect(cacheRead.cost).toBeCloseTo(0.4);
    expect(breakdown.earlier).toEqual({ tokens: 4_500, cost: 12, priced: true });
    expect(breakdown.total.tokens).toBe(570 + 4_500);
    expect(breakdown.total.cost).toBeCloseTo(3.9 + 12);
  });

  it("reports how much of each part its cost covers, including partly priced model-days", () => {
    const unpriced = bucket("2026-09-20", "auto", { uncachedInputTokens: 300, cacheReadTokens: 100, unpricedTokens: 400 });
    // The day a new model's rate arrived: some of its usage is priced.
    const mixed = bucket("2026-09-21", "new", {
      uncachedInputTokens: 200, outputTokens: 10, uncachedInputCost: 0.5, outputCost: 0.1, pricedTokens: 110, unpricedTokens: 100,
    });
    const rows = componentBreakdown([priced("2026-09-20", "opus", 1), unpriced, mixed]).rows;
    const input = rows.find((row) => row.id === "input")!;
    expect(input).toMatchObject({ tokens: 600, costedTokens: 100, partlyCostedTokens: 200 });
    expect(rows.find((row) => row.id === "cacheRead")).toMatchObject({ tokens: 500, costedTokens: 400, partlyCostedTokens: 0 });
  });
});

describe("usage periods", () => {
  it("starts weeks on Monday and keeps empty days so gaps stay visible", () => {
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
    const buckets = [priced("2026-09-20", "opus", 1), priced("2026-09-22", "opus", 1), priced("2026-09-22", "sol", 1, 2)];
    const days = usagePeriods(buckets, { from: "2026-09-20", to: "2026-09-23" }, "day", (item) => item.model === "opus");
    expect(days.map((period) => [period.from, period.amounts.cacheReadTokens])).toEqual([
      ["2026-09-20", 400], ["2026-09-21", 0], ["2026-09-22", 400], ["2026-09-23", 0],
    ]);
    const weeks = usagePeriods(buckets, { from: "2026-09-20", to: "2026-09-23" }, "week");
    expect(weeks.map((period) => [period.from, period.to, period.complete, period.amounts.turns])).toEqual([
      ["2026-09-20", "2026-09-20", false, 1], ["2026-09-21", "2026-09-23", false, 2],
    ]);
  });
});
