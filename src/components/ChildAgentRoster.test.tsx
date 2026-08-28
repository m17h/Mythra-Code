import { render, screen, within } from "@testing-library/react";
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
  render(<ChildAgentRoster value={ROSTER} enabled readiness={READY} onChange={onChange} {...overrides} />);
  return onChange;
}

/** Every worker's controls live behind its own disclosure. */
async function configure(id: string) {
  await userEvent.click(screen.getByRole("button", { name: `Configure ${id}` }));
}

async function choose(menu: string, option: RegExp) {
  await userEvent.click(screen.getByRole("button", { name: menu }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: option }));
}

describe("ChildAgentRoster", () => {
  it("summarizes a worker without opening any of its controls", () => {
    view();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText(/Claude · claude-fable-5 · Inherit parent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure reviewer" })).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals a worker's controls only while it is being configured", async () => {
    view();
    const face = screen.getByRole("button", { name: "Configure reviewer" });
    const panel = document.getElementById(face.getAttribute("aria-controls") ?? "");
    expect(panel).toHaveAttribute("aria-hidden", "true");

    await configure("reviewer");

    expect(face).toHaveAttribute("aria-expanded", "true");
    expect(panel).not.toHaveAttribute("aria-hidden");
    expect(panel).toHaveClass("open");
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

  it("adds a worker with a slug a model can name", async () => {
    const onChange = view();
    await userEvent.type(screen.getByLabelText("New destination name"), "Grok Fast");
    await choose("New sub-agent provider", /OpenRouter/);
    await userEvent.click(screen.getByRole("button", { name: /Add sub-agent/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [
        ROSTER.targets[0],
        expect.objectContaining({ id: "grok-fast", provider: "openrouter", enabled: true }),
      ],
    }));
  });

  it("seeds an unnamed worker from the provider's suggested destination", async () => {
    const onChange = view();
    await choose("New sub-agent provider", /Cursor/);
    await userEvent.click(screen.getByRole("button", { name: /Add sub-agent/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [
        ROSTER.targets[0],
        expect.objectContaining({ id: "cursor", provider: "cursor", model: "auto", description: expect.stringContaining("Cursor") }),
      ],
    }));
  });

  it("removes a worker", async () => {
    const onChange = view();
    await configure("reviewer");
    await userEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ targets: [] }));
  });

  it("clears the model when the provider changes, so a stale identity cannot survive", async () => {
    const onChange = view();
    await configure("reviewer");
    await choose("Provider for reviewer", /Cursor/);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ provider: "cursor", model: "auto" })],
    }));
  });

  it("lets the user choose who controls reasoning", async () => {
    const onChange = view();
    await configure("reviewer");
    await choose("Reasoning control for reviewer", /Main agent decides/);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ reasoningMode: "agent" })],
    }));
  });

  it("lets the user cap agent-selected effort", async () => {
    const onChange = view({ value: { enabled: true, targets: [{ ...ROSTER.targets[0], reasoningMode: "agent" }] } });
    await configure("reviewer");
    await choose("Maximum reasoning for reviewer", /Extra high/);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ reasoningMaxEffort: "xhigh" })],
    }));
  });

  it("uses branded app menus instead of operating-system selects", async () => {
    view();
    await configure("reviewer");
    const card = screen.getByRole("button", { name: "Configure reviewer" }).closest("li") as HTMLElement;
    expect(within(card).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Provider for reviewer" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Model for reviewer" })).toHaveTextContent("Fable 5");
  });

  it("switches one worker off without touching the others", async () => {
    const onChange = view({
      value: { enabled: true, targets: [ROSTER.targets[0], { ...ROSTER.targets[0], id: "builder" }] },
    });
    const builder = screen.getByRole("button", { name: "Configure builder" }).closest("li") as HTMLElement;
    await userEvent.click(within(builder).getByRole("switch", { name: "Enable builder" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ id: "reviewer", enabled: true }), expect.objectContaining({ id: "builder", enabled: false })],
    }));
  });

  it("dims the roster while cross-provider delegation is off", () => {
    view({ enabled: false });
    expect(screen.getByText("Sub-agents").closest(".worker-roster")).toHaveClass("muted");
  });
});
