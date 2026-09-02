import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeModelControl } from "./ClaudeModelControl";
import { ModelPowerControl } from "./ModelPowerControl";
import { ThreadProviderControl } from "./ThreadProviderControl";
import "../styles.css";

describe("model control browser layout", () => {
  it("splits the former model area between provider and model while preserving reasoning space", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" style={{ display: "block", width: 900 }}>
        <ModelPowerControl
          providerControl={<ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} onProvider={vi.fn()} onDefaultSettings={vi.fn()} />}
          model="gpt-5.6-sol"
          effort="high"
          fast={false}
          runtimeModels={[]}
          onModel={vi.fn()}
          onEffort={vi.fn()}
          onFast={vi.fn()}
        />
      </div>,
    );

    const provider = view.container.querySelector<HTMLElement>(".composer-provider-control")!;
    const model = view.container.querySelector<HTMLElement>(".model-picker")!;
    const reasoning = view.container.querySelector<HTMLElement>(".reasoning-control")!;
    const providerRect = provider.getBoundingClientRect();
    const modelRect = model.getBoundingClientRect();
    const reasoningRect = reasoning.getBoundingClientRect();

    expect(providerRect.right).toBeLessThanOrEqual(modelRect.left + 1);
    expect(modelRect.right).toBeLessThanOrEqual(reasoningRect.left + 1);
    expect(Math.abs(providerRect.width - modelRect.width)).toBeLessThanOrEqual(35);
    expect(Math.round(providerRect.height)).toBe(Math.round(modelRect.height));
  });
  it("truncates the Claude catalog label before the refresh button", () => {
    const view = render(
      <div className="app-shell" data-theme="kiwi">
        <ClaudeModelControl
          model="claude-opus-5"
          effort="high"
          models={[
            { id: "claude-opus-5", displayName: "Opus 5", description: "Deep reasoning", resolvedModel: "claude-opus-5", disabled: false, supportedEfforts: [] },
          ]}
          onRefresh={vi.fn()}
          onModel={vi.fn()}
          onEffort={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(view.getByRole("button", { name: /Claude model:/ }));
    const menu = view.container.querySelector<HTMLElement>(".claude-model-menu")!;
    menu.style.width = "330px";
    const header = menu.querySelector<HTMLElement>(".openrouter-menu-meta")!;
    const label = menu.querySelector<HTMLElement>(".openrouter-menu-meta small")!;
    const refresh = view.getByRole("button", { name: "Refresh Claude model catalog" });
    const labelRect = label.getBoundingClientRect();
    const refreshRect = refresh.getBoundingClientRect();

    expect(getComputedStyle(header).display).toBe("grid");
    expect(refreshRect.left - labelRect.right).toBeGreaterThanOrEqual(9);
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
  });

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
    tide: ["rgb(79, 124, 255)", "rgb(62, 153, 245)", "rgb(45, 182, 235)", "rgb(46, 210, 220)", "rgb(85, 234, 210)"],
    dart: ["rgb(14, 155, 115)", "rgb(28, 180, 107)", "rgb(67, 203, 92)", "rgb(126, 224, 74)", "rgb(194, 242, 60)"],
    coil: ["rgb(106, 79, 224)", "rgb(138, 76, 230)", "rgb(171, 72, 224)", "rgb(209, 68, 207)", "rgb(244, 63, 174)"],
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

  const renderStyle = (sliderStyle: string, effort: "low" | "high" | "max") =>
    render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider={sliderStyle}>
        <ModelPowerControl model="gpt-5.6-sol" effort={effort} fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

  // The wake and the cord are drawn on the rail's own ::before, each cut to a
  // shape of its own: neither style is a colored bar with a round thumb.
  it.each([
    ["dart", "dart-slipstream"],
    ["coil", "coil-twist"],
  ] as const)("drives the %s rail decoration from its own animation", (sliderStyle, animationName) => {
    const view = renderStyle(sliderStyle, "high");

    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
    expect(getComputedStyle(rail!, "::before").animationName).toBe(animationName);
  });

  it("cuts the dart wake into a wedge that widens toward the arrowhead", () => {
    const view = renderStyle("dart", "high");

    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
    const track = view.container.querySelector<HTMLElement>(".reasoning-control input[type='range']");
    expect(getComputedStyle(rail!, "::before").clipPath).toContain("polygon");
    // The track keeps nothing but a hairline flight line under the wake.
    expect(getComputedStyle(track!).backgroundSize).toContain("1px");
  });

  it("renders tide as a smooth animated water channel with bubble markers", () => {
    const view = renderStyle("tide", "high");

    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
    const track = view.container.querySelector<HTMLElement>(".reasoning-control input[type='range']");
    const tick = view.container.querySelector<HTMLElement>(".reasoning-ticks i");
    expect(getComputedStyle(rail!, "::before").animationName).toBe("tide-flow");
    expect(getComputedStyle(track!).borderRadius).not.toBe("0px");
    expect(getComputedStyle(tick!).borderRadius).toBe("50%");
  });

  // Coil reads effort as tension: the winding tightens level by level, which
  // only holds if --effort-heat resolves on the rail rather than the shell.
  it("winds the coil tighter as effort rises", () => {
    const gaugeAt = (effort: "low" | "max") => {
      const view = renderStyle("coil", effort);
      const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
      const gauge = parseFloat(getComputedStyle(rail!, "::before").maskSize);
      view.unmount();
      return gauge;
    };

    const slack = gaugeAt("low");
    const taut = gaugeAt("max");
    expect(slack).toBeGreaterThan(0);
    expect(taut).toBeLessThan(slack);
  });

  it("ends the coil cord at the selected effort instead of drawing a gray remainder", () => {
    const view = renderStyle("coil", "high");
    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
    const cord = getComputedStyle(rail!, "::before");
    expect(parseFloat(cord.width)).toBeLessThan(rail!.getBoundingClientRect().width);
    expect(cord.backgroundRepeat).toBe("no-repeat");
  });

  // Water flows, the slipstream runs and the cord turns faster the harder
  // the model works — again, straight off the rail's live --effort-heat.
  it.each([
    ["dart", "--dart-rush"],
    ["coil", "--coil-spin"],
    ["tide", "--tide-flow"],
  ] as const)("shortens the %s motion as effort rises", (sliderStyle, timingVariable) => {
    const secondsAt = (effort: "low" | "max") => {
      const view = renderStyle(sliderStyle, effort);
      const rail = view.container.querySelector<HTMLElement>(".reasoning-rail");
      // Timing lives in a custom property so it can reach the thumb pseudo-
      // element too; resolve it through an animation on a probe element.
      const probe = document.createElement("div");
      probe.style.animationName = "effort-pop";
      probe.style.animationDuration = getComputedStyle(rail!).getPropertyValue(timingVariable);
      rail!.appendChild(probe);
      const seconds = parseFloat(getComputedStyle(probe).animationDuration);
      view.unmount();
      return seconds;
    };

    const calm = secondsAt("low");
    const flatOut = secondsAt("max");
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
