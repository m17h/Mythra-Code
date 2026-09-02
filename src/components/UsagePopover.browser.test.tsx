import type { CSSProperties } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { providerHeaderUsage, type AccountUsageView } from "../lib/providerUsage";
import { UsagePopover } from "./UsagePopover";
import "../styles.css";

describe("usage popover browser layout", () => {
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
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
  });
});
