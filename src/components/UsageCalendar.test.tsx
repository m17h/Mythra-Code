import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { annotateThreadUsage, flushUsageLedger, recordUsageDelta, resetUsageLedgerCache } from "../lib/usageLedger";
import { seedUsageDashboard } from "../test/usageFixture";

// Synthetic usage only (see usageFixture); nothing here reads real records.
const grid = () => screen.getByRole("grid", { name: /^Tokens per day/ });
const day = (key: string) => grid().querySelector<HTMLElement>(`[data-day="${key}"]`);
const usage = (tokens: number) => ({
  inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
  totalTokens: tokens, contextWindow: null, cacheReadReported: true, cacheWriteReported: true,
});

describe("usage calendar in the dashboard", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sits above the range controls and fades days outside the selected range without hiding them", () => {
    seedUsageDashboard(new Date(2026, 8, 29, 12).getTime());
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 8, 29, 12) });
    render(<UsageDashboard />);
    const calendar = screen.getByRole("region", { name: "Token activity" });
    const toolbar = screen.getByRole("radiogroup", { name: "Date range" });
    expect(calendar.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calendar).toHaveTextContent("Dated local records only");
    // Default 30 days: the day 12 days back is inside; a day 60 days back is faded.
    expect(day("2026-09-17")).not.toHaveClass("outside");
    expect(day("2026-07-31")).toHaveClass("outside");
    expect(day("2026-07-31")).toHaveAccessibleName(/outside selected range$/);
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(day("2026-09-17")).toHaveClass("outside");
    expect(day("2026-09-17")).toHaveAttribute("data-state", "active");
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(grid().querySelectorAll(".outside")).toHaveLength(0);
    expect(calendar).not.toHaveTextContent("Faded days");
  });

  it("rolls over at local midnight, and records made after it land on the new day", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date(2026, 8, 28, 23, 59, 0) });
    seedUsageDashboard(Date.now());
    render(<UsageDashboard />);
    const last = () => [...grid().querySelectorAll<HTMLElement>("[data-day]")].map((cell) => cell.dataset.day!).sort().at(-1);
    expect(last()).toBe("2026-09-28");
    expect(day("2026-09-28")).toHaveAttribute("tabindex", "0");
    const card = within(screen.getByRole("region", { name: "Token activity" }));
    expect(card.queryByText("Today so far")).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(last()).toBe("2026-09-29");
    expect(day("2026-09-29")).toHaveAttribute("data-state", "empty");
    expect(day("2026-09-29")).toHaveAccessibleName(/September 29, 2026: no recorded tokens/);
    // The tab stop follows today unless the reader moved it.
    expect(day("2026-09-29")).toHaveAttribute("tabindex", "0");
    expect(day("2026-09-28")).toHaveAttribute("tabindex", "-1");

    act(() => {
      annotateThreadUsage("after-midnight", { provider: "lmstudio", model: "local-model" });
      recordUsageDelta("after-midnight", usage(4_321), "after-midnight-1", "after-midnight-turn");
      flushUsageLedger();
    });
    expect(day("2026-09-29")).toHaveAttribute("data-state", "active");
    expect(day("2026-09-29")).toHaveAccessibleName(/September 29, 2026: 4,321 tokens/);
    // Yesterday keeps its own usage.
    expect(day("2026-09-28")).toHaveAttribute("data-state", "active");
  });
});
