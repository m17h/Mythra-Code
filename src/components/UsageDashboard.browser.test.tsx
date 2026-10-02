import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { refreshOfficialPricing } from "../lib/officialPricing";
import { annotateThreadUsage, flushUsageLedger, pricingForModel, recordAuxiliaryUsage, recordUsageDelta, resetUsageLedgerCache } from "../lib/usageLedger";
import { seedUsageDashboard } from "../test/usageFixture";
import { CURSOR_PRICING_PAGE, OPENAI_PRICING_PAGE } from "../test/pricingPages";
import "../styles.css";

function mount(width: number, scheme: "dark" | "light" = "dark") {
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme={scheme} style={{ display: "block", width, height: "auto", padding: 16 }}><UsageDashboard /></div>);
  return { view, dashboard: view.getByRole("region", { name: "Local usage" }) };
}

function expectNoHorizontalOverflow(element: HTMLElement) {
  const right = element.getBoundingClientRect().right + 1;
  const outside = [...element.querySelectorAll<HTMLElement>("*")].filter((node) => node.getBoundingClientRect().right > right && !node.closest(".usage-table-scroll"))
    .slice(0, 5).map((node) => `${node.tagName}.${node.className}: ${node.textContent?.slice(0, 60)}`).join("; ");
  expect(element.scrollWidth, `${element.className}${outside ? ` · ${outside}` : ""}`).toBeLessThanOrEqual(element.clientWidth + 1);
}

/** Everything fits its container except deliberately scrollable wide tables. */
function expectContained(dashboard: HTMLElement) {
  expectNoHorizontalOverflow(dashboard);
  const right = dashboard.getBoundingClientRect().right + 1;
  for (const element of dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-card, .usage-toolbar, .usage-dashboard-stats, .usage-table-scroll, .usage-pricing, [role='radio'], [role='tab']")) {
    expect(element.getBoundingClientRect().right, element.className || element.textContent || "").toBeLessThanOrEqual(right);
  }
  for (const table of dashboard.querySelectorAll<HTMLElement>("table")) {
    if (table.closest(".usage-table-scroll")) continue;
    expect(table.getBoundingClientRect().right, table.className).toBeLessThanOrEqual(right);
  }
}

async function settleSummaryEntrance(dashboard: HTMLElement) {
  // Tile entrances have independent delays and transforms. Visual rectangles
  // describe those moving tiles, so settle their finite motion before checking
  // visual bounds and taking screenshots. Hover feedback remains intentional.
  for (const tile of dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-stats > div")) {
    for (const animation of tile.getAnimations()) animation.finish();
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function summaryRowCount(dashboard: HTMLElement) {
  // offsetTop belongs to grid layout, unlike painted rectangle tops, which
  // also include each tile's entrance and persistent hover transforms.
  return new Set([...dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-stats > div")].map((tile) => tile.offsetTop)).size;
}

const tab = (view: ReturnType<typeof render>, name: string) => view.getByRole("tab", { name });

describe("usage dashboard layout", () => {
  beforeEach(async () => { seedUsageDashboard(); await page.viewport(1400, 900); await commands.setStreamTestReducedMotion(false); });

  it.each(["light", "dark"] as const)("keeps unknown cache and tier evidence readable and keyboard-scrollable in narrow %s", async (scheme) => {
    localStorage.clear();
    resetUsageLedgerCache();
    await page.viewport(430, 700);
    const usage = { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, totalTokens: 1_010, reasoningOutputTokens: 0, contextWindow: null, cacheReadReported: false, cacheWriteReported: false };
    annotateThreadUsage("cache-unknown", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "fast" });
    recordUsageDelta("cache-unknown", usage, "unknown-cache", "turn-unknown");
    annotateThreadUsage("actual-standard", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "flex" });
    recordUsageDelta("actual-standard", { ...usage, serviceTier: "standard", serviceTierSource: "reported" }, "known-tier", "turn-tier");
    recordAuxiliaryUsage({ executionId: "helper-missing", provider: "openai", model: "gpt-6-luna", purpose: "thread-title", requestedServiceTier: "standard", usage: null });
    flushUsageLedger();
    const { view, dashboard } = mount(320, scheme);
    const stats = view.getByRole("group", { name: /^Summary/ });
    const cache = within(stats).getByText("Cache reads").parentElement!;
    expect(cache).toHaveTextContent("Unknown");
    expect(cache).not.toHaveTextContent("0% of input");
    const guide = view.getByText("Cache and service-tier evidence").closest("summary")!;
    guide.focus();
    await userEvent.keyboard("{Enter}");
    const body = view.getByRole("region", { name: "Usage metric evidence" });
    expect(body).toBeVisible();
    expect(body).toHaveTextContent("Requested tier: Fast / Priority. Actual tier: Unknown — not reported.");
    expect(body).toHaveTextContent("Requested tier: Flex. Actual tier: Standard.");
    expect(body).toHaveTextContent("Tier-specific rate unknown or unsupported");
    expect(body).toHaveTextContent("1 all-time helper request had no token report");
    expectNoHorizontalOverflow(body);
    expect(body.getBoundingClientRect().height).toBeLessThanOrEqual(281);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.focus();
    expect(body).toHaveFocus();
    expect(getComputedStyle(body).outlineStyle).toBe("solid");
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    expectContained(dashboard);
    fireEvent.click(tab(view, "Models"));
    const table = view.getByRole("table", { name: "Tokens and estimated cost by type, all models" });
    expect(within(table).getByRole("rowheader", { name: "Cache read" }).closest("tr")).toHaveTextContent("UnknownNot reported");
  });

  it("has room for the four-up summary inside the widened Settings sheet at a 1380x901 window", async () => {
    await page.viewport(1380, 901);
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "grid", placeItems: "center", width: "100vw", height: "100vh" }}>
      <div className="settings-modal settings-modal-wide" style={{ opacity: 1, transform: "none" }}><div className="settings-layout">
        <nav className="settings-nav" /><div className="settings-pane"><div className="settings-content"><UsageDashboard /></div></div>
      </div></div>
    </div>);
    const dashboard = view.getByRole("region", { name: "Local usage" });
    await settleSummaryEntrance(dashboard);
    const width = dashboard.getBoundingClientRect().width;
    // The standard 920px sheet leaves ~648px; the widened one ~928px.
    expect(width).toBeGreaterThan(880);
    expect(summaryRowCount(dashboard)).toBe(1);
    await page.screenshot({ element: view.container.querySelector<HTMLElement>(".settings-modal")!, path: "../../test-results/usage-settings-sheet.png" });
  });

  it.each([928, 640, 320])("fits every view at a %ipx panel", async (width) => {
    const { view, dashboard } = mount(width);
    await waitFor(() => expect(dashboard.clientWidth).toBeGreaterThan(0));
    await settleSummaryEntrance(dashboard);
    const rows = summaryRowCount(dashboard);
    // Four across on desktop, two by two in the standard sheet, a list when narrow.
    expect(rows).toBe(width >= 900 ? 1 : width >= 600 ? 2 : 4);
    expectContained(dashboard);
    for (const option of dashboard.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]')) expect(option.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    for (const bar of dashboard.querySelectorAll<HTMLElement>(".usage-chart-bar:not(.unknown)")) {
      expect(getComputedStyle(bar).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(bar.getBoundingClientRect().width).toBeLessThanOrEqual(24.5);
    }
    await page.screenshot({ element: dashboard, path: `../../test-results/usage-overview-${width}.png` });

    fireEvent.click(tab(view, "Models"));
    fireEvent.click(dashboard.querySelector<HTMLElement>(".usage-model-toggle")!);
    expectContained(dashboard);
    await page.screenshot({ element: dashboard, path: `../../test-results/usage-models-${width}.png` });

    fireEvent.click(tab(view, "Compare"));
    const compare = view.getByRole("region", { name: "Compare models" });
    expectContained(dashboard);
    // Every comparison cell's cost, token count and average wraps inside its column.
    for (const cell of compare.querySelectorAll<HTMLElement>(".usage-compare-table th, .usage-compare-table td")) {
      expect(cell.scrollWidth, cell.textContent ?? "").toBeLessThanOrEqual(cell.clientWidth + 1);
    }
    await page.screenshot({ element: dashboard, path: `../../test-results/usage-compare-${width}.png` });
  });

  it("keeps two logical summary rows while staggered entrances temporarily separate their visual tops", async () => {
    await userEvent.hover(document.documentElement);
    const { dashboard } = mount(640);
    const tiles = [...dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-stats > div")];
    expect(tiles.some((tile) => tile.matches(":hover"))).toBe(false);
    const animations = tiles.map((tile) => tile.getAnimations());
    expect(tiles).toHaveLength(4);
    for (const group of animations) {
      expect(group).toHaveLength(1);
      group[0].pause();
      group[0].currentTime = 60;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const layoutTops = tiles.map((tile) => tile.offsetTop);
    expect(layoutTops[0]).toBe(layoutTops[1]);
    expect(layoutTops[2]).toBe(layoutTops[3]);
    expect(layoutTops[2]).toBeGreaterThan(layoutTops[0]);
    // This recreates the former three-row result without changing the grid:
    // independently moving cards do not yet share painted top coordinates.
    expect(new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top))).size).toBeGreaterThan(2);
    await settleSummaryEntrance(dashboard);
    expect(summaryRowCount(dashboard)).toBe(2);
    expect(new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top))).size).toBe(2);
    expectContained(dashboard);
  });

  it("keeps summary row measurement valid when a settled tile is hovered", async () => {
    const { dashboard } = mount(640);
    const tiles = [...dashboard.querySelectorAll<HTMLElement>(".usage-dashboard-stats > div")];
    await settleSummaryEntrance(dashboard);
    await userEvent.hover(tiles[0]);
    await settleSummaryEntrance(dashboard);
    expect(tiles[0].matches(":hover")).toBe(true);
    expect(summaryRowCount(dashboard)).toBe(2);
    expect(new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top))).size).toBeGreaterThan(2);
    expectContained(dashboard);
    // Neutral painted rectangles align again when the intentional hover lift
    // ends; the pointer persists across browser tests, so make that explicit.
    await userEvent.hover(dashboard.querySelector<HTMLElement>("h4")!);
    await settleSummaryEntrance(dashboard);
    expect(tiles.some((tile) => tile.matches(":hover"))).toBe(false);
    expect(summaryRowCount(dashboard)).toBe(2);
    expect(new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top))).size).toBe(2);
  });

  it("renders the development preview's weeks of Opus and Sol in dark and light", async () => {
    for (const scheme of ["dark", "light"] as const) {
      const { view, dashboard } = mount(928, scheme);
      act(() => window.__mythraPreviewUsageDashboard?.(true));
      await waitFor(() => expect(view.getByText("Development preview — synthetic usage, not your data.")).toBeInTheDocument());
      expect(dashboard.querySelectorAll(".usage-chart-slot").length).toBe(30);
      const card = dashboard.querySelector(".usage-dashboard-card")!;
      expect(getComputedStyle(card).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ element: dashboard, path: `../../test-results/usage-preview-${scheme}.png` });
      fireEvent.click(tab(view, "Compare"));
      fireEvent.click(view.getByRole("radio", { name: "Week" }));
      fireEvent.click(view.getByRole("button", { name: "Token type" }));
      fireEvent.click(view.getByRole("menuitemradio", { name: /Cache read/ }));
      fireEvent.click(within(view.getByRole("radiogroup", { name: "Compare measure" })).getByRole("radio", { name: "Tokens" }));
      await page.screenshot({ element: dashboard, path: `../../test-results/usage-preview-compare-${scheme}.png` });
      view.unmount();
    }
  });

  it("is operable from the keyboard: range radios, view tabs, model rows and a visible focus ring", async () => {
    const { view } = mount(640);
    const thirty = view.getByRole("radio", { name: "30 days" });
    thirty.focus();
    await userEvent.keyboard("{ArrowRight}");
    const allTime = view.getByRole("radio", { name: "All time" });
    expect(allTime).toHaveFocus();
    expect(allTime).toHaveAttribute("aria-checked", "true");

    const overview = tab(view, "Overview");
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    const models = tab(view, "Models");
    expect(models).toHaveFocus();
    expect(models).toHaveAttribute("aria-selected", "true");
    expect(view.getByRole("tabpanel")).toHaveAccessibleName("Models");

    await userEvent.keyboard("{Tab}");
    const row = view.container.querySelector<HTMLButtonElement>(".usage-model-toggle")!;
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveFocus();
    expect(document.getElementById(row.getAttribute("aria-controls")!)).not.toBeNull();
    expect(getComputedStyle(row).outlineStyle).not.toBe("none");
  });

  it("keeps the trend readout valid when a hovered 30-day slot disappears after changing range", async () => {
    const { view } = mount(640);
    const chart = view.container.querySelector<HTMLElement>(".usage-trend .usage-chart")!;
    const slots = chart.querySelectorAll<HTMLElement>(".usage-chart-slot");
    expect(slots).toHaveLength(30);
    fireEvent.pointerEnter(slots[slots.length - 1]);

    const thirty = view.getByRole("radio", { name: "30 days" });
    thirty.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(view.getByRole("radio", { name: "All time" })).toHaveAttribute("aria-checked", "true");
    const remaining = chart.querySelectorAll<HTMLElement>(".usage-chart-slot");
    expect(remaining.length).toBeLessThan(slots.length);
    // A real pointer can land on a replacement slot as the chart contracts,
    // so either its fresh hover or the highest period is valid. The original
    // failure threw before a readout could render at all.
    expect(chart.querySelector(".usage-chart-readout")?.textContent).toMatch(/^(?:Highest · )?.+ · .+ tokens · .+ prompts$/);
  });

  it.each([928, 320])("refreshes official pricing from the header and lays out each source's result at %ipx", async (width) => {
    const fetchDocument = async (source: string) => {
      if (source === "anthropic") throw new Error("The pricing page returned HTTP 503");
      return source === "openai" ? OPENAI_PRICING_PAGE : CURSOR_PRICING_PAGE;
    };
    let calls = 0;
    const onRefreshPricing = async () => {
      calls += 1;
      const result = await refreshOfficialPricing({ force: true, fetchDocument });
      if (result.failed.length) throw new Error("Some pricing sources could not be checked");
    };
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width, padding: 16 }}>
      <UsageDashboard onRefreshPricing={onRefreshPricing} openRouterPricingError="" />
    </div>);
    await userEvent.click(view.getByRole("button", { name: "Refresh pricing" }));
    await waitFor(() => expect(view.getByRole("status")).toHaveTextContent("Some pricing sources couldn’t be checked"));
    expect(calls).toBe(1);
    const summary = view.getByText("Some rates couldn’t be verified").closest("summary")!;
    await userEvent.click(summary);
    const sources = view.getByRole("list", { name: "Rate sources" });
    expect(within(sources).getByText("OpenAI pricing page").closest("li")).toHaveTextContent(/6 models verified today/);
    expect(within(sources).getByText("Claude pricing page").closest("li")).toHaveTextContent(/Couldn’t verify .*HTTP 503/);
    // A refreshed official rate prices new usage immediately.
    expect(pricingForModel("openai", "gpt-5.5")).toMatchObject({ inputPerMillion: 5, origin: "official" });
    const dashboard = view.getByRole("region", { name: "Local usage" });
    expectContained(dashboard);
    for (const row of sources.querySelectorAll<HTMLElement>("li")) expectNoHorizontalOverflow(row);
    const dot = sources.querySelector<HTMLElement>(".warn .usage-pricing-dot")!;
    expect(getComputedStyle(dot).backgroundColor).not.toBe(getComputedStyle(sources.querySelector<HTMLElement>(".ok .usage-pricing-dot")!).backgroundColor);
    await page.screenshot({ element: view.container.querySelector<HTMLElement>(".usage-dashboard-head")!, path: `../../test-results/usage-pricing-sources-${width}.png` });
  });
});
