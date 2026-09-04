import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPowerControl } from "./ModelPowerControl";

describe("ModelPowerControl", () => {
  it("selects models, reasoning, and Fast independently", () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    const onFast = vi.fn();
    render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" fast={false} runtimeModels={[]} onModel={onModel} onEffort={onEffort} onFast={onFast} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Luna/i }));
    expect(onModel).toHaveBeenCalledWith("gpt-5.6-luna");
    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });
    expect(onEffort).toHaveBeenCalledWith("xhigh");
    fireEvent.click(screen.getByRole("button", { name: /Fast/i }));
    expect(onFast).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("switch", { name: /Ultra/i })).not.toBeInTheDocument();
  });

  it("displays a legacy Ultra effort as editable Maximum reasoning", () => {
    const onEffort = vi.fn();
    render(<ModelPowerControl model="gpt-5.6-sol" effort="ultra" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={onEffort} onFast={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveValue("4");
    expect(slider).toBeEnabled();
    expect(screen.getByText("Maximum")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onEffort).toHaveBeenCalledWith("xhigh");
  });

  it("closes the menu on Escape without letting the key reach app-level handlers", () => {
    // Stand-in for App's document-level Escape handler that stops the turn.
    const appEscape = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") appEscape();
    };
    document.addEventListener("keydown", listener);
    try {
      render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />);
      const trigger = screen.getByRole("button", { name: /OpenAI model: Sol/i });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(appEscape).not.toHaveBeenCalled();

      // With the menu closed the key propagates normally again.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(appEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });
});

describe("ModelPowerControl runtime catalog", () => {
  const runtimeModel = (model: string, displayName: string, description = `${displayName} description`) => ({
    id: model,
    model,
    displayName,
    description,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    isDefault: false,
  });

  // Availability is whatever `model/list` says; Mythra Code's named
  // tiers only supply artwork when a runtime model happens to match one.
  it("lists every model the account reported, not just the named tiers", () => {
    render(
      <ModelPowerControl
        model="gpt-5.6-sol"
        effort="medium"
        fast={false}
        runtimeModels={[
          runtimeModel("gpt-5.6-sol", "Sol"),
          runtimeModel("gpt-5.6-terra", "Terra"),
          runtimeModel("gpt-6-research", "Research preview"),
        ]}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: /Research preview/ })).toBeEnabled();
    expect(screen.getByText("3 from your OpenAI account")).toBeInTheDocument();
  });

  it("uses the selected OpenAI provider mark for every model without named tier artwork", () => {
    const { container } = render(
      <div data-openai-logo="codex">
        <ModelPowerControl
          model="gpt-6-research"
          effort="medium"
          fast={false}
          runtimeModels={[
            runtimeModel("gpt-5.6-sol", "Sol"),
            runtimeModel("gpt-5.6-terra", "Terra"),
            runtimeModel("gpt-5.6-luna", "Luna"),
            runtimeModel("gpt-6-astra", "Astra"),
            runtimeModel("gpt-6-research", "Research preview"),
          ]}
          onModel={vi.fn()}
          onEffort={vi.fn()}
          onFast={vi.fn()}
        />
      </div>,
    );

    expect(container.querySelector(".model-picker-trigger .openai-logo-choice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Research preview/i }));
    expect(screen.getByRole("menuitemradio", { name: /Research preview/ }).querySelector(".openai-logo-choice")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Sol/ }).querySelector(".openai-logo-choice")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Terra/ }).querySelector(".openai-logo-choice")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Luna/ }).querySelector(".openai-logo-choice")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Astra/ }).querySelector(".openai-logo-choice")).not.toBeInTheDocument();
  });

  it("uses generated artwork for Sol, Terra, Luna, and Astra only", () => {
    const { container } = render(
      <ModelPowerControl
        model="gpt-5.6-sol"
        effort="medium"
        fast={false}
        runtimeModels={[
          runtimeModel("gpt-5.6-sol", "Sol"),
          runtimeModel("gpt-5.6-terra", "Terra"),
          runtimeModel("gpt-5.6-luna", "Luna"),
          runtimeModel("gpt-6-astra", "Astra"),
          runtimeModel("gpt-6-research", "Research preview"),
        ]}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );

    expect(container.querySelector<HTMLImageElement>(".model-picker-trigger .named-model-art img")?.src).toContain("/model-icons/sol.png");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    expect(screen.getByRole("menuitemradio", { name: /Terra/ }).querySelector<HTMLImageElement>("img")?.src).toContain("/model-icons/terra.png");
    expect(screen.getByRole("menuitemradio", { name: /Luna/ }).querySelector<HTMLImageElement>("img")?.src).toContain("/model-icons/luna.png");
    expect(screen.getByRole("menuitemradio", { name: /Astra/ }).querySelector<HTMLImageElement>("img")?.src).toContain("/model-icons/astra.png");
    expect(screen.getByRole("menuitemradio", { name: /Research preview/ }).querySelector("img")).not.toBeInTheDocument();
  });

  it("selects a runtime model that has no built-in tier", () => {
    const onModel = vi.fn();
    render(
      <ModelPowerControl
        model="gpt-5.6-sol"
        effort="medium"
        fast={false}
        runtimeModels={[runtimeModel("gpt-5.6-sol", "Sol"), runtimeModel("gpt-6-research", "Research preview")]}
        onModel={onModel}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Research preview/ }));
    expect(onModel).toHaveBeenCalledWith("gpt-6-research");
  });

  it("falls back to the built-in tiers when the runtime reports nothing", () => {
    render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    expect(screen.getByRole("menuitemradio", { name: /Luna/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Astra/ })).toBeInTheDocument();
  });

  it("keeps a saved model the runtime no longer lists", () => {
    render(
      <ModelPowerControl
        model="gpt-5.5-retired"
        effort="medium"
        fast={false}
        runtimeModels={[runtimeModel("gpt-5.6-sol", "Sol")]}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /OpenAI model: gpt-5\.5-retired/i })).toBeInTheDocument();
  });

  it("floats starred models and stars one without selecting it", () => {
    const onToggleFavorite = vi.fn();
    const onModel = vi.fn();
    render(
      <ModelPowerControl
        model="gpt-5.6-sol"
        effort="medium"
        fast={false}
        runtimeModels={[runtimeModel("gpt-5.6-sol", "Sol"), runtimeModel("gpt-5.6-luna", "Luna")]}
        favorites={["gpt-5.6-luna"]}
        onToggleFavorite={onToggleFavorite}
        onModel={onModel}
        onEffort={vi.fn()}
        onFast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Luna");
    fireEvent.click(screen.getByRole("button", { name: "Star Sol" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("gpt-5.6-sol");
    expect(onModel).not.toHaveBeenCalled();
  });
});
