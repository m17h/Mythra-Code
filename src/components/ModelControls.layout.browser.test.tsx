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
});
