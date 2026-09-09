import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubAgentCommandCenter, type SubAgentCommandCenterProps } from "./SubAgentCommandCenter";
import type { ChildAgentReadiness } from "../lib/childAgents";
import type { ChildAgentTarget, ProjectSubagentSettings } from "../types";
import "../styles.css";

const READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  claudeReady: true,
  cursorReady: true,
};

function target(id: string, provider: ChildAgentTarget["provider"]): ChildAgentTarget {
  return {
    id,
    provider,
    model: "",
    label: id,
    description: "",
    enabled: true,
    reasoningMode: "inherit",
    reasoningEffort: "medium",
    reasoningMaxEffort: "high",
  };
}

const POLICY: ProjectSubagentSettings = {
  enabled: true,
  maxConcurrent: 2,
  childAgents: {
    enabled: true,
    targets: [target("one", "claude"), target("two", "openai"), target("three", "cursor")],
  },
};

/** Bottom-anchored over a composer, the way the real control sits. */
async function open(readiness = READY, modelCatalogs?: SubAgentCommandCenterProps["modelCatalogs"]) {
  const onChange = vi.fn();
  const view = render(
    <div className="app-shell" data-theme="midnight" data-color-scheme="dark" style={{ display: "flex", alignItems: "flex-end", width: 900, height: 860, padding: 20 }}>
      <SubAgentCommandCenter
        policy={POLICY}
        capturedPolicy={null}
        mode="open"
        readiness={readiness}
        workers={[]}
        scopeLabel="Chats & project defaults"
        projectOverride={false}
        onChange={onChange}
        onOpenSettings={vi.fn()}
        onSavePreset={vi.fn()}
        modelCatalogs={modelCatalogs}
      />
    </div>,
  );
  fireEvent.click(view.getByRole("button", { name: /Sub-agents/ }));
  const panel = view.container.querySelector<HTMLElement>(".subagent-panel")!;
  const grid = view.container.querySelector<HTMLElement>(".sa-crew-grid")!;
  // Provider marks are real images; measuring before they resolve would
  // compare two different layouts rather than two states of the same one.
  await Promise.all([...panel.querySelectorAll("img")].map((image) => image.complete
    ? undefined
    : new Promise((resolve) => { image.onload = image.onerror = () => resolve(undefined); })));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return { view, panel, grid, onChange };
}

/**
 * Where every tile actually paints, expressed against the panel's own scrolled
 * content so the assertions are about the roster rather than about how far the
 * reader happens to have scrolled the popover.
 */
function boxes(panel: HTMLElement, grid: HTMLElement) {
  const panelRect = panel.getBoundingClientRect();
  const originTop = panelRect.top - panel.scrollTop;
  const originLeft = panelRect.left - panel.scrollLeft;
  return Object.fromEntries([...grid.querySelectorAll<HTMLElement>("[data-flip-key]")].map((tile) => {
    const rect = tile.getBoundingClientRect();
    return [tile.dataset.flipKey!, {
      top: Math.round(rect.top - originTop),
      left: Math.round(rect.left - originLeft),
      width: Math.round(rect.width),
    }];
  }));
}

/** Run every queued movement to completion and let its finish handler fire. */
async function settle(...elements: HTMLElement[]) {
  const running = elements.flatMap((element) => [
    ...element.getAnimations(),
    ...[...element.querySelectorAll<HTMLElement>("[data-flip-key]")].flatMap((tile) => tile.getAnimations()),
  ]);
  for (const animation of running) animation.finish();
  await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
  // One more turn for the finish events the hook cleans up on.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return running;
}

describe("sub-agent roster transition", () => {
  it("themes the signed-out account action for dark palettes", async () => {
    const { view } = await open({ ...READY, openAiSignedIn: false });
    const action = view.getByRole("button", { name: "Models & accounts" });
    const style = getComputedStyle(action);

    expect(style.backgroundColor).not.toBe("rgb(255, 255, 255)");
    expect(style.color).not.toBe("rgb(255, 255, 255)");
    expect(style.borderTopStyle).toBe("solid");
  });

  it("animates every displaced tile rather than re-placing it", async () => {
    const { view, panel, grid } = await open();
    const before = boxes(panel, grid);
    // The roster wraps, so expanding one tile has to displace the others.
    expect(new Set(Object.values(before).map((box) => box.top)).size).toBeGreaterThan(1);

    fireEvent.click(view.getByRole("button", { name: "Configure one" }));

    // The new layout is committed, and every box that moved is mid-flight
    // rather than already parked at its destination.
    const expanding = grid.querySelector<HTMLElement>('[data-flip-key="one"]')!;
    expect(expanding.dataset.flipResizing).toBe("true");
    for (const tile of grid.querySelectorAll<HTMLElement>("[data-flip-key]")) {
      expect(tile.getAnimations().length).toBeGreaterThan(0);
      for (const animation of tile.getAnimations()) {
        const keyframes = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
        expect(keyframes.every((frame) => !("width" in frame) && !("height" in frame))).toBe(true);
      }
    }
    expect(getComputedStyle(panel).scrollbarGutter).toContain("stable");

    await settle(panel, grid);

    // Settled, the expanded tile owns the full row and the others have taken
    // their new places. (Releasing the mid-resize clip is covered by the
    // useRosterFlip specs, which can observe the finish event directly.)
    const after = boxes(panel, grid);
    expect(after.one.width).toBeGreaterThan(before.one.width);
    expect(after.two).not.toEqual(before.two);
  });

  it("collapses back to exactly the layout it started from", async () => {
    const { view, panel, grid } = await open();
    const before = boxes(panel, grid);

    fireEvent.click(view.getByRole("button", { name: "Configure one" }));
    await settle(panel, grid);
    fireEvent.click(view.getByRole("button", { name: "Configure one" }));

    // Collapsing is the same movement in reverse — the tiles travel back
    // instead of the grid snapping under them.
    expect(await settle(panel, grid)).not.toHaveLength(0);
    const after = boxes(panel, grid);
    // Back to one row of equal-width tiles, exactly as it opened. Absolute
    // pixels are left out: the popover's scrollbar comes and goes with the
    // editor and shifts every column by its own width.
    expect(after.one.width).toBe(after.two.width);
    expect(after.one.top).toBe(after.two.top);
    expect(after.three.top).toBeGreaterThan(after.one.top);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const tile of grid.querySelectorAll<HTMLElement>("[data-flip-key]")) {
      expect(tile.dataset.flipResizing).toBeUndefined();
      expect(tile.className).not.toContain("expanded");
    }
  });
});


it("keeps preset controls and the compact editor within the popover", async () => {
  const { view, panel, grid } = await open();
  fireEvent.click(view.getByRole("button", { name: "Configure one" }));
  await settle(panel, grid);
  expect(view.queryByRole("textbox", { name: "When to use one" })).not.toBeInTheDocument();
  const fields = [view.getByRole("textbox", { name: "New sub-agent preset name" }), view.getByRole("button", { name: "Provider for one" }), view.getByRole("button", { name: "Save as preset" })];
  const bounds = panel.getBoundingClientRect();
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(40);
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.right);
  }
});

it("promotes provider and model menus above the scrollable popover", async () => {
  const { view, panel, grid } = await open();
  fireEvent.click(view.getByRole("button", { name: "Configure one" }));
  await settle(panel, grid);

  for (const name of ["Provider for one", "Model for one"]) {
    fireEvent.click(view.getByRole("button", { name }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const menu = view.getByRole("menu", { name: `${name} choices` });
    const popup = menu.closest<HTMLElement>(".app-select-menu")!;
    const trigger = view.getByRole("button", { name });
    expect(panel.contains(menu)).toBe(true);
    expect(popup.matches(":popover-open")).toBe(true);
    const bounds = popup.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    // A centered popup can satisfy all viewport bounds while still being
    // detached from the selector. The top-layer menu must remain adjacent to
    // its trigger, flipping above when the lower edge has no room.
    const verticalGap = Math.min(
      Math.abs(bounds.top - (triggerBounds.bottom + 4)),
      Math.abs(bounds.bottom - (triggerBounds.top - 4)),
    );
    // The menu's short entrance transform can still contribute a few pixels
    // on this frame; a centered popup is hundreds of pixels away.
    expect(verticalGap).toBeLessThan(8);
    expect(bounds.left).toBeGreaterThanOrEqual(triggerBounds.left - 1);
    expect(bounds.left).toBeLessThan(triggerBounds.right);
    fireEvent.click(view.getByRole("button", { name }));
  }
});

it("scrolls to and selects a model at the end of a long catalog", async () => {
  const models = Array.from({ length: 30 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}` }));
  const { view, panel, grid, onChange } = await open(READY, { claude: models });
  fireEvent.click(view.getByRole("button", { name: "Configure one" }));
  await settle(panel, grid);
  fireEvent.click(view.getByRole("button", { name: "Model for one" }));
  const menu = view.getByRole("menu", { name: "Model for one choices" });
  expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
  menu.scrollTop = menu.scrollHeight;
  fireEvent.scroll(menu);
  fireEvent.click(view.getByRole("menuitemradio", { name: "Model 29 model-29" }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    childAgents: expect.objectContaining({ targets: expect.arrayContaining([expect.objectContaining({ id: "one", model: "model-29" })]) }),
  }));
});
