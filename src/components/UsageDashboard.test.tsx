import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard, modelLabel } from "./UsageDashboard";
import { previewUsageSource } from "./usageDashboardPreview";
import { legacyLedgerRecords, seedUsageDashboard } from "../test/usageFixture";
import {
  annotateThreadUsage, recordOpenRouterCharge, flushUsageLedger, formatEstimatedCost, resetUsageLedgerCache,
  recordUsageDelta, updateCursorModelNames, usageTotals, USAGE_LEDGER_KEY,
} from "../lib/usageLedger";
import { recordOfficialPricingResult } from "../lib/officialPricing";
import { localDayKey, shiftDayKey, USAGE_HISTORY_KEY } from "../lib/usageHistory";
import { componentCost, usageDetail } from "../lib/usageSummary";

const summary = () => screen.getByRole("group", { name: /^Summary/ });
const stat = (label: string) => within(summary()).getByText(label).parentElement!;
const approx = (value: number) => `≈ ${formatEstimatedCost(value)}`;
const openView = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const cells = (table: HTMLElement, row: string) => [...within(table).getByRole("rowheader", { name: new RegExp(`^${row}(?![a-z ])`) }).closest("tr")!.querySelectorAll("td")].map((cell) => cell.textContent);
const typeTable = () => screen.getByRole("table", { name: "Tokens and estimated cost by type, all models" });

describe("local usage dashboard", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

  it("distinguishes no data from zero-dollar receipts", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Your usage story starts here")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(screen.getByText("No usage in this range")).toBeInTheDocument();
    const receipts = screen.getByRole("group", { name: "OpenRouter reported charges" });
    expect(receipts).toHaveTextContent("No cost receipts captured yet—");
    act(() => { recordOpenRouterCharge("free", 0); flushUsageLedger(); });
    expect(receipts).toHaveTextContent("$0.00");
    expect(receipts).toHaveTextContent("1 captured request");
  });

  it("opens on the last 30 days with an at-a-glance overview", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    expect(screen.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    const expected = usageDetail({ from: shiftDayKey(localDayKey(), -29), to: localDayKey() });
    expect(stat("Estimated API cost")).toHaveTextContent(approx(expected.totals.estimatedCost));
    expect(stat("Tokens")).toHaveTextContent("5.8M");
    // 13 prompts; the Cursor Auto and OpenRouter ones have no rate, so cost
    // per prompt divides only the fully priced model-days by their 11 prompts.
    expect(stat("Per prompt")).toHaveTextContent("13 prompts · cost from the 11 fully priced");
    expect(stat("Cache reads")).toHaveTextContent("25% of input");
    // A daily trend with an accessible table, and provider shares.
    expect(screen.getByRole("region", { name: "Daily estimated cost" })).toBeInTheDocument();
    const trend = screen.getByRole("table", { name: /^Daily estimated cost/ });
    expect(within(trend).getAllByRole("row")).toHaveLength(31);
    const providers = screen.getByRole("table", { name: "Estimated cost and tokens by provider" });
    expect(cells(providers, "Cursor")).toEqual(["Unpriced", "370K6% of tokens"]);
  });

  it("anchors all-time totals to the ledger and keeps earlier usage under its known provider", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    const totals = usageTotals();
    expect(stat("Estimated API cost")).toHaveTextContent(approx(totals.estimatedCost));
    expect(screen.getByRole("note")).toHaveTextContent("1,960,000 earlier tokens are counted in totals and under their provider where it’s known, but can’t be split by date, model, or prompt");
    const providers = screen.getByRole("table", { name: "Estimated cost and tokens by provider" });
    // OpenAI's all-time row adds its undated $8.50 to its dated models.
    const openaiDated = usageDetail({ from: "2000-01-01", to: localDayKey() }).providers.find((provider) => provider.provider === "openai")!;
    expect(cells(providers, "OpenAI / Codex")[0]).toContain(approx(8.5 + componentCost(openaiDated)));
    expect(within(providers).getByRole("rowheader", { name: /^OpenAI \/ Codex/ })).toHaveTextContent("Includes earlier usage");
    // Usage that never had a provider label is never assigned to one.
    expect(within(providers).getByRole("rowheader", { name: /^Unattributed/ })).toHaveTextContent("No saved provider label");
    expect(cells(providers, "Unattributed")[0]).toBe("Unpriced");

    // The exact figures are in Models: every token type includes earlier
    // usage's known split, and the total matches the ledger.
    openView("Models");
    const table = typeTable();
    expect(cells(table, "Total")[0]).toContain(totals.totalTokens.toLocaleString());
    expect(cells(table, "Total")[1]).toContain(approx(totals.estimatedCost));
    const dated = usageDetail({ from: "2000-01-01", to: localDayKey() }).detailTotals;
    // Legacy cache reads: 500,000 (OpenAI) + 200,000 (Claude).
    expect(cells(table, "Cache read")[0]).toContain((dated.cacheReadTokens + 700_000).toLocaleString());
    // Earlier usage's cost is shown in total only, and the per-type cost
    // coverage says so rather than implying every token is in the type's cost.
    expect(cells(table, "Earlier usage")).toEqual(["1,960,000included above", approx(10.75), "—"]);
    const coverage = Math.round(dated.cacheReadTokens * 1 / (dated.cacheReadTokens + 700_000) * 100);
    expect(Number(cells(table, "Cache read")[2]!.replace("%", ""))).toBeLessThanOrEqual(coverage);
  });

  it("labels a cost-only ledger gap as a pricing adjustment, with no earlier tokens", () => {
    annotateThreadUsage("adjusted", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("adjusted", {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null,
    }, "a", "turn-1");
    flushUsageLedger();
    // The corrected ledger reached storage, but dated detail still has the
    // original $4 estimate. No token count changed.
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ estimatedCost?: number }>;
    records[0].estimatedCost = (records[0].estimatedCost ?? 0) + 2;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    resetUsageLedgerCache();

    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(stat("Estimated API cost")).toHaveTextContent("≈ $6.00");
    expect(screen.getByRole("note")).toHaveTextContent("A pricing adjustment is included in all-time and provider cost");
    expect(screen.getByRole("note")).not.toHaveTextContent("0 earlier tokens");
    const providers = screen.getByRole("table", { name: "Estimated cost and tokens by provider" });
    expect(within(providers).getByRole("rowheader", { name: /^Claude Code/ })).toHaveTextContent("Includes pricing adjustment");
    expect(cells(providers, "Claude Code")[0]).toContain("≈ $6.00");

    openView("Models");
    expect(cells(typeTable(), "Pricing adjustment")[0]).toBe("0tokens unchanged");
    expect(cells(typeTable(), "Pricing adjustment")[1]).toContain("≈ +$2.00");
    expect(cells(typeTable(), "Total")[1]).toContain("≈ $6.00");
    expect(typeTable()).not.toHaveTextContent("Earlier usage");
  });

  it("keeps dated detail visible when a downward pricing adjustment reaches the ledger first", () => {
    annotateThreadUsage("adjusted", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("adjusted", {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null,
    }, "a", "turn-1");
    flushUsageLedger();
    const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ estimatedCost?: number }>;
    records[0].estimatedCost = (records[0].estimatedCost ?? 0) - 2;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    resetUsageLedgerCache();

    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(stat("Estimated API cost")).toHaveTextContent("≈ $2.00");
    expect(screen.getByRole("note")).toHaveTextContent("A pricing adjustment is included in all-time and provider cost");
    expect(screen.getByRole("table", { name: "Estimated cost and tokens by provider" })).toHaveTextContent("≈ $2.00");
    openView("Models");
    expect(cells(typeTable(), "Pricing adjustment")[1]).toContain("≈ −$2.00");
    expect(cells(typeTable(), "Total")[1]).toContain("≈ $2.00");
    expect(screen.getByRole("table", { name: "Estimated cost, tokens and prompts by model" })).toBeInTheDocument();
  });

  it("switches ranges from the keyboard and never includes undated usage in a range", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    const thirty = screen.getByRole("radio", { name: "30 days" });
    thirty.focus();
    fireEvent.keyDown(thirty, { key: "Home" });
    const today = screen.getByRole("radio", { name: "Today" });
    expect(today).toHaveAttribute("aria-checked", "true");
    expect(today).toHaveFocus();
    const expected = usageDetail({ from: localDayKey(), to: localDayKey() });
    expect(stat("Tokens")).toHaveTextContent("2.3M");
    // Five prompts today, all priced.
    expect(stat("Per prompt")).toHaveTextContent(approx(expected.totals.estimatedCost / 5));
    expect(stat("Per prompt")).toHaveTextContent(/5 prompts$/);
    // One day has no trend.
    expect(screen.queryByRole("region", { name: /Daily/ })).not.toBeInTheDocument();
    openView("Models");
    expect(screen.queryByText("Earlier usage")).not.toBeInTheDocument();
  });

  it("filters a custom range, bounds it by retention, and explains when it starts before dated tracking", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const day = (offset: number) => shiftDayKey(localDayKey(), -offset);
    expect(screen.getByLabelText("From")).toHaveAttribute("min", day(400));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: day(40) } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: day(10) } });
    // Only the Sonnet usage 12 days ago falls in range.
    expect(stat("Tokens")).toHaveTextContent("740K");
    expect(screen.getByRole("note")).toHaveTextContent(/Dated detail begins .* Earlier usage is only in All time/);
    // A reversed range is read the right way round.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: day(0) } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: day(1) } });
    expect(stat("Tokens")).toHaveTextContent("2.7M");
  });

  it("averages every token type per prompt and shows how much of each type is priced", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    openView("Models");
    const table = typeTable();
    const detail = usageDetail({ from: shiftDayKey(localDayKey(), -6), to: localDayKey() });
    // Tokens: every model-day with prompt ids, over its 11 prompts. Cost: the
    // 9 prompts whose usage was all priced (not Cursor Auto or OpenRouter).
    const priced = detail.buckets.filter((bucket) => !bucket.unpricedTokens);
    const cacheReadCost = priced.reduce((sum, bucket) => sum + bucket.cacheReadCost, 0);
    expect(cells(table, "Cache read")[0]).toContain(`${Math.round(detail.totals.cacheReadTokens / 11).toLocaleString()}/prompt per prompt`);
    expect(cells(table, "Cache read")[1]).toContain(`${approx(cacheReadCost / 9)}/prompt per prompt`);
    for (const row of ["Uncached input", "Cache write", "Output"]) expect(cells(table, row)[1]).toMatch(/per prompt$/);
    // Cursor and OpenRouter input is counted but not priced; its share says so.
    const input = detail.buckets.reduce((sum, bucket) => sum + bucket.uncachedInputTokens, 0);
    const pricedInput = priced.reduce((sum, bucket) => sum + bucket.uncachedInputTokens, 0);
    expect(cells(table, "Uncached input")[2]).toBe(`${Math.round(pricedInput / input * 100)}%`);
    expect(screen.getByText(/Per-prompt figures cover 11 prompts; costs only the 9 whose usage was all priced/)).toBeInTheDocument();
  });

  it("marks a type's coverage as partial when a model-day was only partly priced", () => {
    // Morning: a new model with no published rate; afternoon: its rate arrives.
    annotateThreadUsage("new", { provider: "openrouter", model: "vendor/new" });
    recordUsageDelta("new", { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1_100, reasoningOutputTokens: 0, contextWindow: null }, "a", "t1");
    annotateThreadUsage("new", { provider: "openrouter", model: "vendor/new", pricing: { inputPerMillion: 1, outputPerMillion: 2, source: "OpenRouter", asOf: "2026-09-25" } });
    recordUsageDelta("new", { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1_100, reasoningOutputTokens: 0, contextWindow: null }, "b", "t2");
    flushUsageLedger();
    render(<UsageDashboard />);
    openView("Models");
    expect(cells(typeTable(), "Uncached input")).toEqual(["2,0001,000/prompt per prompt", approx(0.001), "Partly"]);
    const models = screen.getByRole("table", { name: "Estimated cost, tokens and prompts by model" });
    expect(cells(models, "vendor/new")[0]).toContain("partly priced");
  });

  it("keeps a model's per-prompt average when only another day's usage lacked a prompt id", () => {
    annotateThreadUsage("sol", { provider: "openai", model: "gpt-5.6-sol" });
    const realNow = Date.now;
    Date.now = () => realNow() - 2 * 86_400_000;
    try { recordUsageDelta("sol", { inputTokens: 9_000_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 9_000_000, reasoningOutputTokens: 0, contextWindow: null }); }
    finally { Date.now = realNow; }
    // Today: two identified prompts, 1,000,000 uncached input at $4 per 1M.
    recordUsageDelta("sol", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null }, "a", "t1");
    recordUsageDelta("sol", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null }, "b", "t2");
    flushUsageLedger();
    render(<UsageDashboard />);
    openView("Models");
    const models = screen.getByRole("table", { name: "Estimated cost, tokens and prompts by model" });
    expect(cells(models, "GPT-5.6 Sol")[2]).toBe("≈ $4.001M tokens");
    expect(screen.getByText(/9,000,000 tokens from model-days with usage lacking a prompt id aren’t averaged/)).toBeInTheDocument();
  });

  it("expands a model to its token types, per-prompt averages, current rate and dated breakdown", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    openView("Models");
    const toggle = screen.getByRole("button", { name: /GPT-6 Astra/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    const table = within(panel).getByRole("table", { name: "GPT-6 Astra tokens and estimated cost by type" });
    // 3 prompts: 750,000 uncached input ($7.50) is 250,000 ($2.50) per prompt.
    expect(cells(table, "Uncached input")).toEqual(["750,000250,000/prompt per prompt", "≈ $7.50≈ $2.50/prompt per prompt", "100%"]);
    expect(cells(table, "Cache read")).toEqual(["300,000100,000/prompt per prompt", "≈ $0.30≈ $0.10/prompt per prompt", "100%"]);
    expect(cells(table, "Cache write")).toEqual(["150,00050,000/prompt per prompt", "≈ $1.88≈ $0.63/prompt per prompt", "100%"]);
    expect(cells(table, "Output")).toEqual(["210,00070,000/prompt per prompt", "≈ $10.50≈ $3.50/prompt per prompt", "100%"]);
    expect(panel).toHaveTextContent("Current rate per 1M: $10.00 input, $1.00 cache read, $12.50 cache write, $50.00 output (bundled rate, verified 2026-09-25)");
    const byDay = within(panel).getByRole("table", { name: "GPT-6 Astra tokens and estimated cost by day" });
    expect(within(byDay).getAllByRole("row")).toHaveLength(2);
    expect(cells(byDay, ".+")).toEqual(["750,000≈ $7.50", "300,000≈ $0.30", "150,000≈ $1.88", "210,000≈ $10.50", "1,410,000≈ $20.18"]);

    fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    expect(screen.getByText(/Auto doesn’t report which model served each request, so it isn’t priced\./)).toBeInTheDocument();
    const auto = screen.getByRole("table", { name: "Auto tokens and estimated cost by type" });
    // Cursor never reports cache writes: unknown, not zero.
    expect(cells(auto, "Cache write")).toEqual(["Not reported", "Not reported", "—"]);
    expect(cells(auto, "Output")[1]).toBe("Unpriced");
  });

  it("prices a Cursor model whose name matches its published rate, and says cache writes are missing", () => {
    recordOfficialPricingResult("cursor", { ok: true, models: { "grok 4.5": { input: 2, cacheRead: 0.5, output: 6, asOf: "2026-09-25", name: "Grok 4.5" } } }, Date.parse("2026-09-25T12:00:00Z"));
    updateCursorModelNames([{ id: "cursor-grok-4.5", name: "Grok 4.5" }]);
    annotateThreadUsage("grok", { provider: "cursor", model: "cursor-grok-4.5" });
    recordUsageDelta("grok", { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteInputTokens: 0, outputTokens: 100_000, totalTokens: 1_100_000, reasoningOutputTokens: 0, contextWindow: null }, "g1", "t1");
    flushUsageLedger();
    render(<UsageDashboard />);
    openView("Models");
    const models = screen.getByRole("table", { name: "Estimated cost, tokens and prompts by model" });
    // $1.00 uncached + $0.25 cache read + $0.60 output.
    expect(cells(models, "cursor-grok-4.5")[0]).toBe("≈ $1.85");
    fireEvent.click(screen.getByRole("button", { name: /cursor-grok-4\.5/ }));
    expect(screen.getByText(/Current rate per 1M: \$2\.00 input, \$0\.50 cache read, cache writes at the input rate, \$6\.00 output \(Cursor pricing page, verified 2026-09-25\)\. Cursor doesn’t report cache writes, so this estimate may be low\./)).toBeInTheDocument();
    expect(cells(screen.getByRole("table", { name: /cursor-grok-4\.5 tokens and estimated cost by type/ }), "Cache write")).toEqual(["Not reported", "Not reported", "—"]);
  });

  it("shows Claude's 1-hour cache writes and rate in a model's detail", () => {
    annotateThreadUsage("hour", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("hour", {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000, cacheWrite1hInputTokens: 750_000,
      outputTokens: 0, totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null,
    }, "e", "t");
    flushUsageLedger();
    render(<UsageDashboard />);
    openView("Models");
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    // 250,000 five-minute writes at $5 and 750,000 one-hour writes at $8.
    expect(cells(screen.getByRole("table", { name: /Claude Opus 5\.5 tokens and estimated cost by type/ }), "Cache write")[1]).toContain("≈ $7.25");
    expect(screen.getByText(/\$5\.00 cache write \(\$8\.00 for 1-hour\).* 750,000 cache-write tokens used the 1-hour cache\./)).toBeInTheDocument();
  });

  it("keeps provider-level all-time totals for a ledger recorded before dated detail, and invents no models", () => {
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(legacyLedgerRecords()));
    resetUsageLedgerCache();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(screen.getByRole("note")).toHaveTextContent("Dated, per-model detail starts with your next message");
    const providers = screen.getByRole("table", { name: "Estimated cost and tokens by provider" });
    const rows = within(providers).getAllByRole("rowheader");
    // Largest first; each known provider keeps its own frozen all-time estimate.
    expect(rows.map((row) => row.firstChild!.textContent)).toEqual(["OpenAI / Codex", "Claude Code", "Unattributed"]);
    expect(cells(providers, "OpenAI / Codex")[0]).toContain("≈ $8.50");
    expect(cells(providers, "Claude Code")[0]).toContain("≈ $2.25");
    expect(rows[0]).toHaveTextContent("Earlier usage only");
    // No trend: nothing is dated.
    expect(screen.queryByRole("region", { name: /Daily|Weekly/ })).not.toBeInTheDocument();
    openView("Models");
    // Token types are known; their cost split is not.
    expect(cells(typeTable(), "Cache read")).toEqual(["700,000", "Unpriced", "0%"]);
    expect(cells(typeTable(), "Earlier usage")).toEqual(["1,960,000included above", approx(10.75), "—"]);
    expect(screen.queryByRole("table", { name: "Estimated cost, tokens and prompts by model" })).not.toBeInTheDocument();
  });

  it("compares two models' observed tokens and frozen cost per billable part for a chosen week", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    openView("Compare");
    const compare = screen.getByRole("region", { name: "Compare models" });
    fireEvent.click(within(compare).getByRole("button", { name: "First model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-5\.6 Sol/ }));
    fireEvent.click(within(compare).getByRole("button", { name: "Second model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Opus 5\.5/ }));
    const observed = within(compare).getByRole("table", { name: /^Observed usage and estimated cost · GPT-5\.6 Sol compared with Claude Opus 5\.5/ });
    // Sol: $4 / $0.40 / $5 / $20 per 1M over 4 prompts. Opus 5.5: $4 / $0.20 / $5 / $20 over 2.
    expect(cells(observed, "Uncached input")).toEqual(["≈ $4.501,125,000 tokens · 281.3K per prompt", "≈ $2.00500,000 tokens · 250K per prompt"]);
    expect(cells(observed, "Cache read")).toEqual(["≈ $0.18450,000 tokens · 112.5K per prompt", "≈ $0.04200,000 tokens · 100K per prompt"]);
    expect(cells(observed, "Total")[1]).toBe("≈ $4.54900,000 tokens");
    expect(cells(observed, "Avg per prompt")[1]).toBe("≈ $2.27450,000 tokens");
    expect(cells(observed, "Prompts using model")).toEqual(["4", "2"]);
    expect(cells(observed, "Cache read share of input")).toEqual(["25%", "25%"]);

    // Re-pricing at current rates is collapsed, separate and labelled hypothetical.
    const hypothetical = within(compare).getByText(/Hypothetical: re-price at current standard rates/).closest("details")!;
    expect(hypothetical.open).toBe(false);
    fireEvent.click(within(hypothetical).getByText(/Hypothetical/));
    const rates = within(hypothetical).getByRole("table", { name: /Current standard rates per million tokens/ });
    expect(cells(rates, "Cache read")).toEqual(["$0.40", "$0.20"]);
    expect(cells(rates, "Cache write")).toEqual(["$5.00", "$5.00 · 1h $8.00"]);
    expect(within(hypothetical).getByText(/Claude Opus 5\.5’s usage at GPT-5\.6 Sol rates/).closest("li")).toHaveTextContent("≈ $4.58 · cache reads ≈ $0.08");
  });

  it("puts two models' cache reads side by side by day and by week", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    openView("Compare");
    const compare = screen.getByRole("region", { name: "Compare models" });
    fireEvent.click(within(compare).getByRole("button", { name: "First model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-5\.6 Sol/ }));
    fireEvent.click(within(compare).getByRole("button", { name: "Second model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(within(compare).getByRole("button", { name: "Token type" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Cache read/ }));
    fireEvent.click(within(within(compare).getByRole("radiogroup", { name: "Compare measure" })).getByRole("radio", { name: "Tokens" }));
    const daily = within(compare).getByRole("table", { name: /^Cache read tokens by day · GPT-5\.6 Sol compared with Claude Opus 5\.5/ });
    expect(within(daily).getAllByRole("row")).toHaveLength(31);
    const rowFor = (day: string) => [...within(daily).getAllByRole("row")].find((row) => row.querySelector("th")?.textContent === day)!;
    const label = (offset: number) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect([...rowFor(label(3)).querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["450K", "0"]);
    expect([...rowFor(label(0)).querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["0", "200K"]);

    fireEvent.click(within(compare).getByRole("radio", { name: "Week" }));
    const weekly = within(compare).getByRole("table", { name: /^Cache read tokens by week/ });
    const totals = [...within(weekly).getAllByRole("row")].slice(1).map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    // Every week is listed; the two models' weekly sums add up to their range totals.
    expect(totals.length).toBeGreaterThanOrEqual(5);
    expect(totals.filter(([sol]) => sol === "450K")).toHaveLength(1);
    expect(totals.filter(([, opus]) => opus === "200K")).toHaveLength(1);
  });

  it("labels an unpriced period as unknown in the compare table, not zero cost", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    openView("Compare");
    const compare = screen.getByRole("region", { name: "Compare models" });
    fireEvent.click(within(compare).getByRole("button", { name: "First model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto.*Cursor|Cursor.*Auto/i }));
    const table = within(compare).getByRole("table", { name: /^Estimated cost by day/ });
    expect(within(table).getAllByRole("cell").some((cell) => cell.textContent === "Unpriced")).toBe(true);
  });

  it("says so when one compared model has no usage in the range, and keeps the pair across range changes", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "Today" }));
    openView("Compare");
    const compare = screen.getByRole("region", { name: "Compare models" });
    fireEvent.click(within(compare).getByRole("button", { name: "First model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(within(compare).getByRole("button", { name: "Second model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Sonnet 5/ }));
    const observed = within(compare).getByRole("table", { name: /^Observed usage/ });
    expect(cells(observed, "Cache read")[1]).toBe("—");
    expect(cells(observed, "Total")[1]).toBe("No usagein this range");
    expect(cells(observed, "Avg per prompt")[1]).toBe("—");
    expect(compare).toHaveTextContent("Claude Sonnet 5 has no recorded usage in this range.");
    // Its current rate is still shown, and only the used model is re-priced.
    fireEvent.click(within(compare).getByText(/Hypothetical/));
    expect(cells(within(compare).getByRole("table", { name: /Current standard rates/ }), "Output")).toEqual(["$20.00", "$10.00"]);
    expect(within(compare).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(within(screen.getByRole("region", { name: "Compare models" })).getAllByRole("columnheader", { name: "Claude Sonnet 5" }).length).toBeGreaterThan(0);
    openView("Overview");
    openView("Compare");
    expect(within(screen.getByRole("region", { name: "Compare models" })).getByRole("button", { name: "Second model" })).toHaveTextContent("Claude Sonnet 5");
  });

  it("shows fractional published per-million rates without rounding away precision", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    openView("Compare");
    const compare = screen.getByRole("region", { name: "Compare models" });
    fireEvent.click(within(compare).getByRole("button", { name: "First model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-6 Luna/ }));
    fireEvent.click(within(compare).getByText(/Hypothetical/));
    expect(cells(within(compare).getByRole("table", { name: /Current standard rates per million tokens/ }), "Cache write")[0]).toBe("$0.125");
  });

  it("switches views with the arrow keys", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "End" });
    const compare = screen.getByRole("tab", { name: "Compare" });
    expect(compare).toHaveFocus();
    expect(compare).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Compare");
    fireEvent.keyDown(compare, { key: "ArrowRight" });
    expect(overview).toHaveFocus();
    expect(overview).toHaveAttribute("tabindex", "0");
    expect(compare).toHaveAttribute("tabindex", "-1");
  });

  it("updates from background ledger writes without an App rerender", () => {
    render(<UsageDashboard />);
    act(() => {
      recordUsageDelta("background", { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0, contextWindow: null }, "e", "t");
      flushUsageLedger();
    });
    expect(stat("Tokens")).toHaveTextContent("120");
    expect(screen.getByText("Unattributed")).toBeInTheDocument();
  });

  it("prevents repeated refreshes and exposes refresh failure", async () => {
    let reject!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<UsageDashboard onRefreshPricing={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh pricing" }));
    const checking = screen.getByRole("button", { name: "Checking…" });
    expect(checking).toBeDisabled();
    fireEvent.click(checking);
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("offline")));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Last known rates remain in use"));
    expect(screen.getByRole("button", { name: "Refresh pricing" })).toBeEnabled();
    expect(screen.getByText("Some rates couldn’t be verified")).toBeInTheDocument();
  });

  it("summarizes rate freshness up top and shows each source's own result on demand", async () => {
    const { refreshOfficialPricing } = await import("../lib/officialPricing");
    const { OPENAI_PRICING_PAGE, CURSOR_PRICING_PAGE } = await import("../test/pricingPages");
    const fetchDocument = vi.fn(async (source: string) => {
      if (source === "anthropic") throw new Error("The pricing page returned HTTP 503");
      return source === "openai" ? OPENAI_PRICING_PAGE : CURSOR_PRICING_PAGE;
    });
    const refresh = vi.fn(async () => {
      const result = await refreshOfficialPricing({ force: true, fetchDocument });
      if (result.failed.length) throw new Error("Some pricing sources could not be checked");
    });
    render(<UsageDashboard onRefreshPricing={refresh} openRouterPricingError="" />);
    const summaryLine = screen.getByText("Using bundled rates").closest("summary")!;
    expect(summaryLine.parentElement).toHaveProperty("open", false);
    fireEvent.click(summaryLine);
    const sources = screen.getByRole("list", { name: "Rate sources" });
    expect(sources).toHaveTextContent("OpenAI pricing pageNot checked yet · using catalog and bundled rates");
    fireEvent.click(screen.getByRole("button", { name: "Refresh pricing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh pricing" })).toBeEnabled());
    const item = (label: string) => within(sources).getByText(label).closest("li")!;
    expect(item("OpenAI pricing page")).toHaveTextContent(/6 models verified today/);
    expect(item("OpenAI pricing page")).toHaveClass("ok");
    expect(item("Cursor pricing page")).toHaveTextContent(/7 models verified today/);
    expect(item("Claude pricing page")).toHaveTextContent(/Couldn’t verify today .* · using catalog and bundled rates/);
    expect(item("Claude pricing page")).toHaveTextContent("The pricing page returned HTTP 503");
    expect(item("Claude pricing page")).toHaveClass("warn");
    expect(item("Mythra catalog")).toHaveTextContent("Fallback · not downloaded yet");
    expect(item("OpenRouter")).toHaveTextContent("Live model rates");
    // A partial failure is never summarized as verified.
    expect(screen.getByText("Some rates couldn’t be verified")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Some pricing sources couldn’t be checked. Last known rates remain in use.");
  });

  it("anchors all-time totals to the ledger if dated detail was saved without it", () => {
    recordUsageDelta("saved", { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, cachedInputTokens: 0, reasoningOutputTokens: 0, contextWindow: null }, "a", "t1");
    flushUsageLedger();
    // Simulate an interrupted save: detail advanced, the ledger did not.
    const ledger = localStorage.getItem(USAGE_LEDGER_KEY)!;
    recordUsageDelta("saved", { inputTokens: 5_000, outputTokens: 500, totalTokens: 5_500, cachedInputTokens: 0, reasoningOutputTokens: 0, contextWindow: null }, "b", "t2");
    flushUsageLedger();
    localStorage.setItem(USAGE_LEDGER_KEY, ledger);
    resetUsageLedgerCache();
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(stat("Tokens")).toHaveTextContent("1,100");
    expect(screen.getByRole("note")).toHaveTextContent("Some dated detail was saved without its all-time total");
    const providers = screen.getByRole("table", { name: "Estimated cost and tokens by provider" });
    expect(providers).toHaveTextContent("1,100");
    expect(providers).not.toHaveTextContent("5,500");
    fireEvent.click(screen.getByRole("radio", { name: "Today" }));
    expect(screen.getByText("No usage in this range")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("dated detail is hidden until the records agree");
  });

  it("shows a development preview without writing any usage", () => {
    render(<UsageDashboard />);
    act(() => window.__mythraPreviewUsageDashboard?.(true));
    expect(screen.getByText("Development preview — synthetic usage, not your data.")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Estimated cost and tokens by provider" })).toHaveTextContent("Claude Code");
    openView("Models");
    expect(screen.getByRole("button", { name: /GPT-5\.6 Sol/ })).toBeInTheDocument();
    flushUsageLedger();
    expect(localStorage.getItem(USAGE_LEDGER_KEY)).toBeNull();
    expect(localStorage.getItem(USAGE_HISTORY_KEY)).toBeNull();
    expect(previewUsageSource().detail(null).unallocated?.totalTokens).toBe(5_400_000);
  });

  it("labels known model ids readably and leaves others verbatim", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelLabel("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(modelLabel("gpt-5.6")).toBe("GPT-5.6");
    expect(modelLabel("vendor/model")).toBe("vendor/model");
    expect(modelLabel("")).toBe("Model not reported");
    expect(modelLabel("unattributed")).toBe("Model not attributable");
  });
});

describe("usage repricing status", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

  it("says what was repriced from a confirmed rate and what remains unpriced", async () => {
    const { repriceUsageHistory } = await import("../lib/usageHistory");
    annotateThreadUsage("nova", { provider: "openai", model: "gpt-7-nova" });
    recordUsageDelta("nova", { totalTokens: 1_000_000, inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, contextWindow: null }, "a", "turn-1");
    annotateThreadUsage("local", { provider: "lmstudio", model: "qwen" });
    recordUsageDelta("local", { totalTokens: 50_000, inputTokens: 50_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, contextWindow: null }, "b", "turn-2");
    flushUsageLedger();
    const today = localDayKey();
    localStorage.setItem("kiwi.modelPricingCatalog", JSON.stringify({
      schemaVersion: 1, updatedAt: `${shiftDayKey(today, 1)}T00:00:00Z`,
      models: { "openai:gpt-7-nova": { inputPerMillion: 2, outputPerMillion: 8, asOf: shiftDayKey(today, 1), effectiveFrom: shiftDayKey(today, -3) } },
    }));
    act(() => { repriceUsageHistory(); });
    render(<UsageDashboard />);
    expect(screen.getByText("Repriced 1M previously unpriced tokens using historical rate evidence (+$2.00).")).toBeInTheDocument();
    expect(screen.getByText("50K tokens are unpriced. Dated usage can be corrected when a historical rate is supported; earlier undated usage cannot.")).toBeInTheDocument();
    expect(usageTotals()).toMatchObject({ estimatedCost: 2, unpricedTokens: 50_000 });
  });
});
