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

it.each(["atari", "monochrome"] as const)("keeps %s surfaces, accent ink, and chart series accessible", (theme) => {
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
  if (theme === "atari") {
    expect(panel.backgroundColor).toBe("rgb(247, 239, 223)");
    for (const selector of [".subagent-panel", ".app-select-menu"]) expect(getComputedStyle(view.container.querySelector<HTMLElement>(selector)!).backgroundColor).toBe("rgb(255, 247, 233)");
    expect(getComputedStyle(view.container.querySelector<HTMLElement>(".message-body")!).backgroundColor).toBe("rgb(238, 225, 204)");
    for (const selector of [".app-select", ".sa-add-row"]) {
      for (const logo of view.container.querySelectorAll<SVGElement>(`${selector} :is(.claude-logo-option, .openai-logo-option)`)) {
        expect(contrast(getComputedStyle(logo).fill, panel.backgroundColor)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(getComputedStyle(view.container.querySelector<SVGElement>(".provider-mark.claude .claude-logo-option")!).fill).toBe("rgb(255, 255, 255)");
  } else {
    expect(panel.backgroundColor).toBe("rgb(41, 45, 50)");
    expect(getComputedStyle(view.getByTestId("accent")).color).toBe("rgb(236, 238, 235)");
    expect(getComputedStyle(view.container.querySelector<HTMLElement>(".openrouter-reasoning-heading")!).filter).toBe("grayscale(1)");
    for (const selector of [".openrouter-control", ".claude-logo"]) expect(getComputedStyle(view.container.querySelector<HTMLElement>(selector)!).filter).toBe("none");
  }
});
