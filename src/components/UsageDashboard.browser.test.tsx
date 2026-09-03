import { render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { seedUsageDashboard } from "../test/usageFixture";
import "../styles.css";

describe("usage dashboard layout", () => {
  beforeEach(async () => { seedUsageDashboard(); await page.viewport(1400, 1800); });
  it.each([900, 540, 320])("fits a %ipx panel without overlapping metrics", async (width) => {
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width, height: "auto", padding: 16 }}><UsageDashboard /></div>);
    const dashboard = view.getByRole("region", { name: "All-time local usage" });
    await waitFor(() => expect(dashboard.clientWidth).toBeGreaterThan(0));
    expect(dashboard.scrollWidth).toBeLessThanOrEqual(dashboard.clientWidth + 1);
    const metrics = [...dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-stats > div")];
    const summary = dashboard.querySelector<HTMLElement>(".usage-dashboard-stats")!;
    const heading = dashboard.querySelector<HTMLElement>(".usage-dashboard-heading")!;
    expect(Math.abs(heading.getBoundingClientRect().left - summary.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
    expect(summary.getBoundingClientRect().height).toBeLessThan(width > 640 ? 100 : 190);
    for (const metric of metrics) expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
    for (const bar of dashboard.querySelectorAll<HTMLElement>(".usage-chart-track > span, .usage-composition-bar > span")) {
      expect(bar.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(getComputedStyle(bar).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    }
    const boxes = metrics.map((metric) => metric.getBoundingClientRect());
    expect(boxes[1].left >= boxes[0].right || boxes[1].top >= boxes[0].bottom).toBe(true);
    if (width === 900) await page.screenshot({ element: dashboard, path: "../../test-results/usage-dashboard-dark.png" });
  });

  it("uses theme surfaces in light mode", async () => {
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="light" style={{ display: "block", width: 900, height: "auto", padding: 16 }}><UsageDashboard /></div>);
    const dashboard = view.getByRole("region", { name: "All-time local usage" });
    const card = dashboard.querySelector(".usage-dashboard-card")!;
    expect(getComputedStyle(card).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ element: dashboard, path: "../../test-results/usage-dashboard-light.png" });
  });
});
