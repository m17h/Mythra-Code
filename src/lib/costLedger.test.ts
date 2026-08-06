import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { costTotals, formatCost, recordThreadCost } from "./costLedger";

describe("cost ledger", () => {
  beforeEach(() => localStorage.clear());

  it("stores only cumulative deltas and sums totals", () => {
    recordThreadCost("t1", "/proj/a", 0.05);
    recordThreadCost("t1", "/proj/a", 0.12);
    recordThreadCost("t2", "/proj/b", 0.03);
    const totals = costTotals("/proj/a");
    expect(totals.project).toBeCloseTo(0.12);
    expect(totals.today).toBeCloseTo(0.15);
  });

  it("ignores invalid costs", () => {
    recordThreadCost("t1", "/proj/a", NaN);
    recordThreadCost("t1", "/proj/a", -1);
    recordThreadCost("", "/proj/a", 1);
    expect(costTotals("/proj/a")).toEqual({ today: 0, project: 0 });
  });

  it("retains complete local history", () => {
    for (let index = 0; index < 520; index += 1) recordThreadCost(`t${index}`, "/p", 0.01);
    const stored = JSON.parse(localStorage.getItem("kiwi.costLedger") ?? "[]") as unknown[];
    expect(stored).toHaveLength(520);
  });

  it("parses the stored ledger once across repeated reads", () => {
    recordThreadCost("t1", "/proj/a", 0.05);
    const parse = vi.spyOn(JSON, "parse");
    costTotals("/proj/a");
    costTotals("/proj/a");
    costTotals("/proj/a");
    // Only the first read may parse; later reads must hit the cache. `costTotals`
    // runs on every App render, so a parse per call put the whole spend history
    // on the render path.
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("picks up a ledger replaced outside this module", () => {
    recordThreadCost("t1", "/proj/a", 0.05);
    expect(costTotals("/proj/a").project).toBeCloseTo(0.05);
    localStorage.setItem(
      "kiwi.costLedger",
      JSON.stringify([{ threadId: "t9", projectPath: "/proj/a", cost: 0.5, day: new Date().toISOString().slice(0, 10), updatedAt: Date.now() }]),
    );
    expect(costTotals("/proj/a").project).toBeCloseTo(0.5);
  });

  it("formats sub-cent costs with more precision", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(0)).toBe("$0");
  });
});
