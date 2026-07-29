import { beforeEach, describe, expect, it } from "vitest";
import {
  annotateThreadUsage,
  estimateUsageCost,
  pricingForModel,
  recordCumulativeUsage,
  recordUsageDelta,
  resetUsageLedgerCache,
  flushUsageLedger,
  usageForThread,
  usageTotals,
} from "./usageLedger";

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  totalTokens: inputTokens + outputTokens,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  reasoningOutputTokens: 0,
  contextWindow: null,
});

describe("usage ledger", () => {
  beforeEach(() => {
    resetUsageLedgerCache();
    localStorage.clear();
  });

  it("accumulates cumulative Codex snapshots without double counting them", () => {
    recordCumulativeUsage("thread", usage(100, 20));
    recordCumulativeUsage("thread", usage(180, 45));
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 180, outputTokens: 45 });
  });

  it("rebaselines a lower resumed Codex snapshot without shrinking totals", () => {
    recordCumulativeUsage("thread", usage(100, 20));
    recordCumulativeUsage("thread", usage(10, 5));
    expect(usageForThread("thread")?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      contextTokens: 15,
    });

    recordCumulativeUsage("thread", usage(30, 12));
    expect(usageForThread("thread")?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 27,
      contextTokens: 42,
    });
  });

  it("accumulates Claude run deltas and deduplicates result events", () => {
    recordUsageDelta("thread", usage(100, 20), "turn-1");
    recordUsageDelta("thread", usage(100, 20), "turn-1");
    recordUsageDelta("thread", usage(80, 35), "turn-2");
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 180, outputTokens: 55 });
  });

  it("uses discounted cached-input pricing", () => {
    const pricing = pricingForModel("openai", "gpt-5.6-sol");
    expect(estimateUsageCost(usage(1_000_000, 1_000_000, 500_000), pricing)).toBe(32.75);
  });

  it("uses the cache-write premium when the runtime reports cache creation", () => {
    const pricing = pricingForModel("claude", "claude-opus-5");
    expect(estimateUsageCost(usage(1_000_000, 0, 250_000, 250_000), pricing)).toBe(4.1875);
  });

  it("sums all-time tokens and API-equivalent value", () => {
    recordCumulativeUsage("one", usage(1_000_000, 100_000));
    annotateThreadUsage("one", { provider: "openai", model: "gpt-5.6-terra" });
    recordUsageDelta("two", usage(500_000, 50_000), "turn");
    annotateThreadUsage("two", { provider: "claude", model: "claude-haiku-4-5" });
    expect(usageTotals()).toMatchObject({
      inputTokens: 1_500_000,
      outputTokens: 150_000,
      threads: 2,
      estimatedCost: 4.75,
    });
  });

  it("keeps each usage increment at the model price active when it was recorded", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-5.6-luna" });
    recordCumulativeUsage("thread", usage(1_000_000, 0));
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-5.6-sol" });
    recordCumulativeUsage("thread", usage(2_000_000, 0));

    expect(usageTotals().estimatedCost).toBe(6);
  });

  it("does not erase known OpenRouter pricing while its catalog is unavailable", () => {
    const pricing = { inputPerMillion: 2, outputPerMillion: 4, source: "OpenRouter" as const, asOf: "2026-07-28" };
    annotateThreadUsage("thread", { provider: "openrouter", model: "vendor/model", pricing });
    recordCumulativeUsage("thread", usage(1_000_000, 0));
    annotateThreadUsage("thread", { provider: "openrouter", model: "vendor/model" });
    recordCumulativeUsage("thread", usage(2_000_000, 0));

    expect(usageForThread("thread")?.pricing).toEqual(pricing);
    expect(usageTotals().estimatedCost).toBe(4);
    expect(usageTotals().unpricedTokens).toBe(0);
  });

  it("does not reuse one OpenRouter model's price after the thread changes models", () => {
    annotateThreadUsage("thread", {
      provider: "openrouter",
      model: "vendor/priced",
      pricing: { inputPerMillion: 2, outputPerMillion: 4, source: "OpenRouter", asOf: "2026-07-28" },
    });
    recordCumulativeUsage("thread", usage(1_000_000, 0));
    annotateThreadUsage("thread", { provider: "openrouter", model: "vendor/unpriced" });
    recordCumulativeUsage("thread", usage(2_000_000, 0));

    expect(usageForThread("thread")?.pricing).toBeUndefined();
    expect(usageTotals().estimatedCost).toBe(2);
    expect(usageTotals().pricedTokens).toBe(1_000_000);
    expect(usageTotals().unpricedTokens).toBe(1_000_000);
  });

  it("retains all tracked threads instead of silently truncating all-time totals", () => {
    for (let index = 0; index < 1_005; index += 1) {
      recordUsageDelta(`thread-${index}`, usage(1, 1), `turn-${index}`);
    }
    flushUsageLedger();

    expect(usageTotals().threads).toBe(1_005);
    expect(JSON.parse(localStorage.getItem("kiwi.usageLedger") ?? "[]")).toHaveLength(1_005);
  });
});
