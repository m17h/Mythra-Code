import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EffortSlider, effortFlairStyle } from "./effortFlair";

/**
 * The flair style is the only channel the CSS styles have for the active
 * level, so every registered palette has to publish a variable for all five
 * effort levels — otherwise a style silently falls back to its default color.
 */
describe("effortFlairStyle", () => {
  const LEVEL_VARIABLES = ["--effort-color", "--pixel-effort-color", "--aurora-effort-color", "--sonar-effort-color", "--vital-effort-color", "--dune-effort-color"] as const;

  it.each([0, 1, 2, 3, 4])("publishes every palette's color for level %i", (index) => {
    const flair = effortFlairStyle(index, 5) as Record<string, string>;

    expect(flair["--effort-heat"]).toBe(String(index / 4));
    for (const variable of LEVEL_VARIABLES) expect(flair[variable]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each([
    ["--sonar-effort-color", ["#3d6fe8", "#1f9fe0", "#12c9c4", "#17dd86", "#5cffc0"]],
    ["--vital-effort-color", ["#ffc2ce", "#ff9db4", "#ff6f92", "#ff4770", "#ff2050"]],
    ["--dune-effort-color", ["#f0dcae", "#e6bd85", "#dc9c68", "#cf7a5c", "#c05a4e"]],
  ] as const)("walks %s across its own five colors", (variable, palette) => {
    const walked = palette.map((_, index) => (effortFlairStyle(index, 5) as Record<string, string>)[variable]);

    expect(walked).toEqual([...palette]);
    expect(new Set(walked).size).toBe(palette.length);
  });

  it("keeps a shorter effort scale on the ends of each palette", () => {
    // LM Studio models can expose fewer levels; the ramp still has to resolve.
    const flair = effortFlairStyle(0, 2) as Record<string, string>;
    const top = effortFlairStyle(1, 2) as Record<string, string>;

    expect(flair["--dune-effort-color"]).toBe("#f0dcae");
    expect(top["--dune-effort-color"]).toBe("#c05a4e");
  });
});

describe("EffortSlider keyboard control", () => {
  const renderSlider = (onIndex: (index: number) => void, index = 2) =>
    render(
      <EffortSlider variant="codex" index={index} count={5} ariaLabel="Reasoning effort" valueText="High" onIndex={onIndex} />,
    );

  it("moves a level per arrow key and jumps to the ends", () => {
    const onIndex = vi.fn();
    renderSlider(onIndex);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onIndex).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onIndex).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onIndex).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onIndex).toHaveBeenLastCalledWith(4);
  });

  it("keeps the native range control focusable and labeled for assistive tech", () => {
    renderSlider(vi.fn());
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });

    slider.focus();
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    expect(slider).toBeEnabled();
  });
});
