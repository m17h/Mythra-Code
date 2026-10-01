import { useRef, type CSSProperties } from "react";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageCalendarCard } from "./UsageCalendar";
import type { UsageDashboardSource } from "./usageDashboardPreview";
import { emptyComponentAmounts, shiftDayKey, type UsageBucket } from "../lib/usageHistory";
import { combineUsageDetail, summarizeUsageBuckets } from "../lib/usageSummary";
import { usageCalendarRange } from "../lib/usageCalendar";
import { useModalFocus } from "../hooks/useModalFocus";
import "../styles.css";
import "./UsageDashboard.css";

const TODAY = "2026-09-29";
const PROVIDERS = ["openai", "claude", "cursor", "openrouter"] as const;

function sourceFor(models = 2, multiplier = 1): UsageDashboardSource {
  const buckets: UsageBucket[] = Array.from({ length: models }, (_, index) => ({
    ...emptyComponentAmounts(), day: TODAY, provider: PROVIDERS[index % PROVIDERS.length],
    model: models > 2 ? `vendor/model-with-a-very-long-name-and-version-${index.toString().padStart(2, "0")}` : `model-${index}`,
    totalTokens: (index + 1) * 100 * multiplier, uncachedInputTokens: (index + 1) * 100 * multiplier,
  }));
  buckets.push({ ...emptyComponentAmounts(), day: shiftDayKey(TODAY, -7), provider: "openai", model: "earlier-model", totalTokens: 50, uncachedInputTokens: 50 });
  return {
    reported: () => ({ cost: 0, requests: 0 }),
    detail: (range) => combineUsageDetail(summarizeUsageBuckets(buckets, range, usageCalendarRange(TODAY).from), null),
  };
}

function calendar(source = sourceFor(), revision = 1) {
  return <UsageCalendarCard source={source} revision={revision} today={TODAY} range={null} providerLabel={(provider) => provider} modelLabel={(model) => model} />;
}

function mount(source = sourceFor(), skippedControls?: "both" | "hidden") {
  return render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width: 928, padding: 16 }}>
    <button>Before calendar</button><div className="usage-dashboard">{calendar(source)}</div>
    {skippedControls === "both" && <button tabIndex={-1}>Excluded from sequential focus</button>}
    {skippedControls && <button style={{ visibility: "hidden" }}>Hidden sequential control</button>}
    <button>After calendar</button><div>Outside calendar surface</div>
  </div>);
}

function SettingsFrame({ source, scale, scheme }: { source: UsageDashboardSource; scale: number; scheme: "light" | "dark" }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true);
  return <div className="app-shell" data-theme={scheme === "light" ? "light-mythra" : "mythra"} data-color-scheme={scheme}
    style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <div className="modal-backdrop settings-backdrop open">
      <div ref={dialog} className="settings-modal settings-modal-wide" role="dialog" aria-label="Calendar review settings">
        <div className="settings-layout">
          <nav className="settings-nav"><button data-autofocus>Usage</button></nav>
          <div className="settings-pane">
            <div className="settings-pane-heading"><h3>Usage</h3></div>
            <div className="settings-content">
              <div className="usage-dashboard">{calendar(source)}</div>
              <div style={{ height: 900 }} /><button>End of usage content</button>
            </div>
          </div>
        </div>
        <div className="modal-footer"><button>Close review settings</button></div>
      </div>
    </div>
  </div>;
}

const todayCell = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>(`[data-day="${TODAY}"]`)!;
const cardFor = (view: ReturnType<typeof render>) => view.getByRole("group", { name: /^Usage on / });
function finishMotion(view: ReturnType<typeof render>) {
  act(() => view.container.querySelectorAll<HTMLElement>("*").forEach((element) => element.getAnimations().forEach((animation) => animation.finish())));
}

beforeEach(async () => { await page.viewport(1400, 900); await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { await commands.setStreamTestReducedMotion(false); await page.viewport(1400, 900); });

describe("usage calendar independent interaction review", () => {
  it("lets keyboard navigation take over an earlier hover without disabling later pointer use", async () => {
    const view = mount();
    const previous = view.container.querySelector<HTMLElement>(`[data-day="${shiftDayKey(TODAY, -7)}"]`)!;
    await page.getByRole("gridcell", { name: previous.getAttribute("aria-label")! }).hover();
    expect(cardFor(view)).toHaveTextContent("earlier-model");
    // Moving focus does not move the real mouse. Its older hover must not
    // override the newly requested keyboard breakdown.
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(todayCell(view)).toHaveFocus();
    expect(cardFor(view)).toHaveTextContent("300");
    await userEvent.keyboard("{ArrowLeft}");
    expect(previous).toHaveFocus();
    expect(cardFor(view)).toHaveTextContent("earlier-model");
    await page.getByRole("gridcell", { name: todayCell(view).getAttribute("aria-label")! }).hover();
    expect(cardFor(view)).toHaveTextContent("300");
  });

  it("uses one day tab stop, arrow navigation, pinning, and an Escape that does not reach Settings", async () => {
    const view = mount();
    const grid = view.getByRole("grid");
    expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(todayCell(view)).toHaveFocus();
    expect(cardFor(view)).toHaveTextContent("300");
    await userEvent.keyboard("{ArrowLeft}");
    const previous = grid.querySelector<HTMLElement>(`[data-day="${shiftDayKey(TODAY, -7)}"]`)!;
    expect(previous).toHaveFocus();
    expect(previous).toHaveAccessibleName(/50 tokens/);
    expect(cardFor(view)).toHaveTextContent("earlier-model");
    await userEvent.keyboard("{Enter}");
    expect(previous).toHaveAttribute("aria-selected", "true");
    const closeSettings = vi.fn();
    const settingsEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeSettings(); };
    document.addEventListener("keydown", settingsEscape);
    try {
      await userEvent.keyboard("{Escape}");
      expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
      expect(previous).toHaveFocus();
      expect(previous).toHaveAttribute("aria-selected", "false");
      expect(closeSettings).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      expect(closeSettings).toHaveBeenCalledOnce();
    } finally { document.removeEventListener("keydown", settingsEscape); }
  });

  it("keeps a pointer-opened breakdown available while travelling from the day into its card", async () => {
    const view = mount();
    await page.getByRole("gridcell", { name: todayCell(view).getAttribute("aria-label")! }).hover();
    const card = cardFor(view);
    expect(card).toBeVisible();
    expect(todayCell(view)).toHaveAttribute("aria-describedby", card.id);
    await page.getByRole("group", { name: card.getAttribute("aria-label")! }).hover();
    await new Promise((resolve) => window.setTimeout(resolve, 240));
    expect(cardFor(view)).toBeVisible();
    await page.getByRole("button", { name: "After calendar" }).hover();
    await waitFor(() => expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull());
  });

  it("pins dense details for keyboard scrolling, wraps long names, and closes when Tab leaves the calendar", async () => {
    const view = mount(sourceFor(44));
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}{Enter}{Tab}");
    const list = view.getByRole("region", { name: /^Providers and models on / });
    expect(list).toHaveFocus();
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(getComputedStyle(list).overflowY).toBe("auto");
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    expect(within(list).getAllByRole("listitem")).toHaveLength(44);
    await userEvent.keyboard("{Tab}");
    expect(view.getByRole("button", { name: "After calendar" })).toHaveFocus();
    expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
  });

  it("dismisses a keyboard-pinned card when clicking a nonfocusable surface outside the calendar", async () => {
    const view = mount();
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}{Enter}");
    expect(todayCell(view)).toHaveAttribute("aria-selected", "true");
    expect(cardFor(view)).toBeVisible();
    await page.getByText("Outside calendar surface").click();
    expect(todayCell(view)).toHaveAttribute("aria-selected", "false");
    expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
  });

  it("restores the focused day when Escape dismisses a pinned card from its model-list region", async () => {
    const view = mount(sourceFor(44));
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}{Enter}{Tab}");
    expect(view.getByRole("region", { name: /^Providers and models on / })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
    expect(todayCell(view)).toHaveFocus();
    expect(todayCell(view)).toHaveAttribute("aria-selected", "false");
    expect(todayCell(view)).not.toHaveAttribute("aria-describedby");
  });

  it("reopens the keyboard breakdown when returning to its day after Escape and Tab out", async () => {
    const view = mount();
    view.getByRole("button", { name: "Before calendar" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(todayCell(view)).toHaveFocus();
    expect(cardFor(view)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
    await userEvent.keyboard("{Tab}");
    expect(view.getByRole("button", { name: "After calendar" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(todayCell(view)).toHaveFocus();
    expect(cardFor(view)).toBeVisible();
  });

  it("follows sequential Tab order from pinned details past negative-tabindex and visibility-hidden controls", async () => {
    for (const skippedControls of ["both", "hidden"] as const) {
      const view = mount(sourceFor(44), skippedControls);
      try {
        view.getByRole("button", { name: "Before calendar" }).focus();
        await userEvent.keyboard("{Tab}{Enter}{Tab}");
        expect(view.getByRole("region", { name: /^Providers and models on / })).toHaveFocus();
        await userEvent.keyboard("{Tab}");
        expect.soft(view.getByRole("button", { name: "After calendar" }), `Tab skips ${skippedControls} controls`).toHaveFocus();
        expect.soft(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
      } finally { view.unmount(); }
    }
  });

  it.each([[360, 400, 1, "light"], [980, 480, 1.5, "dark"]] as const)(
    "keeps the newest day, pinned card and dense details inside %ix%i Settings at %s scale in %s",
    async (width, height, scale, scheme) => {
      await page.viewport(width, height);
      const view = render(<SettingsFrame source={sourceFor(44)} scale={scale} scheme={scheme} />);
      finishMotion(view);
      const dialog = view.getByRole("dialog");
      const content = dialog.querySelector<HTMLElement>(".settings-content")!;
      expect(content.clientHeight).toBeGreaterThan(0);
      expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
      const scroller = view.container.querySelector<HTMLElement>(".usage-heat-scroll")!;
      expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
      expect(scroller.scrollLeft).toBeGreaterThan(0);
      todayCell(view).focus();
      await userEvent.keyboard("{Enter}");
      // WebKit can finish the focus-induced scroll before the card's next
      // animation-frame placement. Await its accessible, visible state.
      const card = await view.findByRole("group", { name: /^Usage on / });
      expect(card).toBeVisible();
      await waitFor(() => {
        const bounds = card.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(7);
        expect(bounds.top).toBeGreaterThanOrEqual(7);
        expect(bounds.right).toBeLessThanOrEqual(width - 7);
        expect(bounds.bottom).toBeLessThanOrEqual(height - 7);
      });
      expect(card.matches(":popover-open")).toBe(true);
      const list = view.getByRole("region", { name: /^Providers and models on / });
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
      const target = card.querySelector<HTMLElement>(".usage-heat-card-total")!;
      const bounds = target.getBoundingClientRect();
      expect(card.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
      await page.screenshot({ element: dialog, path: `../../test-results/usage-calendar-review-settings-${scheme}-${scale}.png` });
    },
  );

  it("hides a pinned card when its square scrolls behind the Settings content boundary", async () => {
    await page.viewport(1000, 700);
    const view = render(<SettingsFrame source={sourceFor()} scale={1} scheme="dark" />);
    finishMotion(view);
    todayCell(view).focus();
    await userEvent.keyboard("{Enter}");
    const card = cardFor(view);
    expect(card).toBeVisible();
    const content = view.container.querySelector<HTMLElement>(".settings-content")!;
    const contentBounds = content.getBoundingClientRect();
    const squareBounds = todayCell(view).getBoundingClientRect();
    act(() => { content.scrollTop = squareBounds.bottom - contentBounds.top + 8; });
    await waitFor(() => expect(todayCell(view).getBoundingClientRect().bottom).toBeLessThan(content.getBoundingClientRect().top));
    expect(todayCell(view).getBoundingClientRect().bottom).toBeGreaterThan(0);
    await waitFor(() => expect(getComputedStyle(card).visibility).toBe("hidden"));
  });

  it("keeps pinned details visible, hit-testable and keyboard-scrollable in Settings without the Popover API", async () => {
    await page.viewport(1000, 700);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value: undefined });
    try {
      const view = render(<SettingsFrame source={sourceFor(44)} scale={1} scheme="dark" />);
      finishMotion(view);
      todayCell(view).focus();
      await userEvent.keyboard("{Enter}");
      const card = cardFor(view);
      expect(card).not.toHaveAttribute("popover");
      expect(card).toBeVisible();
      await page.screenshot({ path: "../../test-results/usage-calendar-review-no-popover.png" });
      const bounds = card.getBoundingClientRect();
      expect.soft(bounds.left).toBeGreaterThanOrEqual(0);
      expect.soft(bounds.top).toBeGreaterThanOrEqual(0);
      expect.soft(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect.soft(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      const total = card.querySelector<HTMLElement>(".usage-heat-card-total")!.getBoundingClientRect();
      expect.soft(card.contains(document.elementFromPoint(total.left + total.width / 2, total.top + total.height / 2))).toBe(true);
      const list = view.getByRole("region", { name: /^Providers and models on / });
      expect.soft(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      await userEvent.keyboard("{Tab}");
      expect(list).toHaveFocus();
      await userEvent.keyboard("{End}");
      await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
      const listBounds = list.getBoundingClientRect();
      expect.soft(list.contains(document.elementFromPoint(listBounds.right - 3, listBounds.top + 10))).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    }
  });

  it("updates a pinned day's breakdown from fresh usage and removes its popover when unmounted", async () => {
    const source = sourceFor();
    const view = render(<div className="app-shell" style={{ display: "block", width: 928 }}><div className="usage-dashboard">{calendar(source)}</div></div>);
    fireEvent.click(todayCell(view));
    expect(cardFor(view)).toHaveTextContent("300");
    source.detail = sourceFor(2, 2).detail;
    view.rerender(<div className="app-shell" style={{ display: "block", width: 928 }}><div className="usage-dashboard">{calendar(source, 2)}</div></div>);
    expect(cardFor(view)).toHaveTextContent("600");
    expect(todayCell(view)).toHaveAttribute("aria-selected", "true");
    view.unmount();
    expect(document.querySelector(".usage-heat-card")).toBeNull();
    expect(document.querySelector(".usage-heat-card:popover-open")).toBeNull();
  });

  it("hides the grid and day card when dated detail becomes inconsistent with authoritative totals", () => {
    const source = sourceFor();
    const view = render(<div className="app-shell" style={{ display: "block", width: 928 }}><div className="usage-dashboard">{calendar(source)}</div></div>);
    fireEvent.click(todayCell(view));
    expect(cardFor(view)).toBeVisible();
    const detail = source.detail;
    source.detail = (range) => ({ ...detail(range), detailAhead: true });
    view.rerender(<div className="app-shell" style={{ display: "block", width: 928 }}><div className="usage-dashboard">{calendar(source, 2)}</div></div>);
    expect(view.queryByRole("grid")).toBeNull();
    expect(view.queryByRole("group", { name: /^Usage on / })).toBeNull();
    expect(view.getByText("Dated detail is hidden until it agrees with saved totals.")).toBeVisible();
  });
});
