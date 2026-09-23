import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadProviderControl } from "./ThreadProviderControl";

describe("ThreadProviderControl", () => {
  it("changes only the provider selected for a new thread", () => {
    const onProvider = vi.fn();
    render(<ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} onProvider={onProvider} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));

    expect(onProvider).toHaveBeenCalledWith("claude");
  });

  it("offers provider handoff for an established thread", () => {
    render(<ThreadProviderControl provider="claude" defaultProvider="openai" threadStarted onProvider={vi.fn()} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Thread provider: Claude" }));

    expect(screen.getByText(/hand off this conversation/)).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Hand off to OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Default for new threads/ })).toBeInTheDocument();
    expect(screen.getByText("OpenAI · change in Settings")).toBeInTheDocument();
  });

  it("preserves selection and keeps recovery available for signed-out providers", () => {
    const onProvider = vi.fn();
    const onUnavailable = vi.fn();
    const props = { provider: "openai" as const, defaultProvider: "openai" as const, threadStarted: false, onProvider, onUnavailable, onDefaultSettings: vi.fn() };
    const view = render(<ThreadProviderControl {...props} unavailable={{ openai: "Sign in to ChatGPT", claude: "Sign in to Claude Code" }} />);
    const trigger = screen.getByRole("button", { name: "New thread provider: OpenAI" });
    expect(trigger).toHaveClass("unavailable");
    fireEvent.click(trigger);
    const claude = screen.getByRole("menuitemradio", { name: /Claude/ });
    expect(claude).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(claude);
    expect(onUnavailable).toHaveBeenCalledWith("Sign in to Claude Code");
    expect(onProvider).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    view.rerender(<ThreadProviderControl {...props} />);
    fireEvent.click(claude);
    expect(onProvider).toHaveBeenCalledWith("claude");
  });

  it("offers LM Studio as a local provider", () => {
    const onProvider = vi.fn();
    render(<ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} onProvider={onProvider} onDefaultSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /LM Studio/ }));

    expect(onProvider).toHaveBeenCalledWith("lmstudio");
  });
});
