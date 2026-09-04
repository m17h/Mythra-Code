import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { ClaudeModelControl } from "./ClaudeModelControl";
import { ModelPowerControl } from "./ModelPowerControl";
import { OpenRouterModelControl } from "./OpenRouterModelControl";
import { ThreadProviderControl } from "./ThreadProviderControl";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import "../styles.css";
import "./SettingsModal.css";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

describe("model control browser layout", () => {
  it.each(["dark", "light"])("reserves header refresh spacing at small widths and UI scales in %s mode", (scheme) => {
    const view = render(<div className="app-shell" data-color-scheme={scheme} style={{ display: "block" }}>
      <ModelCatalogHeader provider="OpenAI" heading="Choose your model" description="A deliberately long provider catalog description that needs truncation" onRefresh={vi.fn()} />
    </div>);
    const header = view.container.querySelector<HTMLElement>(".model-catalog-heading")!;
    const label = header.querySelector<HTMLElement>("span")!;
    const description = header.querySelector<HTMLElement>("small")!;
    const refresh = header.querySelector<HTMLElement>("button")!;
    for (const width of [260, 330, 520, 660]) {
      for (const zoom of [0.8, 1, 1.5]) {
        header.style.width = `${width}px`;
        header.style.zoom = String(zoom);
        expect(getComputedStyle(header).display).toBe("grid");
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
        expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(description.getBoundingClientRect().left);
        expect(refresh.getBoundingClientRect().left - description.getBoundingClientRect().right).toBeGreaterThanOrEqual(9 * zoom);
        expect(refresh.getBoundingClientRect().right).toBeLessThanOrEqual(header.getBoundingClientRect().right);
        expect(getComputedStyle(description).textOverflow).toBe("ellipsis");
        expect(refresh.offsetWidth).toBe(28);
      }
    }
  });
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
  // The trigger is half its old width now that it shares the cell with the
  // provider picker, but the catalog it opens must stay as roomy as every
  // other provider's menu instead of shrinking to its anchor.
  it("opens the OpenAI catalog at full menu width without widening its trigger", () => {
    const providerPicker = <ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} onProvider={vi.fn()} onDefaultSettings={vi.fn()} />;
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-color-scheme="dark" style={{ display: "block", width: 900 }}>
        <ModelPowerControl providerControl={providerPicker} model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
        <OpenRouterModelControl providerControl={providerPicker} model="openai/gpt-5" effort="high" models={[{ id: "openai/gpt-5", name: "GPT-5" }]} loading={false} error="" onModel={vi.fn()} onEffort={vi.fn()} onRefresh={vi.fn()} />
      </div>,
    );

    const shell = view.container.firstElementChild as HTMLElement;
    const trigger = view.container.querySelector<HTMLElement>(".model-picker-trigger")!;
    const providerTrigger = view.container.querySelector<HTMLElement>(".composer-provider-control .provider-pill")!;
    const closedTriggerWidth = trigger.offsetWidth;

    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("button", { name: /OpenRouter model:/ }));
    const menu = view.container.querySelector<HTMLElement>(".model-menu")!;
    const routerMenu = view.container.querySelector<HTMLElement>(".openrouter-menu")!;

    // The menus animate in with a scale, so widths are read off the layout box
    // rather than the mid-transition visual rect.
    expect(menu.offsetWidth).toBe(routerMenu.offsetWidth);
    expect(menu.offsetWidth).toBeGreaterThan(closedTriggerWidth * 1.8);
    // Bounded by the chat container and the viewport.
    expect(menu.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 42);
    const menuLeft = menu.getBoundingClientRect().left;
    const shellRect = shell.getBoundingClientRect();
    expect(menuLeft).toBeGreaterThanOrEqual(shellRect.left - 1);
    expect(menuLeft + menu.offsetWidth).toBeLessThanOrEqual(shellRect.right + 1);

    // The half-width trigger is untouched — it still matches the provider pill.
    expect(trigger.offsetWidth).toBe(closedTriggerWidth);
    expect(Math.abs(closedTriggerWidth - providerTrigger.offsetWidth)).toBeLessThanOrEqual(35);

    // Header and options lay out inside that width instead of cramming.
    const heading = menu.querySelector<HTMLElement>(".model-menu-heading")!;
    const headingLabel = heading.querySelector<HTMLElement>("span")!;
    const headingMeta = heading.querySelector<HTMLElement>("small")!;
    expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth);
    expect(headingLabel.getBoundingClientRect().right).toBeLessThanOrEqual(headingMeta.getBoundingClientRect().left);
    const options = menu.querySelectorAll<HTMLElement>(".model-menu-option");
    expect(options.length).toBeGreaterThan(0);
    options.forEach((option) => {
      expect(option.scrollWidth).toBeLessThanOrEqual(option.clientWidth);
      expect(option.offsetLeft + option.offsetWidth).toBeLessThanOrEqual(menu.clientWidth + menu.clientLeft + 1);
    });
  });

  // The provider column is fractional, so the trigger's own left offset grows
  // with the chat column. Widths are swept across the whole 680–900px band
  // rather than sampled at its narrow end, where a fixed reserve happens to be
  // generous enough.
  it.each([900, 860, 815, 790, 760, 730, 700, 650])("keeps the widened OpenAI catalog inside a %spx chat column", (chatWidth) => {
    const view = render(
      <div className="app-shell" data-theme="kiwi" data-color-scheme="dark" style={{ display: "block", width: 1200 }}>
        <main className="main-panel" style={{ width: chatWidth, flex: "none" }}>
          {/* Production padding: the composer inset is what the menu overruns. */}
          <div className="composer-zone">
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
          </div>
        </main>
      </div>,
    );

    const trigger = view.getByRole("button", { name: /^OpenAI model:/ });
    fireEvent.click(trigger);
    const control = view.container.querySelector<HTMLElement>(".model-power-control")!;
    const panel = view.container.querySelector<HTMLElement>(".main-panel")!;
    const menu = view.container.querySelector<HTMLElement>(".model-menu")!;
    const controlRect = control.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    expect(menuRect.left).toBeGreaterThanOrEqual(panelRect.left - 1);
    expect(menuRect.right).toBeLessThanOrEqual(panelRect.right + 1);

    expect(menu.offsetWidth).toBeGreaterThan(trigger.getBoundingClientRect().width * 1.5);
    expect(menuRect.left).toBeGreaterThanOrEqual(controlRect.left - 1);
    expect(menuRect.right).toBeLessThanOrEqual(controlRect.right + 1);
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
    ["astra", "high", "rgb(131, 109, 255)"],
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
    astra: ["rgb(88, 230, 255)", "rgb(90, 160, 255)", "rgb(131, 109, 255)", "rgb(184, 93, 255)", "rgb(255, 110, 216)"],
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

  // Split "a, b, c" into layers without cutting inside a gradient's own commas.
  const splitLayers = (value: string): string[] => {
    const layers: string[] = [];
    let depth = 0;
    let current = "";
    for (const character of value) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) { layers.push(current.trim()); current = ""; continue; }
      current += character;
    }
    if (current.trim()) layers.push(current.trim());
    return layers;
  };

  const pixelsOf = (value: string): number => Number.parseFloat(value);

  /**
   * The rendered background-position of every layer at both ends of one
   * animation cycle. Reading the paused animation rather than the stylesheet
   * measures what actually paints, so a keyframe that stops short of a whole
   * tile shows up as a short travel here.
   */
  const cycleTravel = (target: Element, animationName: string, pseudo?: string) => {
    const animation = target
      .getAnimations({ subtree: true })
      .find((entry) => (entry as CSSAnimation).animationName === animationName
        && (entry.effect as KeyframeEffect | null)?.pseudoElement === (pseudo ?? null));
    expect(animation).toBeTruthy();
    animation!.pause();
    const duration = Number((animation!.effect as KeyframeEffect).getComputedTiming().duration);
    animation!.currentTime = 0;
    const start = splitLayers(getComputedStyle(target, pseudo).backgroundPosition);
    // A hair short of the wrap: at exactly `duration` an infinite animation has
    // already rolled over to the next iteration's first frame.
    animation!.currentTime = duration - 0.001;
    const end = splitLayers(getComputedStyle(target, pseudo).backgroundPosition);
    animation!.play();
    return { start, end, duration };
  };

  // A tile only loops invisibly when both halves hold: its first and last stop
  // are the same color, and the drift covers exactly one tile per cycle. Miss
  // either and the rail visibly snaps once per revolution.
  it("loops Astra's nebula on a seamless tile that travels exactly its own width", () => {
    const view = renderStyle("astra", "high");
    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail")!;
    const track = view.container.querySelector<HTMLElement>(".reasoning-control input[type='range']")!;
    const tile = pixelsOf(getComputedStyle(rail).getPropertyValue("--astra-tile"));
    const starTile = pixelsOf(getComputedStyle(rail).getPropertyValue("--astra-star-tile"));
    const sizes = splitLayers(getComputedStyle(track).backgroundSize);
    const nebula = splitLayers(getComputedStyle(track).backgroundImage).at(-1)!;

    // Layer order: unfilled cap, star tile, nebula tile.
    expect(pixelsOf(sizes[1])).toBeCloseTo(starTile, 1);
    expect(pixelsOf(sizes[2])).toBeCloseTo(tile, 1);

    const stops = nebula.match(/rgba?\([^)]*\)/g)!;
    expect(stops.length).toBeGreaterThan(2);
    expect(stops.at(-1)).toBe(stops[0]);

    const { start, end } = cycleTravel(track, "astra-nebula");
    expect(start[0]).toBe(end[0]); // the unfilled cap stays pinned to the right
    expect(pixelsOf(end[1]) - pixelsOf(start[1])).toBeCloseTo(starTile, 1);
    expect(pixelsOf(end[2]) - pixelsOf(start[2])).toBeCloseTo(tile, 1);
  });

  // The first pass drew both ribbons with `closest-side` ellipses anchored on an
  // edge, which resolves to a zero radius: two layers that painted nothing.
  it("weaves two visible Astra ribbons above and below the bar, drifting right", () => {
    const view = renderStyle("astra", "high");
    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail")!;
    const ticks = view.container.querySelector<HTMLElement>(".reasoning-ticks")!;
    const ribbons = getComputedStyle(ticks, "::after");
    const ribbonTile = pixelsOf(getComputedStyle(rail).getPropertyValue("--astra-ribbon-tile"));
    const layers = splitLayers(ribbons.backgroundImage);

    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer).toContain("radial-gradient");
      expect(layer).not.toContain("closest-side");
      // Explicit, non-zero ellipse radii, so each ribbon actually has a body.
      const [radiusX, radiusY] = layer.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+at/)!.slice(1).map(Number);
      expect(radiusX).toBeGreaterThan(0);
      expect(radiusY).toBeGreaterThan(0);
      // Translucent, but well clear of invisible.
      expect(Number(layer.match(/rgba\([^)]*?,\s*([\d.]+)\)/)![1])).toBeGreaterThan(0.4);
    }
    // One crests above the 6px bar, the other below it.
    expect(layers[0]).toMatch(/at 50% 2[0-9](\.\d+)?%/);
    expect(layers[1]).toMatch(/at 50% 7[0-9](\.\d+)?%/);
    expect(pixelsOf(ribbons.height)).toBeGreaterThan(rail.getBoundingClientRect().height);
    expect(pixelsOf(ribbons.top)).toBeLessThan(0);
    expect(pixelsOf(ribbons.bottom)).toBeLessThan(0);
    expect(Number(ribbons.opacity)).toBeGreaterThan(0.5);
    expect(ribbons.pointerEvents).toBe("none");

    // Opaque at the left, dissolved before the right edge.
    const maskStops = ribbons.maskImage.match(/rgba?\([^)]*\)\s+[\d.]+%/g)!;
    expect(maskStops[0]).toContain("rgb(0, 0, 0)");
    expect(maskStops.at(-1)).toContain("rgba(0, 0, 0, 0)");

    const { start, end } = cycleTravel(ticks, "astra-wave", "::after");
    expect(pixelsOf(end[0]) - pixelsOf(start[0])).toBeCloseTo(ribbonTile, 1);
    expect(pixelsOf(end[1]) - pixelsOf(start[1])).toBeCloseTo(ribbonTile, 1);
    // Half a tile apart, so the crests alternate instead of stacking.
    expect(pixelsOf(start[1]) - pixelsOf(start[0])).toBeCloseTo(ribbonTile / 2, 1);
  });

  const renderModel = (model: string) =>
    render(
      <div className="app-shell" data-theme="kiwi" data-effort-slider="astra">
        <ModelPowerControl model={model} effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
      </div>,
    );

  it("drifts stars only off the selected Astra trigger logo", () => {
    const view = renderModel("gpt-6-astra");
    const trigger = view.container.querySelector<HTMLElement>(".model-picker-trigger")!;
    const field = trigger.querySelector<HTMLElement>(".model-orb-stars")!;
    const stars = [...field.querySelectorAll<HTMLElement>("i")];

    expect(field.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(field).position).toBe("absolute");
    expect(getComputedStyle(field).pointerEvents).toBe("none");
    expect(stars.length).toBeGreaterThanOrEqual(4);

    const directions = new Set<string>();
    for (const star of stars) {
      const style = getComputedStyle(star);
      expect(style.animationName).toBe("astra-orb-star");
      // Slow: a star takes seconds, not a fraction of one, to cross the orb.
      expect(Number.parseFloat(style.animationDuration)).toBeGreaterThanOrEqual(5);
      expect(style.position).toBe("absolute");
      const x = pixelsOf(style.getPropertyValue("--star-x"));
      const y = pixelsOf(style.getPropertyValue("--star-y"));
      expect(Math.hypot(x, y)).toBeGreaterThan(8);
      directions.add(`${Math.sign(x)}:${Math.sign(y)}`);
    }
    // Emitted outward in genuinely different directions, not one shared vector.
    expect(directions.size).toBeGreaterThanOrEqual(4);

    // The menu's own rows never emit, open or closed.
    fireEvent.click(trigger);
    expect(view.container.querySelector(".model-menu .model-orb-stars")).toBeNull();
    expect(view.container.querySelectorAll(".menu-model-orb .model-orb-stars")).toHaveLength(0);
    expect(view.container.querySelectorAll(".model-orb-stars")).toHaveLength(1);
  });

  it("leaves the trigger's layout, hit target and other models untouched", () => {
    const astra = renderModel("gpt-6-astra");
    const astraTrigger = astra.container.querySelector<HTMLElement>(".model-picker-trigger")!;
    const astraOrb = astraTrigger.querySelector<HTMLElement>(".model-orb")!.getBoundingClientRect();
    const astraHeight = astraTrigger.getBoundingClientRect().height;
    // A star that has drifted clear of the orb still lets the click through.
    const star = astraTrigger.querySelector<HTMLElement>(".model-orb-stars i")!.getBoundingClientRect();
    expect(document.elementFromPoint(star.left + star.width / 2, star.top + star.height / 2))
      .not.toBe(astraTrigger.querySelector(".model-orb-stars i"));
    astra.unmount();

    const sol = renderModel("gpt-5.6-sol");
    const solTrigger = sol.container.querySelector<HTMLElement>(".model-picker-trigger")!;
    expect(sol.container.querySelector(".model-orb-stars")).toBeNull();
    expect(solTrigger.getBoundingClientRect().height).toBeCloseTo(astraHeight, 2);
    const solOrb = solTrigger.querySelector<HTMLElement>(".model-orb")!.getBoundingClientRect();
    expect(solOrb.width).toBeCloseTo(astraOrb.width, 2);
    expect(solOrb.height).toBeCloseTo(astraOrb.height, 2);
  });

  it("keeps Astra polished but still when reduced motion is requested", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = renderStyle("astra", "high");
    const rail = view.container.querySelector<HTMLElement>(".reasoning-rail")!;
    const track = view.container.querySelector<HTMLElement>(".reasoning-control input[type='range']")!;
    const stars = getComputedStyle(rail, "::before");
    const ribbons = getComputedStyle(view.container.querySelector<HTMLElement>(".reasoning-ticks")!, "::after");

    expect(getComputedStyle(track).animationName).toBe("none");
    expect(stars.animationName).toBe("none");
    expect(stars.pointerEvents).toBe("none");
    expect(Number(stars.opacity)).toBeGreaterThan(0);
    expect(ribbons.animationName).toBe("none");
    expect(ribbons.pointerEvents).toBe("none");
    // The ribbons keep their shape and color while standing still.
    expect(ribbons.backgroundImage.match(/radial-gradient/g)).toHaveLength(2);
    expect(Number(ribbons.opacity)).toBeGreaterThan(0.5);

    // The trigger's stars stop drifting, and stop at their invisible rest state
    // rather than freezing mid-flight around the logo.
    const model = renderModel("gpt-6-astra");
    for (const star of model.container.querySelectorAll<HTMLElement>(".model-orb-stars i")) {
      expect(getComputedStyle(star).animationName).toBe("none");
      expect(Number(getComputedStyle(star).opacity)).toBe(0);
    }
    model.unmount();

    const card = document.createElement("span");
    card.className = "slider-style-preview astra";
    card.innerHTML = '<i class="slider-style-rail"></i><i class="slider-style-thumb"></i>';
    document.body.append(card);
    expect(getComputedStyle(card, "::before").animationName).toBe("none");
    expect(getComputedStyle(card.querySelector<HTMLElement>(".slider-style-rail")!).animationName).toBe("none");
    card.remove();
  });

  // The wake and the cord are drawn on the rail's own ::before, each cut to a
  // shape of its own: neither style is a colored bar with a round thumb.
  it.each([
    ["astra", "astra-twinkle"],
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
