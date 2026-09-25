import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_PRICING_PAGE, CURSOR_PRICING_PAGE, OPENAI_PRICING_PAGE } from "../test/pricingPages";
import {
  claudeModelId, observeRates, officialPricingStatus, parseAnthropicPricing, parseCursorPricing, parseOpenAIPricing, recordOfficialPricingResult,
  refreshOfficialPricing, type PricingDocumentFetcher,
} from "./officialPricing";
import {
  annotateThreadUsage, MODEL_PRICING_CATALOG_KEY, OFFICIAL_PRICING_KEY, pricingForModel, pricingModelKeys,
  recordUsageDelta, resetUsageLedgerCache, updateCursorModelNames, usageTotals,
} from "./usageLedger";

const DAY = "2026-10-02";
const NOW = Date.parse("2026-10-02T12:00:00Z");
const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens: 0, contextWindow: null,
});
const pages: Record<string, string> = { openai: OPENAI_PRICING_PAGE, anthropic: ANTHROPIC_PRICING_PAGE, cursor: CURSOR_PRICING_PAGE };
const serving = (overrides: Partial<Record<string, string | Error>> = {}): PricingDocumentFetcher & ReturnType<typeof vi.fn> =>
  vi.fn(async (source: string) => {
    const page = overrides[source] ?? pages[source];
    if (page instanceof Error) throw page;
    return page;
  }) as never;
const expectOk = <T extends { ok: boolean }>(result: T) => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<T, { ok: true }>;
};

beforeEach(() => {
  resetUsageLedgerCache();
  localStorage.clear();
});

describe("official price observations", () => {
  it("preserves existing evidence if the device clock moves backwards", () => {
    const earlier = NOW - 3_600_000;
    const prior = { "openai:gpt-6-sol": [[NOW, NOW, 2, 10, 0.2, 2.5, null, 1] as const] };
    const observed = observeRates(prior as never, "openai:", {
      "gpt-6-sol": { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75, asOf: DAY },
    }, earlier);
    expect(observed["openai:gpt-6-sol"]).toEqual(prior["openai:gpt-6-sol"]);
  });
});

describe("OpenAI pricing page", () => {
  it("reads only Standard short-context rates, never Batch or Flex", () => {
    const { models } = expectOk(parseOpenAIPricing(OPENAI_PRICING_PAGE, DAY));
    expect(models["gpt-6-sol"]).toEqual({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, asOf: DAY });
    expect(models["gpt-6-astra"]).toMatchObject({ input: 10, output: 50 });
    // Only the Standard table: the Specialized table's Codex row is not read.
    expect(Object.keys(models).sort()).toEqual(["gpt-4o-2024-05-13", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]);
  });

  it("strips the short-context annotation and never invents a missing component", () => {
    const { models } = expectOk(parseOpenAIPricing(OPENAI_PRICING_PAGE, DAY));
    expect(models["gpt-5.5"]).toEqual({ input: 5, cacheRead: 0.5, output: 30, asOf: DAY });
    expect(models["gpt-4o-2024-05-13"]).toEqual({ input: 5, output: 15, asOf: DAY });
    expect(models["gpt-5.5-pro"].cacheRead).toBeUndefined();
  });

  it("fails when the Standard table is gone, even though Batch and Flex remain", () => {
    const page = OPENAI_PRICING_PAGE.replace("### Standard pricing data", "### Priority pricing data");
    expect(parseOpenAIPricing(page, DAY)).toEqual({ ok: false, error: "“### Standard pricing data” not found" });
  });

  it("fails on renamed, reordered or added columns", () => {
    expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace("| Model | Short context input |", "| Model | Batch input |"), DAY).ok).toBe(false);
    const reordered = OPENAI_PRICING_PAGE.replace("Short context cached input | Short context cache writes", "Short context cache writes | Short context cached input");
    expect(parseOpenAIPricing(reordered, DAY).ok).toBe(false);
    expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace("Long context output |\n| --- |", "Long context output | Notes |\n| --- | --- |"), DAY).ok).toBe(false);
  });

  it("fails on partial rows, unreadable rates, zero rates and swapped columns", () => {
    const row = "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |";
    const cases = [
      "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 |",
      "| gpt-6-sol | $2.00 | $0.20 | $2.50 | ten dollars | $4.00 | $0.40 | $5.00 | $15.00 |",
      "| gpt-6-sol | $0.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |",
      "| gpt-6-sol | $2.00 | $2.50 | $0.20 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |",
      "| gpt-6-sol | $2.00 / 1K | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |",
    ];
    for (const replacement of cases) expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace(row, replacement), DAY).ok, replacement).toBe(false);
  });

  it("fails on conflicting duplicates but accepts an identical repeat", () => {
    const row = "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |";
    expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace(row, `${row}\n${row}`), DAY).ok).toBe(true);
    const conflicting = `${row}\n| gpt-6-sol | $3.00 | $0.30 | $3.75 | $15.00 | - | - | - | - |`;
    expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace(row, conflicting), DAY)).toEqual({ ok: false, error: "Conflicting rates for gpt-6-sol" });
  });

  it("skips rows it cannot map to a model id instead of guessing", () => {
    const page = OPENAI_PRICING_PAGE.replace("| gpt-4o-2024-05-13 |", "| GPT Live (preview) |");
    const result = expectOk(parseOpenAIPricing(page, DAY));
    expect(result.skipped).toBe(1);
    expect(Object.keys(result.models)).not.toContain("gpt live");
  });

  it("rejects a page that is not the pricing page", () => {
    expect(parseOpenAIPricing("<!doctype html><html><body>Not found</body></html>", DAY).ok).toBe(false);
    expect(parseOpenAIPricing("", DAY).ok).toBe(false);
  });
});

describe("Claude pricing page", () => {
  it("maps exact display names to API ids and takes both cache-write durations", () => {
    const { models, skipped } = expectOk(parseAnthropicPricing(ANTHROPIC_PRICING_PAGE, DAY));
    expect(models["claude-opus-5-5"]).toEqual({ input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20, asOf: DAY, name: "Claude Opus 5.5" });
    // Footnote superscripts are not part of the rate.
    expect(models["claude-sonnet-5"]).toMatchObject({ input: 2, output: 10 });
    expect(models["claude-fable-5-1"]).toMatchObject({ cacheRead: 0.25 });
    expect(models["claude-mythos-5-1"]).toMatchObject({ status: "limited", input: 10 });
    expect(models["claude-opus-4-1"]).toMatchObject({ status: "retired", input: 15 });
    // Claude 3.x used a different id order (claude-3-5-haiku), so it is skipped.
    expect(models).not.toHaveProperty("claude-haiku-3-5");
    expect(skipped).toBe(1);
  });

  it("prices 1-hour cache writes at the 1-hour rate, from the page or its published 2x rule", () => {
    // Bundled rates list only the 5-minute write; the page's rule gives 2x input.
    expect(pricingForModel("claude", "claude-haiku-4-5")).toMatchObject({ cacheWriteInputPerMillion: 1.25, cacheWrite1hInputPerMillion: 2 });
    recordOfficialPricingResult("anthropic", parseAnthropicPricing(ANTHROPIC_PRICING_PAGE, DAY) as never, NOW);
    expect(pricingForModel("claude", "claude-opus-5-5")).toMatchObject({ cacheWriteInputPerMillion: 5, cacheWrite1hInputPerMillion: 8, origin: "official" });
    annotateThreadUsage("hour", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("hour", {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000, cacheWrite1hInputTokens: 750_000,
      outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null,
    }, "e", "t");
    // 250,000 five-minute writes at $5 plus 750,000 one-hour writes at $8.
    expect(usageTotals().estimatedCost).toBeCloseTo(7.25, 9);
  });

  it("never maps a new or oddly annotated model onto an older id", () => {
    expect(claudeModelId("Claude Opus 6")?.id).toBe("claude-opus-6");
    expect(claudeModelId("Claude Opus 5.5 (preview pricing)")).toBeNull();
    expect(claudeModelId("Claude 3.5 Sonnet")).toBeNull();
    expect(claudeModelId("Opus 5.5")).toBeNull();
  });

  it("fails when the model table's columns change", () => {
    expect(parseAnthropicPricing(ANTHROPIC_PRICING_PAGE.replace("| 5m cache writes | 1h cache writes |", "| 1h cache writes | 5m cache writes |"), DAY).ok).toBe(false);
    expect(parseAnthropicPricing(ANTHROPIC_PRICING_PAGE.replace("The following table shows pricing for all Claude models:", "Pricing:"), DAY).ok).toBe(false);
  });
});

describe("Cursor pricing page", () => {
  it("reads both tables, keyed by normalized display name, and never prices Auto", () => {
    const page = CURSOR_PRICING_PAGE.replace("| Grok 4.5 (Fast) ", "| Auto | Cursor | $1 | - | $0.1 | $2 | Routed |\n| Grok 4.5 (Fast) ");
    const { models } = expectOk(parseCursorPricing(page, DAY));
    expect(models["grok 4.5"]).toEqual({ input: 2, cacheRead: 0.5, output: 6, asOf: DAY, name: "Grok 4.5", vendor: "Cursor" });
    expect(models["grok 4.5 fast"]).toMatchObject({ input: 4, output: 18 });
    expect(models["claude 4.6 opus"]).toMatchObject({ input: 5, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(models["kimi k3"].cacheWrite).toBeUndefined();
    expect(models).not.toHaveProperty("auto");
  });

  it("fails when a known table's layout drifts", () => {
    expect(parseCursorPricing(CURSOR_PRICING_PAGE.replace("### Model pricing", "### Pricing"), DAY).ok).toBe(false);
    const swapped = CURSOR_PRICING_PAGE.replaceAll("| Cache write | Cache read |", "| Cache read | Cache write |");
    expect(parseCursorPricing(swapped, DAY).ok).toBe(false);
  });

  it("prices only live Cursor models whose names match a published row exactly", () => {
    recordOfficialPricingResult("cursor", parseCursorPricing(CURSOR_PRICING_PAGE, DAY) as never, NOW);
    updateCursorModelNames([
      { id: "cursor-grok-4.5", name: "Grok 4.5" },
      { id: "auto", name: "Auto" },
      // Cursor's page says "Claude 4.6 Opus"; a differently ordered name is not matched.
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    ]);
    expect(pricingForModel("cursor", "cursor-grok-4.5")).toMatchObject({ inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 6, source: "Cursor", origin: "official" });
    expect(pricingForModel("cursor", "cursor-grok-4.5")?.cacheWriteInputPerMillion).toBeUndefined();
    expect(pricingForModel("cursor", "claude-opus-5-5")).toMatchObject({ inputPerMillion: 4, cacheWriteInputPerMillion: 5 });
    expect(pricingForModel("cursor", "auto")).toBeUndefined();
    expect(pricingForModel("cursor", "claude-opus-4-6")).toBeUndefined();
    expect(pricingForModel("cursor", "unknown-id")).toBeUndefined();
    expect(pricingModelKeys()).toEqual(expect.arrayContaining(["cursor:cursor-grok-4.5", "cursor:claude-opus-5-5"]));
    expect(pricingModelKeys()).not.toContain("cursor:auto");
  });
});

describe("official rate precedence", () => {
  it("discovers a newly released model and prices its next usage", async () => {
    const page = OPENAI_PRICING_PAGE.replace("| gpt-6-astra |", "| gpt-7-nova | $3.00 | $0.30 | $3.75 | $12.00 | - | - | - | - |\n| gpt-6-astra |");
    await refreshOfficialPricing({ force: true, fetchDocument: serving({ openai: page }), now: () => NOW });
    expect(pricingForModel("openai", "gpt-7-nova")).toMatchObject({ inputPerMillion: 3, cachedInputPerMillion: 0.3, cacheWriteInputPerMillion: 3.75, outputPerMillion: 12, asOf: DAY, origin: "official" });
    expect(pricingModelKeys()).toContain("openai:gpt-7-nova");
    // Retired and limited-access models still price usage but aren't offered for comparison.
    expect(pricingForModel("claude", "claude-opus-4-1")?.inputPerMillion).toBe(15);
    expect(pricingModelKeys()).not.toContain("claude:claude-opus-4-1");
    expect(pricingModelKeys()).not.toContain("claude:claude-mythos-5-1");
  });

  it("applies a changed rate to future usage without repricing recorded usage", async () => {
    annotateThreadUsage("sol", { provider: "openai", model: "gpt-6-sol" });
    recordUsageDelta("sol", usage(1_000_000, 0), "first");
    expect(usageTotals().estimatedCost).toBe(2);
    const raised = OPENAI_PRICING_PAGE.replace("| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 |", "| gpt-6-sol | $3.00 | $0.30 | $3.75 | $15.00 |");
    await refreshOfficialPricing({ force: true, fetchDocument: serving({ openai: raised }), now: () => NOW });
    expect(usageTotals().estimatedCost).toBe(2);
    recordUsageDelta("sol", usage(1_000_000, 0), "second");
    expect(usageTotals().estimatedCost).toBe(5);
  });

  it("keeps GPT-5.6's alias in step with Sol's official rate", () => {
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-5.6-sol": { input: 6, output: 30, asOf: DAY } } }, NOW);
    expect(pricingForModel("openai", "gpt-5.6")?.inputPerMillion).toBe(6);
  });

  it("chooses per model by verification date, never by a catalog's publish date", () => {
    // A catalog published after everything else, whose entry was verified long ago.
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({
      schemaVersion: 1, updatedAt: "2026-12-01T00:00:00Z",
      models: {
        "openai:gpt-6-sol": { inputPerMillion: 9, outputPerMillion: 90, asOf: "2026-08-01" },
        "openai:gpt-6-luna": { inputPerMillion: 0.3, outputPerMillion: 1.5, asOf: "2026-11-01" },
      },
    }));
    // An official snapshot from before the bundled rates were checked.
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-sol": { input: 7, output: 70, asOf: "2026-09-01" } } }, Date.parse("2026-09-01T12:00:00Z"));
    expect(pricingForModel("openai", "gpt-6-sol")).toMatchObject({ inputPerMillion: 2, origin: "bundled" });
    // A catalog entry verified after the bundled table wins over it.
    expect(pricingForModel("openai", "gpt-6-luna")).toMatchObject({ inputPerMillion: 0.3, origin: "catalog" });
    // A later official check wins over both, and on the same day as the catalog.
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-luna": { input: 0.2, output: 1, asOf: "2026-11-01" } } }, Date.parse("2026-11-01T12:00:00Z"));
    expect(pricingForModel("openai", "gpt-6-luna")).toMatchObject({ inputPerMillion: 0.2, origin: "official" });
  });

  it("keeps a model's last verified rate when it disappears from the page, at its older date", () => {
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-7-nova": { input: 3, output: 12, asOf: "2026-10-01" } } }, Date.parse("2026-10-01T12:00:00Z"));
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-sol": { input: 2, output: 10, asOf: DAY } } }, NOW);
    expect(pricingForModel("openai", "gpt-7-nova")).toMatchObject({ inputPerMillion: 3, asOf: "2026-10-01" });
    expect(officialPricingStatus().find((status) => status.source === "openai")?.models).toBe(1);
  });

  it("drops damaged stored entries on their own", () => {
    localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-10-02T12:00:00.000Z",
      models: {
        "openai:gpt-6-sol": { inputPerMillion: "2", outputPerMillion: 10, asOf: DAY },
        "openai:gpt-6-luna": { inputPerMillion: 0, outputPerMillion: 0.5, asOf: DAY },
        "openai:gpt-6-astra": { inputPerMillion: 11, outputPerMillion: 55, asOf: "yesterday" },
        "lmstudio:local": { inputPerMillion: 1, outputPerMillion: 1, asOf: DAY },
        "openai:gpt-7-nova": { inputPerMillion: 3, outputPerMillion: 12, asOf: DAY },
      },
      sources: { openai: { checkedAt: "soon", verifiedAt: NOW, error: 42 } },
    }));
    expect(pricingForModel("openai", "gpt-6-sol")?.origin).toBe("bundled");
    expect(pricingForModel("openai", "gpt-6-luna")?.origin).toBe("bundled");
    expect(pricingForModel("openai", "gpt-6-astra")?.origin).toBe("bundled");
    expect(pricingForModel("lmstudio", "local")).toBeUndefined();
    expect(pricingForModel("openai", "gpt-7-nova")?.inputPerMillion).toBe(3);
    expect(officialPricingStatus()[0]).toMatchObject({ source: "openai", checkedAt: undefined, verifiedAt: NOW, error: undefined, models: 1 });
  });

  it("never accepts Cursor rates from the published catalog", () => {
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({
      schemaVersion: 1, updatedAt: "2026-12-01T00:00:00Z",
      models: { "cursor:grok 4.5": { inputPerMillion: 1, outputPerMillion: 1, asOf: "2026-12-01" } },
    }));
    updateCursorModelNames([{ id: "cursor-grok-4.5", name: "Grok 4.5" }]);
    expect(pricingForModel("cursor", "cursor-grok-4.5")).toBeUndefined();
  });
});

describe("official pricing refresh", () => {
  it("records each source separately and never reports a failed page as verified", async () => {
    await refreshOfficialPricing({ force: true, fetchDocument: serving(), now: () => NOW });
    const later = NOW + 60_000;
    const result = await refreshOfficialPricing({
      force: true,
      fetchDocument: serving({ anthropic: new Error("Could not reach the pricing page"), cursor: CURSOR_PRICING_PAGE.replace("### Model pricing", "## Pricing") }),
      now: () => later,
    });
    expect(result).toEqual({ checked: ["openai", "anthropic", "cursor"], failed: ["anthropic", "cursor"] });
    const status = Object.fromEntries(officialPricingStatus().map((item) => [item.source, item]));
    expect(status.openai).toMatchObject({ verifiedAt: later, checkedAt: later, error: undefined, models: 6 });
    expect(status.anthropic).toMatchObject({ verifiedAt: NOW, checkedAt: later, error: "Could not reach the pricing page" });
    expect(status.cursor).toMatchObject({ verifiedAt: NOW, checkedAt: later, error: "“### Model pricing” not found" });
    // The failed sources' last verified rates remain in use.
    expect(pricingForModel("claude", "claude-opus-5-5")?.origin).toBe("official");
  });

  it("keeps bundled rates and reports every source failed when offline", async () => {
    const offline = vi.fn(async () => { throw new Error("offline"); });
    const result = await refreshOfficialPricing({ force: true, fetchDocument: offline, now: () => NOW });
    expect(result.failed).toEqual(["openai", "anthropic", "cursor"]);
    expect(officialPricingStatus().every((status) => status.error === "offline" && !status.verifiedAt)).toBe(true);
    expect(pricingForModel("openai", "gpt-6-sol")).toMatchObject({ inputPerMillion: 2, origin: "bundled" });
  });

  it("checks at most daily on its own, sooner after a failure, and always when forced", async () => {
    const fetcher = serving({ cursor: new Error("offline") });
    await refreshOfficialPricing({ fetchDocument: fetcher, now: () => NOW });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await refreshOfficialPricing({ fetchDocument: fetcher, now: () => NOW + 30 * 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Only the failed source is retried after an hour.
    await refreshOfficialPricing({ fetchDocument: fetcher, now: () => NOW + 61 * 60_000 });
    expect(fetcher.mock.calls.slice(3).map(([source]) => source)).toEqual(["cursor"]);
    await refreshOfficialPricing({ fetchDocument: fetcher, now: () => NOW + 25 * 3_600_000 });
    expect(fetcher).toHaveBeenCalledTimes(7);
    await refreshOfficialPricing({ force: true, fetchDocument: fetcher, now: () => NOW + 25 * 3_600_000 });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("shares one run between concurrent callers", async () => {
    const fetcher = serving();
    await Promise.all([
      refreshOfficialPricing({ force: true, fetchDocument: fetcher, now: () => NOW }),
      refreshOfficialPricing({ force: true, fetchDocument: fetcher, now: () => NOW }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("honors a forced Settings refresh queued during a routine check", async () => {
    await refreshOfficialPricing({ force: true, fetchDocument: serving(), now: () => NOW });
    recordOfficialPricingResult("cursor", { ok: false, error: "offline" }, NOW - 2 * 3_600_000);
    let release!: () => void;
    const routineFetcher = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return CURSOR_PRICING_PAGE;
    });
    const routine = refreshOfficialPricing({ fetchDocument: routineFetcher, now: () => NOW + 60_000 });
    await Promise.resolve();
    expect(routineFetcher).toHaveBeenCalledExactlyOnceWith("cursor");
    const forcedFetcher = serving();
    const forced = refreshOfficialPricing({ force: true, fetchDocument: forcedFetcher, now: () => NOW + 60_000 });
    release();
    await Promise.all([routine, forced]);
    expect(forcedFetcher.mock.calls.map(([source]) => source)).toEqual(["openai", "anthropic", "cursor"]);
  });

  it("rejects a page that suddenly lists far fewer models, keeping the previous rates", async () => {
    await refreshOfficialPricing({ force: true, fetchDocument: serving(), now: () => NOW });
    const truncated = OPENAI_PRICING_PAGE.replace(/\| gpt-6-sol \|[^\n]*\n\| gpt-5\.6-sol[^\n]*\n\| gpt-5\.5 [^\n]*\n\| gpt-5\.5-pro[^\n]*\n/, "");
    const result = await refreshOfficialPricing({ force: true, fetchDocument: serving({ openai: truncated }), now: () => NOW + 1 });
    expect(result.failed).toContain("openai");
    expect(pricingForModel("openai", "gpt-5.5")).toMatchObject({ inputPerMillion: 5, origin: "official" });
  });
});
