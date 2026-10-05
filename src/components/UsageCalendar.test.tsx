import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { annotateThreadUsage, flushUsageLedger, recordUsageDelta, resetUsageLedgerCache } from "../lib/usageLedger";
import { seedUsageDashboard } from "../test/usageFixture";
import { UsageCalendarCard } from "./UsageCalendar";
import { previewUsageSource } from "./usageDashboardPreview";

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

  it("reuses the dashboard's full snapshot with the same dated cells and no duplicate history query", () => {
    const preview = previewUsageSource(new Date(2026, 8, 29, 12).getTime());
    const source = { ...preview, detail: vi.fn(preview.detail) };
    const full = preview.detail(null);
    const props = { source, revision: 0, today: "2026-09-29", range: null, providerLabel: (provider: string) => provider, modelLabel: (model: string) => model };
    const readCells = () => [...grid().querySelectorAll<HTMLElement>("[data-day]")].map((cell) => ({
      day: cell.dataset.day, state: cell.dataset.state, level: cell.dataset.level, label: cell.getAttribute("aria-label"),
    }));
    const fallback = render(<UsageCalendarCard {...props} />);
    const expected = readCells();
    expect(source.detail).toHaveBeenCalledTimes(1);
    fallback.unmount();
    source.detail.mockClear();
    const outsideYear = { ...full.buckets[0], day: "2025-01-01", totalTokens: 9_000_000 };
    const snapshot = { ...full, buckets: [...full.buckets, outsideYear] };
    const supplied = render(<UsageCalendarCard {...props} calendarDetail={snapshot} />);
    expect(readCells()).toEqual(expected);
    expect(source.detail).not.toHaveBeenCalled();
    // A replacement snapshot updates recorded totals and retention metadata.
    const first = full.buckets[0];
    supplied.rerender(<UsageCalendarCard {...props} calendarDetail={{ ...snapshot, retainedFrom: "2026-09-28", buckets: [{ ...first, totalTokens: 42 }] }} />);
    expect(day(first.day)).toHaveAttribute("aria-label", expect.stringContaining("42 tokens"));
    expect(day("2026-09-27")).toHaveAttribute("data-state", "unavailable");
    expect(source.detail).not.toHaveBeenCalled();
    supplied.rerender(<UsageCalendarCard {...props} calendarDetail={{ ...snapshot, detailAhead: true }} />);
    expect(screen.queryByRole("grid", { name: /^Tokens per day/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Token activity" })).toHaveTextContent("Dated detail is hidden until it agrees with saved totals.");
  });

  it("opens after 500ms on one day, cancels skipped days, and does not restart for movement within that day", () => {
    vi.useFakeTimers();
    const source = previewUsageSource(new Date(2026, 8, 29, 12).getTime());
    const view = render(<UsageCalendarCard source={source} revision={0} today="2026-09-29" range={null} providerLabel={(provider) => provider} modelLabel={(model) => model} />);
    // jsdom has no visible geometry; the card is hidden by its clipping check.
    const card = () => view.container.querySelector(".usage-heat-card");
    fireEvent.pointerOver(day("2026-09-28")!, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.pointerOver(day("2026-09-27")!, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.pointerMove(day("2026-09-27")!, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(199); });
    expect(card()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(card()).toHaveAttribute("aria-label", "Usage on Sunday, September 27, 2026");
    fireEvent.pointerOver(day("2026-09-26")!, { pointerType: "mouse" });
    fireEvent.pointerLeave(grid(), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(card()).toBeNull();
    fireEvent.pointerOver(day("2026-09-25")!, { pointerType: "mouse" });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending hover when clicking, using the keyboard or replacing the calendar", () => {
    vi.useFakeTimers();
    const source = previewUsageSource(new Date(2026, 8, 29, 12).getTime());
    const props = { source, revision: 0, today: "2026-09-29", range: null, providerLabel: (provider: string) => provider, modelLabel: (model: string) => model };
    const view = render(<UsageCalendarCard {...props} />);
    const card = () => view.container.querySelector(".usage-heat-card");
    fireEvent.pointerOver(day("2026-09-28")!, { pointerType: "mouse" });
    fireEvent.click(day("2026-09-27")!);
    expect(card()).toHaveAttribute("aria-label", "Usage on Sunday, September 27, 2026");
    act(() => { vi.advanceTimersByTime(600); });
    expect(card()).toHaveAttribute("aria-label", "Usage on Sunday, September 27, 2026");
    fireEvent.pointerMove(document.body, { pointerType: "mouse", clientX: 20, clientY: 20 });
    fireEvent.pointerOver(day("2026-09-25")!, { pointerType: "mouse" });
    fireEvent.keyDown(day("2026-09-27")!, { key: "ArrowUp" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(card()).toHaveAttribute("aria-label", "Usage on Saturday, September 26, 2026");
    view.unmount();
    const replacement = render(<UsageCalendarCard {...props} />);
    fireEvent.pointerOver(day("2026-09-28")!, { pointerType: "mouse" });
    replacement.rerender(<UsageCalendarCard {...props} today="2026-09-30" />);
    act(() => { vi.advanceTimersByTime(600); });
    expect(replacement.container.querySelector(".usage-heat-card")).toBeNull();
  });

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
