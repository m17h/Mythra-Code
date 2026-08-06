import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadProviderControl } from "./ThreadProviderControl";

describe("ThreadProviderControl", () => {
  it("changes only the provider selected for a new thread", () => {
    const onProvider = vi.fn();
    render(<ThreadProviderControl provider="openai" model="gpt-5.6-sol" defaultProvider="openai" threadStarted={false} onProvider={onProvider} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));

    expect(onProvider).toHaveBeenCalledWith("claude");
  });

  it("offers provider handoff for an established thread", () => {
    render(<ThreadProviderControl provider="claude" model="claude-fable-5" defaultProvider="openai" threadStarted onProvider={vi.fn()} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Thread provider: Claude" }));

    expect(screen.getByText(/hand off this conversation/)).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Hand off to OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Default for new threads/ })).toBeInTheDocument();
    expect(screen.getByText("OpenAI · change in Settings")).toBeInTheDocument();
  });
});
