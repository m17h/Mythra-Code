import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CursorModelControl } from "./CursorModelControl";

const models = [
  { id: "cursor-grok-4.5", name: "Grok 4.5", configOptions: [] },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", configOptions: [] },
  { id: "gpt-5.4", name: "GPT-5.4", configOptions: [] },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", configOptions: [] },
];

describe("CursorModelControl", () => {
  it("searches a large provider catalog by company and selects a result", async () => {
    const user = userEvent.setup();
    const onModel = vi.fn();
    render(<CursorModelControl model="auto" models={models} effort="medium" onModel={onModel} onEffort={vi.fn()} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Cursor model: auto" }));
    expect(screen.getByText("Choose a Cursor model")).toBeInTheDocument();
    expect(screen.getByText("4 models")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Search Cursor models" }), "xAI");
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Grok 4.5, xAI" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Claude Opus 4.6, Anthropic" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemradio", { name: "Grok 4.5, xAI" }));
    expect(onModel).toHaveBeenCalledWith("cursor-grok-4.5");
  });
});
