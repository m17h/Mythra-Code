import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeModelControl } from "./ClaudeModelControl";
import { ModelPowerControl } from "./ModelPowerControl";
import "../styles.css";

describe("model control browser layout", () => {
  it("keeps the Codex rail the same height as the other provider rails", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" style={{ display: "block", width: 900 }}>
        <div><ClaudeModelControl model="claude-opus-5" effort="high" onModel={vi.fn()} onEffort={vi.fn()} /></div>
        <div><ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} /></div>
      </div>,
    );

    const claude = view.container.querySelector<HTMLElement>(".claude-control");
    const codex = view.container.querySelector<HTMLElement>(".model-power-control");
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();
    expect(Math.round(codex!.getBoundingClientRect().height)).toBe(Math.round(claude!.getBoundingClientRect().height));
  });

  it("matches each provider's reasoning gauge to the selected spectrum effort", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider="spectrum">
        <ClaudeModelControl model="claude-opus-5" effort="max" onModel={vi.fn()} onEffort={vi.fn()} />
        <ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

    const claudeGauge = view.container.querySelector<SVGElement>(".openrouter-reasoning-heading > svg:first-child");
    const codexGauge = view.container.querySelector<SVGElement>(".reasoning-heading > svg:first-child");
    expect(getComputedStyle(claudeGauge!).color).toBe("rgb(255, 70, 85)");
    expect(getComputedStyle(codexGauge!).color).toBe("rgb(255, 197, 49)");
  });

  it.each([
    ["pixel", "low", "rgb(51, 209, 122)"],
    ["aurora", "max", "rgb(255, 140, 209)"],
    ["ink", "high", "rgb(236, 238, 235)"],
  ] as const)("uses the %s slider palette for its reasoning gauge", (sliderStyle, effort, expectedColor) => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider={sliderStyle}>
        <ModelPowerControl model="gpt-5.6-sol" effort={effort} fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

    const gauge = view.container.querySelector<SVGElement>(".reasoning-heading > svg:first-child");
    expect(getComputedStyle(gauge!).color).toBe(expectedColor);
  });

  it("uses provider accents for classic sliders without recoloring the Fast icon", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider="classic">
        <ClaudeModelControl model="claude-opus-5" effort="high" onModel={vi.fn()} onEffort={vi.fn()} />
        <ModelPowerControl model="gpt-5.6-sol" effort="high" fast runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

    const claudeGauge = view.container.querySelector<SVGElement>(".openrouter-reasoning-heading > svg:first-child");
    const codexGauge = view.container.querySelector<SVGElement>(".reasoning-heading > svg:first-child");
    const fastIcon = view.container.querySelector<SVGElement>(".fast-tier svg");
    expect(getComputedStyle(claudeGauge!).color).toBe("rgb(221, 139, 106)");
    expect(getComputedStyle(codexGauge!).color).toBe("rgb(224, 160, 102)");
    expect(getComputedStyle(fastIcon!).color).not.toBe("rgb(224, 160, 102)");
  });
});
