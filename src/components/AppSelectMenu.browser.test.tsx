import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { AppSelectMenu } from "./AppSelectMenu";
import "../styles.css";

describe("app-owned select browser layout", () => {
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
