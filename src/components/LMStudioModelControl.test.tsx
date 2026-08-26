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

  it("accepts a model identifier that is not present in the catalog", () => {
    const onModel = vi.fn();
    render(<LMStudioModelControl model="" models={[]} effort="medium" loading={false} error="" onRefresh={vi.fn()} onModel={onModel} onEffort={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "LM Studio model: not selected" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search LM Studio models" }), { target: { value: "my-org/custom-model" } });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Use model identifier/ }));
    expect(onModel).toHaveBeenCalledWith("my-org/custom-model");
  });
});

describe("LMStudioModelControl favorites", () => {
  const localModels = [
    { id: "lmstudio-community/qwen3-coder", displayName: "Qwen3 Coder", publisher: "lmstudio-community", trainedForToolUse: true, reasoningEfforts: [] },
    { id: "openai/gpt-oss-20b", displayName: "GPT-OSS 20B", publisher: "openai", trainedForToolUse: true, reasoningEfforts: [] },
  ];

  it("floats a starred local model to the top", () => {
    render(<LMStudioModelControl model="" models={localModels} effort="medium" loading={false} error="" favorites={["openai/gpt-oss-20b"]} onToggleFavorite={vi.fn()} onRefresh={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /LM Studio model:/ }));
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("GPT-OSS 20B");
    expect(screen.getByText("Favorites first · local server catalog")).toBeInTheDocument();
  });

  it("stars a local model without selecting it", () => {
    const onToggleFavorite = vi.fn();
    const onModel = vi.fn();
    render(<LMStudioModelControl model="" models={localModels} effort="medium" loading={false} error="" favorites={[]} onToggleFavorite={onToggleFavorite} onRefresh={vi.fn()} onModel={onModel} onEffort={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /LM Studio model:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Star Qwen3 Coder" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("lmstudio-community/qwen3-coder");
    expect(onModel).not.toHaveBeenCalled();
  });
});
