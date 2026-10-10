import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_PRICING_PAGE, CURSOR_PRICING_PAGE, OPENAI_PRICING_PAGE } from "../test/pricingPages";
import { frontierPricingSnapshot, refreshFrontierPricing } from "./frontierPricing";
import { parseAnthropicPricing, parseOpenAIPricing, recordOfficialPricingResult, refreshOfficialPricing } from "./officialPricing";
import { resetStorageMemoryForTests } from "./storage";
import { OFFICIAL_PRICING_KEY, resetUsageLedgerCache } from "./usageLedger";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = "2026-10-09";
const pages = { openai: OPENAI_PRICING_PAGE, anthropic: ANTHROPIC_PRICING_PAGE, cursor: CURSOR_PRICING_PAGE };

beforeEach(() => {
  localStorage.clear();
  resetStorageMemoryForTests();
  resetUsageLedgerCache();
});

describe("frontier official API pricing catalog", () => {
  it("starts empty without claiming bundled prices are verified", () => {
    expect(frontierPricingSnapshot()).toMatchObject({ entries: [], checking: false });
    expect(frontierPricingSnapshot().providers.every((provider) => !provider.verifiedAt)).toBe(true);
  });

  it("shows standard published cache prices, both Anthropic durations and separate long-context rates", async () => {
    await refreshOfficialPricing({ force: true, fetchDocument: async (source) => pages[source], now: () => NOW });
    const snapshot = frontierPricingSnapshot();
    expect(snapshot.entries.find((entry) => entry.id === "gpt-6-sol")).toMatchObject({
      provider: "openai", inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2,
      cacheWriteInputPerMillion: 2.5, longContext: { inputPerMillion: 4, outputPerMillion: 15, cacheWriteInputPerMillion: 5 },
    });
    expect(snapshot.entries.find((entry) => entry.id === "claude-opus-5-5")).toMatchObject({
      name: "Claude Opus 5.5", cacheWriteInputPerMillion: 5, cacheWrite1hInputPerMillion: 8,
    });
    const legacy = snapshot.entries.find((entry) => entry.id === "gpt-5.5")!;
    expect(legacy.cacheWriteInputPerMillion).toBeUndefined();
    expect(legacy.longContext?.cacheWriteInputPerMillion).toBeUndefined();
    expect(snapshot.entries.some((entry) => entry.id.includes("@") || entry.provider as string === "cursor")).toBe(false);
    expect(snapshot.providers.every((provider) => provider.verifiedAt === NOW)).toBe(true);
  });

  it("preserves successful dates and data on a partial-provider failure", async () => {
    await refreshOfficialPricing({ force: true, fetchDocument: async (source) => pages[source], now: () => NOW });
    const next = NOW + 30_000;
    await refreshOfficialPricing({ force: true, now: () => next, fetchDocument: async (source) => {
      if (source === "anthropic") throw new Error("offline");
      return pages[source];
    } });
    const snapshot = frontierPricingSnapshot();
    expect(snapshot.providers.find((source) => source.provider === "anthropic")).toMatchObject({ verifiedAt: NOW, checkedAt: next, error: "offline" });
    expect(snapshot.providers.find((source) => source.provider === "openai")).toMatchObject({ verifiedAt: next, error: undefined });
    expect(snapshot.entries.some((entry) => entry.id === "claude-opus-5-5")).toBe(true);
  });

  it("uses the exact last successful list after same-day model removals", () => {
    const rate = { input: 2, output: 10, asOf: DAY };
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-sol": rate, "gpt-6-luna": rate } }, NOW);
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-sol": rate } }, NOW + 1);
    expect(frontierPricingSnapshot().entries.map((entry) => entry.id)).toEqual(["gpt-6-sol"]);
  });

  it("revalidates persisted rates and refuses malformed or implausible values", () => {
    for (const amount of [null, "2", 0, -1, 100_001]) {
      localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({
        schemaVersion: 1, updatedAt: new Date(NOW).toISOString(), models: {},
        sources: { openai: { verifiedAt: NOW, catalog: { "gpt-6-sol": { input: amount, output: 10, asOf: DAY } } } },
      }));
      expect(frontierPricingSnapshot().entries, String(amount)).toEqual([]);
    }
  });

  it("rejects changed long-context columns and incomplete or conflicting long prices", () => {
    const row = "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |";
    for (const replacement of [
      row.replace("$4.00", "$0.00"), row.replace("$15.00", "-"),
      `${row}\n${row.replace("$4.00", "$8.00")}`,
    ]) {
      expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace(row, replacement), DAY, { includeLongContext: true }).ok).toBe(false);
    }
    expect(parseOpenAIPricing(OPENAI_PRICING_PAGE.replace("Long context input", "Unknown context input"), DAY, { includeLongContext: true }).ok).toBe(false);
  });

  it("reads explicitly annotated Haiku prompt-price tiers without entering an inaccurate ledger rate", async () => {
    const rows = `| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |`;
    // Append inside the pricing table, rather than below its closing paragraph.
    const priced = ANTHROPIC_PRICING_PAGE.replace("| Claude Haiku 4.5", `${rows}\n| Claude Haiku 4.5`);
    const result = parseAnthropicPricing(priced, DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models["claude-haiku-5-5"]).toMatchObject({ input: 0.1, output: 0.5, cacheWrite: 0.125,
      longContext: { input: 0.5, output: 2.5, cacheWrite: 0.625 }, longContextThresholdTokens: 100_000 });
    expect(parseAnthropicPricing(priced.replace("over 100,000", "over 200,000"), DAY).ok).toBe(false);
    await refreshOfficialPricing({ force: true, now: () => NOW, fetchDocument: async (source) => source === "anthropic" ? priced : pages[source] });
    expect(frontierPricingSnapshot().entries.find((entry) => entry.id === "claude-haiku-5-5")).toMatchObject({ inputPerMillion: 0.1, longContextThresholdTokens: 100_000 });
    const stored = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    expect(stored.models["claude:claude-haiku-5-5"]).toBeUndefined();
    expect(stored.epochs["claude:claude-haiku-5-5"]).toBeUndefined();
  });

  it("scopes supplementary standard tables without affecting existing usage pricing or including Fast prices", async () => {
    const header = OPENAI_PRICING_PAGE.split("### Standard pricing data\n\n")[1].split("\n").slice(0, 2).join("\n");
    const page = `${OPENAI_PRICING_PAGE}\nCyber models\nPrices per 1M tokens.\n### Grouped Pricing Table data\n${header}
| gpt-5.6-cyber | $12.50 | $1.25 | $15.625 | $75 | - | - | - | - |
Life sciences models\nPrices per 1M tokens.\n### Grouped Pricing Table data
| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| gpt-rosalind-research | $5 | $0.50 | $25 |
Multimodal models
Specialized models\nPrices per 1M tokens.\nStandard\n### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14 |
| Moderation | omni-moderation-latest | Free | - | - |
Fast\n### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $0.35 | $28 |`;
    const result = parseOpenAIPricing(page, DAY, { includeCatalogDetails: true, includeLongContext: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.models["gpt-5.6-cyber"]).toMatchObject({ input: 12.5, cacheWrite: 15.625 });
    expect(result.models["gpt-rosalind-research"]).toMatchObject({ input: 5, output: 25 });
    expect(result.models["gpt-5.3-codex"]).toMatchObject({ input: 1.75, output: 14 });
    expect(result.models["omni-moderation-latest"]).toBeUndefined();
    expect(parseOpenAIPricing(page.replace("Prices per 1M tokens.\nStandard", "Prices per 1M tokens.\nBatch"), DAY, { includeCatalogDetails: true }).ok).toBe(false);
    await refreshOfficialPricing({ force: true, now: () => NOW, fetchDocument: async (source) => source === "openai" ? page : pages[source] });
    expect(frontierPricingSnapshot().entries.find((entry) => entry.id === "gpt-5.3-codex")).toMatchObject({ inputPerMillion: 1.75 });
    const stored = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    expect(stored.models["openai:gpt-5.3-codex"]).toBeUndefined();
    expect(stored.models["openai:gpt-5.6-cyber"]).toBeUndefined();
  });

  it("rejects corrupt timestamp or tier metadata without recovering removed historical rows", () => {
    const rate = { input: 2, output: 10, asOf: DAY };
    recordOfficialPricingResult("openai", { ok: true, models: { "gpt-6-sol": rate } }, NOW);
    const stored = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    stored.sources.openai.catalog["gpt-6-sol"].serviceTier = "unknown-batch";
    localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify(stored));
    expect(frontierPricingSnapshot().entries).toEqual([]);
    stored.sources.openai.verifiedAt = 1e100;
    localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify(stored));
    expect(frontierPricingSnapshot().providers.find((provider) => provider.provider === "openai")?.verifiedAt).toBeUndefined();
  });

  it("does not trust source catalogs outside the recognized stored envelope", () => {
    const stored = {
      schemaVersion: 1, updatedAt: new Date(NOW).toISOString(), models: {},
      sources: { openai: { verifiedAt: NOW, catalog: { "gpt-6-sol": { input: 2, output: 10, asOf: DAY } } } },
    };
    for (const invalid of [{ schemaVersion: 999 }, { updatedAt: "garbage" }, { models: [] }, { models: null }]) {
      localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({ ...stored, ...invalid }));
      const snapshot = frontierPricingSnapshot();
      expect(snapshot.entries, JSON.stringify(invalid)).toEqual([]);
      expect(snapshot.providers.every((provider) => !provider.verifiedAt)).toBe(true);
    }
  });

  it("rejects rows dated after their observation, including nested bands", () => {
    const rate = { input: 2, output: 10, asOf: DAY };
    for (const invalid of [
      { ...rate, asOf: "2099-01-01" },
      { ...rate, longContext: { ...rate, asOf: "2099-01-01" }, longContextThresholdTokens: 272_000 },
    ]) {
      localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({
        schemaVersion: 1, updatedAt: new Date(NOW).toISOString(), models: {},
        sources: { openai: { verifiedAt: NOW, catalog: { "gpt-6-sol": invalid } } },
      }));
      expect(frontierPricingSnapshot().entries).toEqual([]);
      expect(frontierPricingSnapshot().providers.find((provider) => provider.provider === "openai")?.error).toMatch(/invalid/);
    }
  });

  it("shows published legacy Claude rows only in the reference catalog", async () => {
    await refreshOfficialPricing({ force: true, now: () => NOW, fetchDocument: async (source) => pages[source] });
    expect(frontierPricingSnapshot().entries.find((entry) => entry.id === "claude-3-5-haiku")).toMatchObject({
      name: "Claude Haiku 3.5", status: "retired", inputPerMillion: 0.8, outputPerMillion: 4,
      cachedInputPerMillion: 0.08, cacheWriteInputPerMillion: 1, cacheWrite1hInputPerMillion: 1.6,
    });
    const stored = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    expect(stored.models).not.toHaveProperty("claude:claude-3-5-haiku");
    expect(stored.epochs).not.toHaveProperty("claude:claude-3-5-haiku");
  });

  it("keeps dated legacy snapshots and valid catalog-only stores readable after a failed check", () => {
    localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify({
      schemaVersion: 1, updatedAt: new Date(NOW).toISOString(),
      models: { "openai:gpt-6-sol": { inputPerMillion: 2, outputPerMillion: 10, asOf: "2026-10-08" } },
      sources: { openai: { verifiedAt: NOW } },
    }));
    expect(frontierPricingSnapshot().entries[0]).toMatchObject({ id: "gpt-6-sol", asOf: "2026-10-08" });
    recordOfficialPricingResult("openai", { ok: false, error: "offline" }, NOW + 1);
    expect(frontierPricingSnapshot().entries[0]).toMatchObject({ id: "gpt-6-sol", asOf: "2026-10-08" });
    const catalog = parseAnthropicPricing(ANTHROPIC_PRICING_PAGE, DAY, { includeCatalogDetails: true });
    if (!catalog.ok) throw new Error(catalog.error);
    const legacy = { "claude-3-5-haiku": catalog.models["claude-3-5-haiku"] };
    recordOfficialPricingResult("anthropic", { ok: true, models: legacy }, NOW);
    recordOfficialPricingResult("anthropic", { ok: false, error: "offline" }, NOW + 1);
    expect(frontierPricingSnapshot().entries.find((entry) => entry.id === "claude-3-5-haiku")).toMatchObject({ name: "Claude Haiku 3.5" });
    expect(JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!).models).not.toHaveProperty("claude:claude-3-5-haiku");
  });

  it("manual refresh shares an in-progress forced official request", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetchDocument = vi.fn(async (source: keyof typeof pages) => { await waiting; return pages[source]; });
    const existing = refreshOfficialPricing({ force: true, fetchDocument, now: () => NOW });
    const manual = refreshFrontierPricing();
    expect(manual).toBe(existing);
    release();
    await manual;
    expect(fetchDocument).toHaveBeenCalledTimes(3);
  });

  it("preserves future-dated rates and provenance while warning after a backward clock correction", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const future = Date.parse("2099-01-01T12:00:00Z");
    await refreshOfficialPricing({ force: true, now: () => future, fetchDocument: async (source) => pages[source] });
    const rawBefore = localStorage.getItem(OFFICIAL_PRICING_KEY)!;
    const futureSnapshot = frontierPricingSnapshot();
    expect(futureSnapshot.entries.some((entry) => entry.asOf === "2099-01-01")).toBe(true);
    expect(futureSnapshot.providers.every((provider) => provider.verificationTimeUncertain && provider.checkedTimeUncertain)).toBe(true);
    expect(localStorage.getItem(OFFICIAL_PRICING_KEY)).toBe(rawBefore);
    const offline = vi.fn(async () => { throw new Error("offline"); });
    const checked = await refreshOfficialPricing({ now: () => NOW, fetchDocument: offline });
    expect(checked.checked).toEqual(["openai", "anthropic", "cursor"]);
    expect(offline).toHaveBeenCalledTimes(3);
    const failed = frontierPricingSnapshot();
    expect(failed.entries).toEqual(futureSnapshot.entries);
    expect(failed.providers.every((provider) => provider.verificationTimeUncertain && !provider.checkedTimeUncertain
      && provider.verifiedAt === future && provider.checkedAt === NOW && provider.error === "offline")).toBe(true);
    const after = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    expect(after.epochs).toEqual(JSON.parse(rawBefore).epochs);
    expect(after.sources.openai.catalog).toEqual(JSON.parse(rawBefore).sources.openai.catalog);
    await refreshOfficialPricing({ force: true, now: () => NOW, fetchDocument: async (source) => pages[source] });
    const corrected = frontierPricingSnapshot();
    expect(corrected.providers.every((provider) => !provider.verificationTimeUncertain && !provider.checkedTimeUncertain
      && provider.verifiedAt === NOW && !provider.error)).toBe(true);
    expect(corrected.entries.every((entry) => entry.asOf === DAY)).toBe(true);
    expect(JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!).epochs).toEqual(after.epochs);
  });

  it("tolerates at most five minutes of forward clock skew and flags each timestamp independently", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await refreshOfficialPricing({ force: true, now: () => NOW + 5 * 60_000, fetchDocument: async (source) => pages[source] });
    expect(frontierPricingSnapshot().providers.every((provider) => !provider.verificationTimeUncertain && !provider.checkedTimeUncertain)).toBe(true);
    const fetcher = vi.fn(async (source: keyof typeof pages) => pages[source]);
    await refreshOfficialPricing({ now: () => NOW, fetchDocument: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    recordOfficialPricingResult("openai", { ok: false, error: "offline" }, NOW + 5 * 60_000 + 1);
    expect(frontierPricingSnapshot().providers.find((provider) => provider.provider === "openai")).toMatchObject({
      verificationTimeUncertain: false, checkedTimeUncertain: true,
    });
    await refreshOfficialPricing({ now: () => NOW, fetchDocument: fetcher });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("openai");
    expect(frontierPricingSnapshot().providers.find((provider) => provider.provider === "openai")).toMatchObject({
      verificationTimeUncertain: false, checkedTimeUncertain: false,
    });
  });
});
