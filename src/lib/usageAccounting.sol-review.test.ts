import { beforeEach, describe, expect, it } from "vitest";
import {
  annotateThreadUsage, flushUsageLedger, recordUsageDelta, resetUsageLedgerCache, usageTotals,
  usageForThread, USAGE_LEDGER_KEY, providerUsageTotals,
  MODEL_PRICING_CATALOG_KEY,
  recordCumulativeUsage,
  recordAuxiliaryUsage,
} from "./usageLedger";
import { recordBackgroundUsage } from "./backgroundUsage";
import { promptAverages, usageDetail } from "./usageSummary";
import { localDayKey, repriceUsageHistory, USAGE_HISTORY_KEY } from "./usageHistory";

describe("Sol review: total-only receipt price coverage", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

  it("keeps a total-only helper receipt unpriced alongside priced chat usage, including after reload", () => {
    annotateThreadUsage("fully-observed", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("fully-observed", {
      inputTokens: 90, outputTokens: 10, totalTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true,
    }, "chat-event", "chat-turn");
    expect(recordBackgroundUsage({
      executionId: "91a63c25-1eb4-4b9b-b82d-5422df96cdf4", provider: "openai", model: "gpt-6-luna", modelSource: "requested",
      purpose: "thread-title", serviceTier: null, serviceTierSource: "unknown", requestedServiceTier: null,
      outcome: "completed", tokenAvailability: "partial", reportedCost: null,
      usage: { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, cacheWrite1hInputTokens: null,
        outputTokens: null, reasoningOutputTokens: null, totalTokens: 100 },
    })).toBe(true);
    flushUsageLedger();
    resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
    expect(usageDetail({ from: localDayKey(), to: localDayKey() }).totals).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
  });

  it("does not treat a chat's total-only partial receipt as a fully priced zero-cost prompt", () => {
    annotateThreadUsage("partial-total", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("partial-total", {
      inputTokens: 0, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0, cacheReadReported: false, cacheWriteReported: false, tokenAvailability: "partial",
    }, "partial-event", "partial-turn");
    flushUsageLedger();
    expect(usageDetail(null).totals).toMatchObject({ totalTokens: 100, pricedTokens: 0, unpricedTokens: 100 });
    expect(usageForThread("partial-total")?.usage.tokenAvailability).toBe("partial");
    expect(promptAverages(usageDetail(null).buckets, "turns")).toMatchObject({
      prompts: 1, tokens: { total: 100 }, pricedPrompts: 0, cost: null,
    });
    resetUsageLedgerCache();
    expect(usageForThread("partial-total")?.usage.tokenAvailability).toBe("partial");
  });

  it("prices only supplied token types when a receipt's reported total exceeds its complete split", () => {
    annotateThreadUsage("unsplit", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("unsplit", {
      inputTokens: 90, outputTokens: 10, totalTokens: 200, cachedInputTokens: 20, cacheWriteInputTokens: 10,
      reasoningOutputTokens: 5, cacheReadReported: true, cacheWriteReported: true,
    }, "unsplit-event", "unsplit-turn");
    flushUsageLedger();
    const before = usageTotals();
    expect(before).toMatchObject({ totalTokens: 200, inputTokens: 90, outputTokens: 10, pricedTokens: 100, unpricedTokens: 100 });
    const cost = before.estimatedCost;
    // Emulate records saved by the earlier build, which omitted only residual
    // coverage. Their original token split, costs, and provider must survive.
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!);
    records[0].unpricedTokens = 0;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    const history = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
    history.buckets[0][14] = 0;
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
    resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100, estimatedCost: cost });
    expect(usageDetail(null).totals).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
    expect(usageDetail(null).totals.estimatedCost).toBeCloseTo(cost, 12);
    expect(providerUsageTotals()[0]).toMatchObject({ provider: "openai", totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
  });

  it("historically corrects only the known split and leaves the unsplit residual unpriced", () => {
    annotateThreadUsage("historical-unsplit", { provider: "openai", model: "sol-review-new-model", requestedServiceTier: "standard" });
    recordUsageDelta("historical-unsplit", {
      inputTokens: 90, outputTokens: 10, totalTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true,
    }, "historic-event", "historic-turn");
    flushUsageLedger();
    const cohort = usageDetail(null).buckets[0].cohorts![0];
    expect(usageTotals()).toMatchObject({ totalTokens: 200, pricedTokens: 0, unpricedTokens: 200 });
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), models: {
      "openai:sol-review-new-model": { inputPerMillion: 1, outputPerMillion: 2, asOf: new Date().toISOString().slice(0, 10), effectiveFrom: new Date(cohort.firstAt - 60_000).toISOString() },
    } }));
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals()).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageDetail(null).totals).toMatchObject({ totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 });
  });

  it("preserves each provider's attribution while repairing older residual coverage", () => {
    const counts = { inputTokens: 90, outputTokens: 10, totalTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true };
    annotateThreadUsage("provider-switch", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("provider-switch", counts, "openai-event", "openai-turn");
    annotateThreadUsage("provider-switch", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("provider-switch", counts, "claude-event", "claude-turn");
    flushUsageLedger();
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!);
    records[0].unpricedTokens = 0;
    for (const provider of ["openai", "claude"]) records[0].providerUsage[provider].unpricedTokens = 0;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ totalTokens: 400, pricedTokens: 200, unpricedTokens: 200 });
    expect(providerUsageTotals()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 }),
      expect.objectContaining({ provider: "claude", totalTokens: 200, pricedTokens: 100, unpricedTokens: 100 }),
    ]));
    expect(usageDetail(null).detailAhead).toBeUndefined();
  });

  it("does not count a newly reported cumulative split as fresh consumption", () => {
    annotateThreadUsage("late-split", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordCumulativeUsage("late-split", { inputTokens: 0, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "partial", cacheReadReported: false, cacheWriteReported: false }, "turn-first");
    recordCumulativeUsage("late-split", { inputTokens: 90, outputTokens: 10, totalTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-first");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 100, pricedTokens: 0, unpricedTokens: 100 });
    recordCumulativeUsage("late-split", { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-second");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 110, inputTokens: 10, outputTokens: 0, pricedTokens: 10, unpricedTokens: 100 });
  });

  it("keeps actual total growth once when older token types become visible at the same time", () => {
    annotateThreadUsage("growing-late-split", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordCumulativeUsage("growing-late-split", { inputTokens: 0, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "partial", cacheReadReported: false, cacheWriteReported: false }, "turn-first");
    recordCumulativeUsage("growing-late-split", { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-second");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 110, pricedTokens: 0, unpricedTokens: 110 });
    resetUsageLedgerCache();
    recordCumulativeUsage("growing-late-split", { inputTokens: 110, outputTokens: 10, totalTokens: 120, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-third");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 120, inputTokens: 10, outputTokens: 0, pricedTokens: 10, unpricedTokens: 110 });
    recordCumulativeUsage("growing-late-split", { inputTokens: 110, outputTokens: 10, totalTokens: 120, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-third");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 120, pricedTokens: 10, unpricedTokens: 110 });
  });

  it("does not assign rediscovered usage to a new provider/model or add cache/reasoning subsets twice", () => {
    annotateThreadUsage("late-transition", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordCumulativeUsage("late-transition", { inputTokens: 0, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, tokenAvailability: "partial", cacheReadReported: false, cacheWriteReported: false }, "turn-first");
    flushUsageLedger();
    resetUsageLedgerCache();
    annotateThreadUsage("late-transition", { provider: "claude", model: "claude-sonnet-5" });
    recordCumulativeUsage("late-transition", { inputTokens: 90, outputTokens: 20, totalTokens: 110, cachedInputTokens: 30,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 10, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-second");
    annotateThreadUsage("late-transition", { provider: "claude", model: "claude-opus-5-5" });
    recordCumulativeUsage("late-transition", { inputTokens: 95, outputTokens: 25, totalTokens: 120, cachedInputTokens: 35,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 15, tokenAvailability: "reported", cacheReadReported: true, cacheWriteReported: true }, "turn-third");
    flushUsageLedger();
    expect(usageTotals()).toMatchObject({ totalTokens: 120, inputTokens: 5, outputTokens: 5, cachedInputTokens: 5,
      reasoningOutputTokens: 5, pricedTokens: 10, unpricedTokens: 110 });
    expect(providerUsageTotals()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", totalTokens: 100, pricedTokens: 0, unpricedTokens: 100 }),
      expect.objectContaining({ provider: "claude", totalTokens: 20, pricedTokens: 10, unpricedTokens: 10 }),
    ]));
    const buckets = usageDetail(null).buckets;
    expect(buckets.find((bucket) => bucket.model === "gpt-6-sol")).toMatchObject({ totalTokens: 100, pricedTokens: 0 });
    expect(buckets.find((bucket) => bucket.model === "claude-sonnet-5")).toMatchObject({ totalTokens: 10, pricedTokens: 0 });
    expect(buckets.find((bucket) => bucket.model === "claude-opus-5-5")).toMatchObject({ totalTokens: 10, cacheReadTokens: 5, reasoningOutputTokens: 5, pricedTokens: 10 });
  });

  it("does not include legacy total-only helpers in a chat prompt average when their bucket is shared", () => {
    annotateThreadUsage("shared-bucket-chat", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("shared-bucket-chat", { inputTokens: 90, outputTokens: 10, totalTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true }, "chat-event", "chat-turn");
    recordAuxiliaryUsage({ executionId: "old-total-only-helper", provider: "openai", model: "gpt-6-sol", purpose: "thread-title",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0, tokenAvailability: "partial" }, tokenAvailability: "partial" });
    flushUsageLedger();
    const history = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
    history.buckets[0][16] = 0;
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
    resetUsageLedgerCache();
    expect(promptAverages(usageDetail(null).buckets, "turns")).toMatchObject({ prompts: 0, tokens: null, pricedPrompts: 0, cost: null, excludedTokens: 200 });
  });
});
