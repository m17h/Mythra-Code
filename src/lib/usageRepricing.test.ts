import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateThreadUsage, flushUsageLedger, MODEL_PRICING_CATALOG_KEY, OFFICIAL_PRICING_KEY, PRICING_CORRECTIONS_ID, providerUsageTotals,
  recordUsageDelta, resetUsageLedgerCache, updateCursorModelNames, usageTotals, USAGE_LEDGER_KEY,
} from "./usageLedger";
import { pruneUsageHistory, repriceUsageHistory, repricingSummary, retainedUsageHistory, USAGE_HISTORY_KEY } from "./usageHistory";
import { recordOfficialPricingResult, type OfficialRate } from "./officialPricing";
import { componentCost, usageDetail } from "./usageSummary";

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens: 0, contextWindow: null,
});
const at = (day: number, hour: number) => new Date(2026, 8, day, hour).getTime();
const HOUR = 3_600_000;

function reload() {
  flushUsageLedger();
  resetUsageLedgerCache();
}

function publishCatalog(models: Record<string, Record<string, unknown>>, updatedAt = "2026-09-22T00:00:00Z") {
  localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, updatedAt, models }));
}

function observe(source: "openai" | "anthropic" | "cursor", models: Record<string, Omit<OfficialRate, "asOf">>, when: number) {
  vi.setSystemTime(when);
  const day = new Date(when).toISOString().slice(0, 10);
  recordOfficialPricingResult(source, { ok: true, models: Object.fromEntries(Object.entries(models).map(([key, rate]) => [key, { ...rate, asOf: day }])) }, when);
}

/** The ledger and the dated detail describe the same usage and cost. */
function expectInSync() {
  const detail = usageDetail(null);
  expect(detail.detailAhead).toBeUndefined();
  expect(detail.unallocated).toBeNull();
  const totals = usageTotals();
  expect(componentCost(detail.detailTotals)).toBeCloseTo(totals.estimatedCost, 10);
  expect(detail.detailTotals.pricedTokens).toBe(totals.pricedTokens);
  expect(detail.detailTotals.unpricedTokens).toBe(totals.unpricedTokens);
}

function modelBucket(model: string) {
  return [...retainedUsageHistory().buckets].find((bucket) => bucket.model === model)!;
}

describe("evidence-backed repricing of dated usage", () => {
  beforeEach(() => {
    resetUsageLedgerCache();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(at(20, 10));
  });
  afterEach(() => {
    resetUsageLedgerCache();
    vi.useRealTimers();
  });

  it("prices unpriced usage once the catalog attests the rate for its date, exactly once across refreshes and restarts", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(3_000_000, 1_000_000, 1_000_000), "a", "turn-1");
    reload();
    expect(usageTotals()).toMatchObject({ estimatedCost: 0, pricedTokens: 0, unpricedTokens: 4_000_000 });

    vi.setSystemTime(at(23, 9));
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    // 2M uncached × $1 + 1M cached × $0.10 + 1M output × $4.
    expect(usageTotals()).toMatchObject({ pricedTokens: 4_000_000, unpricedTokens: 0 });
    expect(usageTotals().estimatedCost).toBeCloseTo(6.1, 10);
    expect(providerUsageTotals().find((item) => item.provider === "openai")).toMatchObject({ pricedTokens: 4_000_000, unpricedTokens: 0 });
    expectInSync();

    for (let pass = 0; pass < 3; pass += 1) {
      expect(repriceUsageHistory()).toBe(0);
      reload();
      expect(repriceUsageHistory()).toBe(0);
    }
    expect(usageTotals().estimatedCost).toBeCloseTo(6.1, 10);
    expectInSync();
    expect(repricingSummary(retainedUsageHistory().buckets)).toMatchObject({ pricedTokens: 4_000_000, correctedTokens: 0 });
    expect(repricingSummary(retainedUsageHistory().buckets).costChange).toBeCloseTo(6.1, 10);
  });

  it("never applies a rate observed only after the usage, or attested only up to an earlier day", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    // The page lists the model an hour later, and again the next day.
    observe("openai", { "gpt-7-nova": { input: 1, output: 4 } }, at(20, 11));
    observe("openai", { "gpt-7-nova": { input: 1, output: 4 } }, at(21, 9));
    // The catalog verified the rate only up to the day before the usage.
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-19", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals()).toMatchObject({ estimatedCost: 0, unpricedTokens: 1_000_000 });
    expect(modelBucket("gpt-7-nova").unpricedTokens).toBe(1_000_000);
  });

  it("prices Cursor usage the page showed at one rate before and after, and not across a long gap", () => {
    const composer = { input: 1.25, cacheRead: 0.125, output: 10 };
    observe("cursor", { "composer 2": composer }, at(20, 9));
    vi.setSystemTime(at(20, 10));
    // The live model list isn't loaded yet, so this usage can't be matched.
    annotateThreadUsage("thread", { provider: "cursor", model: "composer-2" });
    recordUsageDelta("thread", usage(2_000_000, 100_000), "a", "turn-1");
    annotateThreadUsage("late", { provider: "cursor", model: "composer-2" });
    vi.setSystemTime(at(21, 20));
    recordUsageDelta("late", usage(1_000_000, 0), "b", "turn-2");
    observe("cursor", { "composer 2": composer }, at(21, 8));
    // Seen again 3 days later: the 21st 08:00 → 24th epoch is broken by the gap.
    observe("cursor", { "composer 2": composer }, at(24, 9));
    expect(usageTotals().unpricedTokens).toBe(3_100_000);

    updateCursorModelNames([{ id: "composer-2", name: "Composer 2" }]);
    expect(repriceUsageHistory()).toBe(1);
    // Only the usage bracketed on the 20th: 2M × $1.25 + 100K × $10.
    expect(usageTotals().estimatedCost).toBeCloseTo(3.5, 10);
    expect(usageTotals()).toMatchObject({ pricedTokens: 2_100_000, unpricedTokens: 1_000_000 });
    expectInSync();
  });

  it("corrects usage recorded at a different rate than the page showed at the time", () => {
    const page = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 };
    observe("anthropic", { "claude-sonnet-5": page }, at(20, 9));
    // The bundled rate is dated later than the page read, so new usage takes it.
    vi.setSystemTime(at(20, 10));
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(1_000_000, 1_000_000), "a", "turn-1");
    expect(usageTotals().estimatedCost).toBeCloseTo(12, 10);
    observe("anthropic", { "claude-sonnet-5": page }, at(21, 9));

    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals().estimatedCost).toBeCloseTo(18, 10);
    expect(usageTotals()).toMatchObject({ pricedTokens: 2_000_000, unpricedTokens: 0 });
    expectInSync();
    const summary = repricingSummary(retainedUsageHistory().buckets);
    expect(summary).toMatchObject({ pricedTokens: 0, correctedTokens: 2_000_000 });
    expect(summary.costChange).toBeCloseTo(6, 10);
    reload();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(18, 10);
  });

  it("keeps pre-drop usage at its old price and applies a lower price only from its effective date", () => {
    publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion: 8, outputPerMillion: 32, asOf: "2026-09-21", effectiveFrom: "2026-09-01" },
    });
    annotateThreadUsage("before", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("before", usage(1_000_000, 0), "before", "before-turn");
    flushUsageLedger();
    expect(usageTotals().estimatedCost).toBeCloseTo(8, 10);

    vi.setSystemTime(at(23, 10));
    publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion: 4, outputPerMillion: 16, asOf: "2026-09-25", effectiveFrom: "2026-09-22" },
    }, "2026-09-25T00:00:00Z");
    annotateThreadUsage("after", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("after", usage(1_000_000, 0), "after", "after-turn");
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(12, 10);

    // Later page observations of the $4 rate cannot move the September 20
    // usage into the lower-priced September 22-and-later period.
    observe("openai", { "gpt-7-nova": { input: 4, output: 16 } }, at(23, 11));
    observe("openai", { "gpt-7-nova": { input: 4, output: 16 } }, at(24, 11));
    expect(repriceUsageHistory()).toBe(0);
    reload();
    expect(usageTotals().estimatedCost).toBeCloseTo(12, 10);
    const days = [...retainedUsageHistory().buckets];
    expect(days.find((bucket) => bucket.day === "2026-09-20")?.uncachedInputCost).toBeCloseTo(8, 10);
    expect(days.find((bucket) => bucket.day === "2026-09-23")?.uncachedInputCost).toBeCloseTo(4, 10);
    expectInSync();
  });

  it("uses an explicit within-day effective moment rather than lowering earlier requests that day", () => {
    publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion: 5, outputPerMillion: 20, asOf: "2026-09-25", effectiveFrom: "2026-09-01" },
    });
    vi.setSystemTime(Date.parse("2026-09-25T09:00:00Z"));
    annotateThreadUsage("morning", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("morning", usage(1_000_000, 0), "morning", "turn-1");

    // The published change took effect at noon UTC, not at midnight.
    vi.setSystemTime(Date.parse("2026-09-25T13:00:00Z"));
    publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion: 4, outputPerMillion: 16, asOf: "2026-09-25", effectiveFrom: "2026-09-25T12:00:00Z" },
    }, "2026-09-25T13:00:00Z");
    annotateThreadUsage("afternoon", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("afternoon", usage(1_000_000, 0), "afternoon", "turn-2");
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(9, 10);
    reload();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(9, 10);
    expectInSync();
  });

  it("keeps repeated same-day rates in separate cohorts when another rate intervenes", () => {
    const rate = (inputPerMillion: number) => ({
      inputPerMillion, outputPerMillion: inputPerMillion * 4,
      source: "OpenAI" as const, asOf: "2026-09-25", origin: "catalog" as const,
    });
    for (const [hour, price] of [[9, 5], [10, 4], [11, 5]] as const) {
      vi.setSystemTime(at(20, hour));
      annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova", pricing: rate(price) });
      recordUsageDelta("thread", usage(1_000_000, 0), `${hour}`, `turn-${hour}`);
    }
    const cohortPrices = modelBucket("gpt-7-nova").cohorts!.map((cohort) => cohort.rate);
    expect(cohortPrices).toHaveLength(3);
    expect(cohortPrices[0]).toBe(cohortPrices[2]);
    expect(cohortPrices[0]).not.toBe(cohortPrices[1]);
    expect(usageTotals().estimatedCost).toBeCloseTo(14, 10);
    reload();
    expect(modelBucket("gpt-7-nova").cohorts).toHaveLength(3);
  });

  it("changes nothing when sources disagree about the rate at the time", () => {
    observe("openai", { "gpt-7-nova": { input: 2, output: 8 } }, at(20, 9));
    localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!), models: {} }));
    resetUsageLedgerCache();
    vi.setSystemTime(at(20, 10));
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    observe("openai", { "gpt-7-nova": { input: 2, output: 8 } }, at(21, 9));
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().unpricedTokens).toBe(1_000_000);
  });

  it("reprices a wholly unpriced legacy day, but never a mixed legacy day or the archive", () => {
    const old = at(1, 12);
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([
      { threadId: "unpriced", provider: "openai", model: "gpt-7-nova", usage: usage(1_000_000, 100_000), estimatedCost: 0, pricedTokens: 0, unpricedTokens: 1_100_000, updatedAt: at(19, 12) },
      { threadId: "mixed", provider: "openai", model: "gpt-7-nova", usage: usage(2_000_000, 0), estimatedCost: 1, pricedTokens: 1_000_000, unpricedTokens: 1_000_000, updatedAt: at(18, 12) },
      { threadId: "openkiwi:archived-usage", provider: "openai", usage: usage(500_000, 0), estimatedCost: 0, pricedTokens: 0, unpricedTokens: 500_000, archivedThreads: 1, updatedAt: old },
    ]));
    // Pre-cohort buckets: [day, provider, model, 16 amounts].
    const bucket = (day: string, uncached: number, output: number, cost: number, priced: number, unpriced: number) =>
      [day, "openai", "gpt-7-nova", uncached, 0, 0, output, 0, uncached + output, cost, 0, 0, 0, priced, unpriced, 1, 0, 1, 0];
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify({
      schemaVersion: 1, startedAt: at(10, 0), recentTurns: [],
      buckets: [bucket("2026-09-19", 1_000_000, 100_000, 0, 0, 1_100_000), bucket("2026-09-18", 2_000_000, 0, 1, 1_000_000, 1_000_000)],
    }));
    resetUsageLedgerCache();
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });

    expect(repriceUsageHistory()).toBe(1);
    // $1 + $0.40 for the unpriced day; the mixed day and the archive keep theirs.
    expect(usageTotals().estimatedCost).toBeCloseTo(2.4, 10);
    expect(usageTotals()).toMatchObject({ pricedTokens: 2_100_000, unpricedTokens: 1_500_000 });
    const days = [...retainedUsageHistory().buckets];
    expect(days.find((item) => item.day === "2026-09-18")).toMatchObject({ pricedTokens: 1_000_000, unpricedTokens: 1_000_000, uncachedInputCost: 1 });
    expect(days.find((item) => item.day === "2026-09-19")).toMatchObject({ pricedTokens: 1_100_000, unpricedTokens: 0 });
    // The archive's undated usage stays unpriced and outside dated detail.
    expect(usageDetail(null).unallocated).toMatchObject({ unpricedTokens: 500_000, estimatedCost: 0 });
    reload();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(2.4, 10);
  });

  it("finishes the dated side of a correction interrupted before detail was saved, without charging twice", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const detailBefore = localStorage.getItem(USAGE_HISTORY_KEY)!;
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    // The ledger's write landed; the detail's didn't.
    localStorage.setItem(USAGE_HISTORY_KEY, detailBefore);
    resetUsageLedgerCache();
    expect(usageTotals()).toMatchObject({ estimatedCost: 1, unpricedTokens: 0 });
    expect(usageDetail(null).unallocated).toMatchObject({ estimatedCost: 1 });

    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals()).toMatchObject({ estimatedCost: 1, pricedTokens: 1_000_000, unpricedTokens: 0 });
    expectInSync();
    const ledger = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ threadId: string; appliedCorrections?: string[] }>;
    expect(ledger.find((record) => record.threadId === PRICING_CORRECTIONS_ID)?.appliedCorrections).toHaveLength(1);
  });

  it("recovers when native detail saved a correction before the independent ledger queue", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const ledgerBefore = localStorage.getItem(USAGE_LEDGER_KEY)!;
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    // Simulate a crash after the native history write, before the native
    // ledger write; hydration brings this older ledger back on next launch.
    localStorage.setItem(USAGE_LEDGER_KEY, ledgerBefore);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals()).toMatchObject({ estimatedCost: 1, pricedTokens: 1_000_000, unpricedTokens: 0 });
    expectInSync();
  });

  it("recovers a ledger-first correction even when evidence disappeared before restart", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const historyBefore = localStorage.getItem(USAGE_HISTORY_KEY)!;
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    localStorage.setItem(USAGE_HISTORY_KEY, historyBefore);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(1);
    expectInSync();
  });

  it("reconciles a later revision after either native key falls one write behind", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const publish = (price: number) => publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion: price, outputPerMillion: 4 * price, asOf: "2026-09-22", effectiveFrom: "2026-09-01" },
    });
    publish(1);
    expect(repriceUsageHistory()).toBe(1);
    const firstLedger = localStorage.getItem(USAGE_LEDGER_KEY)!;
    const firstHistory = localStorage.getItem(USAGE_HISTORY_KEY)!;
    publish(2);
    expect(repriceUsageHistory()).toBe(1);

    localStorage.setItem(USAGE_LEDGER_KEY, firstLedger);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals().estimatedCost).toBeCloseTo(2, 10);
    expectInSync();

    // The other ordering restores the same target rate from the ledger.
    localStorage.setItem(USAGE_HISTORY_KEY, firstHistory);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals().estimatedCost).toBeCloseTo(2, 10);
    expectInSync();
  });

  it("does not fold fresh usage into a cohort awaiting ledger-first recovery", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const historyBefore = localStorage.getItem(USAGE_HISTORY_KEY)!;
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    localStorage.setItem(USAGE_HISTORY_KEY, historyBefore);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    annotateThreadUsage("fresh", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("fresh", usage(1_000_000, 0), "b", "turn-2");
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals()).toMatchObject({ estimatedCost: 1, pricedTokens: 1_000_000, unpricedTokens: 1_000_000 });
    expect(modelBucket("gpt-7-nova").cohorts).toHaveLength(2);
    expectInSync();
  });

  it("does not double-charge an older correction whose rolling id aged out before checkpoints existed", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<Record<string, unknown>>;
    const correction = records.find((record) => record.threadId === PRICING_CORRECTIONS_ID)!;
    delete correction.correctionCheckpoints;
    correction.appliedCorrections = [];
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    const legacyHistory = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!) as { buckets: unknown[][] };
    (legacyHistory.buckets[0][19] as unknown[][])[0].pop();
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(legacyHistory));
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(1, 10);
    expectInSync();
  });

  it("recovers a new cohort when other correction records already exist in the older ledger", () => {
    annotateThreadUsage("first", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("first", usage(1_000_000, 0), "a", "turn-1");
    const rate = { "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } };
    publishCatalog(rate);
    expect(repriceUsageHistory()).toBe(1);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    vi.setSystemTime(at(21, 10));
    annotateThreadUsage("second", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("second", usage(1_000_000, 0), "b", "turn-2");
    reload();
    const ledgerBeforeSecondCorrection = localStorage.getItem(USAGE_LEDGER_KEY)!;
    publishCatalog(rate);
    expect(repriceUsageHistory()).toBe(1);
    localStorage.setItem(USAGE_LEDGER_KEY, ledgerBeforeSecondCorrection);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(1);
    expect(usageTotals().estimatedCost).toBeCloseTo(2, 10);
    expectInSync();
  });

  it("retires checkpoint entries with dated history and fences stale copies from replay", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    const staleHistory = localStorage.getItem(USAGE_HISTORY_KEY)!;
    const later = at(500, 10);
    pruneUsageHistory(later);
    flushUsageLedger();
    const record = (JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<Record<string, unknown>>)
      .find((item) => item.threadId === PRICING_CORRECTIONS_ID)!;
    expect(Object.keys(record.correctionCheckpoints as object)).toHaveLength(0);
    expect(record.correctionPrunedBefore).toBeTruthy();
    localStorage.setItem(USAGE_HISTORY_KEY, staleHistory);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(0);
    expect(usageTotals().estimatedCost).toBeCloseTo(1, 10);
  });

  it("ignores a corrupt checkpoint rate instead of creating non-finite dated costs", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    const historyBefore = localStorage.getItem(USAGE_HISTORY_KEY)!;
    publishCatalog({ "openai:gpt-7-nova": { inputPerMillion: 1, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" } });
    expect(repriceUsageHistory()).toBe(1);
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<Record<string, unknown>>;
    const record = records.find((item) => item.threadId === PRICING_CORRECTIONS_ID)!;
    const checkpoint = Object.values(record.correctionCheckpoints as Record<string, { pricing: { inputPerMillion: number } }>)[0];
    checkpoint.pricing.inputPerMillion = -1;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    localStorage.setItem(USAGE_HISTORY_KEY, historyBefore);
    localStorage.removeItem(MODEL_PRICING_CATALOG_KEY);
    resetUsageLedgerCache();
    expect(repriceUsageHistory()).toBe(0);
    expect(Number.isFinite(usageTotals().estimatedCost)).toBe(true);
    expect(modelBucket("gpt-7-nova").uncachedInputCost).toBe(0);
  });

  it("applies each revision when historical evidence changes away and then returns to a prior rate", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    const setRate = (inputPerMillion: number) => publishCatalog({
      "openai:gpt-7-nova": { inputPerMillion, outputPerMillion: 4, asOf: "2026-09-22", effectiveFrom: "2026-09-01" },
    });
    for (const [rate, expected] of [[1, 1], [2, 2], [1, 1], [2, 2]] as const) {
      setRate(rate);
      expect(repriceUsageHistory()).toBe(1);
      reload();
      expect(usageTotals().estimatedCost).toBeCloseTo(expected, 10);
      expectInSync();
      expect(repriceUsageHistory()).toBe(0);
    }
    const ledger = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ threadId: string; appliedCorrections?: string[] }>;
    expect(new Set(ledger.find((record) => record.threadId === PRICING_CORRECTIONS_ID)?.appliedCorrections).size).toBe(4);
  });

  it("reprices automatically when a pricing page read supplies the evidence", async () => {
    observe("anthropic", { "claude-sonnet-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 } }, at(20, 9));
    vi.setSystemTime(at(20, 10));
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    reload();
    observe("anthropic", { "claude-sonnet-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 } }, at(21, 9));
    await Promise.resolve();
    await Promise.resolve();
    expect(usageTotals().estimatedCost).toBeCloseTo(3, 10);
    expectInSync();
  });

  it("closes an epoch when a successful read stops listing the model", () => {
    const rate = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 };
    observe("anthropic", { "claude-sonnet-5": rate }, at(20, 9));
    observe("anthropic", { "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 } }, at(20, 9) + HOUR);
    observe("anthropic", { "claude-sonnet-5": rate }, at(21, 9));
    const epochs = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!).epochs["claude:claude-sonnet-5"];
    expect(epochs).toHaveLength(2);
    expect(epochs[0][7]).toBe(0);
  });
  it("persists cohorts compactly, and drops only the provenance of a damaged or legacy Claude bucket", () => {
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    recordUsageDelta("thread", usage(1_000_000, 0), "b", "turn-1");
    reload();
    const saved = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
    // One rate, one cohort holding both deltas, spanning whole minutes.
    expect(saved.rates).toHaveLength(1);
    expect(saved.buckets[0]).toHaveLength(20);
    expect(saved.buckets[0][19]).toEqual([[expect.any(String), 0, at(20, 10) / 60_000, at(20, 10) / 60_000, 2_000_000, 0, 0, 0, 0]]);

    saved.buckets[0][19][0][1] = 7;
    const claudeLegacy = ["2026-09-19", "claude", "claude-sonnet-5", 0, 0, 500_000, 0, 0, 500_000, 0, 0, 0, 0, 0, 500_000, 1, 0, 1, 0];
    saved.buckets.push(claudeLegacy);
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(saved));
    resetUsageLedgerCache();
    const buckets = [...retainedUsageHistory().buckets];
    expect(buckets).toHaveLength(2);
    expect(buckets.every((bucket) => !bucket.cohorts)).toBe(true);
    expect(buckets[0].pricedTokens).toBe(2_000_000);
  });
});
