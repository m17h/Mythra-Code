import type { CSSProperties } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { providerHeaderUsage, type AccountUsageView } from "../lib/providerUsage";
import { UsagePopover } from "./UsagePopover";
import "../styles.css";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

describe("usage popover browser layout", () => {
  it("fades continuously, reverses mid-exit, and removes closed decoration", async () => {
    await commands.setStreamTestReducedMotion(false);
    const usage: AccountUsageView = { label: "Claude subscription", summary: "Max plan", windows: [
      { label: "5h", percent: 17, percentLabel: "17% used", resetLabel: "11 PM", resetsAt: Date.now() / 1000 + 600 },
    ] };
    const intervals = vi.spyOn(window, "setInterval");
    const clears = vi.spyOn(window, "clearInterval");
    const view = render(<div style={{ position: "fixed", top: 0, left: 0, width: 900, height: 60 }}><UsagePopover provider="claude" usage={usage} header={providerHeaderUsage("claude", usage)!} onSelect={vi.fn()} onDetails={vi.fn()} onConnect={vi.fn()} /></div>);
    const trigger = view.getByRole("button", { name: /Open usage details/ });
    fireEvent.click(trigger);
    const panel = view.getByRole("dialog");
    const entrance = panel.getAnimations()[0];
    entrance.pause(); entrance.currentTime = 110;
    const opacity = () => Number(getComputedStyle(panel).opacity);
    expect(opacity()).toBeGreaterThan(0);
    expect(opacity()).toBeLessThan(1);
    const geometry = panel.getBoundingClientRect().toJSON();
    act(() => entrance.finish());
    await waitFor(() => expect(opacity()).toBe(1));
    expect(panel.getBoundingClientRect().toJSON()).toEqual(geometry);
    fireEvent.click(view.getByRole("button", { name: "Close usage details" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(panel.isConnected).toBe(true);
    expect(panel).toHaveAttribute("inert");
    expect(getComputedStyle(panel).pointerEvents).toBe("none");
    expect(trigger).toHaveFocus();
    expect(clears).toHaveBeenCalledWith(intervals.mock.results[0].value);
    const exit = panel.getAnimations()[0];
    exit.pause(); exit.currentTime = 90;
    const midExit = opacity();
    expect(midExit).toBeGreaterThan(0);
    expect(midExit).toBeLessThan(1);
    // Re-enter during exit: no second hover delay, no new DOM or opacity jump.
    fireEvent.pointerOver(trigger, { pointerType: "mouse" });
    expect(view.getByRole("dialog")).toBe(panel);
    expect(opacity()).toBeCloseTo(midExit, 2);
    expect(exit.onfinish).toBeNull();
    expect(intervals.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(2);
    const reversal = panel.getAnimations()[0];
    act(() => reversal.finish());
    await waitFor(() => expect(opacity()).toBe(1));
    fireEvent.click(trigger); // pin the hover panel and focus its radio
    expect(view.getByRole("radio")).toHaveFocus();
    fireEvent.click(trigger); // WebKit does not focus buttons on mouse click
    expect(trigger).toHaveFocus();
    const finalExit = panel.getAnimations()[0];
    act(() => finalExit.finish());
    await waitFor(() => expect(panel.isConnected).toBe(false));
    expect(panel.getAnimations()).toHaveLength(0);
  });

  it("settles immediately for reduced motion, including a preference change mid-fade", async () => {
    await commands.setStreamTestReducedMotion(false);
    const usage: AccountUsageView = { label: "Claude subscription", summary: "Sign in to view usage" };
    const view = render(<UsagePopover provider="claude" usage={usage} header={providerHeaderUsage("claude", usage)!} onSelect={vi.fn()} onDetails={vi.fn()} onConnect={vi.fn()} />);
    const trigger = view.getByRole("button", { name: /Open usage details/ });
    fireEvent.click(trigger);
    const panel = view.getByRole("dialog");
    panel.getAnimations()[0].pause();
    await commands.setStreamTestReducedMotion(true);
    await waitFor(() => {
      expect(getComputedStyle(panel).opacity).toBe("1");
      expect(panel.getAnimations()).toHaveLength(0);
    });
    fireEvent.click(view.getByRole("button", { name: "Close usage details" }));
    expect(panel.isConnected).toBe(false);
    fireEvent.click(trigger);
    const reopened = view.getByRole("dialog");
    expect(getComputedStyle(reopened).opacity).toBe("1");
    expect(reopened.getAnimations()).toHaveLength(0);
    await commands.setStreamTestReducedMotion(false);
    fireEvent.click(view.getByRole("button", { name: "Close usage details" }));
    reopened.getAnimations()[0].pause();
    await commands.setStreamTestReducedMotion(true);
    await waitFor(() => expect(reopened.isConnected).toBe(false));
  });

  it.each(["dark", "light"])("keeps selected rows neutral with an outline in %s mode", (scheme) => {
    const usage: AccountUsageView = { label: "Claude subscription", summary: "Max plan", windows: [
      { label: "5h", percent: 17, percentLabel: "17% used", resetLabel: "11 PM" },
      { label: "Weekly", percent: 5, percentLabel: "5% used", resetLabel: "Friday" },
    ] };
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme={scheme}>
      <UsagePopover provider="claude" usage={usage} header={providerHeaderUsage("claude", usage)!} onSelect={vi.fn()} onDetails={vi.fn()} onConnect={vi.fn()} />
    </div>);
    fireEvent.click(view.getByRole("button", { name: /Open usage details/ }));
    const rows = view.container.querySelectorAll(".usage-popover-window");
    expect(getComputedStyle(rows[0]).backgroundColor).toBe(getComputedStyle(rows[1]).backgroundColor);
    expect(getComputedStyle(rows[0]).borderColor).not.toBe(getComputedStyle(rows[1]).borderColor);
    expect(view.getByRole("radio", { name: "Show 5h in top bar" })).toBeChecked();
    const track = view.container.querySelector(".usage-popover-track")!;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const luminance = (...colors: string[]) => {
      context.clearRect(0, 0, 1, 1);
      for (const color of colors) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const background = getComputedStyle(rows[0]).backgroundColor;
    const rail = getComputedStyle(track).backgroundColor;
    const empty = luminance(background, rail);
    const filled = luminance(background, rail, getComputedStyle(track.firstElementChild!).backgroundColor);
    expect((Math.max(empty, filled) + 0.05) / (Math.min(empty, filled) + 0.05)).toBeGreaterThanOrEqual(3);
  });
  it.each([0.8, 1, 1.5])("stays inside a narrow chat toolbar at %sx UI scale with scrollable details", (scale) => {
    const usage: AccountUsageView = {
      label: "Claude subscription", summary: "Max plan", planLabel: "Max plan",
      windows: Array.from({ length: 8 }, (_, index) => ({ label: index ? `Weekly model-specific limit ${index}` : "5h", percent: 88, percentLabel: "88% left", resetLabel: "Friday · 10:30 AM" })),
    };
    const view = render(
      <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 520, height: 700 / scale, zoom: scale, "--ui-scale": scale } as CSSProperties}>
        <main className="main-panel">
          <header className="topbar">
            <div className="topbar-right" style={{ marginLeft: "auto" }}>
              <UsagePopover provider="claude" usage={usage} header={providerHeaderUsage("claude", usage)!} onSelect={vi.fn()} onDetails={vi.fn()} onConnect={vi.fn()} />
              <button style={{ width: 100 }}>Workspace</button>
            </div>
          </header>
          <div style={{ height: 700, position: "relative", zIndex: 3 }}>Chat content</div>
        </main>
      </div>,
    );
    const trigger = view.getByRole("button", { name: /Open usage details/ });
    fireEvent.click(trigger);
    const panel = view.getByRole("dialog");
    const header = view.container.querySelector(".topbar")!;
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    expect(panelRect.left).toBeGreaterThanOrEqual(headerRect.left);
    expect(panelRect.right).toBeLessThanOrEqual(headerRect.right);
    expect(panelRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
    const heading = panel.querySelector(".usage-popover-heading")!;
    const rect = heading.getBoundingClientRect();
    expect(panel.contains(document.elementFromPoint(rect.left + 10, rect.top + 10))).toBe(true);
    for (const row of panel.querySelectorAll<HTMLElement>(".usage-popover-window")) {
      // WebKit rounds scrollWidth/clientWidth in opposite directions at 150%
      // zoom (330/329 for a 330.67px row). Also check real child geometry so
      // this one-CSS-pixel allowance cannot hide clipped content.
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      const rowRect = row.getBoundingClientRect();
      for (const child of row.children) {
        const rect = child.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(rowRect.left);
        expect(rect.right).toBeLessThanOrEqual(rowRect.right - parseFloat(getComputedStyle(row).paddingRight) * scale + 1);
      }
    }
  });
});
