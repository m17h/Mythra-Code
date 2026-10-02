import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThemeName } from "../types";
import { themeColorScheme, THEMES as THEME_CATALOG } from "../lib/appConfig";
import "../styles.css";

const THEMES = THEME_CATALOG.map((theme) => theme.id);

function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(first: string, second: string) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function ToggleSamples({ theme }: { theme: ThemeName }) {
  return (
    <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} data-testid={theme}>
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

  // Lumen redesign: an active switch is a track in the theme accent (lit by
  // the accent gradient where supported) carrying an on-accent thumb. The
  // contracts below are the legacy ones restated for that model: the track is
  // the theme's own hue, never another theme's, and the thumb stays visible.
  it("keeps Synthwave's switches pink instead of pairing its thumb with a green track", () => {
    const view = render(<ToggleSamples theme="synthwave" />);
    const track = view.container.querySelector<HTMLElement>(".toggle-switch.on");
    const thumb = view.container.querySelector<HTMLElement>(".toggle-switch.on span");

    expect(getComputedStyle(track!).backgroundColor).toBe("rgb(255, 106, 193)");
    expect(getComputedStyle(track!).backgroundColor).not.toBe("rgba(167, 226, 111, 0.32)");
    expect(getComputedStyle(track!).backgroundColor).not.toBe(getComputedStyle(thumb!).backgroundColor);
    expect(contrast(getComputedStyle(thumb!).backgroundColor, getComputedStyle(track!).backgroundColor)).toBeGreaterThanOrEqual(3);
  });

  it("gives Light Mythra its own cyan palette instead of inheriting Light Kiwi green", () => {
    const view = render(<><ToggleSamples theme="light-mythra" /><ToggleSamples theme="daylight" /></>);
    const shell = view.getByTestId("light-mythra");
    const track = shell.querySelector<HTMLElement>(".toggle-switch.on");
    const thumb = shell.querySelector<HTMLElement>(".toggle-switch.on span");
    const kiwiTrack = view.getByTestId("daylight").querySelector<HTMLElement>(".toggle-switch.on");

    // The restrained canvas for Light Mythra stays neutral, with sky cyan
    // reserved for the active control rather than the entire surface.
    expect(getComputedStyle(shell).backgroundColor).toBe("rgb(227, 231, 234)");
    expect(getComputedStyle(track!).backgroundColor).toBe("rgb(10, 149, 212)");
    expect(getComputedStyle(track!).backgroundColor).not.toBe(getComputedStyle(kiwiTrack!).backgroundColor);
    expect(getComputedStyle(track!).backgroundColor).not.toBe("rgba(62, 142, 34, 0.38)");
    expect(contrast(getComputedStyle(thumb!).backgroundColor, getComputedStyle(track!).backgroundColor)).toBeGreaterThanOrEqual(3);
  });

  it("keeps every theme's switch thumb distinguishable from its track", () => {
    const view = render(<>{THEMES.map((theme) => <ToggleSamples key={theme} theme={theme} />)}</>);
    for (const theme of THEMES) {
      const shell = view.getByTestId(theme);
      const track = shell.querySelector<HTMLElement>(".toggle-switch.on")!;
      const thumb = shell.querySelector<HTMLElement>(".toggle-switch.on span")!;
      expect(contrast(getComputedStyle(thumb).backgroundColor, getComputedStyle(track).backgroundColor), theme).toBeGreaterThanOrEqual(3);
    }
  });
});
