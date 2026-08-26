import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThemeName } from "../types";
import "../styles.css";

const THEMES: ThemeName[] = ["mythra", "kiwi", "daylight", "midnight", "synthwave", "ember", "terminal"];

function ToggleSamples({ theme }: { theme: ThemeName }) {
  return (
    <div className="app-shell" data-theme={theme} data-testid={theme}>
      <button className="toggle-switch on"><span /></button>
      <button className="mini-toggle on"><span /></button>
      <button className="sa-tile-switch on"><span /></button>
      <button className="project-prompt-layer-toggle enabled">
        <span className="project-prompt-switch"><i /></span>
        <span>Prompt layer</span>
      </button>
    </div>
  );
}

describe("theme-aware toggle colors", () => {
  it("uses one theme-derived active track across every switch variant", () => {
    const view = render(<>{THEMES.map((theme) => <ToggleSamples key={theme} theme={theme} />)}</>);
    const trackColors = new Set<string>();

    for (const theme of THEMES) {
      const shell = view.getByTestId(theme);
      const tracks = [
        shell.querySelector<HTMLElement>(".toggle-switch.on"),
        shell.querySelector<HTMLElement>(".mini-toggle.on"),
        shell.querySelector<HTMLElement>(".sa-tile-switch.on"),
        shell.querySelector<HTMLElement>(".project-prompt-switch"),
      ];
      const colors = tracks.map((track) => getComputedStyle(track!).backgroundColor);
      expect(new Set(colors).size).toBe(1);
      trackColors.add(colors[0]);
    }

    expect(trackColors.size).toBe(THEMES.length);
    expect([...trackColors]).not.toContain("rgba(167, 226, 111, 0.32)");
  });

  it("keeps Midnight entirely blue instead of pairing its blue thumb with a green track", () => {
    const view = render(<ToggleSamples theme="midnight" />);
    const track = view.container.querySelector<HTMLElement>(".toggle-switch.on");
    const thumb = view.container.querySelector<HTMLElement>(".toggle-switch.on span");

    expect(getComputedStyle(thumb!).backgroundColor).toBe("rgb(127, 196, 255)");
    expect(getComputedStyle(track!).backgroundColor).not.toBe("rgba(167, 226, 111, 0.32)");
    expect(getComputedStyle(track!).backgroundColor).not.toBe(getComputedStyle(thumb!).backgroundColor);
  });
});
