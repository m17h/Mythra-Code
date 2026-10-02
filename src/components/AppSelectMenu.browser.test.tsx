import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { AppSelectMenu } from "./AppSelectMenu";
import "../styles.css";

afterEach(() => page.viewport(1400, 900));

describe("app-owned select browser layout", () => {
  it.each([1, 1.5])("anchors fallback choices in a scrolled dialog at %s zoom", async (zoom) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover")!;
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
    try {
      const onChange = vi.fn();
      const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width: 800, height: 600, zoom }}>
        <div role="dialog" aria-label="Scrolled picker" style={{ position: "relative", width: 550, height: 240, overflow: "auto", margin: 40 }}>
          <div style={{ width: 800, height: 250 }} />
          <div style={{ width: 100, height: 60, marginLeft: 100, overflow: "hidden" }}>
            <AppSelectMenu value="one" options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} ariaLabel="Scrolled choices" portal onChange={onChange} />
          </div>
          <div style={{ height: 300 }} />
        </div>
      </div>);
      const dialog = view.getByRole("dialog", { name: "Scrolled picker" });
      dialog.scrollTop = 200;
      dialog.scrollLeft = 40;
      await page.getByRole("button", { name: "Scrolled choices" }).click();
      const menu = view.container.querySelector<HTMLElement>(".app-select-menu")!;
      menu.getAnimations().forEach((animation) => animation.finish());
      const trigger = view.getByRole("button", { name: "Scrolled choices" }).getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      expect(Math.abs(bounds.left - trigger.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.top - trigger.bottom - 4)).toBeLessThanOrEqual(1);
      await page.getByRole("menuitemradio", { name: "Two" }).click();
      expect(onChange).toHaveBeenCalledWith("two");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
    }
  });

  it.each([1, 1.5])("anchors fallback choices outside a clipped, unpositioned shell at a nonzero offset (%s zoom)", async (zoom) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover")!;
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
    try {
      const onChange = vi.fn();
      const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", position: "static", width: 600, height: 400, marginLeft: 80, marginTop: 40, padding: "80px 100px", zoom }}>
        <div style={{ width: 100, height: 60, overflow: "hidden" }}>
          <AppSelectMenu value="one" options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} ariaLabel="Fallback choices" portal onChange={onChange} />
        </div>
      </div>);
      await page.getByRole("button", { name: "Fallback choices" }).click();
      const menu = view.container.querySelector<HTMLElement>(".app-select-menu")!;
      menu.getAnimations().forEach((animation) => animation.finish());
      const trigger = view.getByRole("button", { name: "Fallback choices" }).getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      expect(Math.abs(bounds.left - trigger.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.top - trigger.bottom - 4)).toBeLessThanOrEqual(1);
      const palette = document.createElement("span");
      palette.style.backgroundColor = "var(--menu-surface)";
      view.container.querySelector(".app-shell")!.append(palette);
      expect(getComputedStyle(menu).backgroundColor).toBe(getComputedStyle(palette).backgroundColor);
      const option = view.getByRole("menuitemradio", { name: "Two" });
      const box = option.getBoundingClientRect();
      expect(option.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
      await page.getByRole("menuitemradio", { name: "Two" }).click();
      expect(onChange).toHaveBeenCalledWith("two");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
    }
  });

  it.each([1, 1.5])("keeps a searchable portal menu scrollable inside a short viewport at %s scale", async (zoom) => {
    await page.viewport(360, 200);
    const view = render(<div className="app-shell" style={{ display: "block", position: "fixed", inset: 0, width: window.innerWidth / zoom, height: window.innerHeight / zoom, zoom }}>
      <AppSelectMenu value="one" options={Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `Choice ${index}` }))} ariaLabel="Short window choices" portal searchable onChange={vi.fn()} />
    </div>);
    await page.getByRole("button", { name: "Short window choices" }).click();
    const menu = view.container.querySelector<HTMLElement>(".app-select-menu")!;
    act(() => menu.getAnimations().forEach((animation) => animation.finish()));
    const bounds = menu.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(7);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 7);
    const options = view.getByRole("menu", { name: "Short window choices choices" });
    expect(options.scrollHeight).toBeGreaterThan(options.clientHeight);
    expect(getComputedStyle(options).overflowY).toBe("auto");
    await page.getByRole("textbox", { name: "Search Short window choices" }).fill("Choice 19");
    await page.getByRole("menuitemradio", { name: "Choice 19" }).click();
    expect(view.queryByRole("menu", { name: "Short window choices choices" })).toBeNull();
  });

  it.each([.8, 1, 1.5])("keeps portal choices anchored and selectable outside a clipping container at %s scale", async (zoom) => {
    const onChange = vi.fn();
    const view = render(<div className="app-shell" data-theme="mythra" style={{ display: "block", position: "fixed", top: 0, left: 0, width: window.innerWidth / zoom, height: window.innerHeight / zoom, paddingTop: (window.innerHeight - 100) / zoom, paddingLeft: (window.innerWidth - 100) / zoom, zoom }}>
      <div style={{ width: 70, height: 60, overflow: "hidden" }}>
        <AppSelectMenu value="one" options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} ariaLabel="Clipped portal choices" portal onChange={onChange} />
      </div>
    </div>);
    await page.getByRole("button", { name: "Clipped portal choices" }).click();
    const menu = view.container.querySelector<HTMLElement>(".app-select-menu")!;
    menu.getAnimations().forEach((animation) => animation.finish());
    const trigger = view.getByRole("button", { name: "Clipped portal choices" }).getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 7);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 7);
    expect(Math.min(Math.abs(bounds.top - trigger.bottom), Math.abs(bounds.bottom - trigger.top))).toBeLessThanOrEqual(5);
    expect(Math.abs(bounds.width - 320 * zoom)).toBeLessThanOrEqual(1);
    await page.getByRole("menuitemradio", { name: "Two" }).click();
    expect(onChange).toHaveBeenCalledWith("two");
  });

  it("can open a settings model menu above its trigger without clipping into the footer", () => {
    const view = render(
      <div className="app-shell" data-theme="midnight" style={{ display: "block", width: 760, height: 520, padding: "340px 80px 0" }}>
        <div className="field-label default-model-picker" style={{ width: 520 }}>
          <AppSelectMenu
            value="claude-opus-5"
            options={[
              { value: "claude-fable-5", label: "Fable 5", detail: "Frontier coding" },
              { value: "claude-opus-5", label: "Opus 5", detail: "Deepest reasoning" },
              { value: "claude-sonnet-5", label: "Sonnet 5", detail: "Balanced power" },
            ]}
            ariaLabel="Default Claude model"
            menuPlacement="top"
            onChange={vi.fn()}
          />
        </div>
      </div>,
    );

    const trigger = view.getByRole("button", { name: "Default Claude model" });
    fireEvent.click(trigger);
    expect(view.getByRole("menu", { name: "Default Claude model choices" })).toBeVisible();
    const menu = view.container.querySelector<HTMLElement>(".app-select-menu")!;
    menu.getAnimations().forEach((animation) => animation.finish());
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    expect(menuRect.bottom).toBeLessThanOrEqual(triggerRect.top);
    expect(Math.round(menuRect.width)).toBe(Math.round(triggerRect.width));
  });

  it("coalesces nested scroll bursts into one top-layer position read per frame", async () => {
    const view = render(
      <AppSelectMenu
        value="one"
        options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]}
        ariaLabel="Portal model"
        portal
        onChange={vi.fn()}
      />,
    );
    const trigger = view.getByRole("button", { name: "Portal model" });
    const rect = vi.spyOn(trigger, "getBoundingClientRect");
    fireEvent.click(trigger);
    const initialReads = rect.mock.calls.length;

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(rect).toHaveBeenCalledTimes(initialReads);

    let readsAtFrameEnd = initialReads;
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        // Initial ResizeObserver delivery can schedule the next frame while
        // async act settles. Count this burst's frame, not later frames.
        readsAtFrameEnd = rect.mock.calls.length;
        resolve();
      }));
    });
    expect(readsAtFrameEnd).toBe(initialReads + 1);
  });
});
