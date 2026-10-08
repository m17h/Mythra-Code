import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { UsageCalendarCard } from "./UsageCalendar";
import { usageDetail } from "../lib/usageSummary";
import { annotateThreadUsage, flushUsageLedger, recordUsageDelta, resetUsageLedgerCache, type UsageProvider } from "../lib/usageLedger";
import { localDayKey, shiftDayKey } from "../lib/usageHistory";
import type { ThemeName } from "../types";
// Attach dated detail synchronously; the app loads it on first usage instead.
import "../lib/usageHistory";
import "../styles.css";

/*
 * Clearly synthetic usage recorded through the real ledger and dated-detail
 * path. Nothing here reads real account, usage or conversation data.
 */
const DAY_MS = 86_400_000;
const NOON = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
const TODAY = localDayKey(NOON);
const dayAgo = (days: number) => shiftDayKey(TODAY, -days);

let sequence = 0;
function record(daysAgo: number, provider: Exclude<UsageProvider, "unknown"> | null, model: string, tokens: number) {
  const realNow = Date.now;
  Date.now = () => NOON - daysAgo * DAY_MS;
  try {
    const thread = `calendar-${sequence += 1}`;
    if (provider) annotateThreadUsage(thread, { provider, model, ...(provider === "openai" ? { requestedServiceTier: "standard" } : {}) });
    recordUsageDelta(thread, {
      inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
      totalTokens: tokens, contextWindow: null, cacheReadReported: true, cacheWriteReported: true,
    }, `${thread}-event`, `${thread}-turn`);
  } finally { Date.now = realNow; }
}

/** Tracking begins 40 days back; a busy multi-provider day, sparse days and one unknown-provider day. */
function seed({ manyModels = 0 } = {}) {
  resetUsageLedgerCache();
  localStorage.clear();
  resetUsageLedgerCache();
  record(40, "claude", "claude-sonnet-5", 20);
  record(2, "openai", "gpt-6-sol", 6_000);
  record(2, "openai", "gpt-6-luna", 1_000);
  record(2, "claude", "claude-opus-5-5", 2_500);
  record(2, "cursor", "auto", 400);
  record(2, "openrouter", "vendor/preview-model", 90);
  record(2, "lmstudio", "local-model", 10);
  record(5, null, "", 700);
  record(6, "claude", "claude-haiku-4-5", 1);
  for (let index = 0; index < manyModels; index += 1) {
    record(1, index % 2 ? "openrouter" : "lmstudio", `synthetic/model-${String(index).padStart(2, "0")}`, 100 + index);
  }
  flushUsageLedger();
}

function mount({ width = 928, theme = "mythra", scheme = "dark", zoom = 1, height }: { width?: number; theme?: ThemeName; scheme?: "dark" | "light"; zoom?: number; height?: number } = {}) {
  const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={scheme} style={{ display: "block", zoom }}>
    {/* Settings' own scrolling pane, which must never clip the day card. */}
    <div className="settings-content" data-testid="scroller" style={{ width, height: height ?? "auto", overflow: height ? "auto" : "visible", padding: 16, boxSizing: "border-box" }}>
      <UsageDashboard />
    </div>
  </div>);
  const calendar = view.getByRole("region", { name: "Token activity" });
  const grid = within(calendar).getByRole("grid", { name: /^Tokens per day/ });
  const cell = (day: string) => grid.querySelector<HTMLElement>(`[data-day="${day}"]`)!;
  const card = () => document.querySelector<HTMLElement>(".usage-heat-card");
  return { view, calendar, grid, cell, card, scroller: view.getByTestId("scroller") };
}

/** Playwright's pointer outlives a test; move it off the calendar. */
async function parkPointer() {
  await userEvent.hover(document.querySelector("h4")!);
  await waitFor(() => expect(document.querySelector(".usage-heat-card")).toBeNull());
}

/** Start a fresh hover without carrying the preceding day's intent timer. */
async function hoverDay(target: HTMLElement) {
  await userEvent.hover(document.querySelector("h4")!);
  await waitFor(() => expect(document.querySelector(".usage-heat-card")).toBeNull());
  await userEvent.hover(target);
}

function expectInViewport(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual(7.5);
  expect(box.left).toBeGreaterThanOrEqual(7.5);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight - 7.5);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth - 7.5);
}

/** The card is really painted on top: nothing (including a scroll clip) covers its middle. */
function expectUnclipped(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  for (const [x, y] of [[box.left + 4, box.top + 4], [box.left + box.width / 2, box.top + box.height / 2], [box.right - 4, box.bottom - 4]]) {
    expect(element.contains(document.elementFromPoint(x, y))).toBe(true);
  }
}

function rgb(value: string): [number, number, number, number] {
  const numbers = value.match(/[\d.]+/g)!.map(Number);
  if (value.startsWith("color(")) return [numbers[0] * 255, numbers[1] * 255, numbers[2] * 255, numbers[3] ?? 1];
  return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
}
function luminance([r, g, b]: number[]) {
  const linear = (channel: number) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function contrast(left: number[], right: number[]) {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe("usage calendar", () => {
  beforeEach(async () => { await page.viewport(1400, 900); });
  afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

  it("waits exactly 500ms on the current day and cancels skipped-day hover intent", async () => {
    seed();
    const { cell, card } = mount();
    await parkPointer();
    // Trusted hover uses a runner round trip. Control only the timeout clock
    // so transport/scheduling delay cannot consume the intent window; rAF,
    // rendering, native pointer events and hit-testing remain real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await userEvent.hover(cell(dayAgo(2)));
      act(() => { vi.advanceTimersByTime(200); });
      expect(card()).toBeNull();
      await userEvent.hover(cell(dayAgo(5)));
      // Cross the skipped day's old deadline, still before the new deadline.
      act(() => { vi.advanceTimersByTime(300); });
      expect(card()).toBeNull();
      act(() => { vi.advanceTimersByTime(199); });
      expect(card()).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(card()).toHaveTextContent("Unknown provider");
      expect(card()).not.toHaveTextContent("10,000");
    } finally { vi.useRealTimers(); }
  });

  it("opens a hit-testable breakdown after real hover intent from a trusted pointer", async () => {
    seed();
    const { cell, card } = mount();
    await parkPointer();
    const target = cell(dayAgo(2));
    let enteredAt: number | null = null;
    let openedAt: number | null = null;
    let trusted = false;
    const onOver = (event: PointerEvent) => {
      if (event.target !== target || enteredAt !== null) return;
      enteredAt = performance.now();
      trusted = event.isTrusted;
    };
    // Observe onset inside the page, before awaiting the hover RPC. A slow
    // command return must not turn a correct 500ms delay into an early-open
    // failure. Mutation delivery records the first committed breakdown.
    const observer = new MutationObserver(() => {
      if (card() && openedAt === null) openedAt = performance.now();
    });
    document.addEventListener("pointerover", onOver, true);
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await userEvent.hover(target);
      await waitFor(() => expect(card()).toHaveTextContent("10,000"));
      expect(trusted).toBe(true);
      expect(enteredAt).not.toBeNull();
      expect(openedAt).not.toBeNull();
      // Allow one millisecond for browser clock/timer resolution.
      expect(openedAt! - enteredAt!).toBeGreaterThanOrEqual(499);
      await waitFor(() => expectUnclipped(card()!));
    } finally {
      document.removeEventListener("pointerover", onOver, true);
      observer.disconnect();
    }
  });

  it("lets the real pointer explore neighboring days while a detailed popup is open", async () => {
    seed();
    const { cell, card, grid } = mount();
    await parkPointer();
    await userEvent.hover(cell(dayAgo(2)));
    await waitFor(() => expect(card()).toHaveTextContent("10,000"));
    const popup = card()!.getBoundingClientRect();
    const squares = [...grid.querySelectorAll<HTMLElement>("[data-day]")];
    for (const square of squares) {
      const box = square.getBoundingClientRect();
      expect(popup.bottom <= box.top || popup.top >= box.bottom).toBe(true);
      expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(square);
    }
    // No parking the pointer outside the calendar to get around the popup.
    await userEvent.hover(cell(dayAgo(5)));
    await waitFor(() => expect(card()).toHaveTextContent("Unknown provider"));
    await userEvent.hover(cell(dayAgo(3)));
    await waitFor(() => expect(card()).toHaveTextContent("No tokens recorded on this day."));
  });

  it("keeps days reachable when a very short zoomed viewport forces overlap, and pins the list for scrolling", async () => {
    seed({ manyModels: 40 });
    await page.viewport(900, 260);
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark"
      style={{ display: "block", zoom: 1.5, height: 260 / 1.5, overflow: "clip" }}>
      <div className="usage-dashboard" style={{ width: 580 }}>
        <UsageCalendarCard source={{ detail: usageDetail, reported: () => ({ cost: 0, requests: 0 }) }} revision={0} today={TODAY} range={null}
          providerLabel={(provider) => provider} modelLabel={(model) => model} />
      </div>
    </div>);
    const calendar = view.getByRole("region", { name: "Token activity" });
    const grid = within(calendar).getByRole("grid", { name: /^Tokens per day/ });
    const card = () => document.querySelector<HTMLElement>(".usage-heat-card");
    const target = grid.querySelector<HTMLElement>(`[data-day="${dayAgo(1)}"]`)!;
    // Center the painted grid so neither side can fit a readable popup.
    // The bounded shell prevents auto-scrolling from moving it out of this
    // geometry, independently of each engine's scrollIntoView behavior.
    const table = grid.getBoundingClientRect();
    calendar.style.marginTop = `${(window.innerHeight / 2 - (table.top + table.height / 2)) / 1.5}px`;
    await userEvent.hover(target);
    await waitFor(() => expect(card()).not.toBeNull());
    const shown = card()!;
    expect(shown.dataset.overlapsGrid).toBe("true");
    expect(getComputedStyle(shown).pointerEvents).toBe("none");
    await waitFor(() => expect(within(shown).getByText("Click a day to keep details open and scroll.")).toBeVisible());
    const box = target.getBoundingClientRect();
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(target);
    await userEvent.click(target);
    expect(shown.dataset.pinned).toBe("true");
    expect(getComputedStyle(shown).pointerEvents).toBe("auto");
    const list = within(shown).getByRole("region", { name: /^Providers and models on / });
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    list.focus();
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await userEvent.keyboard("{Escape}");
    expect(card()).toBeNull();
  });

  it("cancels another day's intent while moving into the open scrollable breakdown", async () => {
    seed({ manyModels: 40 });
    const { cell, card } = mount();
    await parkPointer();
    await userEvent.hover(cell(dayAgo(1)));
    await waitFor(() => expect(card()?.querySelectorAll("li")).toHaveLength(40));
    const shown = card()!;
    // Enter the card before another day's intent expires. Browser-command
    // transport can exceed 500ms on a busy runner; control only timeout time
    // so that delay cannot turn this cancellation check into a day switch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await userEvent.hover(cell(dayAgo(2)));
      await userEvent.hover(shown.querySelector<HTMLElement>(".usage-heat-card-list")!);
      act(() => { vi.advanceTimersByTime(600); });
      expect(card()).toBe(shown);
      expect(card()?.querySelectorAll("li")).toHaveLength(40);
    } finally { vi.useRealTimers(); }
  });

  it("shows every provider and model for a hovered day as shares of that day's total tokens", async () => {
    seed();
    const { cell, card } = mount();
    expect(cell(dayAgo(2))).toHaveAccessibleName(new RegExp(`: 10,000 tokens$`));
    await userEvent.hover(cell(dayAgo(2)));
    await waitFor(() => expect(card()).not.toBeNull());
    const shown = card()!;
    expect(shown.matches(":popover-open")).toBe(true);
    expect(shown).toHaveAccessibleName(/^Usage on /);
    expect(cell(dayAgo(2))).toHaveAttribute("aria-describedby", shown.id);
    const text = within(shown);
    expect(text.getByText("Total tokens").parentElement).toHaveTextContent("10,000");
    const provider = (name: string) => text.getByText(name).closest("section")!;
    const rows = (name: string) => [...provider(name).querySelectorAll("h6, li")].map((row) => [...row.children].map((part) => part.textContent));
    expect(rows("OpenAI / Codex")).toEqual([["OpenAI / Codex", "7,000", "70.0%"], ["GPT-6 Sol", "6,000", "60.0%"], ["GPT-6 Luna", "1,000", "10.0%"]]);
    expect(rows("Claude Code")).toEqual([["Claude Code", "2,500", "25.0%"], ["Claude Opus 5.5", "2,500", "25.0%"]]);
    expect(rows("Cursor")).toEqual([["Cursor", "400", "4.0%"], ["Auto", "400", "4.0%"]]);
    expect(rows("OpenRouter")).toEqual([["OpenRouter", "90", "0.9%"], ["vendor/preview-model", "90", "0.9%"]]);
    expect(rows("LM Studio")).toEqual([["LM Studio", "10", "0.1%"], ["local-model", "10", "0.1%"]]);
    expect(shown).toHaveTextContent("Percentages are shares of this day’s total tokens.");
    expectInViewport(shown);
    expectUnclipped(shown);
    // Outside the entire grid, leaving every other day visible and reachable.
    const [box, table] = [shown.getBoundingClientRect(), cell(dayAgo(2)).closest("table")!.getBoundingClientRect()];
    const gap = box.bottom <= table.top ? table.top - box.bottom : box.top - table.bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(3);

    // The card stays while the pointer moves into it, then closes after it leaves.
    await userEvent.hover(shown);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(card()).toBe(shown);
    await userEvent.hover(document.querySelector("h4")!);
    await waitFor(() => expect(card()).toBeNull());
  });

  it("names unknown providers and models, tracked days with nothing and days before tracking", async () => {
    seed();
    const { cell, card } = mount();
    await userEvent.hover(cell(dayAgo(5)));
    await waitFor(() => expect(card()).toHaveTextContent("Unknown provider"));
    expect(card()).toHaveTextContent("Unknown model (not reported)");
    expect(card()).toHaveTextContent("100.0%");

    expect(cell(dayAgo(3))).toHaveAttribute("data-state", "empty");
    expect(cell(dayAgo(3))).toHaveAccessibleName(/: no recorded tokens$/);
    await hoverDay(cell(dayAgo(3)));
    await waitFor(() => expect(card()).toHaveTextContent("No tokens recorded on this day."));
    expect(within(card()!).getByText("Total tokens").parentElement).toHaveTextContent("0");

    expect(cell(dayAgo(41))).toHaveAttribute("data-state", "unavailable");
    expect(cell(dayAgo(41))).toHaveAccessibleName(/: not tracked/);
    await hoverDay(cell(dayAgo(41)));
    await waitFor(() => expect(card()).toHaveTextContent(/Not tracked: dated usage tracking began/));
    expect(card()).not.toHaveTextContent("Total tokens");

    const empty = getComputedStyle(cell(dayAgo(3)));
    const untracked = getComputedStyle(cell(dayAgo(41)));
    expect(rgb(empty.backgroundColor)[3]).toBeGreaterThan(0.9);
    expect(rgb(untracked.backgroundColor)[3]).toBe(0);
    expect(untracked.boxShadow).not.toBe("none");

    await hoverDay(cell(TODAY));
    await waitFor(() => expect(card()).toHaveTextContent("Today so far"));
  });

  it("colors sparse days lighter than busy ones, distinctly in every theme", async () => {
    seed();
    const themes: Array<[ThemeName, "dark" | "light"]> = [
      ["mythra", "dark"], ["light-mythra", "light"], ["kiwi", "dark"], ["daylight", "light"],
      ["synthwave", "dark"], ["atari", "light"],
    ];
    for (const [theme, scheme] of themes) {
      const { view, calendar, cell } = mount({ theme, scheme });
      expect(cell(dayAgo(2)).dataset.level).toBe("4");
      expect(cell(dayAgo(6)).dataset.level).toBe("1");
      const field = rgb(getComputedStyle(calendar).backgroundColor);
      const swatches = [...calendar.querySelectorAll<HTMLElement>('.usage-heat-legend [data-level]')].map((swatch) => rgb(getComputedStyle(swatch).backgroundColor));
      expect(swatches).toHaveLength(5);
      const ratios = swatches.map((color) => contrast(color, field));
      for (let level = 1; level < ratios.length; level += 1) expect(ratios[level], `${theme} level ${level}`).toBeGreaterThan(ratios[level - 1] + 0.15);
      expect(ratios[4], `${theme} strongest`).toBeGreaterThanOrEqual(3);
      expect(new Set(swatches.map((color) => color.slice(0, 3).map(Math.round).join())).size).toBe(5);
      view.unmount();
    }
  });

  it("navigates days from the keyboard, and Escape closes the card before it can reach Settings", async () => {
    seed();
    const { view, cell, card, grid } = mount();
    await parkPointer();
    // Settings closes from a bubbling document listener, like this one.
    const escapes: boolean[] = [];
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") escapes.push(event.defaultPrevented); };
    document.addEventListener("keydown", listener);
    try {
      view.getByRole("radio", { name: "30 days" });
      // Only one square is a tab stop: today.
      expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
      const before = document.createElement("button");
      grid.closest("section")!.prepend(before);
      before.focus();
      await userEvent.tab();
      expect(cell(TODAY)).toHaveFocus();
      await waitFor(() => expect(card()).toHaveAccessibleName(/^Usage on /));
      expect(cell(TODAY)).toHaveAttribute("aria-describedby", card()!.id);

      await userEvent.keyboard("{ArrowUp}{ArrowUp}");
      expect(cell(dayAgo(2))).toHaveFocus();
      expect(cell(dayAgo(2))).toHaveAttribute("tabindex", "0");
      await waitFor(() => expect(card()).toHaveTextContent("10,000"));
      await userEvent.keyboard("{ArrowLeft}");
      expect(cell(dayAgo(9))).toHaveFocus();
      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      // Nothing after today: the move is ignored rather than wrapping.
      expect(cell(dayAgo(2))).toHaveFocus();
      // Home and End stay on the same weekday row.
      await userEvent.keyboard("{Home}");
      const first = (document.activeElement as HTMLElement).dataset.day!;
      expect(first <= dayAgo(358)).toBe(true);
      expect(new Date(`${first}T12:00`).getDay()).toBe(new Date(`${dayAgo(2)}T12:00`).getDay());
      expect(cell(shiftDayKey(first, -7))).toBeNull();
      await userEvent.keyboard("{End}");
      expect(cell(dayAgo(2))).toHaveFocus();

      await userEvent.keyboard("{Escape}");
      expect(card()).toBeNull();
      expect(cell(dayAgo(2))).toHaveFocus();
      expect(escapes).toEqual([]);
      // With nothing open, Escape is left for Settings.
      await userEvent.keyboard("{Escape}");
      expect(escapes).toEqual([false]);

      // Enter pins the day; its list takes focus next and scrolls from the keyboard.
      await userEvent.keyboard("{Enter}");
      expect(cell(dayAgo(2))).toHaveAttribute("aria-selected", "true");
      await userEvent.tab();
      expect(within(card()!).getByRole("region", { name: /^Providers and models on / })).toHaveFocus();
      // Escape from inside the card returns focus to its day.
      await userEvent.keyboard("{Escape}");
      expect(card()).toBeNull();
      expect(cell(dayAgo(2))).toHaveFocus();
      expect(cell(dayAgo(2))).not.toHaveAttribute("aria-describedby");
      await userEvent.keyboard("{Enter}");
      await userEvent.tab();
      expect(within(card()!).getByRole("region", { name: /^Providers and models on / })).toHaveFocus();
      // Tabbing on out closes the card; no hidden focus stop remains.
      await userEvent.tab();
      await waitFor(() => expect(card()).toBeNull());
      expect(cell(dayAgo(2))).toHaveAttribute("aria-selected", "false");
    } finally { document.removeEventListener("keydown", listener); }
  });

  it("selects a day with a tap, keeps it without hover and releases it on an outside tap", async () => {
    seed();
    const { cell, card } = mount();
    await parkPointer();
    fireEvent.pointerOver(cell(dayAgo(2)), { pointerType: "touch" });
    expect(card()).toBeNull();
    fireEvent.pointerDown(cell(dayAgo(2)), { pointerType: "touch" });
    fireEvent.click(cell(dayAgo(2)));
    await waitFor(() => expect(card()).toHaveTextContent("10,000"));
    expect(cell(dayAgo(2))).toHaveAttribute("aria-selected", "true");
    fireEvent.pointerLeave(cell(dayAgo(2)).closest("table")!, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(card()).not.toBeNull();
    // A tap on another day moves the selection.
    fireEvent.click(cell(dayAgo(5)));
    await waitFor(() => expect(card()).toHaveTextContent("Unknown provider"));
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    await waitFor(() => expect(card()).toBeNull());
    expect(cell(dayAgo(5))).toHaveAttribute("aria-selected", "false");
  });

  it("keeps a long breakdown scrollable, hoverable and inside a short, zoomed viewport", async () => {
    seed({ manyModels: 40 });
    await page.viewport(900, 460);
    const { cell, card, scroller } = mount({ width: 860, zoom: 1.25, height: 360 });
    const target = cell(dayAgo(1));
    // Keep enough room above the grid for every weekday row. Centering
    // yesterday can leave neither side enough room after the scroll.
    target.scrollIntoView({ block: "end" });
    fireEvent.click(target);
    await waitFor(() => expect(card()).not.toBeNull());
    const shown = card()!;
    expectInViewport(shown);
    expectUnclipped(shown);
    const list = shown.querySelector<HTMLElement>(".usage-heat-card-list")!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(shown.querySelectorAll("li")).toHaveLength(40);
    // The header and total stay put while the list scrolls.
    list.scrollTop = list.scrollHeight;
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await Promise.all(shown.getAnimations().map((animation) => animation.finished));
    expect(within(shown).getByText("Total tokens")).toBeVisible();

    // It follows the grid as Settings scrolls, and hides once its square leaves view.
    const attachedGap = () => {
      const [box, table] = [shown.getBoundingClientRect(), target.closest("table")!.getBoundingClientRect()];
      return box.bottom <= table.top + 0.5 ? table.top - box.bottom : box.top - table.bottom;
    };
    const before = target.getBoundingClientRect().top;
    const scrollBefore = scroller.scrollTop;
    scroller.scrollTop += 20;
    const movement = before - target.getBoundingClientRect().top;
    // WebKit quantizes scroll offsets at fractional zoom. Verify the actual
    // movement against the applied scroll, allowing one zoomed CSS pixel;
    // the attachment and clipping assertions below still test the behavior.
    expect(movement).toBeGreaterThan(20);
    expect(Math.abs(movement - (scroller.scrollTop - scrollBefore) * 1.25)).toBeLessThanOrEqual(1.25);
    // Re-placed on the next frame while remaining attached to the whole grid.
    await waitFor(() => { expect(attachedGap()).toBeGreaterThanOrEqual(0); expect(attachedGap()).toBeLessThan(3); });
    expectInViewport(shown);
    expect(getComputedStyle(shown).visibility).toBe("visible");
    scroller.scrollTop = scroller.scrollHeight;
    await waitFor(() => expect(getComputedStyle(shown).visibility).toBe("hidden"));
  });

  it("without the Popover API, stays inside a transformed, clipping sheet and keeps keyboard order", async () => {
    seed({ manyModels: 30 });
    await page.viewport(1000, 640);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value: undefined });
    try {
      // Like Settings: a transformed, overflow-hidden sheet around a scrolling pane.
      const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
        <div data-testid="sheet" style={{ position: "fixed", inset: 40, transform: "translateY(0) scale(1)", overflow: "hidden" }}>
          <div className="settings-content" style={{ height: "100%", overflow: "auto", padding: 16, boxSizing: "border-box" }}>
            <UsageDashboard />
          </div>
        </div>
      </div>);
      const sheet = view.getByTestId("sheet").getBoundingClientRect();
      const grid = view.getByRole("grid", { name: /^Tokens per day/ });
      const target = grid.querySelector<HTMLElement>(`[data-day="${dayAgo(1)}"]`)!;
      target.focus();
      await userEvent.keyboard("{Enter}");
      const card = view.getByRole("group", { name: /^Usage on / });
      expect(card).not.toHaveAttribute("popover");
      // Placement must survive the dashboard entrance releasing its animated
      // styles, even when keyboard focus opened the fallback card mid-entrance.
      for (const animation of view.container.querySelector<HTMLElement>(".usage-dashboard")!.getAnimations()) animation.finish();
      const box = card.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(sheet.top);
      expect(box.bottom).toBeLessThanOrEqual(sheet.bottom);
      expect(box.left).toBeGreaterThanOrEqual(sheet.left);
      expect(box.right).toBeLessThanOrEqual(sheet.right);
      expectUnclipped(card);
      await userEvent.keyboard("{Tab}");
      expect(within(card).getByRole("region", { name: /^Providers and models on / })).toHaveFocus();
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(target).toHaveFocus();
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    }
  });

  it("updates an open card when new usage is recorded", async () => {
    seed();
    const { cell, card } = mount();
    fireEvent.click(cell(TODAY));
    await waitFor(() => expect(card()).toHaveTextContent("No tokens recorded on this day."));
    act(() => { record(0, "claude", "claude-opus-5-5", 1_234); record(0, "openai", "gpt-6-sol", 766); flushUsageLedger(); });
    await waitFor(() => expect(card()).toHaveTextContent("2,000"));
    expect(card()).toHaveTextContent("61.7%");
    expect(card()).toHaveTextContent("38.3%");
    expect(cell(TODAY)).toHaveAccessibleName(/: 2,000 tokens$/);
    // 2,000 of the busiest day's 10,000: ceil(4 × √0.2) = step 2.
    expect(cell(TODAY).dataset.level).toBe("2");
    expect(cell(dayAgo(2)).dataset.level).toBe("4");
  });

  it.each([928, 640, 320])("fits a %ipx panel, sized squares, today in view", async (width) => {
    seed();
    const { calendar, cell } = mount({ width });
    const dashboard = calendar.closest<HTMLElement>(".usage-dashboard")!;
    expect(dashboard.scrollWidth).toBeLessThanOrEqual(dashboard.clientWidth + 1);
    const scroll = calendar.querySelector<HTMLElement>(".usage-heat-scroll")!;
    expect(scroll.getBoundingClientRect().right).toBeLessThanOrEqual(calendar.getBoundingClientRect().right);
    const size = cell(TODAY).getBoundingClientRect();
    expect(size.width).toBeGreaterThanOrEqual(9.5);
    expect(size.width).toBeLessThanOrEqual(14.5);
    expect(Math.abs(size.width - size.height)).toBeLessThan(0.6);
    if (width >= 900) expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
    // The newest week is always visible without scrolling.
    const box = scroll.getBoundingClientRect();
    expect(size.right).toBeLessThanOrEqual(box.right + 0.5);
    expect(size.left).toBeGreaterThanOrEqual(box.left - 0.5);
    await page.screenshot({ element: calendar, path: `../../test-results/usage-calendar-${width}.png` });
  });

  it("respects reduced motion for the card", async () => {
    seed();
    await commands.setStreamTestReducedMotion(true);
    const { cell, card } = mount();
    fireEvent.click(cell(dayAgo(2)));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(getComputedStyle(card()!).animationName).toBe("none");
  });
});
