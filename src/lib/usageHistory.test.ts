import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateThreadUsage, flushUsageLedger, MODEL_PRICING_CATALOG_KEY, recordCumulativeUsage, recordUsageDelta,
  resetUsageLedgerCache, usageTotals, USAGE_LEDGER_KEY,
} from "./usageLedger";
import { localDayKey, pruneUsageHistory, shiftDayKey, USAGE_HISTORY_KEY, USAGE_HISTORY_RETENTION_DAYS } from "./usageHistory";
import { componentCost, knownPricedModels, summarizeUsageHistory, usageDetail } from "./usageSummary";
import { resetClaudeEventUsageState, routeClaudeEvent, type ClaudeEventContext } from "./claudeEvents";
import { resetCursorEventStateForTests, routeCursorEvent, type CursorEventContext } from "./cursorEvents";
import { routeCodexEvent } from "./codexEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { legacyLedgerRecords } from "../test/usageFixture";

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  totalTokens: inputTokens + outputTokens,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  reasoningOutputTokens: 0,
  contextWindow: null,
});

/** Simulates a renderer reload: flush, forget every in-memory cache, re-read. */
function reload() {
  flushUsageLedger();
  resetUsageLedgerCache();
}

describe("dated usage detail", () => {
  beforeEach(() => {
    resetUsageLedgerCache();
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 20, 10));
  });
  afterEach(() => {
    resetUsageLedgerCache();
    vi.useRealTimers();
  });

  it("splits a thread's usage by resolved model and freezes each component's cost", () => {
    annotateThreadUsage("thread", { provider: "claude", model: "claude-opus-5-5" });
    // 1M uncached + 1M cache read + 1M cache write input, 1M output.
    recordUsageDelta("thread", usage(3_000_000, 1_000_000, 1_000_000, 1_000_000), "a", "turn-1");
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(1_000_000, 0), "b", "turn-2");

    const detail = usageDetail(null);
    const [claude] = detail.providers;
    expect(claude.models.map((model) => model.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
    const opus = claude.models[0];
    expect(opus).toMatchObject({ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000, turns: 1 });
    expect(opus.uncachedInputCost).toBeCloseTo(4);
    expect(opus.cacheReadCost).toBeCloseTo(0.2);
    expect(opus.cacheWriteCost).toBeCloseTo(5);
    expect(opus.outputCost).toBeCloseTo(20);
    expect(componentCost(claude.models[1])).toBeCloseTo(2);
    // Dated detail and the authoritative all-time ledger agree exactly.
    expect(detail.unallocated).toBeNull();
    expect(detail.totals.estimatedCost).toBeCloseTo(usageTotals().estimatedCost);
  });

  it("filters inclusive local-day ranges", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol" });
    recordUsageDelta("thread", usage(100, 10), "a", "turn-1");
    vi.setSystemTime(new Date(2026, 8, 22, 23, 59));
    recordUsageDelta("thread", usage(200, 20), "b", "turn-2");
    vi.setSystemTime(new Date(2026, 8, 23, 0, 1));
    recordUsageDelta("thread", usage(400, 40), "c", "turn-3");

    expect(usageDetail({ from: "2026-09-20", to: "2026-09-20" }).totals).toMatchObject({ totalTokens: 110, turns: 1 });
    expect(usageDetail({ from: "2026-09-21", to: "2026-09-22" }).totals).toMatchObject({ totalTokens: 220, turns: 1 });
    expect(usageDetail({ from: "2026-09-20", to: "2026-09-23" }).totals).toMatchObject({ totalTokens: 770, turns: 3 });
    expect(usageDetail({ from: "2026-09-24", to: "2026-09-30" }).totals.totalTokens).toBe(0);
  });

  it("never reprices saved detail when rates refresh", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-sol" });
    recordUsageDelta("thread", usage(1_000_000, 0), "a", "turn-1");
    localStorage.setItem(MODEL_PRICING_CATALOG_KEY, JSON.stringify({
      schemaVersion: 1, updatedAt: "2026-10-01T00:00:00Z",
      models: { "openai:gpt-6-sol": { inputPerMillion: 20, outputPerMillion: 80, asOf: "2026-10-01" } },
    }));
    expect(usageDetail(null).totals.estimatedCost).toBeCloseTo(2);
    recordUsageDelta("thread", usage(1_000_000, 0), "b", "turn-2");
    expect(usageDetail(null).totals.estimatedCost).toBeCloseTo(22);
    expect(usageTotals().estimatedCost).toBeCloseTo(22);
  });

  it("counts a turn once across several deltas and a reload, and ignores duplicate events", () => {
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(100, 10), "assistant-1", "turn-1");
    recordUsageDelta("thread", usage(100, 10), "assistant-1", "turn-1");
    recordUsageDelta("thread", usage(50, 5), "assistant-2", "turn-1");
    reload();
    recordUsageDelta("thread", usage(100, 10), "assistant-1", "turn-1");
    recordUsageDelta("thread", usage(10, 1), "result-1", "turn-1");
    const totals = usageDetail(null).totals;
    expect(totals).toMatchObject({ totalTokens: 176, turns: 1, unturnedTokens: 0 });
    expect(usageTotals().totalTokens).toBe(176);
  });

  it("keeps a turn that runs past midnight on the day its prompt began", () => {
    annotateThreadUsage("late", { provider: "claude", model: "claude-sonnet-5" });
    vi.setSystemTime(new Date(2026, 8, 20, 23, 59));
    recordUsageDelta("late", usage(1_000, 100), "assistant-1", "turn-1");
    // The rest of the same turn arrives after midnight, across a reload.
    reload();
    vi.setSystemTime(new Date(2026, 8, 21, 0, 2));
    recordUsageDelta("late", usage(3_000, 300), "result-1", "turn-1");
    // A new prompt after midnight belongs to the new day.
    recordUsageDelta("late", usage(500, 50), "assistant-2", "turn-2");
    const day = (date: string) => usageDetail({ from: date, to: date }).totals;
    expect(day("2026-09-20")).toMatchObject({ totalTokens: 4_400, turns: 1 });
    expect(day("2026-09-21")).toMatchObject({ totalTokens: 550, turns: 1 });
    expect(usageTotals().totalTokens).toBe(4_950);
  });

  it("counts a turn that switches models once overall and once for each model it used", () => {
    annotateThreadUsage("thread", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("thread", usage(1_000, 100), "a", "turn-1");
    // A fallback or model switch partway through the same prompt.
    annotateThreadUsage("thread", { provider: "claude", model: "claude-sonnet-5" });
    recordUsageDelta("thread", usage(3_000, 300), "b", "turn-1");
    recordUsageDelta("thread", usage(500, 50), "c", "turn-2");

    const detail = usageDetail(null);
    // Two prompts, never three.
    expect(detail.totals.turns).toBe(2);
    const [opus, sonnet] = ["claude-opus-5-5", "claude-sonnet-5"].map((id) => detail.providers[0].models.find((model) => model.model === id)!);
    expect(opus).toMatchObject({ turns: 1, modelTurns: 1, totalTokens: 1_100 });
    // Sonnet did real work in turn-1, so it has a denominator for it.
    expect(sonnet).toMatchObject({ turns: 1, modelTurns: 2, totalTokens: 3_850 });
    reload();
    recordUsageDelta("thread", usage(10, 1), "d", "turn-2");
    expect(usageDetail(null).providers[0].models.find((model) => model.model === "claude-sonnet-5")).toMatchObject({ modelTurns: 2 });
  });

  it("keeps child threads' turns distinct even when turn ids collide", () => {
    annotateThreadUsage("parent", { provider: "openai", model: "gpt-6-astra" });
    annotateThreadUsage("child", { provider: "openai", model: "gpt-6-astra" });
    recordUsageDelta("parent", usage(10, 1), "a", "turn-1");
    recordUsageDelta("child", usage(10, 1), "b", "turn-1");
    expect(usageDetail(null).totals.turns).toBe(2);
  });

  it("reports usage without a turn identity instead of inventing a denominator", () => {
    annotateThreadUsage("thread", { provider: "cursor", model: "auto" });
    recordUsageDelta("thread", usage(100, 20));
    expect(usageDetail(null).totals).toMatchObject({ turns: 0, unturnedTokens: 120, unpricedTokens: 120, pricedTokens: 0 });
  });

  it("follows Codex cumulative snapshots through a resumed, lower counter", () => {
    annotateThreadUsage("codex", { provider: "openai", model: "gpt-6-sol" });
    recordCumulativeUsage("codex", usage(1_000, 100), "turn-1");
    recordCumulativeUsage("codex", usage(1_500, 150), "turn-1");
    reload();
    // A resumed runtime restarts its counter; the ledger rebaselines without
    // adding anything, and so must the dated detail.
    recordCumulativeUsage("codex", usage(200, 20), "turn-2");
    recordCumulativeUsage("codex", usage(500, 50), "turn-2");
    const totals = usageDetail(null).totals;
    expect(totals).toMatchObject({ uncachedInputTokens: 1_800, outputTokens: 180, turns: 2 });
    expect(usageTotals()).toMatchObject({ inputTokens: 1_800, outputTokens: 180 });
    expect(usageDetail(null).unallocated).toBeNull();
  });

  it("labels usage recorded before detailed tracking as unallocated, never as a model", () => {
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([{
      threadId: "legacy", provider: "claude", model: "claude-opus-5",
      usage: usage(1_000_000, 100_000, 400_000), estimatedCost: 3, pricedTokens: 1_100_000, unpricedTokens: 0,
      updatedAt: Date.now() - 86_400_000,
    }]));
    annotateThreadUsage("new", { provider: "claude", model: "claude-opus-5-5" });
    recordUsageDelta("new", usage(1_000_000, 0), "a", "turn-1");

    const all = usageDetail(null);
    expect(all.providers.flatMap((provider) => provider.models.map((model) => model.model))).toEqual(["claude-opus-5-5"]);
    expect(all.unallocated).toMatchObject({ uncachedInputTokens: 600_000, cacheReadTokens: 400_000, outputTokens: 100_000, estimatedCost: 3 });
    expect(all.totals.estimatedCost).toBeCloseTo(usageTotals().estimatedCost);
    expect(all.totals.totalTokens).toBe(usageTotals().totalTokens);
    // Averages only use dated detail.
    expect(all.detailTotals).toMatchObject({ totalTokens: 1_000_000, turns: 1 });
    // A range never includes usage it cannot date.
    const today = usageDetail({ from: localDayKey(), to: localDayKey() });
    expect(today.unallocated).toBeNull();
    expect(today.totals.totalTokens).toBe(1_000_000);
    expect(today.providers[0].earlier).toBeUndefined();
  });

  it("keeps each known provider's earlier all-time usage without inventing attribution", () => {
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(legacyLedgerRecords()));
    resetUsageLedgerCache();
    annotateThreadUsage("new", { provider: "openai", model: "gpt-5.6-sol" });
    recordUsageDelta("new", usage(1_000_000, 0), "a", "turn-1");

    const providers = usageDetail(null).providers;
    expect(providers.map((provider) => provider.provider)).toEqual(["openai", "claude", "unknown"]);
    const [openai, claude, unknown] = providers;
    // Dated detail covers only the new usage; the rest stays a provider total.
    expect(openai.models.map((model) => model.model)).toEqual(["gpt-5.6-sol"]);
    expect(componentCost(openai)).toBeCloseTo(4);
    expect(openai.earlier).toMatchObject({ totalTokens: 1_200_000, cacheReadTokens: 500_000, estimatedCost: 8.5 });
    expect(claude.models).toEqual([]);
    expect(claude.earlier).toMatchObject({ totalTokens: 700_000, estimatedCost: 2.25, uncachedInputCost: 0, cacheReadCost: 0 });
    expect(unknown.earlier).toMatchObject({ totalTokens: 60_000, pricedTokens: 0, unpricedTokens: 60_000 });
    // Provider rows add up to the ledger's all-time totals.
    const sum = providers.reduce((total, provider) => total + provider.totalTokens + (provider.earlier?.totalTokens ?? 0), 0);
    expect(sum).toBe(usageTotals().totalTokens);
  });

  it("persists compactly, drops malformed buckets alone, and prunes by retention", () => {
    annotateThreadUsage("thread", { provider: "openai", model: "gpt-6-luna" });
    recordUsageDelta("thread", usage(100, 10), "a", "turn-1");
    flushUsageLedger();
    const stored = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
    stored.buckets.push(["2026-09-19", "openai", "gpt-6-luna", -1, ...Array(14).fill(0)]);
    stored.buckets.push(["not-a-day", "openai", "x", ...Array(15).fill(0)]);
    stored.buckets.push(["2026-09-19", "openai", "x", ...Array(3).fill(0)]);
    // A bucket from before per-model turns keeps its turn as the model's.
    stored.buckets.push(["2026-09-18", "claude", "claude-opus-5-5", 7, ...Array(4).fill(0), 7, ...Array(6).fill(0), 1, 0]);
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(stored));
    resetUsageLedgerCache();
    const parsed = summarizeUsageHistory(null);
    expect(parsed.totals.totalTokens).toBe(117);
    expect(parsed.providers.find((provider) => provider.provider === "claude")?.models[0]).toMatchObject({ turns: 1, modelTurns: 1 });
    stored.buckets.pop();
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(stored));
    resetUsageLedgerCache();

    const later = new Date(2026, 8, 20 + USAGE_HISTORY_RETENTION_DAYS + 2, 10).getTime();
    vi.setSystemTime(later);
    recordUsageDelta("thread", usage(1, 1), "b", "turn-2");
    pruneUsageHistory(later);
    const summary = summarizeUsageHistory(null);
    expect(summary.totals.totalTokens).toBe(2);
    expect(summary.retainedFrom).toBe(localDayKey(later));
    // Pruned detail becomes unallocated all-time usage; the ledger keeps it.
    expect(usageDetail(null).unallocated?.totalTokens).toBe(110);
  });

  it("offers only models with a published first-party rate for hypothetical comparisons", () => {
    const keys = knownPricedModels().map((model) => `${model.provider}:${model.model}`);
    expect(keys).toEqual(expect.arrayContaining(["openai:gpt-6-astra", "openai:gpt-6-sol", "claude:claude-opus-5-5", "claude:claude-fable-5-1"]));
    expect(keys.some((key) => key.startsWith("cursor:"))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("queues deltas accepted before the lazily loaded detail attaches", async () => {
    vi.resetModules();
    const ledger = await import("./usageLedger");
    ledger.annotateThreadUsage("lazy", { provider: "openai", model: "gpt-5.6-sol" });
    ledger.recordUsageDelta("lazy", usage(1_000, 100), "a", "turn-1");
    vi.setSystemTime(new Date(2026, 8, 21, 10));
    ledger.recordUsageDelta("lazy", usage(1_000, 100), "b", "turn-2");
    // Evaluating the module (as the ledger's own dynamic import does) drains
    // the queue in order, with each delta's original day and turn.
    const summary = await import("./usageSummary");
    const detail = summary.usageDetail(null);
    expect(detail.unallocated).toBeNull();
    expect(summary.usageDetail({ from: "2026-09-20", to: "2026-09-20" }).totals).toMatchObject({ totalTokens: 1_100, turns: 1 });
    expect(detail.totals).toMatchObject({ totalTokens: 2_200, turns: 2 });
    // The ledger's persist is still pending, so the drained detail waits for it.
    expect(localStorage.getItem(USAGE_HISTORY_KEY)).toBeNull();
    ledger.flushUsageLedger();
    expect(JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!).buckets).toHaveLength(2);
    ledger.resetUsageLedgerCache();
    vi.resetModules();
  });

  it("shifts day keys across month and DST boundaries", () => {
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("provider event attribution", () => {
  const claudeContext: ClaudeEventContext = {
    bindingFor: () => "/tmp/project", onStatus: vi.fn(), onError: vi.fn(), onTurnCompleted: vi.fn(),
    onApprovalRequested: vi.fn(), onTranscriptChanged: vi.fn(), onUnsupportedControlRequest: vi.fn(),
  };
  const cursorContext: CursorEventContext = {
    bindingFor: () => "/tmp/project", onStatus: vi.fn(), onError: vi.fn(), onTurnCompleted: vi.fn(),
    onApprovalRequested: vi.fn(), onTranscriptChanged: vi.fn(),
  };

  beforeEach(() => {
    resetClaudeEventUsageState();
    resetCursorEventStateForTests();
    resetTaskStore();
  });

  it("attributes Claude assistant usage to the resolved model and dedupes the result", () => {
    const send = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "claude", turnId: "turn-1", message }, claudeContext);
    send({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [], usage: { input_tokens: 100, output_tokens: 10 } } });
    send({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [], usage: { input_tokens: 100, output_tokens: 10 } } });
    send({ type: "result", subtype: "success", usage: { input_tokens: 150, output_tokens: 30 },
      modelUsage: { "claude-opus-5-5": { inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    const [provider] = usageDetail(null).providers;
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({ model: "claude-opus-5-5", totalTokens: 180, turns: 1 });
  });

  it("prices Claude's 1-hour cache writes at the 1-hour rate, including the result's remainder", () => {
    const send = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "claude", turnId: "turn-1", message }, claudeContext);
    const claudeUsage = (output: number) => ({
      input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 800_000 }, output_tokens: output,
    });
    send({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [], usage: claudeUsage(3) } });
    // The result repeats the same writes and completes the output count.
    send({ type: "result", subtype: "success", usage: claudeUsage(33),
      modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 33, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 } } });
    const [model] = usageDetail(null).providers[0].models;
    // 200,000 at the 5-minute $5 and 800,000 at the 1-hour $8 per million.
    expect(model).toMatchObject({ cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 800_000, outputTokens: 33 });
    expect(model.cacheWriteCost).toBeCloseTo(7.4, 9);
    expect(usageTotals().estimatedCost).toBeCloseTo(componentCost(model), 9);
  });

  it("reconciles a mixed-model result without charging the last assistant model for both", () => {
    const send = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "claude", turnId: "turn-mixed", message }, claudeContext);
    send({ type: "assistant", message: { id: "opus-msg", model: "claude-opus-5-5", content: [], usage: { input_tokens: 100, output_tokens: 10 } } });
    send({ type: "assistant", message: { id: "sonnet-msg", model: "claude-sonnet-5", content: [], usage: { input_tokens: 200, output_tokens: 20 } } });
    send({ type: "result", subtype: "success", usage: { input_tokens: 300, output_tokens: 90 }, modelUsage: {
      "claude-opus-5-5": { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "claude-sonnet-5": { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } });
    const models = usageDetail(null).providers[0].models;
    expect(models.find((model) => model.model === "claude-opus-5-5")).toMatchObject({ uncachedInputTokens: 100, outputTokens: 40 });
    expect(models.find((model) => model.model === "claude-sonnet-5")).toMatchObject({ uncachedInputTokens: 200, outputTokens: 50 });
    expect(usageDetail(null).totals).toMatchObject({ totalTokens: 390, unpricedTokens: 0, turns: 1 });
  });

  it("keeps a resumed session snapshot's unmatched remainder unattributed", () => {
    const send = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "claude", turnId: "turn-resumed", message }, claudeContext);
    send({ type: "assistant", message: { id: "opus-msg", model: "claude-opus-5-5", content: [], usage: { input_tokens: 100, output_tokens: 10 } } });
    send({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 40 }, modelUsage: {
      "claude-opus-5-5": { inputTokens: 600, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } });
    const models = usageDetail(null).providers[0].models;
    expect(models.find((model) => model.model === "claude-opus-5-5")).toMatchObject({ totalTokens: 110, outputTokens: 10 });
    expect(models.find((model) => model.model === "unattributed")).toMatchObject({ totalTokens: 30, outputTokens: 30, unpricedTokens: 30 });
    expect(usageTotals()).toMatchObject({ totalTokens: 140, unpricedTokens: 30 });
  });

  it("does not guess which model owns unobserved 1-hour cache writes", () => {
    const send = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "claude", turnId: "turn-hour", message }, claudeContext);
    send({ type: "result", subtype: "success", usage: {
      input_tokens: 0, cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_1h_input_tokens: 100 }, output_tokens: 0,
    }, modelUsage: {
      "claude-opus-5-5": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 100 },
      "claude-sonnet-5": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 100 },
    } });
    expect(usageDetail(null).providers[0].models).toMatchObject([{ model: "unattributed", cacheWriteTokens: 200, cacheWrite1hTokens: 100, unpricedTokens: 200 }]);
    expect(usageTotals().totalTokens).toBe(200);
  });

  it("counts a Cursor turn once across usage_update snapshots and its result", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("cursor", "starting");
    const update = (value: Record<string, unknown>) => routeCursorEvent({ threadId: "cursor", turnId: "turn-1", message: { type: "notification", method: "session/update", params: { update: { sessionUpdate: "usage_update", usage: value } } } }, cursorContext);
    annotateThreadUsage("cursor", { provider: "cursor", model: "auto" });
    update({ inputTokens: 100, outputTokens: 40 });
    update({ inputTokens: 200, outputTokens: 80 });
    routeCursorEvent({ threadId: "cursor", turnId: "turn-1", message: { type: "result", result: { usage: { inputTokens: 200, outputTokens: 80 } } } }, cursorContext);
    expect(usageDetail(null).totals).toMatchObject({ totalTokens: 280, turns: 1, unpricedTokens: 280, pricedTokens: 0 });
  });

  it("uses Codex's reported turn id for cumulative token updates", () => {
    annotateThreadUsage("codex", { provider: "openai", model: "gpt-6-astra" });
    const ctx = { onTerminalOutput: vi.fn() } as unknown as Parameters<typeof routeCodexEvent>[1];
    const tokenUsage = (input: number, turnId: string) => routeCodexEvent({
      method: "thread/tokenUsage/updated",
      params: { threadId: "codex", turnId, tokenUsage: { total: { totalTokens: input + 10, inputTokens: input, outputTokens: 10 } } },
    }, ctx);
    tokenUsage(100, "turn-a");
    tokenUsage(300, "turn-b");
    const [model] = usageDetail(null).providers[0].models;
    expect(model).toMatchObject({ model: "gpt-6-astra", turns: 2, uncachedInputTokens: 300 });
  });
});
