import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeModelControl } from "./ClaudeModelControl";
import type { ClaudeModel } from "../lib/claude";

const model = (id: string, displayName: string, overrides: Partial<ClaudeModel> = {}): ClaudeModel => ({
  id,
  displayName,
  description: `${displayName} description`,
  resolvedModel: `claude-${id}`,
  disabled: false,
  supportedEfforts: [],
  ...overrides,
});

const LIVE: ClaudeModel[] = [
  model("default", "Default (recommended)"),
  model("sonnet", "Sonnet"),
  model("haiku", "Haiku"),
];

function open(name = /Claude model:/i) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("ClaudeModelControl", () => {
  it.each([
    ["claude-haiku-4-5", "Haiku"],
    ["claude-haiku-4-5-20251001", "Haiku"],
    ["claude-opus-5[1m]", "Opus"],
    ["claude-opus-5", "Opus"],
    ["claude-fable-5-1", "Fable"],
    ["claude-sonnet-5", "Sonnet"],
    ["claude-3-5-sonnet-20241022", "Sonnet"],
    ["claude-3-opus-20240229", "Opus"],
    ["Claude 3.5 Sonnet", "Sonnet"],
  ])("keeps %s friendly before and after the live catalog loads", (saved, label) => {
    const onModel = vi.fn();
    const view = render(<ClaudeModelControl model={saved} effort="high" loading onModel={onModel} onEffort={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: `Claude model: ${label}` });
    expect(trigger.textContent).toBe(`Model${label}`);
    view.rerender(<ClaudeModelControl model={saved} effort="high" models={[model(label.toLowerCase(), `${label} (1M context)`, { resolvedModel: `${saved}-20260101` })]} onModel={onModel} onEffort={vi.fn()} />);
    expect(screen.getByRole("button", { name: `Claude model: ${label}` }).textContent).toBe(`Model${label}`);
    expect(onModel).not.toHaveBeenCalled();
  });

  it("shortens selected aliases and resolved defaults only in the trigger", () => {
    const catalog = [model("opus", "Opus (1M context)", { resolvedModel: "claude-opus-5[1m]" }), model("default", "Default (recommended)", { resolvedModel: "claude-opus-5[1m]" })];
    const view = render(<ClaudeModelControl model="opus" effort="high" models={catalog} onModel={vi.fn()} onEffort={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Claude model: Opus" }).textContent).toBe("ModelOpus");
    open();
    expect(screen.getByRole("menuitemradio", { name: "Opus (1M context)" })).toHaveAttribute("aria-checked", "true");
    view.rerender(<ClaudeModelControl model="default" effort="high" models={catalog} onModel={vi.fn()} onEffort={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Claude model: Opus" }).textContent).toBe("ModelOpus");
  });
  it("lists every model the CLI reported", () => {
    render(<ClaudeModelControl model="sonnet" effort="medium" models={LIVE} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    expect(screen.getByRole("menuitemradio", { name: /Default \(recommended\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Haiku/ })).toBeInTheDocument();
    expect(screen.getByText("Live catalog from your Claude Code CLI")).toBeInTheDocument();
  });

  it("selects a live model by its --model value", () => {
    const onModel = vi.fn();
    render(<ClaudeModelControl model="sonnet" effort="medium" models={LIVE} onModel={onModel} onEffort={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));
    expect(onModel).toHaveBeenCalledWith("haiku");
  });

  // The CLI has no models subcommand, so an old CLI or a signed-out install
  // gets Mythra Code's built-ins — labelled, never passed off as the account's
  // real entitlements.
  it("labels the built-in list when the CLI catalog is unavailable", () => {
    render(<ClaudeModelControl model="claude-fable-5" effort="medium" models={[]} error="Claude Code closed before returning its models" onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    expect(screen.getByText("Built-in list — CLI catalog unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Showing Mythra Code’s built-in list/)).toBeInTheDocument();
    expect(screen.getByText(/Claude Code closed before returning its models/)).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Fable 5/ })).toBeInTheDocument();
  });

  it("puts starred models first and reports the star state", () => {
    render(<ClaudeModelControl model="default" effort="medium" models={LIVE} favorites={["haiku"]} onToggleFavorite={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    const options = screen.getAllByRole("menuitemradio").map((option) => option.textContent);
    expect(options[0]).toContain("Haiku");
    expect(screen.getByRole("button", { name: "Unstar Haiku" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Star Sonnet" })).toHaveAttribute("aria-pressed", "false");
  });

  it("stars a model without selecting it or closing the menu", () => {
    const onToggleFavorite = vi.fn();
    const onModel = vi.fn();
    render(<ClaudeModelControl model="default" effort="medium" models={LIVE} favorites={[]} onToggleFavorite={onToggleFavorite} onModel={onModel} onEffort={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Star Sonnet" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("sonnet");
    expect(onModel).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitemradio", { name: /^Sonnet/ })).toBeInTheDocument();
  });

  it("keeps a saved model that the live catalog no longer offers", () => {
    render(<ClaudeModelControl model="claude-retired-9" effort="medium" models={LIVE} onModel={vi.fn()} onEffort={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Claude model: claude-retired-9/ })).toBeInTheDocument();
  });

  it("keeps friendly live metadata when supersession hides the saved model row", () => {
    const catalog = [
      ...LIVE,
      model("claude-fable-5[1m]", "Fable", { description: "Fable 5 · Most capable" }),
      model("cc-update-required-1", "Fable 5.1", {
        description: "Update to 2.1.255+ to use Fable 5.1",
        disabled: true,
        unavailableReason: "update-required",
        requiredVersion: "2.1.255",
      }),
    ];
    render(<ClaudeModelControl model="claude-fable-5[1m]" effort="medium" models={catalog} onModel={vi.fn()} onEffort={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Claude model: Fable" })).toBeInTheDocument();
    expect(screen.queryByText("Saved model")).not.toBeInTheDocument();
  });

  it("disables a model the plan cannot run", () => {
    render(<ClaudeModelControl model="sonnet" effort="medium" models={[...LIVE, model("opus", "Opus", { disabled: true })]} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    expect(screen.getByRole("menuitemradio", { name: /Opus \(unavailable on your plan\)/ })).toBeDisabled();
  });

  it("replaces a superseded Fable row with clickable update guidance without selecting the sentinel", () => {
    const onModel = vi.fn();
    const onUnavailableModel = vi.fn();
    const catalog = [
      ...LIVE,
      model("claude-fable-5[1m]", "Fable", { description: "Fable 5 · Most capable" }),
      model("cc-update-required-1", "Fable 5.1", {
        description: "Update to 2.1.255+ to use Fable 5.1",
        resolvedModel: "cc-update-required-1",
        disabled: true,
        unavailableReason: "update-required",
        requiredVersion: "2.1.255",
      }),
    ];
    render(<ClaudeModelControl model="sonnet" effort="medium" models={catalog} onUnavailableModel={onUnavailableModel} onModel={onModel} onEffort={vi.fn()} />);
    open();

    expect(screen.queryByRole("menuitemradio", { name: /^Fable$/ })).not.toBeInTheDocument();
    const successor = screen.getByRole("menuitem", { name: /Fable 5\.1 \(Claude Code update required\)/ });
    expect(successor).not.toHaveAttribute("aria-disabled");
    expect(successor).not.toHaveAttribute("aria-checked");
    expect(successor).not.toBeDisabled();
    fireEvent.click(successor);
    expect(onUnavailableModel).toHaveBeenCalledWith(expect.objectContaining({ id: "cc-update-required-1" }));
    expect(onModel).not.toHaveBeenCalled();
  });

  it("announces a persisted update-required sentinel as the current item", () => {
    const sentinel = model("cc-update-required-1", "Fable 5.1", {
      description: "Update Claude Code to use Fable 5.1",
      disabled: true,
      unavailableReason: "update-required",
    });
    render(<ClaudeModelControl model={sentinel.id} effort="medium" models={[...LIVE, sentinel]} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();

    expect(screen.getByRole("menuitem", { name: /Fable 5\.1 \(Claude Code update required\)/ }))
      .toHaveAttribute("aria-current", "true");
  });

  it("explains that a signed-out catalog is generic", () => {
    const onSignInRequired = vi.fn();
    render(<ClaudeModelControl model="sonnet" effort="medium" models={LIVE} signedIn={false} onSignInRequired={onSignInRequired} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    expect(screen.getByText("Generic CLI catalog — sign in for account models")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to Claude Code on this computer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account settings" }));
    expect(onSignInRequired).toHaveBeenCalledOnce();
  });

  it("refreshes the catalog on request", () => {
    const onRefresh = vi.fn();
    render(<ClaudeModelControl model="sonnet" effort="medium" models={LIVE} onRefresh={onRefresh} onModel={vi.fn()} onEffort={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude model catalog" }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
