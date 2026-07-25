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

  it("explains that switching an established thread starts a new one", () => {
    render(<ThreadProviderControl provider="claude" model="claude-fable-5" defaultProvider="openai" threadStarted onProvider={vi.fn()} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Thread provider: Claude" }));

    expect(screen.getByText(/Changing provider starts a new thread/)).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Start a new OpenAI thread/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Default for new threads/ })).toBeInTheDocument();
    expect(screen.getByText("OpenAI · change in Settings")).toBeInTheDocument();
  });
});
