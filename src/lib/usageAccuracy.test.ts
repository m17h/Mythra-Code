import { beforeEach, describe, expect, it } from "vitest";
import type { TokenUsageView } from "../components/StudioDock";
import { annotateThreadUsage, flushUsageLedger, MODEL_PRICING_CATALOG_KEY, OFFICIAL_PRICING_KEY, openRouterReportedCost,
  pricingForServiceTier, pricingModelKeys, recordAuxiliaryUsage, recordCumulativeUsage, recordUsageDelta, reportThreadServiceTier,
  resetUsageLedgerCache, usageForThread, usageTotals, USAGE_LEDGER_KEY } from "./usageLedger";
import { repriceUsageHistory, USAGE_HISTORY_KEY } from "./usageHistory";
import { usageDetail } from "./usageSummary";
import { historicalPricing } from "./pricingEvidence";
import { parseOpenAIPricing, recordOfficialPricingResult } from "./officialPricing";
import { OPENAI_PRICING_PAGE } from "../test/pricingPages";

const counts = (input = 100, output = 10, extra: Partial<TokenUsageView> = {}): TokenUsageView => ({
  inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true, serviceTier: "standard", serviceTierSource: "requested", ...extra,
});
const reload = () => { flushUsageLedger(); resetUsageLedgerCache(); };
const fastTable = `\n### Fast pricing data\n\n| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| gpt-6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |\n`;

describe("usage metric and tier evidence", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

  it("preserves omitted versus explicitly reported zero through history and reload", () => {
    annotateThreadUsage("missing", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordUsageDelta("missing", counts(100, 10, { cacheReadReported: false, cacheWriteReported: false }), "a", "turn-a");
    recordUsageDelta("missing", counts(100, 10), "b", "turn-b");
    expect(usageTotals()).toMatchObject({ inputTokens: 200, cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100, unpricedTokens: 110, pricedTokens: 110 });
    expect(usageDetail(null).totals).toMatchObject({ cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
    reload();
    expect(usageForThread("missing")?.usage).toMatchObject({ cacheReadReported: false, cacheWriteReported: false, cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
    expect(usageDetail(null).totals).toMatchObject({ cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
  });

  it("does not upgrade legacy numeric zeros to verified zero or reprice their frozen cost", () => {
    const legacy = counts();
    delete legacy.cacheReadReported; delete legacy.cacheWriteReported; delete legacy.serviceTier; delete legacy.serviceTierSource;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([{ threadId: "old", provider: "openai", model: "gpt-6-sol", usage: legacy, estimatedCost: 3, updatedAt: Date.now() }]));
    expect(usageTotals()).toMatchObject({ estimatedCost: 3, cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
    const detail = usageDetail(null);
    expect(detail.unallocated).toMatchObject({ cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
  });

  it("does not assign historical cache counters to the latest delta when reporting resumes", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    recordCumulativeUsage("thread", counts(100, 0, { cacheReadReported: false }));
    recordCumulativeUsage("thread", counts(200, 0, { cachedInputTokens: 150 }));
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 200, cachedInputTokens: 0, cacheReadUnknownTokens: 200 });
    recordCumulativeUsage("thread", counts(250, 0, { cachedInputTokens: 170 }));
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 250, cachedInputTokens: 20, cacheReadUnknownTokens: 200 });
    reload();
    expect(usageDetail(null).totals).toMatchObject({ cacheReadTokens: 20, cacheReadUnknownTokens: 200 });
  });

  it("does not treat a newly omitted cache counter as a cumulative reset", () => {
    recordCumulativeUsage("thread", counts(100, 0, { cachedInputTokens: 30 }));
    recordCumulativeUsage("thread", counts(150, 0, { cacheReadReported: false }));
    expect(usageForThread("thread")?.usage).toMatchObject({ inputTokens: 150, cachedInputTokens: 30, cacheReadUnknownTokens: 50 });
  });

  it("clears last turn's served tier and retains requested-estimate provenance", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "priority" });
    reportThreadServiceTier("thread", "fast");
    recordUsageDelta("thread", counts(0, 10, { serviceTier: undefined, serviceTierSource: undefined }), "a", "a");
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
    expect(usageForThread("thread")?.reportedServiceTier).toBeUndefined();
    recordUsageDelta("thread", counts(0, 20, { serviceTier: undefined, serviceTierSource: undefined }), "b", "b");
    const tiers = usageDetail(null).buckets[0].serviceTiers;
    expect(tiers).toEqual(expect.arrayContaining([{ tier: "fast", source: "reported", requestedTier: "fast" }, { tier: "standard", source: "requested", requestedTier: "standard" }]));
    expect(usageForThread("thread")?.usage.serviceTier).toBe("mixed");
    reload();
    expect(usageDetail(null).buckets[0].serviceTiers).toEqual(tiers);
  });

  it("zero-token deltas do not wipe output-only tier evidence", () => {
    recordUsageDelta("thread", counts(0, 10, { serviceTier: "fast", serviceTierSource: "reported" }), "a");
    recordUsageDelta("thread", counts(0, 0, { serviceTier: undefined, serviceTierSource: undefined }), "b");
    expect(usageForThread("thread")?.usage).toMatchObject({ serviceTier: "fast", serviceTierSource: "reported" });
    reload();
    expect(usageForThread("thread")?.usage).toMatchObject({ serviceTier: "fast", serviceTierSource: "reported" });
  });

  it("reads Fast rates as independent observed evidence without phantom models", () => {
    const result = parseOpenAIPricing(OPENAI_PRICING_PAGE + fastTable, "2026-09-28");
    expect(result.ok).toBe(true);
    recordOfficialPricingResult("openai", result, Date.parse("2026-09-28T12:00:00Z"));
    expect(pricingForServiceTier("openai", "gpt-6-sol", "priority")).toMatchObject({ inputPerMillion: 4, outputPerMillion: 20, serviceTier: "fast" });
    expect(pricingForServiceTier("openai", "unknown-model", "fast")).toBeUndefined();
    expect(pricingModelKeys().some((model) => model.includes("@"))).toBe(false);
    expect(historicalPricing("openai", "gpt-6-sol", Date.parse("2026-09-27T12:00:00Z"), Date.parse("2026-09-27T12:01:00Z"), "fast")).toBeUndefined();
  });

  it("never invents Fast pricing from Standard or expired catalog evidence", () => {
    expect(pricingForServiceTier("openai", "gpt-6-sol", "fast")).toBeUndefined();
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, updatedAt: "2026-09-28T12:00:00Z", models: {
      "openai:gpt-6-sol@fast": { inputPerMillion: 4, outputPerMillion: 20, serviceTier: "fast", asOf: "2026-09-25", effectiveUntil: "2026-09-26" },
    } }));
    expect(pricingForServiceTier("openai", "gpt-6-sol", "fast")).toBeUndefined();
  });

  it("does not merge partial and complete unpriced cohorts then retrospectively price both", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "unknown-model", requestedServiceTier: "standard" });
    recordUsageDelta("thread", counts(100, 10, { tokenAvailability: "reported" }), "a", "a");
    recordUsageDelta("thread", counts(100, 10, { tokenAvailability: "partial" }), "b", "b");
    expect(usageDetail(null).buckets[0].cohorts).toHaveLength(2);
    reload();
    const cohorts = usageDetail(null).buckets[0].cohorts!;
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), models: {
      "openai:unknown-model": { inputPerMillion: 1, outputPerMillion: 2, asOf: new Date().toISOString().slice(0, 10), effectiveFrom: new Date(cohorts[0].firstAt - 60_000).toISOString() },
    } }));
    repriceUsageHistory();
    expect(usageDetail(null).totals).toMatchObject({ pricedTokens: 110, unpricedTokens: 110 });
  });

  it("counts helpers once across reload without creating chats or chat turns", () => {
    const entry = { executionId: "execution-a", provider: "openai" as const, model: "gpt-6-sol", purpose: "thread-title", usage: counts(), requestedServiceTier: "standard" };
    expect(recordAuxiliaryUsage(entry)).toBe(true);
    expect(recordAuxiliaryUsage(entry)).toBe(false);
    expect(recordAuxiliaryUsage({ ...entry, model: "different-alias" })).toBe(false);
    expect(recordAuxiliaryUsage({ ...entry, executionId: "execution-b", usage: null })).toBe(true);
    expect(usageTotals()).toMatchObject({ threads: 0, auxiliaryRequests: 2, auxiliaryUnavailableRequests: 1 });
    expect(usageDetail(null).detailTotals).toMatchObject({ turns: 0, modelTurns: 0, auxiliaryRequests: 1 });
    reload();
    expect(recordAuxiliaryUsage(entry)).toBe(false);
    expect(usageTotals()).toMatchObject({ threads: 0, auxiliaryRequests: 2, auxiliaryUnavailableRequests: 1 });
  });

  it("keeps partial helpers unpriced and does not call Claude charges OpenRouter receipts", () => {
    recordAuxiliaryUsage({ executionId: "partial", provider: "claude", model: "claude-sonnet-5", purpose: "check-discovery", usage: counts(), tokenAvailability: "partial", reportedCost: 0.5 });
    expect(usageTotals()).toMatchObject({ pricedTokens: 0, unpricedTokens: 110, auxiliaryPartialRequests: 1 });
    expect(openRouterReportedCost()).toEqual({ cost: 0, requests: 0 });
    reload();
    expect(usageDetail(null).totals.unpricedTokens).toBe(110);
  });

  it("preserves cache-only and reasoning-only lower bounds as partial after reload", () => {
    recordAuxiliaryUsage({ executionId: "cache-only", provider: "openai", model: "gpt-6-sol", purpose: "run-discovery",
      usage: counts(0, 0, { cachedInputTokens: 300, cacheReadReported: true, cacheWriteReported: false }), tokenAvailability: "partial" });
    recordAuxiliaryUsage({ executionId: "reasoning-only", provider: "openai", model: "gpt-6-sol", purpose: "check-discovery",
      usage: counts(0, 0, { reasoningOutputTokens: 25 }), tokenAvailability: "partial" });
    expect(usageTotals()).toMatchObject({ inputTokens: 300, cachedInputTokens: 300, outputTokens: 25, reasoningOutputTokens: 25, pricedTokens: 0, unpricedTokens: 325 });
    reload();
    expect(usageTotals()).toMatchObject({ cachedInputTokens: 300, reasoningOutputTokens: 25, unpricedTokens: 325 });
  });

  it("applies known alias and dated snapshot identities without dropping the tier", () => {
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-5.6-sol@fast": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10, asOf: "2026-09-28", serviceTier: "fast" } } }, Date.parse("2026-09-28T12:00:00Z"));
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-5.6-sol@fast": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10, asOf: "2026-09-28", serviceTier: "fast" } } }, Date.parse("2026-09-28T12:05:00Z"));
    expect(pricingForServiceTier("openai", "gpt-5.6", "fast")).toMatchObject({ inputPerMillion: 8 });
    expect(pricingForServiceTier("openai", "gpt-5.6-sol-20260901", "fast")).toMatchObject({ inputPerMillion: 8 });
    expect(historicalPricing("openai", "gpt-5.6", Date.parse("2026-09-28T12:01:00Z"), Date.parse("2026-09-28T12:02:00Z"), "fast")).toMatchObject({ pricing: { inputPerMillion: 8, serviceTier: "fast" } });
  });

  it("legacy history without metric evidence remains unknown and is never repriced", () => {
    recordUsageDelta("thread", counts(), "a", "a");
    flushUsageLedger();
    const history = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
    delete history.bucketEvidence; delete history.cohortEvidence;
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
    resetUsageLedgerCache();
    expect(usageDetail(null).detailTotals).toMatchObject({ cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
    expect(repriceUsageHistory()).toBe(0);
    expect(localStorage.getItem(OFFICIAL_PRICING_KEY)).toBeNull();
  });

  it("rejects malformed optional provider coverage after reload without contaminating totals", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol" });
    recordUsageDelta("thread", counts(100, 0, { cacheReadReported: false }), "a");
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", counts(100, 0, { cacheReadReported: false }), "b");
    flushUsageLedger();
    const original = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!);
    for (const corrupt of [-100, "oops", Number.MAX_VALUE]) {
      const records = structuredClone(original);
      records[0].providerUsage.openai.cacheReadUnknownTokens = corrupt;
      localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
      resetUsageLedgerCache();
      expect(usageTotals()).toMatchObject({ cacheReadUnknownTokens: 200 });
      expect(usageDetail(null).totals.cacheReadUnknownTokens).toBe(200);
    }
  });

  it("bounds helper model groups while preserving request totals", () => {
    for (let index = 0; index < 160; index += 1) recordAuxiliaryUsage({ executionId: `execution-${index}`, provider: "openai", model: `model-${index}`, purpose: "thread-title", usage: null });
    flushUsageLedger();
    expect(JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!).filter((record: { kind?: string }) => record.kind === "auxiliary")).toHaveLength(129);
    expect(usageTotals()).toMatchObject({ auxiliaryRequests: 160, auxiliaryUnavailableRequests: 160, threads: 0 });
  });
});
