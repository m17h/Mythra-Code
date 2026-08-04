import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPowerControl } from "./ModelPowerControl";

describe("ModelPowerControl", () => {
  it("selects models, reasoning, Fast, and Ultra independently", () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    const onFast = vi.fn();
    const onUltra = vi.fn();
    render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" ultra={false} fast={false} runtimeModels={[]} onModel={onModel} onEffort={onEffort} onFast={onFast} onUltra={onUltra} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Luna/i }));
    expect(onModel).toHaveBeenCalledWith("gpt-5.6-luna");
    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });
    expect(onEffort).toHaveBeenCalledWith("xhigh");
    fireEvent.click(screen.getByRole("button", { name: /Fast/i }));
    expect(onFast).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: /Ultra/i }));
    expect(onUltra).toHaveBeenCalledWith(true);
  });

  it("closes the menu on Escape without letting the key reach app-level handlers", () => {
    // Stand-in for App's document-level Escape handler that stops the turn.
    const appEscape = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") appEscape();
    };
    document.addEventListener("keydown", listener);
    try {
      render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" ultra={false} fast={false} runtimeModels={[]} onModel={vi.fn()} onEffort={vi.fn()} onFast={vi.fn()} onUltra={vi.fn()} />);
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
