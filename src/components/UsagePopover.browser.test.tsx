import type { CSSProperties } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { providerHeaderUsage, type AccountUsageView } from "../lib/providerUsage";
import { UsagePopover } from "./UsagePopover";
import "../styles.css";

describe("usage popover browser layout", () => {
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
