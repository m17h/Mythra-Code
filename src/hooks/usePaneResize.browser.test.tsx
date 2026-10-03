import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { themeColorScheme } from "../lib/appConfig";
import { clampPaneSize, PANE_BOUNDS, usePaneResize, type PaneKey } from "./usePaneResize";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

declare module "vitest/browser" {
  interface BrowserCommands {
    setMouseButton(down: boolean): Promise<void>;
  }
}

// Production styles arrive through the browser setup (legacy, then Lumen), and
// the panes sit in a fully attributed shell, the scope every Lumen rule
// requires. A pane drag must paint the pointer's width on the next frame:
// Lumen's open/close motion out-specified legacy's drag override once, which
// made both panes ease hundreds of milliseconds behind the pointer.

const START: Record<PaneKey, number> = { sidebar: 260, dock: 430 };
const SIZE_PROPERTIES = new Set(["width", "flex-basis"]);

function Workbench({ open = true }: { open?: boolean }) {
  const { paneSizes, paneRefs, startPaneResize } = usePaneResize(1);
  const handle = (pane: PaneKey, label: string) => (
    <div
      className={`pane-resize ${pane}-resize`}
      onPointerDown={startPaneResize(pane)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANE_BOUNDS[pane].min}
      aria-valuemax={PANE_BOUNDS[pane].max}
      aria-valuenow={Math.round(paneSizes[pane])}
      tabIndex={0}
    />
  );
  return (
    <div className="app-shell" data-theme="mythra" data-color-scheme={themeColorScheme("mythra")} data-testid="shell" style={{ height: 600 }}>
      <aside ref={paneRefs.sidebar} className={`sidebar ${open ? "open" : "closed"}`} data-testid="sidebar">{open && handle("sidebar", "Resize sidebar")}</aside>
      <main className="main-panel"><p data-testid="transcript">Transcript</p></main>
      <aside ref={paneRefs.dock} className={`studio-dock ${open ? "open" : "closed"}`} data-testid="dock">{open && handle("dock", "Resize workspace tools")}</aside>
    </div>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const paneOf = (pane: PaneKey) => screen.getByTestId(pane);
const handleOf = (pane: PaneKey) => screen.getByRole("separator", { name: pane === "sidebar" ? "Resize sidebar" : "Resize workspace tools" });
const sizeTransitions = (element: Element) =>
  element.getAnimations().filter((animation) => animation instanceof CSSTransition && SIZE_PROPERTIES.has(animation.transitionProperty));

let pointerX = 0;
const trackPointer = (event: PointerEvent) => { pointerX = event.clientX; };
let mouseDown = false;

beforeEach(async () => {
  // Exercise the motion that caused the regression regardless of the host's
  // accessibility preference or a preceding spec's emulated media state.
  await commands.setStreamTestReducedMotion(false);
  localStorage.clear();
  localStorage.setItem("kiwi.paneSizes", JSON.stringify(START));
  window.addEventListener("pointerdown", trackPointer, true);
  window.addEventListener("pointermove", trackPointer, true);
});

afterEach(async () => {
  window.removeEventListener("pointerdown", trackPointer, true);
  window.removeEventListener("pointermove", trackPointer, true);
  if (mouseDown) await commands.setMouseButton(false);
  mouseDown = false;
  await commands.setStreamTestReducedMotion(false);
});

/** Presses the real mouse on the pane's handle and returns the press point. */
async function press(pane: PaneKey) {
  await userEvent.hover(handleOf(pane));
  await commands.setMouseButton(true);
  mouseDown = true;
  expect(document.body).toHaveAttribute("data-pane-resizing", pane);
  return pointerX;
}

/** Moves the held mouse `delta` px horizontally from the press point. */
async function moveBy(startX: number, delta: number) {
  const shell = screen.getByTestId("shell");
  const { left, height } = shell.getBoundingClientRect();
  await userEvent.hover(shell, { position: { x: startX + delta - left, y: height / 2 } });
}

async function release() {
  await commands.setMouseButton(false);
  mouseDown = false;
}

const targetFor = (pane: PaneKey, startX: number) =>
  clampPaneSize(pane, pane === "sidebar" ? START[pane] + pointerX - startX : START[pane] - (pointerX - startX));

it.each<PaneKey>(["sidebar", "dock"])("paints the %s width on the frame after each trusted drag move, then restores its motion", async (pane) => {
  const view = render(<Workbench />);
  const element = paneOf(pane);
  // Any border or gutter the island draws stays constant through the drag.
  const chrome = element.getBoundingClientRect().width - START[pane];
  const startX = await press(pane);

  for (const delta of pane === "sidebar" ? [70, 140] : [-80, -190]) {
    await moveBy(startX, delta);
    const target = targetFor(pane, startX);
    expect(target, "the move reached the hook").not.toBe(START[pane]);
    await nextFrame();
    expect(sizeTransitions(element), "no width easing while dragging").toEqual([]);
    expect(element.getBoundingClientRect().width).toBeCloseTo(target + chrome, 0);
    expect(handleOf(pane)).toHaveAttribute("aria-valuenow", String(Math.round(target)));
  }

  const committed = targetFor(pane, startX);
  await release();
  expect(document.body).not.toHaveAttribute("data-pane-resizing");
  await nextFrame();
  expect(element.getBoundingClientRect().width, "release does not snap or re-ease").toBeCloseTo(committed + chrome, 0);
  expect(sizeTransitions(element)).toEqual([]);
  expect(JSON.parse(localStorage.getItem("kiwi.paneSizes")!)[pane]).toBe(committed);

  // Outside a drag the pane keeps its open/close motion.
  view.rerender(<Workbench open={false} />);
  expect(sizeTransitions(element).length).toBeGreaterThan(0);
});

it("eases a cancelled drag back to the committed width without committing", async () => {
  render(<Workbench />);
  const element = paneOf("sidebar");
  const chrome = element.getBoundingClientRect().width - START.sidebar;
  const startX = await press("sidebar");
  await moveBy(startX, 120);
  await nextFrame();
  expect(element.getBoundingClientRect().width).toBeCloseTo(targetFor("sidebar", startX) + chrome, 0);

  await userEvent.keyboard("{Escape}");
  expect(document.body).not.toHaveAttribute("data-pane-resizing");
  // The drag override lifts first, so the revert uses the normal motion.
  const revert = sizeTransitions(element);
  expect(revert.length).toBeGreaterThan(0);
  await Promise.all(revert.map((animation) => animation.finished));
  expect(element.getBoundingClientRect().width).toBeCloseTo(START.sidebar + chrome, 0);
  expect(handleOf("sidebar")).toHaveAttribute("aria-valuenow", String(START.sidebar));

  await release();
  expect(JSON.parse(localStorage.getItem("kiwi.paneSizes")!)).toEqual(START);
});

it.each<PaneKey>(["sidebar", "dock"])("tracks the %s drag with reduced motion", async (pane) => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Workbench />);
  const element = paneOf(pane);
  const chrome = element.getBoundingClientRect().width - START[pane];
  const startX = await press(pane);
  await moveBy(startX, pane === "sidebar" ? 90 : -90);
  await nextFrame();
  expect(element.getBoundingClientRect().width).toBeCloseTo(targetFor(pane, startX) + chrome, 0);
  expect(sizeTransitions(element)).toEqual([]);
  await release();
  view.rerender(<Workbench open={false} />);
  expect(sizeTransitions(element)).toEqual([]);
});

it.each<PaneKey>(["sidebar", "dock"])("keeps the dragged width local to the %s root", async (pane) => {
  render(<Workbench />);
  const variable = pane === "sidebar" ? "--sidebar-width" : "--dock-width";
  const computed = (element: Element) => getComputedStyle(element).getPropertyValue(variable).trim();
  const startX = await press(pane);
  await moveBy(startX, pane === "sidebar" ? 60 : -60);
  const target = targetFor(pane, startX);

  expect(computed(paneOf(pane))).toBe(`${target}px`);
  // The width variable does not inherit into the shell, transcript, other
  // pane or dragged pane contents. This checks variable isolation; resizing
  // can still cause layout and paint in surrounding elements.
  for (const element of [screen.getByTestId("shell"), screen.getByTestId("transcript"), paneOf(pane === "sidebar" ? "dock" : "sidebar"), handleOf(pane)]) {
    expect(computed(element), element.className || element.tagName).toBe("");
  }
  await release();
});
