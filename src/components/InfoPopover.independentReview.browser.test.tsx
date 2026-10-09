import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { InfoPopover } from "./InfoPopover";
import { ActivityDetailsModal } from "./ActivityDetailsModal";

const capability = vi.hoisted(() => ({ topLayer: true }));
vi.mock("../lib/floatingLayer", async (original) => ({
  ...await original<typeof import("../lib/floatingLayer")>(),
  supportsTopLayer: () => capability.topLayer,
}));
afterEach(async () => { capability.topLayer = true; await page.viewport(1400, 900); });

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it("preserves scroll position while a zoomed long list is clamped to short viewport space", async () => {
  await page.viewport(600, 520);
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: 1.5 }}>
    <div style={{ position: "fixed", top: 170, left: 30 }}>
      <InfoPopover label="Scrollable names" trigger="Names">
        <ul style={{ padding: 0, margin: 0 }}>
          {Array.from({ length: 32 }, (_, index) => <li key={index} style={{ height: 24 }}>skill-{index}</li>)}
        </ul>
      </InfoPopover>
    </div>
  </div>);
  await userEvent.click(screen.getByRole("button", { name: "Scrollable names" }));
  await frame();
  const panel = screen.getByRole("tooltip");
  expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
  panel.scrollTop = panel.scrollHeight;
  const bottom = panel.scrollTop;
  await frame();
  await frame();
  expect(Math.abs(panel.scrollTop - bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.scrollHeight - panel.clientHeight - panel.scrollTop)).toBeLessThanOrEqual(1);
});

it("claims the first Escape for hovered details when focus fell to the body", async () => {
  const onClose = vi.fn();
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <ActivityDetailsModal sourceRef={{ current: null }} onClose={onClose}
      run={{ state: "completed", entries: [{ kind: "activity", value: {
        id: "skill", kind: "command", title: "Skill", status: "completed",
        skillUsage: [{ name: "review", source: "claude-skill-tool", status: "loaded" }],
      } }] }} renderMessage={() => null} renderSubAgents={() => null} />
  </div>);
  await userEvent.hover(screen.getByRole("button", { name: "1 skill used" }));
  await frame();
  expect(screen.getByRole("tooltip")).toBeVisible();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  expect(document.activeElement).toBe(document.body);
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
});

it.each([0.9, 1, 1.25, 1.5])("anchors native details at %sx theme zoom", async (zoom) => {
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="light" style={{ zoom }}>
    <div style={{ position: "fixed", top: 140, left: 120 }}>
      <InfoPopover label="Zoom details" trigger="Requirements">
        <p>Python and Chromium.</p>
      </InfoPopover>
    </div>
  </div>);
  const trigger = screen.getByRole("button", { name: "Zoom details" });
  await userEvent.click(trigger);
  await frame();
  const panel = screen.getByRole("tooltip");
  const anchor = trigger.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  expect(Math.abs(bounds.left - anchor.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds.top - anchor.bottom - 6)).toBeLessThanOrEqual(2);
  expect(panel.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
  expect(getComputedStyle(panel).getPropertyValue("--text").trim()).toBe(getComputedStyle(trigger).getPropertyValue("--text").trim());
});

it("keeps an open details panel in the viewport when live skill names grow", async () => {
  const fixture = (count: number) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <div style={{ position: "fixed", left: 100, bottom: 80 }}>
      <InfoPopover label="Live skills" trigger="Skills">
        <ul style={{ margin: 0, padding: 0 }}>
          {Array.from({ length: count }, (_, index) => <li key={index} style={{ height: 24 }}>skill-{index}</li>)}
        </ul>
      </InfoPopover>
    </div>
  </div>;
  const view = render(fixture(1));
  await userEvent.click(screen.getByRole("button", { name: "Live skills" }));
  await frame();
  const panel = screen.getByRole("tooltip");
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight - 7);
  view.rerender(fixture(12));
  await frame();
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight - 7);
});

it("keeps fallback details readable beside a clipped native dialog", async () => {
  capability.topLayer = false;
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <dialog aria-label="Clipped owner" style={{ width: 250, height: 180, padding: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", right: 8, bottom: 8 }}>
        <InfoPopover label="Fallback details" trigger="Info">
          <p>Python, Playwright, Chromium and a running local application.</p>
        </InfoPopover>
      </div>
    </dialog>
  </div>);
  const dialog = document.querySelector("dialog")!;
  dialog.showModal();
  await userEvent.click(screen.getByRole("button", { name: "Fallback details" }));
  await frame();
  const panel = screen.getByRole("tooltip");
  const bounds = panel.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(panel.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
});

it.each([true, false])("keeps details visible when their scrolling trigger leaves the viewport (top layer: %s)", async (topLayer) => {
  capability.topLayer = topLayer;
  await page.viewport(800, 600);
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <dialog aria-label="Scrolling owner" style={{ width: 450, height: 350, padding: 0, overflow: "hidden", transform: "translateY(0px) scale(1)" }}>
      <div data-testid="owner-scroll" style={{ height: 300, overflow: "auto" }}>
        <div style={{ height: 100 }} />
        <InfoPopover label="Scrolling requirements" trigger="Details">
          <p>Python and Playwright plus a running web server.</p>
        </InfoPopover>
        <div style={{ height: 1800 }} />
      </div>
    </dialog>
  </div>);
  const dialog = document.querySelector("dialog")!;
  dialog.showModal();
  const trigger = screen.getByRole("button", { name: "Scrolling requirements" });
  await userEvent.click(trigger);
  await frame();
  const panel = screen.getByRole("tooltip");
  screen.getByTestId("owner-scroll").scrollTop = 900;
  await frame();
  expect(trigger.getBoundingClientRect().bottom).toBeLessThan(0);
  // An invisible anchor may dismiss its details, or leave a readable panel
  // clamped to the area its modal owner can actually show.
  if (trigger.getAttribute("aria-expanded") === "true") {
    const area = topLayer ? new DOMRect(0, 0, window.innerWidth, window.innerHeight) : dialog.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(area.top - 1);
    expect(bounds.bottom).toBeLessThanOrEqual(area.bottom + 1);
    expect(panel.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
  }
  dialog.close();
});
