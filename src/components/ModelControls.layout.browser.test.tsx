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

  // Every level of the three newest styles, on both rails: Codex's own
  // .reasoning-* markup and the .openrouter-* one every other provider shares.
  const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
  const NEW_STYLE_PALETTES = {
    sonar: ["rgb(61, 111, 232)", "rgb(31, 159, 224)", "rgb(18, 201, 196)", "rgb(23, 221, 134)", "rgb(92, 255, 192)"],
    vital: ["rgb(255, 194, 206)", "rgb(255, 157, 180)", "rgb(255, 111, 146)", "rgb(255, 71, 112)", "rgb(255, 32, 80)"],
    dune: ["rgb(240, 220, 174)", "rgb(230, 189, 133)", "rgb(220, 156, 104)", "rgb(207, 122, 92)", "rgb(192, 90, 78)"],
  } as const;

  it.each(Object.entries(NEW_STYLE_PALETTES))("gives the %s slider its own color at every effort level", (sliderStyle, palette) => {
    EFFORT_LEVELS.forEach((effort, level) => {
      const view = render(
        <div className="app-shell" data-theme="kiwi" data-effort-slider={sliderStyle}>
          <ClaudeModelControl model="claude-opus-5" effort={effort} onModel={vi.fn()} onEffort={vi.fn()} />
          <ModelPowerControl model="gpt-5.6-sol" effort={effort} fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
        </div>,
      );

      const claudeGauge = view.container.querySelector<SVGElement>(".openrouter-reasoning-heading > svg:first-child");
      const codexGauge = view.container.querySelector<SVGElement>(".reasoning-heading > svg:first-child");
      const activeLabel = view.container.querySelector<HTMLElement>(".reasoning-labels span.active");
      expect(getComputedStyle(claudeGauge!).color).toBe(palette[level]);
      expect(getComputedStyle(codexGauge!).color).toBe(palette[level]);
      expect(getComputedStyle(activeLabel!).color).toBe(palette[level]);
      view.unmount();
    });
  });

  it.each([
    ["sonar", "sonar-ping"],
    ["vital", "vital-trace"],
  ] as const)("drives the %s rail decoration from its own animation", (sliderStyle, animationName) => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider={sliderStyle}>
        <ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
    expect(getComputedStyle(rail!, "::before").animationName).toBe(animationName);
  });

  it("drifts the dune rail's grain instead of decorating it", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider="dune">
        <ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

    const track = view.container.querySelector<HTMLElement>(".reasoning-control input[type='range']");
    expect(getComputedStyle(track!).animationName).toBe("dune-drift");
    // The drifting layer is the 22px grain tile, not the sand ramp itself.
    expect(getComputedStyle(track!).backgroundSize).toContain("22px");
  });

  // Sonar pings, Vital beats and Dune drifts faster the harder the model works,
  // which only holds if --effort-heat resolves on the rail rather than the shell.
  it.each([
    ["sonar", ".reasoning-rail", "::before"],
    ["vital", ".reasoning-rail", "::before"],
    ["dune", ".reasoning-control input[type='range']", ""],
  ] as const)("shortens the %s motion as effort rises", (sliderStyle, selector, pseudo) => {
    const durationAt = (effort: "low" | "max") => {
      const view = render(
        <div className="app-shell" data-theme="kiwi" data-effort-slider={sliderStyle}>
          <ModelPowerControl model="gpt-5.6-sol" effort={effort} fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
        </div>,
      );
      const target = view.container.querySelector<HTMLElement>(selector);
      const duration = parseFloat(getComputedStyle(target!, pseudo || undefined).animationDuration);
      view.unmount();
      return duration;
    };

    const calm = durationAt("low");
    const flatOut = durationAt("max");
    expect(calm).toBeGreaterThan(0);
    expect(flatOut).toBeLessThan(calm);
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
