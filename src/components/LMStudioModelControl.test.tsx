import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LMStudioModelControl } from "./LMStudioModelControl";

describe("LMStudioModelControl", () => {
  it("selects a model from LM Studio's live local catalog", () => {
    const onModel = vi.fn();
    render(<LMStudioModelControl
      model=""
      models={[
        { id: "lmstudio-community/qwen3-coder", displayName: "Qwen3 Coder", publisher: "lmstudio-community", trainedForToolUse: true, reasoningEfforts: ["low", "medium", "high"] },
        { id: "openai/gpt-oss-20b", displayName: "GPT-OSS 20B", publisher: "openai", trainedForToolUse: true, reasoningEfforts: ["low", "medium", "high"] },
      ]}
      effort="medium"
      loading={false}
      error=""
      onRefresh={vi.fn()}
      onModel={onModel}
      onEffort={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "LM Studio model: not selected" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search LM Studio models" }), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "lmstudio-community/qwen3-coder" }));

    expect(onModel).toHaveBeenCalledWith("lmstudio-community/qwen3-coder");
  });

  it("moves an unsupported reasoning level to the model's reported default", () => {
    const onEffort = vi.fn();
    render(<LMStudioModelControl
      model=""
      models={[{ id: "local/reasoner", displayName: "Reasoner", publisher: "local", trainedForToolUse: true, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }]}
      effort="xhigh"
      loading={false}
      error=""
      onRefresh={vi.fn()}
      onModel={vi.fn()}
      onEffort={onEffort}
    />);

    fireEvent.click(screen.getByRole("button", { name: "LM Studio model: not selected" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "local/reasoner" }));
    expect(onEffort).toHaveBeenCalledWith("medium");
  });

  it("surfaces an actionable disconnected state", () => {
    const onRefresh = vi.fn();
    render(<LMStudioModelControl model="" models={[]} effort="medium" loading={false} error="Start the LM Studio local server" onRefresh={onRefresh} onModel={vi.fn()} onEffort={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "LM Studio model: not selected" }));
    expect(screen.getByText("LM Studio is not connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh LM Studio model catalog" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
