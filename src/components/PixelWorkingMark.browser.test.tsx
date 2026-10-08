import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import type { Activity } from "../types";
// Match startApplication: global CSS, then Lumen, then component chunks.
import "../styles.css";
import "../styles/lumen/index.css";
import { ActivityStatus } from "./ActivityStatus";
import { ActivityDetailsModal, type ActivityDetailsRun } from "./ActivityDetailsModal";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
    setForcedColors(active: boolean): Promise<void>;
  }
}

function Shell({ state = "running", category = "thinking", scheme = "dark" }: { state?: "running" | "completed"; category?: "thinking" | "approval"; scheme?: "dark" | "light" }) {
  return <div className="app-shell" data-theme="mythra" data-color-scheme={scheme} style={{ width: 600, height: 200 }}>
    <ActivityStatus state={state} label={category === "approval" ? "Waiting for approval" : "Thinking"} category={category} onOpen={vi.fn()} />
  </div>;
}

function History({ run }: { run: ActivityDetailsRun }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  return <div ref={sourceRef} className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <ActivityDetailsModal sourceRef={sourceRef} onClose={vi.fn()} run={run} renderMessage={() => null} renderSubAgents={() => null} />
  </div>;
}

const pixels = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(".pixel-working-mark > i")];
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
const resolved = (color: string) => {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
};

afterEach(async () => {
  cleanup();
  await commands.setStreamTestReducedMotion(false);
  await commands.setForcedColors(false);
});

describe("dot-matrix working mark", () => {
  it("draws a 3×3 grid of round 2px dots in the neutral foreground, with a clockwise comet and a pulsing center", () => {
    const view = render(<Shell />);
    const mark = view.container.querySelector<HTMLElement>(".activity-status-mark")!;
    expect(getComputedStyle(mark).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    const cells = pixels(mark);
    expect(cells).toHaveLength(9);
    const origin = cells[0].getBoundingClientRect();
    const columns = new Set<number>();
    const rows = new Set<number>();
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      expect([rect.width, rect.height]).toEqual([2, 2]);
      expect(getComputedStyle(cell).borderRadius).toBe("50%");
      expect(getComputedStyle(cell).boxShadow).toBe("none");
      columns.add(rect.left - origin.left);
      rows.add(rect.top - origin.top);
    }
    expect([...columns].sort((a, b) => a - b)).toEqual([0, 3, 6]);
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 3, 6]);
    const text = getComputedStyle(view.container.querySelector(".app-shell")!).getPropertyValue("--text").trim();
    expect(getComputedStyle(cells[0]).backgroundColor).toBe(resolved(text));

    // The ring: 120ms per cell, 960ms per revolution, head reaching cell n at n×120ms.
    const delays = RING.map((cell) => getComputedStyle(cells[cell]).animationDelay);
    expect(delays).toEqual(["-0.96s", "-0.84s", "-0.72s", "-0.6s", "-0.48s", "-0.36s", "-0.24s", "-0.12s"]);
    for (const cell of RING) {
      expect(getComputedStyle(cells[cell]).animationName).toBe("pixel-working-ring");
      expect(getComputedStyle(cells[cell]).animationDuration).toBe("0.96s");
      expect(getComputedStyle(cells[cell]).animationTimingFunction).toBe("linear");
    }
    expect(getComputedStyle(cells[4]).animationName).toBe("pixel-working-core");
    expect(getComputedStyle(cells[4]).animationDuration).toBe("0.96s");
    expect(view.container.querySelector(".activity-status-orbit, .lucide-sparkles")).toBeNull();
  });

  it("follows the theme's text color in light schemes too", () => {
    const view = render(<Shell scheme="light" />);
    const text = getComputedStyle(view.container.querySelector(".app-shell")!).getPropertyValue("--text").trim();
    expect(getComputedStyle(pixels(view.container)[0]).backgroundColor).toBe(resolved(text));
  });

  it("holds one static comet frame under reduced motion, and under forced colors even when motion is allowed", async () => {
    await commands.setStreamTestReducedMotion(true);
    let view = render(<Shell />);
    let cells = pixels(view.container);
    for (const cell of cells) expect(getComputedStyle(cell).animationName).toBe("none");
    // Head on the first ring cell, its trail counter-clockwise behind it,
    // center at its brightest.
    expect(RING.map((cell) => Number(getComputedStyle(cells[cell]).opacity))).toEqual([1, 0, 0, 0, 0, 0.25, 0.5, 0.75]);
    expect(Number(getComputedStyle(cells[4]).opacity)).toBe(0.75);
    view.unmount();

    await commands.setStreamTestReducedMotion(false);
    await commands.setForcedColors(true);
    view = render(<Shell />);
    cells = pixels(view.container);
    expect(matchMedia("(prefers-reduced-motion: no-preference)").matches).toBe(true);
    for (const cell of cells) {
      expect(getComputedStyle(cell).animationName).toBe("none");
      // WebKit honors the media query but does not expose this property.
      if ("forcedColorAdjust" in getComputedStyle(cell)) expect(getComputedStyle(cell).forcedColorAdjust).toBe("none");
    }
    view.unmount();
  });

  it("is absent from waiting and settled rows, which keep a static icon", () => {
    for (const props of [{ category: "approval" as const }, { state: "completed" as const }]) {
      const view = render(<Shell {...props} />);
      expect(view.container.querySelector(".pixel-working-mark")).toBeNull();
      expect(view.container.querySelector(".activity-status-mark svg")).not.toBeNull();
      view.unmount();
    }
  });

  it("replaces the sparkle in a live empty Work history and on thinking that is happening now", () => {
    let view = render(<History run={{ state: "running", entries: [] }} />);
    const empty = document.querySelector<HTMLElement>(".activity-details-empty-mark.live")!;
    expect(empty.querySelector("svg")).toBeNull();
    expect(getComputedStyle(empty, "::after").content).toBe("none");
    expect(getComputedStyle(empty).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(pixels(empty)).toHaveLength(9);
    // Layout size: the dialog's entrance scale() affects only its rects.
    expect([pixels(empty)[0].offsetWidth, pixels(empty)[0].offsetHeight]).toEqual([3, 3]);
    expect(getComputedStyle(pixels(empty)[0]).animationName).toBe("pixel-working-ring");
    view.unmount();

    const thinking = (status: Activity["status"]) => ({ kind: "activity" as const, value: { id: "think", kind: "reasoning" as const, title: "Reasoning", detail: "Weighing options", status } });
    view = render(<History run={{ state: "running", entries: [thinking("inProgress")] }} />);
    const node = document.querySelector<HTMLElement>('[data-step-id="think"] .activity-step-node')!;
    expect(node.querySelector(".pixel-working-mark.live")).not.toBeNull();
    expect(node.querySelector("svg")).toBeNull();
    // Thinking opens as readable prose beside the live mark.
    expect(document.querySelector('[data-step-id="think"] .activity-step-thought')?.textContent).toBe("Weighing options");
    view.unmount();

    // Finished thinking, or a stale in-progress step in a settled run, is static.
    for (const run of [{ state: "running" as const, entries: [thinking("completed")] }, { state: "completed" as const, entries: [thinking("inProgress")] }]) {
      view = render(<History run={run} />);
      expect(document.querySelector(".pixel-working-mark")).toBeNull();
      expect(document.querySelector('[data-step-id="think"] .activity-step-node svg')).not.toBeNull();
      view.unmount();
    }
  });
});
