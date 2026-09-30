import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenUsageView } from "../components/StudioDock";
import { annotateThreadUsage, flushUsageLedger, providerUsageTotals, recordCumulativeUsage, resetUsageLedgerCache, usageTotals } from "./usageLedger";
import { localDayKey } from "./usageHistory";
import { usageDetail } from "./usageSummary";

const counts = (totalTokens: number, inputTokens: number, outputTokens: number, partial = false): TokenUsageView => ({
  totalTokens, inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
  cacheReadReported: !partial, cacheWriteReported: !partial, tokenAvailability: partial ? "partial" : "reported",
});

describe("independent cumulative attribution review", () => {
  beforeEach(() => {
    resetUsageLedgerCache(); localStorage.clear(); vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T16:00:00Z"));
  });
  afterEach(() => { resetUsageLedgerCache(); vi.useRealTimers(); });

  it.each([50, 100])("does not attribute %i rediscovered cumulative input tokens to a later model/day when total growth is at least that large", (rediscoveredInput) => {
    annotateThreadUsage("attribution", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    const firstDay = localDayKey();
    recordCumulativeUsage("attribution", counts(100, 0, 0, true), "first-turn");
    flushUsageLedger(); resetUsageLedgerCache();

    vi.setSystemTime(new Date("2026-09-26T16:00:00Z"));
    annotateThreadUsage("attribution", { provider: "claude", model: "claude-sonnet-5" });
    const secondDay = localDayKey();
    // The supplied cumulative input may describe the earlier 100 tokens.
    // Total growth alone cannot identify which token types belong to this turn.
    recordCumulativeUsage("attribution", counts(200, rediscoveredInput, 0, true), "second-turn");
    flushUsageLedger(); resetUsageLedgerCache();
    const buckets = usageDetail(null).buckets;
    expect(buckets.find((bucket) => bucket.day === firstDay && bucket.model === "gpt-6-sol")).toMatchObject({ totalTokens: 100 });
    expect(buckets.find((bucket) => bucket.day === secondDay && bucket.model === "claude-sonnet-5")).toMatchObject({
      totalTokens: 100, uncachedInputTokens: 0, outputTokens: 0, pricedTokens: 0, unpricedTokens: 100,
    });
    expect(usageTotals()).toMatchObject({ totalTokens: 200, inputTokens: 0, outputTokens: 0, pricedTokens: 0, unpricedTokens: 200 });

    vi.setSystemTime(new Date("2026-09-27T16:00:00Z"));
    recordCumulativeUsage("attribution", counts(210, 200, 10), "complete-turn");
    flushUsageLedger(); resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 210, inputTokens: 0, outputTokens: 0, pricedTokens: 0, unpricedTokens: 210 });

    vi.setSystemTime(new Date("2026-09-28T16:00:00Z"));
    annotateThreadUsage("attribution", { provider: "claude", model: "claude-opus-5-5" });
    recordCumulativeUsage("attribution", { ...counts(220, 205, 15), cachedInputTokens: 5, reasoningOutputTokens: 5 }, "fresh-turn");
    flushUsageLedger(); resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 220, inputTokens: 5, outputTokens: 5, cachedInputTokens: 5,
      reasoningOutputTokens: 5, pricedTokens: 10, unpricedTokens: 210 });
    expect(usageDetail(null).buckets.find((bucket) => bucket.day === localDayKey() && bucket.model === "claude-opus-5-5"))
      .toMatchObject({ totalTokens: 10, cacheReadTokens: 5, outputTokens: 5, reasoningOutputTokens: 5, pricedTokens: 10 });
  });

  it("retains an archived total-only cumulative baseline through reload and a provider change", () => {
    vi.setSystemTime(new Date("2026-06-15T16:00:00Z"));
    const oldDay = localDayKey();
    annotateThreadUsage("archived", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordCumulativeUsage("archived", counts(100, 0, 0, true), "old-turn");
    flushUsageLedger();

    vi.setSystemTime(new Date("2026-09-29T16:00:00Z"));
    // A normal fresh write folds quiet records beyond the 90-day retention window.
    annotateThreadUsage("fresh-trigger", { provider: "openai", model: "gpt-6-luna", requestedServiceTier: "standard" });
    flushUsageLedger(); resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 100, threads: 1, pricedTokens: 0, unpricedTokens: 100 });

    annotateThreadUsage("archived", { provider: "claude", model: "claude-sonnet-5" });
    recordCumulativeUsage("archived", counts(100, 90, 10), "restored-turn");
    recordCumulativeUsage("archived", counts(110, 100, 10), "fresh-turn");
    flushUsageLedger(); resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 110, inputTokens: 10, outputTokens: 0, threads: 1, pricedTokens: 10, unpricedTokens: 100 });
    expect(providerUsageTotals()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", totalTokens: 100, pricedTokens: 0, unpricedTokens: 100 }),
      expect.objectContaining({ provider: "claude", totalTokens: 10, pricedTokens: 10, unpricedTokens: 0 }),
    ]));
    expect(usageDetail(null).buckets.find((bucket) => bucket.day === oldDay && bucket.model === "gpt-6-sol"))
      .toMatchObject({ totalTokens: 100, uncachedInputTokens: 0, pricedTokens: 0 });
    expect(usageDetail(null).buckets.find((bucket) => bucket.day === localDayKey() && bucket.model === "claude-sonnet-5"))
      .toMatchObject({ totalTokens: 10, uncachedInputTokens: 10, pricedTokens: 10 });
  });
});
