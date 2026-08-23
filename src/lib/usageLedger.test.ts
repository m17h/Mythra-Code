import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateThreadUsage,
  compactUsageRecords,
  estimateUsageCost,
  MODEL_PRICING_CATALOG_KEY,
  parseModelPricingCatalog,
  pricingForModel,
  recordCumulativeUsage,
  recordUsageDelta,
  refreshModelPricingCatalog,
  resetUsageLedgerCache,
  flushUsageLedger,
  usageForThread,
  usageTotals,
  USAGE_LEDGER_KEY,
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

/** Writes a catalog straight to storage, without clearing module caches, so
 * tests exercise the same late-arriving-snapshot path the app has at launch. */
const storeCatalog = (models: Record<string, unknown>) => {
  localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-08T17:00:00Z",
    models,
  }));
};

describe("usage ledger", () => {
  beforeEach(() => {
    resetUsageLedgerCache();
    localStorage.clear();
  });

  it("folds stale thread records into one archive record with identical totals", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const stale = now - 120 * 86_400_000;
    const records = [
      { threadId: "fresh", usage: usage(100, 10), estimatedCost: 0.5, pricedTokens: 110, unpricedTokens: 0, updatedAt: now - 86_400_000 },
      { threadId: "old-a", usage: usage(200, 20), estimatedCost: 1, pricedTokens: 220, unpricedTokens: 0, updatedAt: stale },
      { threadId: "old-b", usage: usage(50, 5), updatedAt: stale },
    ];
    const compacted = compactUsageRecords(records, now);
    expect(compacted).toHaveLength(2);
    const archive = compacted.find((record) => record.threadId === "openkiwi:archived-usage");
    expect(archive?.archivedThreads).toBe(2);
    expect(archive?.usage).toMatchObject({ inputTokens: 250, outputTokens: 25 });
    expect(archive?.estimatedCost).toBeCloseTo(1);
    // old-b had no pricing, so its tokens count as unpriced.
    expect(archive?.unpricedTokens).toBe(55);
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(compacted));
    const totals = usageTotals();
    expect(totals.threads).toBe(3);
    expect(totals.inputTokens).toBe(350);
    expect(totals.estimatedCost).toBeCloseTo(1.5);
  });

  it("accumulates cumulative Codex snapshots without double counting them", () => {
    recordCumulativeUsage("thread", usage(100, 20));
    recordCumulativeUsage("thread", usage(180, 45));
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 180, outputTokens: 45 });
  });

  it("resumes an archived cumulative thread from its retained baseline", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const compacted = compactUsageRecords([{
      threadId: "old-codex",
      usage: usage(200, 20),
      cumulativeSnapshot: usage(200, 20),
      updatedAt: now - 120 * 86_400_000,
    }], now);
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(compacted));
    resetUsageLedgerCache();

    recordCumulativeUsage("old-codex", usage(250, 25));

    expect(usageForThread("old-codex")).toMatchObject({
      countedInArchive: true,
      usage: { inputTokens: 50, outputTokens: 5 },
    });
    expect(usageTotals()).toMatchObject({ inputTokens: 250, outputTokens: 25, threads: 1 });
  });

  it("rebaselines a lower counter after archive without recounting history", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const compacted = compactUsageRecords([{
      threadId: "old-codex",
      usage: usage(200, 20),
      cumulativeSnapshot: usage(200, 20),
      updatedAt: now - 120 * 86_400_000,
    }], now);
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(compacted));
    resetUsageLedgerCache();

    recordCumulativeUsage("old-codex", usage(10, 5));
    recordCumulativeUsage("old-codex", usage(30, 12));

    expect(usageTotals()).toMatchObject({ inputTokens: 220, outputTokens: 27, threads: 1 });
  });

  it("rebaselines a lower resumed Codex snapshot without shrinking totals", () => {
    recordCumulativeUsage("thread", { ...usage(100, 20), contextTokens: 90 });
    recordCumulativeUsage("thread", { ...usage(10, 5), contextTokens: 12 });
    expect(usageForThread("thread")?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      contextTokens: 12,
    });

    recordCumulativeUsage("thread", { ...usage(30, 12), contextTokens: 35 });
    expect(usageForThread("thread")?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 27,
      contextTokens: 35,
    });
  });

  it("keeps latest context occupancy separate from cumulative billed usage", () => {
    recordCumulativeUsage("thread", { ...usage(100_000, 8_000), contextTokens: 20_000, contextWindow: 200_000 });
    recordCumulativeUsage("thread", { ...usage(140_000, 10_000), contextTokens: 25_000, contextWindow: 200_000 });
    expect(usageForThread("thread")?.usage).toMatchObject({
      totalTokens: 150_000,
      contextTokens: 25_000,
      contextWindow: 200_000,
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
    annotateThreadUsage("one", { provider: "openai", model: "gpt-5.6-terra" });
    recordCumulativeUsage("one", usage(1_000_000, 100_000));
    annotateThreadUsage("two", { provider: "claude", model: "claude-haiku-4-5" });
    recordUsageDelta("two", usage(500_000, 50_000), "turn");
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

  it("never reprices tokens recorded before a price becomes available", () => {
    recordUsageDelta("thread", usage(1_000_000, 0), "before-price");
    annotateThreadUsage("thread", {
      provider: "openrouter",
      model: "vendor/new-model",
      pricing: { inputPerMillion: 2, outputPerMillion: 4, source: "OpenRouter", asOf: "2026-08-08" },
    });
    recordUsageDelta("thread", usage(1_000_000, 0), "after-price");

    expect(usageForThread("thread")).toMatchObject({
      estimatedCost: 2,
      pricedTokens: 1_000_000,
      unpricedTokens: 1_000_000,
    });
  });

  it("validates, caches, and adopts a refreshed startup price", async () => {
    const remote = {
      schemaVersion: 1,
      updatedAt: "2026-08-08T17:00:00Z",
      models: {
        "openai:gpt-5.6-sol": {
          inputPerMillion: 4,
          cachedInputPerMillion: 0.4,
          outputPerMillion: 24,
          asOf: "2026-08-08",
        },
        "cursor:not-a-billable-provider": {
          inputPerMillion: 99,
          outputPerMillion: 99,
          asOf: "2026-08-08",
        },
      },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(remote), { status: 200 }));

    const catalog = await refreshModelPricingCatalog(fetcher as typeof fetch, "https://example.test/prices.json");

    expect(catalog?.models).toHaveProperty("openai:gpt-5.6-sol");
    expect(catalog?.models).not.toHaveProperty("cursor:not-a-billable-provider");
    expect(pricingForModel("openai", "gpt-5.6-sol")?.inputPerMillion).toBe(4);
    expect(JSON.parse(localStorage.getItem(MODEL_PRICING_CATALOG_KEY) ?? "null")?.updatedAt).toBe(remote.updatedAt);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("openkiwi="), expect.objectContaining({ cache: "no-store" }));
  });

  it("rejects a pricing catalog with no trustworthy entries", () => {
    expect(parseModelPricingCatalog({
      schemaVersion: 1,
      updatedAt: "2026-08-08T17:00:00Z",
      models: { "openai:gpt-5.6-sol": { inputPerMillion: -1, outputPerMillion: 24, asOf: "2026-08-08" } },
    })).toBeNull();
  });

  it("rejects a rate that is not a number rather than treating it as free", () => {
    expect(parseModelPricingCatalog({
      schemaVersion: 1,
      updatedAt: "2026-08-08T17:00:00Z",
      models: {
        "openai:gpt-5.6-sol": { inputPerMillion: null, outputPerMillion: 24, asOf: "2026-08-08" },
        "openai:gpt-5.6-luna": { inputPerMillion: "1", outputPerMillion: 6, asOf: "2026-08-08" },
        "claude:claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: true, asOf: "2026-08-08" },
      },
    })).toBeNull();
  });

  it("stops applying a catalog rate once its scheduled end date passes", () => {
    storeCatalog({
      "claude:claude-sonnet-5": {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.2,
        cacheWriteInputPerMillion: 2.5,
        outputPerMillion: 10,
        asOf: "2026-07-28",
        effectiveUntil: "2026-09-01",
        note: "Introductory pricing through August 31, 2026",
      },
    });

    expect(pricingForModel("claude", "claude-sonnet-5", new Date("2026-08-31T23:00:00Z"))?.inputPerMillion).toBe(2);
    // The bundled table's post-introductory rate takes over on schedule even if
    // the published catalog is never edited again.
    expect(pricingForModel("claude", "claude-sonnet-5", new Date("2026-09-01T00:00:00Z"))).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
      note: undefined,
    });
  });

  it("applies a refreshed rate to a model's dated snapshot alias", () => {
    storeCatalog({
      "claude:claude-opus-4-8": { inputPerMillion: 7, outputPerMillion: 35, asOf: "2026-08-08" },
    });

    expect(pricingForModel("claude", "claude-opus-4-8-20260101")?.inputPerMillion).toBe(7);
    // A non-dated suffix is not a snapshot alias, so it falls through to the
    // bundled table instead of inheriting the refreshed rate.
    expect(pricingForModel("claude", "claude-opus-4-8-turbo")?.inputPerMillion).toBe(5);
  });

  it("reads a cached catalog that lands in storage after the first lookup", () => {
    expect(pricingForModel("openai", "gpt-5.6-luna")?.inputPerMillion).toBe(1);
    storeCatalog({ "openai:gpt-5.6-luna": { inputPerMillion: 9, outputPerMillion: 40, asOf: "2026-08-08" } });
    expect(pricingForModel("openai", "gpt-5.6-luna")?.inputPerMillion).toBe(9);
  });

  it("freezes a legacy record's cost at its old rate before adopting a new one", () => {
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([{
      threadId: "legacy",
      provider: "claude",
      model: "claude-haiku-4-5",
      usage: usage(1_000_000, 0),
      pricing: { inputPerMillion: 1, outputPerMillion: 5, source: "Anthropic", asOf: "2026-07-28" },
      updatedAt: 1,
    }]));
    storeCatalog({ "claude:claude-haiku-4-5": { inputPerMillion: 4, outputPerMillion: 20, asOf: "2026-08-08" } });

    annotateThreadUsage("legacy", { provider: "claude", model: "claude-haiku-4-5" });

    expect(usageForThread("legacy")).toMatchObject({
      estimatedCost: 1,
      pricedTokens: 1_000_000,
      pricing: { inputPerMillion: 4 },
    });
    expect(usageTotals().estimatedCost).toBe(1);
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
