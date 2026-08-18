import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LmStudioModelControl } from "./LmStudioModelControl";

describe("LmStudioModelControl", () => {
  it("selects a model discovered from the local server", () => {
    const onModel = vi.fn();
    render(
      <LmStudioModelControl
        model=""
        effort="medium"
        models={[{ id: "qwen/local-coder", owned_by: "lmstudio" }]}
        loading={false}
        error=""
        onModel={onModel}
        onEffort={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^LM Studio model:/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /qwen\/local-coder/ }));
    expect(onModel).toHaveBeenCalledWith("qwen/local-coder");
  });

  it("keeps manual model identifiers available when the server catalog is incomplete", () => {
    const onModel = vi.fn();
    render(
      <LmStudioModelControl
        model=""
        effort="low"
        models={[]}
        loading={false}
        error=""
        onModel={onModel}
        onEffort={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^LM Studio model:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search LM Studio models" }), { target: { value: "loaded-model" } });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Use model identifier/ }));
    expect(onModel).toHaveBeenCalledWith("loaded-model");
  });

  it("moves an unsupported reasoning level to the model's reported default", () => {
    const onEffort = vi.fn();
    render(
      <LmStudioModelControl
        model=""
        effort="xhigh"
        models={[{
          id: "local/reasoner",
          name: "Reasoner",
          reasoning: { allowed_options: ["low", "medium", "high"], default: "medium" },
        }]}
        loading={false}
        error=""
        onModel={vi.fn()}
        onEffort={onEffort}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^LM Studio model:/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /local\/reasoner/ }));
    expect(onEffort).toHaveBeenCalledWith("medium");
  });

  it("shows an actionable disconnected state and keeps refresh available", () => {
    const onRefresh = vi.fn();
    render(
      <LmStudioModelControl
        model=""
        effort="medium"
        models={[]}
        loading={false}
        error="Start the LM Studio local server"
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^LM Studio model:/ }));
    expect(screen.getByText("LM Studio is unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh LM Studio models" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
