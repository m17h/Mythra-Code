import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ClaudeModelControl } from "./ClaudeModelControl";
import { CursorModelControl } from "./CursorModelControl";
import { LMStudioModelControl } from "./LMStudioModelControl";
import { ModelPowerControl } from "./ModelPowerControl";
import { OpenRouterModelControl } from "./OpenRouterModelControl";
import { ThreadProviderControl } from "./ThreadProviderControl";

/**
 * The composer renders the provider picker inside each model control, so the
 * two popovers used to be mutually exclusive in one direction only. These
 * specs pin both opening orders for every provider rail.
 */
const providerControl = (
  <ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} onProvider={vi.fn()} onDefaultSettings={vi.fn()} />
);

const CONTROLS: Array<[string, () => ReactElement, RegExp]> = [
  ["OpenAI", () => (
    <ModelPowerControl providerControl={providerControl} model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />
  ), /^OpenAI model:/],
  ["Claude", () => (
    <ClaudeModelControl providerControl={providerControl} model="claude-opus-5" effort="high" onModel={vi.fn()} onEffort={vi.fn()} />
  ), /^Claude model:/],
  ["Cursor", () => (
    <CursorModelControl providerControl={providerControl} model="auto" models={[{ id: "auto", name: "Auto", configOptions: [] }]} effort="high" onRefresh={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} />
  ), /^Cursor model:/],
  ["OpenRouter", () => (
    <OpenRouterModelControl providerControl={providerControl} model="openai/gpt-5" effort="high" models={[{ id: "openai/gpt-5", name: "GPT-5" }]} loading={false} error="" onModel={vi.fn()} onEffort={vi.fn()} onRefresh={vi.fn()} />
  ), /^OpenRouter model:/],
  ["LM Studio", () => (
    <LMStudioModelControl providerControl={providerControl} model="local-model" models={[]} effort="high" loading={false} error="" onRefresh={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} />
  ), /^LM Studio model:/],
];

/** A real pointer press exercises both native dismissal paths. */
function press(element: HTMLElement) {
  fireEvent.pointerDown(element);
  fireEvent.click(element);
}

describe("composer provider and model popovers", () => {
  it.each(CONTROLS)("%s closes the model menu when the provider menu opens", (_name, renderControl, modelTriggerName) => {
    render(renderControl());
    const modelTrigger = screen.getByRole("button", { name: modelTriggerName });
    const providerTrigger = screen.getByRole("button", { name: "New thread provider: OpenAI" });

    // Click-only activation mirrors Enter/Space activation, where browsers do
    // not emit the pointerdown that originally hid the containment bug.
    fireEvent.click(modelTrigger);
    expect(modelTrigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(providerTrigger);
    expect(providerTrigger).toHaveAttribute("aria-expanded", "true");
    expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each(CONTROLS)("%s closes the provider menu when the model menu opens", (_name, renderControl, modelTriggerName) => {
    render(renderControl());
    const modelTrigger = screen.getByRole("button", { name: modelTriggerName });
    const providerTrigger = screen.getByRole("button", { name: "New thread provider: OpenAI" });

    fireEvent.click(providerTrigger);
    expect(providerTrigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(modelTrigger);
    expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
    expect(providerTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each(CONTROLS)("%s keeps the model menu open while its own options are used", (_name, renderControl, modelTriggerName) => {
    render(renderControl());
    const modelTrigger = screen.getByRole("button", { name: modelTriggerName });

    press(modelTrigger);
    // A press inside the model menu itself must not be mistaken for an
    // outside click now that containment is evaluated selectively.
    const menu = screen.getAllByRole("menu").find((node) => node.getAttribute("aria-label")?.includes("model selector"))!;
    fireEvent.pointerDown(menu);
    expect(modelTrigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerDown(document.body);
    expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the model menu on Escape and returns focus to its trigger", () => {
    render(CONTROLS[0][1]());
    const modelTrigger = screen.getByRole("button", { name: /^OpenAI model:/ });

    press(modelTrigger);
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
    expect(modelTrigger).toHaveFocus();
  });

  it("closes the model menu for a keyboard-style click on an outside control", () => {
    render(<div><button type="button">Outside action</button>{CONTROLS[0][1]()}</div>);
    const modelTrigger = screen.getByRole("button", { name: /^OpenAI model:/ });

    fireEvent.click(modelTrigger);
    fireEvent.click(screen.getByRole("button", { name: "Outside action" }));

    expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  });

  // ArrowDown/ArrowUp opens these catalogs directly from the trigger, so this
  // keyboard path emits neither pointerdown nor click. The Claude and LM Studio
  // triggers have no arrow-key shortcut, so they have nothing to assert.
  it.each(CONTROLS.filter(([name]) => name === "OpenAI" || name === "Cursor" || name === "OpenRouter"))(
    "%s closes the provider menu when arrow keys open the model menu",
    (_name, renderControl, modelTriggerName) => {
      render(renderControl());
      const modelTrigger = screen.getByRole("button", { name: modelTriggerName });
      const providerTrigger = screen.getByRole("button", { name: "New thread provider: OpenAI" });

      fireEvent.click(providerTrigger);
      expect(providerTrigger).toHaveAttribute("aria-expanded", "true");

      fireEvent.keyDown(modelTrigger, { key: "ArrowDown" });
      expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
      expect(providerTrigger).toHaveAttribute("aria-expanded", "false");
    },
  );

  // An in-menu action may replace its own node before the event reaches the
  // document dismissal listener. The original propagation path must continue
  // to count as an inside click.
  it("keeps the OpenRouter catalog open when Show all unmounts itself", () => {
    const models = Array.from({ length: 70 }, (_, index) => ({ id: `vendor/model-${index}`, name: `Model ${index}` }));
    render(
      <OpenRouterModelControl providerControl={providerControl} model="vendor/model-0" effort="high" models={models} loading={false} error="" onModel={vi.fn()} onEffort={vi.fn()} onRefresh={vi.fn()} />,
    );
    const modelTrigger = screen.getByRole("button", { name: /^OpenRouter model:/ });

    press(modelTrigger);
    press(screen.getByRole("button", { name: /Show all 70 models/ }));

    expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Model 69,/ })).toBeInTheDocument();
  });

  it("keeps the Cursor catalog open when clearing the search swaps the button back to refresh", () => {
    render(
      <CursorModelControl providerControl={providerControl} model="auto" models={[{ id: "auto", name: "Auto", configOptions: [] }]} effort="high" onRefresh={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} />,
    );
    const modelTrigger = screen.getByRole("button", { name: /^Cursor model:/ });

    press(modelTrigger);
    fireEvent.change(screen.getByLabelText("Search Cursor models"), { target: { value: "auto" } });
    press(screen.getByRole("button", { name: "Clear Cursor model search" }));

    expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Refresh Cursor model catalog" })).toBeInTheDocument();
  });

  it("leaves both popovers shut while the composer is disabled", () => {
    render(
      <ModelPowerControl
        providerControl={<ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} disabled onProvider={vi.fn()} onDefaultSettings={vi.fn()} />}
        model="gpt-5.6-sol"
        effort="high"
        fast={false}
        disabled
        runtimeModels={[]}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );

    const modelTrigger = screen.getByRole("button", { name: /^OpenAI model:/ });
    const providerTrigger = screen.getByRole("button", { name: "New thread provider: OpenAI" });
    expect(modelTrigger).toBeDisabled();
    expect(providerTrigger).toBeDisabled();

    press(modelTrigger);
    press(providerTrigger);
    expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
    expect(providerTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("labels every closed model trigger 'Model' while keeping its provider-specific accessible name", () => {
    CONTROLS.forEach(([, renderControl, modelTriggerName]) => {
      const view = render(renderControl());
      const modelTrigger = screen.getByRole("button", { name: modelTriggerName });

      expect(within(modelTrigger).getByText("Model")).toBeInTheDocument();
      expect(modelTrigger.querySelector("small")!.textContent).toBe("Model");
      expect(modelTrigger.getAttribute("aria-label")).toMatch(modelTriggerName);
      view.unmount();
    });
  });
});
