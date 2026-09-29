import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import type { TokenUsageView } from "../components/StudioDock";
import { UsageCalendarCard } from "../components/UsageCalendar";
import { buildUsageCalendar, formatDayShare } from "./usageCalendar";
import { emptyComponentAmounts, localDayKey, type UsageBucket, type UsageComponentAmounts } from "./usageHistory";
import {
  annotateThreadUsage, flushUsageLedger, recordAuxiliaryUsage, recordUsageDelta,
  resetUsageLedgerCache, USAGE_LEDGER_KEY, type UsageProvider,
} from "./usageLedger";
import { usageDetail } from "./usageSummary";

const today = "2026-09-29";
const history = { startedDay: "2026-09-01" };

function bucket(provider: UsageProvider, model: string, totalTokens: number, amounts: Partial<UsageComponentAmounts> = {}): UsageBucket {
  return { day: today, provider, model, ...emptyComponentAmounts(), ...amounts, totalTokens };
}

function usage(inputTokens: number, outputTokens: number): TokenUsageView {
  return {
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
    contextWindow: null, cacheReadReported: true, cacheWriteReported: true,
    serviceTier: "standard", serviceTierSource: "requested",
  };
}

describe("usage calendar independent accounting checks", () => {
  it("uses one whole-day denominator across providers and keeps shared model IDs separate", () => {
    const calendar = buildUsageCalendar([
      bucket("openai", "same-model", 500), bucket("openai", "same-model", 100),
      bucket("openai", "another-model", 100), bucket("claude", "same-model", 300),
    ], today, history);
    const day = calendar.days.get(today)!;
    expect(day.totalTokens).toBe(1_000);
    expect(day.providers).toEqual([
      { provider: "openai", totalTokens: 700, models: [{ model: "same-model", totalTokens: 600 }, { model: "another-model", totalTokens: 100 }] },
      { provider: "claude", totalTokens: 300, models: [{ model: "same-model", totalTokens: 300 }] },
    ]);
    expect(day.providers.flatMap((provider) => provider.models.map((model) => formatDayShare(model.totalTokens, day.totalTokens))))
      .toEqual(["60.0%", "10.0%", "30.0%"]);
  });

  it("preserves recorded totals when cache/reasoning are subsets and when only a total was reported", () => {
    const calendar = buildUsageCalendar([
      bucket("claude", "claude-opus-5-5", 1_300, {
        uncachedInputTokens: 300, cacheReadTokens: 400, cacheWriteTokens: 300,
        cacheWrite1hTokens: 200, outputTokens: 300, reasoningOutputTokens: 250,
      }),
      bucket("cursor", "auto", 120),
    ], today, history);
    const day = calendar.days.get(today)!;
    expect(day.totalTokens).toBe(1_420);
    expect(calendar.totalTokens).toBe(1_420);
    expect(day.providers.find((provider) => provider.provider === "cursor")?.models).toEqual([{ model: "auto", totalTokens: 120 }]);
  });

  it("keeps every provider and model, including unknown attribution and unreported model IDs", () => {
    const providers: UsageProvider[] = ["openai", "claude", "openrouter", "cursor", "lmstudio", "unknown"];
    const buckets = providers.flatMap((provider) => [
      bucket(provider, "", 1), bucket(provider, "unattributed", 2),
      ...Array.from({ length: 20 }, (_, index) => bucket(provider, `custom/model-${index}`, index + 3)),
    ]);
    const day = buildUsageCalendar(buckets, today, history).days.get(today)!;
    expect(new Set(day.providers.map((provider) => provider.provider))).toEqual(new Set(providers));
    for (const provider of day.providers) {
      expect(provider.models).toHaveLength(22);
      expect(provider.models.some((model) => model.model === "")).toBe(true);
      expect(provider.models.some((model) => model.model === "unattributed")).toBe(true);
    }
    expect(day.totalTokens).toBe(buckets.reduce((total, item) => total + item.totalTokens, 0));
  });

  it("distinguishes empty recorded days from pre-tracking and retained-out history", () => {
    const calendar = buildUsageCalendar([], today, { startedDay: "2026-09-15", retainedFrom: "2026-09-20" }, 4);
    expect(calendar.days.get("2026-09-14")).toMatchObject({ state: "unavailable", unavailableReason: "before-tracking" });
    expect(calendar.days.get("2026-09-19")).toMatchObject({ state: "unavailable", unavailableReason: "past-retention" });
    expect(calendar.days.get("2026-09-20")).toMatchObject({ state: "empty", totalTokens: 0 });
    expect(calendar.weeks.at(-1)!.slice(2)).toEqual([null, null, null, null, null]);
  });

  it("iterates local calendar dates through a leap day and DST without skipping dates", () => {
    const leap = buildUsageCalendar([], "2028-03-01", { startedDay: "2028-02-21" }, 2);
    expect([...leap.days.keys()]).toEqual([
      "2028-02-21", "2028-02-22", "2028-02-23", "2028-02-24", "2028-02-25", "2028-02-26", "2028-02-27",
      "2028-02-28", "2028-02-29", "2028-03-01",
    ]);
    const dst = buildUsageCalendar([], "2026-11-03", { startedDay: "2026-10-26" }, 2);
    expect([...dst.days.keys()]).toEqual([
      "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
      "2026-11-02", "2026-11-03",
    ]);
    expect(localDayKey(new Date(2026, 10, 1, 23, 59))).toBe("2026-11-01");
  });

  it("does not label tiny positive shares as zero or nearly complete shares as complete", () => {
    expect(formatDayShare(1, 1_000_000)).toBe("<0.1%");
    expect(formatDayShare(999_999, 1_000_000)).toBe(">99.9%");
    expect(formatDayShare(1_000_000, 1_000_000)).toBe("100.0%");
    expect(formatDayShare(0, 0)).toBe("0.0%");
  });
});

describe("usage calendar guarded recording integration", () => {
  beforeEach(() => {
    resetUsageLedgerCache();
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 10));
  });
  afterEach(() => {
    resetUsageLedgerCache();
    vi.useRealTimers();
  });

  it("includes supplied helper tokens without assigning unavailable reports an invented token count", () => {
    recordAuxiliaryUsage({ executionId: "title", provider: "openai", model: "gpt-6-luna", purpose: "thread-title", usage: usage(100, 20) });
    recordAuxiliaryUsage({ executionId: "no-report", provider: "claude", model: "claude-opus-5-5", purpose: "run-discovery", usage: null });
    const detail = usageDetail(null);
    const day = buildUsageCalendar(detail.buckets, today, detail).days.get(today)!;
    expect(day.totalTokens).toBe(120);
    expect(day.providers).toEqual([{ provider: "openai", totalTokens: 120, models: [{ model: "gpt-6-luna", totalTokens: 120 }] }]);
    expect(detail.totals.turns).toBe(0);
  });

  it("keeps a cross-midnight turn on its first recorded local day after reload", () => {
    annotateThreadUsage("late", { provider: "claude", model: "claude-opus-5-5" });
    vi.setSystemTime(new Date(2026, 8, 28, 23, 59));
    recordUsageDelta("late", usage(100, 20), "assistant", "turn");
    flushUsageLedger();
    resetUsageLedgerCache();
    vi.setSystemTime(new Date(2026, 8, 29, 0, 1));
    recordUsageDelta("late", usage(200, 40), "result", "turn");
    recordUsageDelta("late", usage(50, 10), "new-assistant", "new-turn");
    const detail = usageDetail(null);
    const calendar = buildUsageCalendar(detail.buckets, today, detail);
    expect(calendar.days.get("2026-09-28")?.totalTokens).toBe(360);
    expect(calendar.days.get(today)?.totalTokens).toBe(60);
    expect(calendar.totalTokens).toBe(420);
  });

  it("does not place undated legacy totals on a calendar day", () => {
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([{ threadId: "legacy", provider: "claude", model: "claude-opus-5-5", usage: usage(500, 100), updatedAt: Date.now() }]));
    resetUsageLedgerCache();
    const detail = usageDetail(null);
    expect(detail.totals.totalTokens).toBe(600);
    const calendar = buildUsageCalendar(detail.buckets, today, detail);
    expect(calendar.totalTokens).toBe(0);
    expect(calendar.days.get(today)).toMatchObject({ state: "unavailable", unavailableReason: "before-tracking" });
  });

  it("hides inconsistent dated detail instead of presenting suppressed tokens as measured zero days", () => {
    annotateThreadUsage("ahead", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("ahead", usage(100, 20), "assistant", "turn");
    flushUsageLedger();
    const ledger = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ usage: TokenUsageView; estimatedCost: number; pricedTokens: number; unpricedTokens: number }>;
    ledger[0].usage = usage(50, 10);
    ledger[0].estimatedCost = 0;
    ledger[0].pricedTokens = 0;
    ledger[0].unpricedTokens = 60;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(ledger));
    resetUsageLedgerCache();
    const detail = usageDetail(null);
    expect(detail.detailAhead).toBe(true);
    expect(detail.buckets).toEqual([]);
    render(createElement(UsageCalendarCard, {
      source: { detail: usageDetail, reported: () => ({ cost: 0, requests: 0 }) },
      revision: 0, today, range: null,
      providerLabel: (provider) => provider, modelLabel: (model) => model,
    }));
    expect(screen.getByText("Dated detail is hidden until it agrees with saved totals.")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-day]")).toHaveLength(0);
  });
});
