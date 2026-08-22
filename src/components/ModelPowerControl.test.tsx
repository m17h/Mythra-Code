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
