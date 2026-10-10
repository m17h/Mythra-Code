import { describe, expect, it } from "vitest";
import type { FrontierPricingEntry } from "./frontierPricing";
import { compactionPriceBoundary, compactionPricingEntry, describeCompactionPriceBoundary, modelCompactionWindows } from "./modelCompactionPricing";

const SOL: FrontierPricingEntry = { id: "gpt-6.1-sol", name: "Sol 6.1", provider: "openai", asOf: "2026-10-09", inputPerMillion: 2, outputPerMillion: 10,
  longContext: { inputPerMillion: 4, outputPerMillion: 15 }, longContextThresholdTokens: 272_000 };
const HAIKU: FrontierPricingEntry = { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", asOf: "2026-10-09", inputPerMillion: .1, outputPerMillion: .5,
  longContext: { inputPerMillion: .5, outputPerMillion: 2.5 }, longContextThresholdTokens: 100_000 };
const OPUS: FrontierPricingEntry = { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", asOf: "2026-10-09", inputPerMillion: 4, outputPerMillion: 20 };
const ENTRIES = [SOL, HAIKU, OPUS];

describe("model-specific compaction pricing guidance", () => {
  it("offers the selected model's published boundary, never a flat provider threshold", () => {
    expect(modelCompactionWindows(compactionPricingEntry("openai", "gpt-6.1-sol", ENTRIES))).toEqual([200_000, 272_000, 500_000, 1_000_000]);
    expect(modelCompactionWindows(compactionPricingEntry("claude", "claude-haiku-5-5", ENTRIES))).toEqual([100_000, 200_000, 500_000, 1_000_000]);
    expect(modelCompactionWindows(compactionPricingEntry("claude", "claude-opus-5-5", ENTRIES))).toEqual([200_000, 500_000, 1_000_000]);
    expect(modelCompactionWindows(compactionPricingEntry("openai", "gpt-custom", ENTRIES))).toEqual([200_000, 500_000, 1_000_000]);
  });

  it("uses the refreshed catalog's exact model rule rather than hardcoding 100K or 272K", () => {
    const updated = { ...SOL, longContextThresholdTokens: 300_000 };
    expect(modelCompactionWindows(compactionPricingEntry("openai", SOL.id, [updated]))).toEqual([200_000, 300_000, 500_000, 1_000_000]);
    expect(modelCompactionWindows(compactionPricingEntry("openai", SOL.id, []))).not.toContain(272_000);
    expect(modelCompactionWindows({ ...HAIKU, longContextThresholdTokens: 200_000 })).toEqual([200_000, 500_000, 1_000_000]);
  });

  it("resolves dated ids and explicit runtime aliases, not floating-name guesses or other providers", () => {
    expect(compactionPricingEntry("openai", "gpt-6.1-sol-2026-10-09", ENTRIES)).toBe(SOL);
    expect(compactionPricingEntry("claude", "claude-haiku-5-5-20261009[1m]", ENTRIES)).toBe(HAIKU);
    expect(compactionPricingEntry("claude", "haiku", ENTRIES)).toBeUndefined();
    expect(compactionPricingEntry("claude", "haiku", ENTRIES, "claude-haiku-5-5")).toBe(HAIKU);
    expect(compactionPricingEntry("claude", "haiku", ENTRIES, "claude-haiku-4-5")).toBeUndefined();
    expect(compactionPricingEntry("openai", "gpt-6.1-sol-custom", ENTRIES)).toBeUndefined();
    expect(compactionPricingEntry("claude", "claude-haiku-5-50", ENTRIES)).toBeUndefined();
    expect(compactionPricingEntry("claude", "claude-haiku-5-5-custom", ENTRIES)).toBeUndefined();
    expect(compactionPricingEntry("openrouter", "claude-haiku-5-5", ENTRIES)).toBeUndefined();
    expect(compactionPricingEntry("openai", "claude-haiku-5-5", ENTRIES)).toBeUndefined();
  });

  it("does not confuse an unknown boundary with no listed long-context increase", () => {
    expect(describeCompactionPriceBoundary(OPUS)).toContain("does not list a long-context price increase");
    expect(describeCompactionPriceBoundary({ ...SOL, longContextThresholdTokens: undefined })).toContain("boundary is unavailable");
    expect(describeCompactionPriceBoundary(undefined)).toContain("No published API price boundary");
    expect(describeCompactionPriceBoundary(HAIKU)).toContain("above 100K input tokens");
    expect(describeCompactionPriceBoundary(SOL)).toContain("above 272K input tokens");
  });

  it("only annotates usable thresholds with corresponding published rates", () => {
    for (const longContextThresholdTokens of [NaN, Infinity, 0, 99_999, 272_000.5, 1_000_001]) {
      expect(compactionPriceBoundary({ ...SOL, longContextThresholdTokens })).toBeUndefined();
    }
    expect(compactionPriceBoundary({ ...SOL, longContext: undefined })).toBeUndefined();
  });
});
