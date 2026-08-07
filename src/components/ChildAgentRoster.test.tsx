import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChildAgentRoster } from "./ChildAgentRoster";
import type { ChildAgentReadiness } from "../lib/childAgents";
import type { ChildAgentSettings } from "../types";

const READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  claudeReady: true,
  cursorReady: true,
};

const ROSTER: ChildAgentSettings = {
  enabled: true,
  targets: [{ id: "reviewer", provider: "claude", model: "claude-fable-5", label: "Reviewer", description: "Careful review", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" }],
};

function view(overrides: Partial<Parameters<typeof ChildAgentRoster>[0]> = {}) {
  const onChange = vi.fn();
  render(<ChildAgentRoster value={ROSTER} subagentsEnabled readiness={READY} onChange={onChange} {...overrides} />);
  return onChange;
}

describe("ChildAgentRoster", () => {
  it("cannot be enabled until sub-agents themselves are on", () => {
    view({ subagentsEnabled: false, value: { enabled: false, targets: [] } });
    expect(screen.getByRole("switch", { name: "Allow cross-provider sub-agents" })).toBeDisabled();
    expect(screen.getByText(/Turn sub-agent spawning on first/)).toBeInTheDocument();
  });

  it("shows each destination's provider and resolved model", () => {
    view();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Claude · claude-fable-5")).toBeInTheDocument();
  });

  it("explains why an unusable destination will not be offered to the model", () => {
    view({ readiness: { ...READY, claudeReady: false } });
    expect(screen.getByText(/Install and sign in to Claude Code first/)).toBeInTheDocument();
  });

  it("stays quiet about a destination the user switched off", () => {
    view({
      readiness: { ...READY, claudeReady: false },
      value: { enabled: true, targets: [{ ...ROSTER.targets[0], enabled: false }] },
    });
    expect(screen.queryByText(/Install and sign in to Claude Code first/)).not.toBeInTheDocument();
  });

  it("adds a destination with a slug a model can name", async () => {
    const onChange = view();
    await userEvent.type(screen.getByLabelText("New destination name"), "Grok Fast");
    await userEvent.selectOptions(screen.getByLabelText("New destination provider"), "openrouter");
    await userEvent.type(screen.getByLabelText("New destination model"), "x-ai/grok-4.5");
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [
        ROSTER.targets[0],
        expect.objectContaining({ id: "grok-fast", provider: "openrouter", model: "x-ai/grok-4.5", enabled: true }),
      ],
    }));
  });

  it("offers a one-click destination for each provider that has none yet", async () => {
    const onChange = view();
    // Claude is already in the roster, so only the other three are suggested.
    expect(screen.queryByRole("button", { name: /Claude Code/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Cursor/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [ROSTER.targets[0], expect.objectContaining({ provider: "cursor", model: "auto", enabled: true })],
    }));
  });

  it("removes a destination", async () => {
    const onChange = view();
    await userEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ targets: [] }));
  });

  it("clears the model when the provider changes, so a stale identity cannot survive", async () => {
    const onChange = view();
    await userEvent.selectOptions(screen.getByLabelText("Provider for reviewer"), "cursor");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ provider: "cursor", model: "" })],
    }));
  });

  it("lets the user choose who controls reasoning", async () => {
    const onChange = view();
    await userEvent.selectOptions(screen.getByLabelText("Reasoning control for reviewer"), "agent");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ reasoningMode: "agent" })],
    }));
  });

  it("lets the user cap agent-selected effort", async () => {
    const onChange = view({ value: { enabled: true, targets: [{ ...ROSTER.targets[0], reasoningMode: "agent" }] } });
    await userEvent.selectOptions(screen.getByLabelText("Maximum reasoning for reviewer"), "xhigh");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ reasoningMaxEffort: "xhigh" })],
    }));
  });
});
