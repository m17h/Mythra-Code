import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { InfoPopover } from "./InfoPopover";

const capability = vi.hoisted(() => ({ topLayer: true }));
vi.mock("../lib/floatingLayer", async (original) => ({
  ...await original<typeof import("../lib/floatingLayer")>(),
  supportsTopLayer: () => capability.topLayer,
}));
afterEach(async () => {
  capability.topLayer = true;
  vi.unstubAllGlobals();
  await page.viewport(1400, 900);
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const details = <p>Requires Python, Playwright and its browser installation, plus a running local application to test.</p>;

function expectPaintedWithin(panel: HTMLElement, area: DOMRect) {
  const box = panel.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(area.left - 1);
  expect(box.top).toBeGreaterThanOrEqual(area.top - 1);
  expect(box.right).toBeLessThanOrEqual(area.right + 1);
  expect(box.bottom).toBeLessThanOrEqual(area.bottom + 1);
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  expect(hit && panel.contains(hit)).toBe(true);
}

it("old engines: stays inside a transformed, clipping native dialog and keeps first Escape", async () => {
  capability.topLayer = false;
  await page.viewport(800, 600);
  const onCancel = vi.fn();
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <dialog aria-label="Owner" onCancel={onCancel} style={{ width: 300, height: 220, padding: 0, overflow: "hidden", transform: "translateY(0px) scale(1)" }}>
      <div style={{ height: "100%", overflow: "auto" }}>
        <div style={{ position: "absolute", right: 10, bottom: 10 }}>
          <InfoPopover label="Requirements" trigger="Info">{details}</InfoPopover>
        </div>
      </div>
    </dialog>
  </div>);
  const dialog = document.querySelector("dialog")!;
  dialog.showModal();
  const trigger = screen.getByRole("button", { name: "Requirements" });
  await userEvent.click(trigger);
  await frame();
  const panel = screen.getByRole("tooltip");
  expect(panel.parentElement).toBe(dialog);
  expectPaintedWithin(panel, dialog.getBoundingClientRect());
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top + 1);

  // Clicking inside the portaled panel keeps it; Escape closes only it.
  await userEvent.click(panel);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  trigger.focus();
  await userEvent.keyboard("{Escape}");
  expect(panel).not.toBeVisible();
  expect(dialog.open).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();
  dialog.close();
});

it("old engines: escapes a transformed Settings sheet through its backdrop and follows nested scrolling and resizes", async () => {
  capability.topLayer = false;
  await page.viewport(900, 700);
  render(<div className="app-shell" data-theme="light-mythra" data-color-scheme="light">
    <div className="modal-backdrop settings-backdrop open" style={{ animation: "none" }}>
      <div className="settings-modal" role="dialog" aria-label="Settings" style={{ width: 360, height: 300, animation: "none", transform: "translateY(0px) scale(1)", overflow: "hidden" }}>
        <div data-testid="scroller" style={{ height: 260, overflow: "auto" }}>
          <div style={{ height: 230 }} />
          <InfoPopover label="Requirements" trigger="Info">{details}</InfoPopover>
          <div style={{ height: 600 }} />
        </div>
      </div>
    </div>
  </div>);
  const backdrop = document.querySelector<HTMLElement>(".settings-backdrop")!;
  const trigger = screen.getByRole("button", { name: "Requirements" });
  await userEvent.click(trigger);
  await frame();
  const panel = screen.getByRole("tooltip");
  expect(panel.parentElement).toBe(backdrop);
  expect(getComputedStyle(panel).getPropertyValue("--text").trim()).toBe(getComputedStyle(trigger).getPropertyValue("--text").trim());
  // Extends past the sheet's clipped bottom edge, yet stays painted.
  expect(panel.getBoundingClientRect().bottom).toBeGreaterThan(document.querySelector(".settings-modal")!.getBoundingClientRect().bottom);
  expectPaintedWithin(panel, new DOMRect(0, 0, window.innerWidth, window.innerHeight));

  const scroller = screen.getByTestId("scroller");
  scroller.scrollTop = 120;
  await frame();
  expect(Math.abs(panel.getBoundingClientRect().left - trigger.getBoundingClientRect().left)).toBeLessThanOrEqual(2);
  const anchor = trigger.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  expect(Math.abs(box.top - anchor.bottom - 6) <= 2 || Math.abs(anchor.top - box.bottom - 6) <= 2).toBe(true);

  await page.viewport(520, 420);
  await frame();
  expectPaintedWithin(panel, new DOMRect(0, 0, window.innerWidth, window.innerHeight));

  // An outside click releases it; the portal does not count as outside.
  await userEvent.click(document.body, { position: { x: 4, y: 4 } });
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
});

it("top layer: re-places growing content and leaves no observers or listeners once closed", async () => {
  await page.viewport(900, 700);
  let active = 0;
  const Native = ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends Native {
    constructor(callback: ResizeObserverCallback) { super(callback); active += 1; }
    disconnect() { active -= 1; super.disconnect(); }
  });
  const scrollListeners = new Set<EventListenerOrEventListenerObject>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "scroll" || type === "resize" || type === "keydown") scrollListeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    scrollListeners.delete(listener);
    remove(type, listener, options);
  });
  const fixture = (count: number) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <div style={{ position: "fixed", left: 100, bottom: 60 }}>
      <InfoPopover label="Live skills" trigger="Skills">
        <ul style={{ margin: 0, padding: 0 }}>{Array.from({ length: count }, (_, index) => <li key={index} style={{ height: 24 }}>skill-{index}</li>)}</ul>
      </InfoPopover>
    </div>
  </div>;
  const view = render(fixture(1));
  expect(active).toBe(0);
  const trigger = screen.getByRole("button", { name: "Live skills" });
  await userEvent.click(trigger);
  await frame();
  const panel = screen.getByRole("tooltip");
  expect(panel.matches(":popover-open")).toBe(true);
  expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(trigger.getBoundingClientRect().bottom);
  view.rerender(fixture(12));
  await frame();
  // Not enough room below any more: it moves above, whole and unclipped.
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top + 1);
  // Bounded at its 280 px cap; the longer list scrolls inside it.
  expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(281);
  expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
  expectPaintedWithin(panel, new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  expect(active).toBeGreaterThan(0);

  await userEvent.click(trigger);
  await frame();
  expect(panel.matches(":popover-open")).toBe(false);
  expect(active).toBe(0);
  expect(scrollListeners.size).toBe(0);
});
