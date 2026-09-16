import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppSelectMenu } from "./AppSelectMenu";
import "../styles.css";

describe("app-owned select browser layout", () => {
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

    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(rect).toHaveBeenCalledTimes(initialReads + 1);
  });
});
