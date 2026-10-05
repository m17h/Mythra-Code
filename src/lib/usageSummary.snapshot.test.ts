import { beforeEach, expect, it } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { UsageDashboard } from "../components/UsageDashboard";
import { seedUsageDashboard } from "../test/usageFixture";
import { annotateThreadUsage, flushUsageLedger, formatEstimatedCost, getUsageRevision, recordUsageDelta, resetUsageLedgerCache, USAGE_LEDGER_KEY } from "./usageLedger";
import { localDayKey, repriceUsageHistory, shiftDayKey, USAGE_HISTORY_KEY } from "./usageHistory";
import { selectUsageRange, usageDetail } from "./usageSummary";

const NOON = new Date(2026, 8, 29, 12).getTime();
const RANGES = [
  { from: "2000-01-01", to: "2026-09-29" },
  { from: "2026-09-23", to: "2026-09-29" },
  { from: "2026-09-29", to: "2026-09-29" },
  { from: "2026-09-17", to: "2026-09-17" },
  { from: "2026-10-01", to: "2026-10-02" },
];

beforeEach(() => { seedUsageDashboard(NOON); });

function expectRangeParity() {
  const snapshot = usageDetail(null);
  const before = structuredClone(snapshot);
  for (const range of RANGES) expect(selectUsageRange(snapshot, range)).toEqual(usageDetail(range));
  expect(snapshot).toEqual(before);
  return snapshot;
}

it("matches the original reader with dated, legacy and signed pricing-adjustment ledger totals", () => {
  const original = expectRangeParity();
  expect(original.unallocated!.totalTokens).toBeGreaterThan(0);
  const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ threadId: string; estimatedCost: number }>;
  const dated = records.find((record) => record.threadId === "fixture-opus")!;
  const originalCost = dated.estimatedCost;
  for (const adjustment of [2, -2]) {
    dated.estimatedCost = originalCost + adjustment;
    localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records));
    resetUsageLedgerCache();
    expectRangeParity();
  }
});

it("matches the original reader when a crash leaves dated detail ahead of the saved ledger", () => {
  const records = JSON.parse(localStorage.getItem(USAGE_LEDGER_KEY)!) as Array<{ threadId: string }>;
  localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(records.filter((record) => record.threadId.startsWith("fixture-legacy"))));
  resetUsageLedgerCache();
  const snapshot = expectRangeParity();
  expect(snapshot.detailAhead).toBe(true);
  expect(snapshot.buckets).toEqual([]);
  expect(snapshot.totals.totalTokens).toBeGreaterThan(0);
});

function prepareHistoryCheckpointRepair() {
  annotateThreadUsage("snapshot-reconcile", { provider: "openai", model: "gpt-7-nova", requestedServiceTier: "standard" });
  recordUsageDelta("snapshot-reconcile", {
    inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    totalTokens: 1_000_000, reasoningOutputTokens: 0, contextWindow: null, cacheReadReported: true, cacheWriteReported: true,
  }, "snapshot-reconcile-event", "snapshot-reconcile-turn");
  flushUsageLedger();
  const uncorrectedHistory = localStorage.getItem(USAGE_HISTORY_KEY)!;
  const today = localDayKey();
  localStorage.setItem("kiwi.modelPricingCatalog", JSON.stringify({
    schemaVersion: 1, updatedAt: `${shiftDayKey(today, 1)}T00:00:00Z`,
    models: { "openai:gpt-7-nova": { inputPerMillion: 2, outputPerMillion: 8, asOf: shiftDayKey(today, 1), effectiveFrom: shiftDayKey(today, -3) } },
  }));
  const initialRevision = getUsageRevision();
  expect(repriceUsageHistory()).toBeGreaterThan(0);
  expect(getUsageRevision()).toBe(initialRevision + 1);
  // Simulate the authoritative correction reaching disk before its history.
  localStorage.setItem(USAGE_HISTORY_KEY, uncorrectedHistory);
  resetUsageLedgerCache();
  return { from: today, to: today };
}

it("publishes one revision for a history-only checkpoint repair and none for a no-op repeat", () => {
  const range = prepareHistoryCheckpointRepair();
  const revision = getUsageRevision();
  const before = usageDetail(range);
  expect(repriceUsageHistory()).toBeGreaterThan(0);
  expect(usageDetail(range).totals.estimatedCost).toBeGreaterThan(before.totals.estimatedCost);
  expect(getUsageRevision()).toBe(revision + 1);
  expect(repriceUsageHistory()).toBe(0);
  expect(getUsageRevision()).toBe(revision + 1);
});

it("refreshes an already mounted dashboard when only dated history is repaired", () => {
  const range = prepareHistoryCheckpointRepair();
  const before = usageDetail(range).totals.estimatedCost;
  render(createElement(UsageDashboard));
  fireEvent.click(screen.getByRole("radio", { name: "Today" }));
  const summary = within(screen.getByRole("group", { name: /^Summary/ }));
  const stat = summary.getByText("Estimated API cost").parentElement!;
  expect(stat).toHaveTextContent(before ? formatEstimatedCost(before) : "Estimated API cost—");
  act(() => { expect(repriceUsageHistory()).toBeGreaterThan(0); });
  const corrected = usageDetail(range).totals.estimatedCost;
  expect(corrected).toBeGreaterThan(before);
  expect(stat).toHaveTextContent(formatEstimatedCost(corrected));
});
