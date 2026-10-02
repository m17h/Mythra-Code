import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { themeColorScheme } from "../lib/appConfig";
import { ClaudeProviderLogo, OpenAILogo } from "./BrandLogos";
import { ThreadInboxCard } from "./ThreadInboxCard";
import "../styles.css";
import "./UsageDashboard.css";

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

function compositeColor(color: string, background: string, opacity = 1): string {
  const channels = color.match(/[\d.]+/g)!.map(Number);
  if (color.startsWith("color(srgb")) {
    for (let index = 0; index < 3; index++) channels[index] *= 255;
  }
  const backdrop = background.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const alpha = (channels[3] ?? 1) * opacity;
  return `rgb(${channels.slice(0, 3).map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha)).join(", ")})`;
}

function hsl(color: string) {
  const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => Number(value) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, lightness = (max + min) / 2;
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  const hue = !delta ? 0 : max === r ? (((g - b) / delta) % 6 + 6) % 6 * 60 : max === g ? ((b - r) / delta + 2) * 60 : ((r - g) / delta + 4) * 60;
  return { hue, saturation, lightness };
}

// Every surface token a dark palette owns. Synthwave shares Mythra's values
// exactly; only its accent family differs.
const SURFACE_TOKENS = [
  "--lm-canvas", "--bg", "--sidebar", "--panel", "--panel-2", "--panel-3", "--field", "--menu-surface", "--topbar",
  "--line", "--line-strong", "--line-quiet", "--text", "--ink-2", "--muted", "--muted-2",
  "--lm-island-edge", "--lm-island-highlight", "--lm-island-shadow", "--lm-pop-shadow", "--lm-hover", "--lm-press",
  "--lm-code-bg", "--lm-code-ink", "--lm-scrim", "--lm-aurora-1", "--lm-aurora-3",
];
const SURFACES = [".sidebar", ".main-panel", ".topbar", ".studio-dock", ".composer", ".settings-modal", ".app-select-menu", ".mention-menu", ".command-palette", ".code-block pre"];

function SurfaceSamples({ theme }: { theme: "mythra" | "synthwave" }) {
  return <div className="app-shell" data-theme={theme} data-color-scheme="dark" data-testid={theme} style={{ display: "block" }}>
    <aside className="sidebar" />
    <main className="main-panel"><header className="topbar" /></main>
    <aside className="studio-dock" />
    <div className="composer" />
    <div className="settings-modal" />
    <div className="app-select-menu" />
    <div className="mention-menu" />
    <div className="command-palette" />
    <div className="code-block"><pre>code</pre></div>
    <span data-testid={`${theme}-accent`} style={{ color: "var(--green)" }}>Accent</span>
  </div>;
}

it("gives Synthwave Mythra's neutral graphite surfaces while keeping its pink accent", () => {
  const view = render(<><SurfaceSamples theme="mythra" /><SurfaceSamples theme="synthwave" /></>);
  const mythra = view.getByTestId("mythra"), synthwave = view.getByTestId("synthwave");
  for (const token of SURFACE_TOKENS) {
    expect(getComputedStyle(synthwave).getPropertyValue(token).trim(), token).toBe(getComputedStyle(mythra).getPropertyValue(token).trim());
  }
  for (const selector of SURFACES) {
    expect(getComputedStyle(synthwave.querySelector(selector)!).backgroundColor, selector)
      .toBe(getComputedStyle(mythra.querySelector(selector)!).backgroundColor);
  }
  expect(getComputedStyle(synthwave).backgroundColor).toBe(getComputedStyle(mythra).backgroundColor);
  // No plum or magenta wash behind the islands: the canvas light is neutral.
  for (const token of ["--lm-aurora-1", "--lm-aurora-2", "--lm-aurora-3"]) {
    const probe = document.createElement("i");
    probe.style.color = `var(${token})`;
    synthwave.appendChild(probe);
    const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number);
    probe.remove();
    expect(r === g && g === b, `${token} is neutral`).toBe(true);
  }
  expect(getComputedStyle(view.getByTestId("synthwave-accent")).color).toBe("rgb(255, 106, 193)");
  expect(getComputedStyle(view.getByTestId("mythra-accent")).color).toBe("rgb(100, 221, 242)");
  const panel = getComputedStyle(synthwave.querySelector(".settings-modal")!).backgroundColor;
  expect(contrast(getComputedStyle(view.getByTestId("synthwave-accent")).color, panel)).toBeGreaterThanOrEqual(4.5);
});

it("gives Light Mythra cyan action fills with dark ink and a readable blue text accent", () => {
  const view = render(<div className="app-shell" data-theme="light-mythra" data-color-scheme="light" style={{ display: "block" }}>
    {["--bg", "--sidebar", "--panel", "--panel-2", "--field"].map((surface) => (
      <div key={surface} data-surface={surface} style={{ background: `var(${surface})` }}>
        <span style={{ color: "var(--green)" }}>Accent</span>
        <button className="primary-button">Open project</button>
        <button className="send-button" aria-label="Send">↑</button>
        <button className="toggle-switch on"><span /></button>
      </div>
    ))}
  </div>);
  for (const row of view.container.querySelectorAll<HTMLElement>("[data-surface]")) {
    const surface = getComputedStyle(row).backgroundColor;
    const label = row.dataset.surface!;
    const accent = getComputedStyle(row.querySelector("span")!).color;
    // Text accents are a deep sky blue, not the old teal, and stay AA.
    expect(contrast(accent, surface), `accent text on ${label}`).toBeGreaterThanOrEqual(4.5);
    expect(hsl(accent).hue, "accent hue").toBeGreaterThanOrEqual(200);
    expect(hsl(accent).hue, "accent hue").toBeLessThanOrEqual(220);
    for (const selector of [".primary-button", ".send-button", ".toggle-switch.on"]) {
      const node = row.querySelector<HTMLElement>(selector)!;
      const fill = getComputedStyle(node).backgroundColor;
      // A lighter, clearly cyan fill whose boundary still reads on white.
      expect(hsl(fill).lightness, `${selector} fill lightness`).toBeGreaterThanOrEqual(.42);
      expect(hsl(fill).hue, `${selector} fill hue`).toBeGreaterThanOrEqual(192);
      expect(hsl(fill).hue, `${selector} fill hue`).toBeLessThanOrEqual(206);
      expect(contrast(fill, surface), `${selector} boundary on ${label}`).toBeGreaterThanOrEqual(3);
      if (selector !== ".toggle-switch.on") expect(contrast(getComputedStyle(node).color, fill), `${selector} ink`).toBeGreaterThanOrEqual(4.5);
    }
    const thumb = getComputedStyle(row.querySelector(".toggle-switch.on span")!).backgroundColor;
    expect(contrast(thumb, getComputedStyle(row.querySelector(".toggle-switch.on")!).backgroundColor)).toBeGreaterThanOrEqual(4.5);
  }
});

it("keeps Atari sidebar labels and actual thread metadata readable in inactive and selected rows", () => {
  const view = render(<div className="app-shell" data-theme="atari" data-color-scheme="light">
    <aside className="sidebar">
      <div className="section-label-row"><span className="section-label">Threads</span><span className="thread-count">2</span></div>
      {[false, true].map((active) => <div className={`thread-row-wrap${active ? " active" : ""}`} key={String(active)}>
        <ThreadInboxCard threadId={`contrast-${active}`} title="Review changes" workspaceName="Example project" directory="/projects/example" provider="openai" providerName="OpenAI" pinned={false} onOpen={() => {}} />
      </div>)}
      <button className="sidebar-settings">Settings</button>
    </aside>
  </div>);
  const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
  const surface = getComputedStyle(sidebar).backgroundColor;
  for (const selector of [".section-label", ".thread-count", ".sidebar-settings", ".thread-card-workspace", ".thread-card-directory"]) {
    for (const label of sidebar.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(label);
      const card = label.closest<HTMLElement>(".thread-card");
      const rowSurface = card ? compositeColor(getComputedStyle(card.parentElement!).backgroundColor, surface) : surface;
      const background = card ? compositeColor(getComputedStyle(card).backgroundColor, rowSurface) : surface;
      const ink = compositeColor(style.color, background, Number(style.opacity));
      expect(contrast(ink, background), `${selector} in ${card?.parentElement?.className ?? "sidebar"}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

it.each(["atari"] as const)("keeps %s surfaces, accent ink, and chart series accessible", (theme) => {
  const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block" }}>
    <div data-testid="panel" style={{ background: "var(--panel)", color: "var(--text)" }}>
      <span data-testid="muted" style={{ color: "var(--muted)" }}>Secondary text</span>
      <span data-testid="accent" style={{ color: "var(--green)" }}>Accent text</span>
      <span data-testid="warning" style={{ color: "var(--orange)" }}>Warning</span>
      <span data-testid="error" style={{ color: "var(--red)" }}>Error</span>
      <div className="message user"><div className="message-body">User message</div></div>
      <div className="subagent-panel" />
      <div className="app-select-menu" />
      <div className="app-select"><ClaudeProviderLogo /><OpenAILogo className="openai-logo-option" /></div>
      <div className="sa-add-row"><button><ClaudeProviderLogo /><OpenAILogo className="openai-logo-option" /></button></div>
      <span className="provider-mark claude"><ClaudeProviderLogo /></span>
      <div className="openrouter-control claude-control"><span className="openrouter-logo claude-logo"><ClaudeProviderLogo /></span><div className="openrouter-reasoning-heading">Reasoning</div></div>
      <div className="usage-dashboard" style={{ background: "var(--field)" }}>
        <i data-testid="first" className="usage-chart-bar" />
        <i data-testid="second" style={{ background: "var(--usage-series-2)" }} />
        <i data-testid="texture" className="usage-chart-bar series-2" />
        <i data-testid="legend" className="usage-swatch series-2" />
      </div>
    </div>
  </div>);
  const panel = getComputedStyle(view.getByTestId("panel"));
  expect(contrast(panel.color, panel.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  for (const id of ["muted", "accent", "warning", "error"]) {
    expect(contrast(getComputedStyle(view.getByTestId(id)).color, panel.backgroundColor), id).toBeGreaterThanOrEqual(4.5);
  }
  expect(getComputedStyle(view.getByTestId("accent")).color).not.toBe(getComputedStyle(view.getByTestId("warning")).color);
  expect(getComputedStyle(view.getByTestId("warning")).color).not.toBe(getComputedStyle(view.getByTestId("error")).color);
  const field = getComputedStyle(view.container.querySelector<HTMLElement>(".usage-dashboard")!).backgroundColor;
  for (const id of ["first", "second"]) expect(contrast(getComputedStyle(view.getByTestId(id)).backgroundColor, field)).toBeGreaterThanOrEqual(3);
  expect(getComputedStyle(view.getByTestId("texture")).backgroundImage).toContain("repeating-linear-gradient");
  expect(getComputedStyle(view.getByTestId("legend")).backgroundImage).toBe(getComputedStyle(view.getByTestId("texture")).backgroundImage);
  expect(panel.backgroundColor).toBe("rgb(247, 239, 223)");
  for (const selector of [".subagent-panel", ".app-select-menu"]) expect(getComputedStyle(view.container.querySelector<HTMLElement>(selector)!).backgroundColor).toBe("rgb(255, 247, 233)");
  expect(getComputedStyle(view.container.querySelector<HTMLElement>(".message-body")!).backgroundColor).toBe("rgb(238, 225, 204)");
  for (const selector of [".app-select", ".sa-add-row"]) {
    for (const logo of view.container.querySelectorAll<SVGElement>(`${selector} :is(.claude-logo-option, .openai-logo-option)`)) {
      expect(contrast(getComputedStyle(logo).fill, panel.backgroundColor)).toBeGreaterThanOrEqual(3);
    }
  }
  expect(getComputedStyle(view.container.querySelector<SVGElement>(".provider-mark.claude .claude-logo-option")!).fill).toBe("rgb(255, 255, 255)");
});

it("leaves no palette for the retired Midnight and Monochrome ids", () => {
  const view = render(<>{["not-a-theme", "midnight", "monochrome"].map((theme) => (
    <div key={theme} className="app-shell" data-theme={theme} data-color-scheme="dark" data-testid={theme}>
      <div className="usage-dashboard"><i className="usage-chart-bar series-2" /></div>
    </div>
  ))}</>);
  // Saved ids are sanitized before they reach the shell; even a stale
  // attribute is styled exactly like any unknown id, with no leftover palette.
  const unknown = view.getByTestId("not-a-theme");
  for (const retired of ["midnight", "monochrome"]) {
    const shell = view.getByTestId(retired);
    for (const token of ["--green", "--bg", "--panel", "--sidebar", "--muted", "--mythra-mark-cyan-a"]) {
      expect(getComputedStyle(shell).getPropertyValue(token).trim(), `${retired} ${token}`).toBe(getComputedStyle(unknown).getPropertyValue(token).trim());
    }
    expect(getComputedStyle(shell.querySelector(".usage-chart-bar")!).backgroundImage, retired).toBe(getComputedStyle(unknown.querySelector(".usage-chart-bar")!).backgroundImage);
  }
});
