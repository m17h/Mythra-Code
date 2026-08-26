import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterModelControl } from "./OpenRouterModelControl";
import type { OpenRouterModel } from "../lib/openRouterCatalog";

const catalog = (count: number): OpenRouterModel[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor/model-${index}`,
    name: `Vendor Model ${index}`,
    context_length: 128_000,
  }));

function open() {
  fireEvent.click(screen.getByRole("button", { name: /OpenRouter model:/i }));
}

function search(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search OpenRouter models" }), { target: { value } });
}

const base = {
  effort: "medium" as const,
  loading: false,
  error: "",
  onEffort: vi.fn(),
  onRefresh: vi.fn(),
};

describe("OpenRouterModelControl", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A truncated result list is indistinguishable from a model the catalog does
  // not have, so a search is never capped.
  it("shows every match for a search, past any browse limit", () => {
    render(<OpenRouterModelControl {...base} model="" models={catalog(250)} onModel={vi.fn()} />);
    open();
    search("vendor");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(250);
    expect(screen.getByText("250 matches")).toBeInTheDocument();
  });

  it("finds a model far past the browse limit", () => {
    render(<OpenRouterModelControl {...base} model="" models={catalog(300)} onModel={vi.fn()} />);
    open();
    // Not rendered while idly browsing…
    expect(screen.queryByRole("menuitemradio", { name: /Vendor Model 299/ })).not.toBeInTheDocument();
    search("model-299");
    // …but always reachable by search.
    expect(screen.getByRole("menuitemradio", { name: /Vendor Model 299/ })).toBeInTheDocument();
  });

  it("reveals the rest of a long catalog on request", () => {
    render(<OpenRouterModelControl {...base} model="" models={catalog(300)} onModel={vi.fn()} />);
    open();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(60);
    fireEvent.click(screen.getByRole("button", { name: /Show all 300 models \(240 more\)/ }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(300);
  });

  it("matches every token across name, id, and description", () => {
    const models: OpenRouterModel[] = [
      { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", description: "Efficient for routine tasks" },
      { id: "openai/gpt-5.6", name: "OpenAI: GPT-5.6" },
    ];
    render(<OpenRouterModelControl {...base} model="" models={models} onModel={vi.fn()} />);
    open();
    search("anthropic sonnet");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio", { name: /Claude Sonnet 5/ })).toBeInTheDocument();
  });

  it("only asks the app to resolve a complete slug after a pause in typing", () => {
    const onDiscover = vi.fn();
    render(<OpenRouterModelControl {...base} model="" models={catalog(3)} onModel={vi.fn()} onDiscover={onDiscover} />);
    open();
    search("kimi");
    act(() => { vi.advanceTimersByTime(400); });
    expect(onDiscover).not.toHaveBeenCalled();
    search("moonshotai/kimi-k2");
    act(() => { vi.advanceTimersByTime(400); });
    expect(onDiscover).toHaveBeenCalledWith("moonshotai/kimi-k2");
  });

  it("offers a typed slug directly when the catalog has no match", () => {
    const onModel = vi.fn();
    render(<OpenRouterModelControl {...base} model="" models={catalog(3)} onModel={onModel} />);
    open();
    search("moonshotai/kimi-k2");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Use model slug directly/ }));
    expect(onModel).toHaveBeenCalledWith("moonshotai/kimi-k2");
  });

  it("does not offer the slug row for a model the catalog already has", () => {
    render(<OpenRouterModelControl {...base} model="" models={[{ id: "vendor/model-0", name: "Vendor Model 0" }]} onModel={vi.fn()} />);
    open();
    search("vendor/model-0");
    expect(screen.queryByRole("menuitemradio", { name: /Use model slug directly/ })).not.toBeInTheDocument();
  });

  it("puts starred models first and toggles a star without selecting", () => {
    const onToggleFavorite = vi.fn();
    const onModel = vi.fn();
    render(<OpenRouterModelControl {...base} model="" models={catalog(4)} favorites={["vendor/model-3"]} onToggleFavorite={onToggleFavorite} onModel={onModel} />);
    open();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Vendor Model 3");
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Star Vendor Model 1" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("vendor/model-1");
    expect(onModel).not.toHaveBeenCalled();
  });
});
