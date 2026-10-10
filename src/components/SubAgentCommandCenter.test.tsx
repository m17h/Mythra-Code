import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentCommandCenter, type SubAgentCommandCenterProps } from "./SubAgentCommandCenter";
import type { ChildAgentPolicy, ChildAgentReadiness } from "../lib/childAgents";
import type { SubAgentWorker } from "../lib/subAgentActivity";
import type { ChildAgentTarget, NativeSubagentOptions, ProjectSubagentSettings } from "../types";
import { recordOfficialPricingResult } from "../lib/officialPricing";
import { resetStorageMemoryForTests } from "../lib/storage";
import { resetUsageLedgerCache } from "../lib/usageLedger";

beforeEach(() => {
  localStorage.clear();
  resetStorageMemoryForTests();
  resetUsageLedgerCache();
  const now = Date.now();
  const asOf = new Date(now).toISOString().slice(0, 10);
  recordOfficialPricingResult("anthropic", { ok: true, models: {
    "claude-haiku-5-5": { input: .1, output: .5, asOf, longContext: { input: .5, output: 2.5, asOf }, longContextThresholdTokens: 100_000 },
    "claude-opus-5-5": { input: 4, output: 20, asOf },
  } }, now);
  recordOfficialPricingResult("openai", { ok: true, models: {
    "gpt-6.1-sol": { input: 2, output: 10, asOf, longContext: { input: 4, output: 15, asOf }, longContextThresholdTokens: 272_000 },
  } }, now);
});

const READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  claudeReady: true,
  cursorReady: true,
};

const REVIEWER: ChildAgentTarget = {
  id: "reviewer",
  provider: "claude",
  model: "claude-fable-5",
  label: "Reviewer",
  description: "Careful review",
  enabled: true,
  reasoningMode: "inherit",
  reasoningEffort: "medium",
  reasoningMaxEffort: "high",
};

const BUILDER: ChildAgentTarget = {
  ...REVIEWER,
  id: "builder",
  provider: "openai",
  model: "gpt-5.6-terra",
  label: "Terra builder",
};

const POLICY: ProjectSubagentSettings = {
  enabled: true,
  maxConcurrent: 1,
  childAgents: { enabled: true, targets: [REVIEWER] },
};

const CAPTURED: ChildAgentPolicy = {
  sessionId: "session-1",
  rootThreadId: "root-1",
  maxConcurrent: 2,
  permission: "ask",
  systemPrompt: "",
  projectInstructionsEnabled: false,
  reasoningEffort: "medium",
  serviceTier: null,
  targets: [{ ...REVIEWER, id: "frozen-reviewer", label: "Frozen reviewer" }],
  capturedAt: 1_000,
};

function view(overrides: Partial<SubAgentCommandCenterProps> = {}) {
  const onChange = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <SubAgentCommandCenter
      policy={POLICY}
      capturedPolicy={null}
      mode="open"
      readiness={READY}
      workers={[]}
      scopeLabel="Chats & project defaults"
      projectOverride={false}
      onChange={onChange}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />,
  );
  return { onChange, onOpenSettings };
}

function trigger() {
  return screen.getByRole("button", { name: /Sub-agents/ });
}

async function open(overrides: Partial<SubAgentCommandCenterProps> = {}) {
  const handlers = view(overrides);
  await userEvent.click(trigger());
  return handlers;
}

function worker(overrides: Partial<SubAgentWorker> = {}): SubAgentWorker {
  return {
    id: "child-1",
    kind: "cross-provider",
    status: "working",
    title: "Review the diff",
    targetId: "reviewer",
    provider: "claude",
    model: "claude-fable-5",
    detail: "Claude · claude-fable-5",
    createdAt: 1_000,
    ...overrides,
  };
}

describe("SubAgentCommandCenter trigger", () => {
  it("summarizes the crew size while closed", () => {
    view();
    expect(trigger()).toHaveTextContent("Sub-agents: 1");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("says agents are off when delegation is disabled", () => {
    view({ policy: { ...POLICY, enabled: false, childAgents: { enabled: false, targets: [] } } });
    expect(trigger()).toHaveTextContent("Sub-agents off");
    expect(trigger()).not.toHaveClass("enabled");
  });

  it("stays neutral when an old cross-provider setting remains on", () => {
    view({ policy: { ...POLICY, enabled: false, childAgents: { enabled: true, targets: [REVIEWER] } } });
    expect(trigger()).toHaveTextContent("Sub-agents off");
    expect(trigger()).not.toHaveClass("enabled");
  });

  it("shows a live count and an announced status while children work", () => {
    view({ workers: [worker(), worker({ id: "child-2", status: "completed" })] });
    expect(trigger()).toHaveTextContent("Sub-agents 1/1");
    expect(trigger().className).toContain("live");
    expect(trigger().querySelector(".sa-trigger-trace")).toBeInTheDocument();
    expect(trigger().querySelector(".sa-trigger-trace-outline")).toBeInTheDocument();
    expect(trigger().querySelector(".sa-trigger-trace-runner")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 working · 1 done");
  });

  it("does not render the activity outline when no child is active", () => {
    view({ workers: [worker({ status: "completed" })] });
    expect(trigger().querySelector(".sa-trigger-trace")).not.toBeInTheDocument();
  });

  it("marks a project-scoped policy", () => {
    view({ projectOverride: true });
    expect(within(trigger()).getByText("project")).toBeInTheDocument();
  });

  it("stays available on a started thread instead of being disabled", () => {
    view({ mode: "captured", capturedPolicy: CAPTURED });
    expect(trigger()).toBeEnabled();
  });
});

describe("SubAgentCommandCenter open and close", () => {
  it("opens a labelled dialog and wires aria-controls to it", async () => {
    await open();
    const panel = screen.getByRole("dialog", { name: "Sub-agent command center" });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger().getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
  });

  it("moves focus into the panel on open", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Close sub-agent command center" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("closes on an outside click", async () => {
    await open();
    await userEvent.click(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when the panel itself is clicked", async () => {
    await open();
    await userEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps Tab inside the panel instead of leaking into the composer", async () => {
    await open();
    const focusable = Array.from(
      screen.getByRole("dialog").querySelectorAll<HTMLElement>("button:not([disabled]), input, select"),
    );
    focusable[focusable.length - 1].focus();
    await userEvent.tab();
    expect(focusable[0]).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(focusable[focusable.length - 1]).toHaveFocus();
  });

  it("does not announce the same live summary twice while open", async () => {
    await open({ workers: [worker()] });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("closes from the close button", async () => {
    await open();
    const panel = screen.getByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(panel).toHaveClass("closing");
    expect(panel).toBeInTheDocument();
    await waitFor(() => expect(panel).not.toBeInTheDocument(), { timeout: 500 });
  });

  it("hands off to the durable Settings screen", async () => {
    const { onOpenSettings } = await open();
    await userEvent.click(screen.getByRole("button", { name: /Advanced sub-agent settings/ }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter editing a draft policy", () => {
  it("names the scope an edit will be written to", async () => {
    await open({ scopeLabel: "Alpha" });
    expect(screen.getByText("Editing Alpha")).toBeInTheDocument();
  });

  it("toggles delegation", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("raises and lowers the parallel limit within 1–24", async () => {
    const targets = [REVIEWER, BUILDER, { ...REVIEWER, id: "third" }, { ...REVIEWER, id: "fourth" }, { ...REVIEWER, id: "fifth" }];
    const { onChange } = await open({ policy: { ...POLICY, maxConcurrent: 4, childAgents: { enabled: true, targets } } });
    await userEvent.click(screen.getByRole("button", { name: "More concurrent sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 5 }));
    await userEvent.click(screen.getByRole("button", { name: "Fewer concurrent sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 3 }));
  });

  it("disables the upper bound at the enabled crew size", async () => {
    await open();
    expect(screen.getByRole("button", { name: "More concurrent sub-agents" })).toBeDisabled();
  });

  it("disables the lower bound at one", async () => {
    await open({ policy: { ...POLICY, maxConcurrent: 1 } });
    expect(screen.getByRole("button", { name: "Fewer concurrent sub-agents" })).toBeDisabled();
  });

  it("lets a limit of two coexist with a larger roster of destinations", async () => {
    // The roster is a menu and the limit is a budget. Refusing to go below the
    // number of destinations made a limit of 2 impossible to express, and the
    // frozen policy really did allow a third child.
    const { onChange } = await open({
      policy: {
        enabled: true,
        maxConcurrent: 3,
        childAgents: { enabled: true, targets: [REVIEWER, BUILDER, { ...REVIEWER, id: "third", label: "Third" }] },
      },
    });
    const fewer = screen.getByRole("button", { name: "Fewer concurrent sub-agents" });
    expect(fewer).toBeEnabled();
    await userEvent.click(fewer);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 2 }));
    expect(screen.getByText(/chosen from 3 configured sub-agents/)).toBeInTheDocument();
  });

  it("uses one main switch and makes the configured roster available when enabled", async () => {
    const { onChange } = await open({ policy: { ...POLICY, enabled: false, childAgents: { ...POLICY.childAgents, enabled: false } } });
    expect(screen.queryByRole("switch", { name: "Allow cross-provider sub-agents" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, childAgents: expect.objectContaining({ enabled: true, targets: [REVIEWER] }) }));
  });

  it("enables a destination independently", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Enable Reviewer" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ targets: [expect.objectContaining({ id: "reviewer", enabled: false })] }),
    }));
  });

  it("adds a worker with a slug a model can name, turning delegation on", async () => {
    const { onChange } = await open({
      policy: { enabled: false, maxConcurrent: 2, childAgents: { enabled: false, targets: [] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Add OpenRouter sub-agent" }));
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      maxConcurrent: 1,
      childAgents: {
        enabled: true,
        targets: [expect.objectContaining({ id: "openrouter", provider: "openrouter", label: "OpenRouter", enabled: true })],
      },
    });
  });

  it("clears every configured worker in one action", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, maxConcurrent: 2, childAgents: { enabled: true, targets: [REVIEWER, BUILDER] } },
    });

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      maxConcurrent: 1,
      childAgents: { enabled: false, targets: [] },
    });
  });

  it("applies a saved crew preset through the current policy scope", async () => {
    const presetPolicy: ProjectSubagentSettings = {
      enabled: true,
      maxConcurrent: 2,
      childAgents: { enabled: true, targets: [REVIEWER, BUILDER] },
    };
    const { onChange } = await open({ presets: [{ id: "review-and-build", name: "Review and build", policy: presetPolicy }] });

    await userEvent.click(screen.getByRole("button", { name: "Sub-agent preset" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Review and build/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith(presetPolicy);
  });

  it("links to Settings when no crew presets exist", async () => {
    const { onOpenSettings } = await open({ presets: [] });
    await userEvent.click(screen.getByRole("button", { name: "Create preset" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("gives a second destination on the same provider a unique name", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, childAgents: { enabled: true, targets: [{ ...REVIEWER, id: "cursor", provider: "cursor" }] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Add Cursor sub-agent" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({
        targets: [expect.objectContaining({ id: "cursor" }), expect.objectContaining({ id: "cursor-2" })],
      }),
    }));
  });

  it("grows a limit that was tracking the enabled crew", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, maxConcurrent: 2, childAgents: { enabled: true, targets: [REVIEWER, BUILDER] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Add Cursor sub-agent" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      maxConcurrent: 3,
      childAgents: expect.objectContaining({ targets: expect.arrayContaining([expect.objectContaining({ provider: "cursor" })]) }),
    }));
  });

  it("lets the parallel limit go below the configured crew size", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, maxConcurrent: 2, childAgents: { enabled: true, targets: [REVIEWER, BUILDER] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Fewer concurrent sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 1 }));
  });

  it("does not count parked destinations toward the parallel limit", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, maxConcurrent: 2, childAgents: { enabled: true, targets: [REVIEWER, { ...BUILDER, enabled: false }] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Fewer concurrent sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 1 }));
  });

  it("still allows a lower limit with a legacy secondary flag", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, maxConcurrent: 2, childAgents: { enabled: false, targets: [REVIEWER, BUILDER] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Fewer concurrent sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 1 }));
  });

  it("reveals provider, model, and reasoning controls for a destination", async () => {
    const { onChange } = await open();
    const configure = screen.getByRole("button", { name: "Configure Reviewer" });
    expect(configure).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(configure);
    expect(configure).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "Provider for reviewer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Cursor/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({
        targets: [expect.objectContaining({ provider: "cursor", model: "auto" })],
      }),
    }));

    onChange.mockClear();
    expect(screen.queryByRole("textbox", { name: "Model for reviewer" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Model for reviewer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Opus 5/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ targets: [expect.objectContaining({ model: "claude-opus-5" })] }),
    }));
  });

  it("settles the roster layout immediately in both directions", async () => {
    await open();
    const configure = screen.getByRole("button", { name: "Configure Reviewer" });
    const tile = configure.closest(".sa-tile");
    const shell = screen.getByLabelText("Provider for reviewer").closest(".sa-tile-config-shell");

    await userEvent.click(configure);
    expect(configure).toHaveAttribute("aria-expanded", "true");
    expect(shell).toHaveClass("open");
    expect(shell).not.toHaveAttribute("aria-hidden");
    expect(tile).toHaveClass("expanded");

    await userEvent.click(configure);

    // No exit class and no timer: the DOM is already in its settled layout and
    // the roster's FLIP pass animates the difference from the previous one.
    expect(configure).toHaveAttribute("aria-expanded", "false");
    expect(shell).not.toHaveClass("open");
    expect(shell).toHaveAttribute("aria-hidden", "true");
    expect(tile).not.toHaveClass("expanded");
  });

  it("keeps every tile addressable by the roster transition", async () => {
    await open({ policy: { ...POLICY, childAgents: { enabled: true, targets: [REVIEWER, BUILDER] } } });

    const grid = screen.getByRole("list", { name: "Configured sub-agents" });
    expect([...grid.querySelectorAll("[data-flip-key]")].map((node) => node.getAttribute("data-flip-key")))
      .toEqual(["reviewer", "builder", "__add__"]);
  });

  it("labels the primary switch as sub-agents", async () => {
    await open();
    expect(screen.getAllByText("Sub-agents").length).toBeGreaterThan(0);
    expect(screen.queryByText("Delegation")).not.toBeInTheDocument();
  });

  it("offers a fixed reasoning level", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Configure Reviewer" }));
    await userEvent.click(screen.getByRole("button", { name: "Reasoning control for reviewer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /You set the level/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ targets: [expect.objectContaining({ reasoningMode: "fixed" })] }),
    }));
  });

  it("offers an authority ceiling when the main agent decides", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, childAgents: { enabled: true, targets: [{ ...REVIEWER, reasoningMode: "agent" }] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Configure Reviewer" }));
    expect(screen.getByText("Main agent decides · up to High")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Maximum reasoning for reviewer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Maximum" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ targets: [expect.objectContaining({ reasoningMaxEffort: "max" })] }),
    }));
  });

  it("removes a destination", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Configure Reviewer" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ targets: [] }),
    }));
  });

  it.each(["claude", "openai"] as const)("grays signed-out %s without changing the roster on mouse or keyboard activation", async (provider) => {
    const onUnavailable = vi.fn();
    const unavailableTarget = { ...REVIEWER, provider };
    const { onChange } = await open({
      readiness: { ...READY, claudeReady: false, openAiSignedIn: false },
      policy: { ...POLICY, childAgents: { enabled: true, targets: [unavailableTarget] } },
      onUnavailable,
    });
    const face = screen.getByRole("button", { name: "Configure Reviewer" });
    expect(face).toHaveAttribute("aria-disabled", "true");
    expect(face.closest(".sa-tile")).toHaveClass("unavailable");
    expect(screen.queryByRole("button", { name: "Models & accounts" })).not.toBeInTheDocument();
    await userEvent.click(face);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("switch", { name: "Enable Reviewer" }));
    await userEvent.click(screen.getByRole("button", { name: `Add ${provider === "openai" ? "OpenAI" : "Claude"} sub-agent` }));
    expect(onUnavailable).toHaveBeenCalledTimes(4);
    expect(onUnavailable).toHaveBeenLastCalledWith(expect.stringContaining("Settings → Models & accounts"));
    expect(onChange).not.toHaveBeenCalled();
    expect(face).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ childAgents: expect.objectContaining({ targets: [] }) }));
  });

  it("explains a signed-out provider choice without replacing a configured target", async () => {
    const onUnavailable = vi.fn();
    const { onChange } = await open({ readiness: { ...READY, openAiSignedIn: false }, onUnavailable });
    await userEvent.click(screen.getByRole("button", { name: "Configure Reviewer" }));
    await userEvent.click(screen.getByRole("button", { name: "Provider for reviewer" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Claude/ })).toHaveFocus());
    const option = screen.getByRole("menuitemradio", { name: /OpenAI/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(option);
    await userEvent.keyboard("{Enter}");
    expect(onUnavailable).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays quiet about a destination the user switched off", async () => {
    await open({
      readiness: { ...READY, claudeReady: false },
      policy: { ...POLICY, childAgents: { enabled: true, targets: [{ ...REVIEWER, enabled: false }] } },
    });
    expect(screen.queryByText(/Install and sign in to Claude Code first/)).not.toBeInTheDocument();
  });

  it("says so when every destination is switched off", async () => {
    await open({ policy: { ...POLICY, childAgents: { enabled: true, targets: [{ ...REVIEWER, enabled: false }] } } });
    expect(screen.getByText(/None switched on/)).toBeInTheDocument();
  });

  it("invites a first destination when the roster is empty", async () => {
    await open({ policy: { ...POLICY, childAgents: { enabled: true, targets: [] } } });
    expect(screen.getByText("No sub-agents yet. Add one to let the model delegate across providers.")).toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter on a thread that froze a roster", () => {
  const capturedDraft: ProjectSubagentSettings = {
    ...POLICY,
    maxConcurrent: CAPTURED.maxConcurrent,
    childAgents: { enabled: true, targets: CAPTURED.targets },
  };

  it("lets an idle captured thread edit its own crew for the next message", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED, policy: capturedDraft });
    expect(screen.getByText("Editing this thread")).toBeInTheDocument();
    expect(screen.getByText(/Sub-agent and limit changes stay in this thread/)).toBeInTheDocument();
    expect(screen.getByText("Frozen reviewer")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable Frozen reviewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More concurrent sub-agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add OpenAI sub-agent" })).toBeInTheDocument();
  });

  it("locks every crew control while the parent is active", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED, policy: capturedDraft, parentActive: true });
    expect(screen.getByText("Sub-agents locked while work is active")).toBeInTheDocument();
    expect(screen.getByText(/Finish or stop the parent and every sub-agent/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /^Enable / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
    expect(screen.queryByRole("switch", { name: "Allow cross-provider sub-agents" })).not.toBeInTheDocument();
  });

  it("locks every crew control while any child is active", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED, policy: capturedDraft, workers: [worker()] });
    expect(screen.getByText("Sub-agents locked while work is active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
  });

  it("shows the captured limit rather than the limit configured since", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED, policy: capturedDraft });
    expect(trigger()).toHaveTextContent("Sub-agents: 2");
  });

  it("keeps the main switch editable once the thread is idle", async () => {
    const { onChange } = await open({ mode: "captured", capturedPolicy: CAPTURED, policy: capturedDraft });
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));


  });

  it("never claims a frozen thread still has agents once they are switched off", async () => {
    await open({
      mode: "captured",
      capturedPolicy: CAPTURED,
      policy: { ...POLICY, enabled: false, childAgents: { enabled: false, targets: [] } },
    });
    expect(trigger()).toHaveTextContent("Sub-agents off");
    expect(screen.getByText("Sub-agents are off for this task.")).toBeInTheDocument();
  });

  it("uses the configured roster despite the removed legacy switch", async () => {
    await open({
      mode: "captured",
      capturedPolicy: CAPTURED,
      policy: { ...capturedDraft, enabled: true, childAgents: { enabled: false, targets: CAPTURED.targets } },
    });
    expect(trigger()).toHaveTextContent("Sub-agents: 2");
    expect(trigger()).toHaveTextContent("↗");
    // A hidden legacy flag cannot contradict the main switch.
    expect(screen.getByText("Frozen reviewer")).toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter enabling sub-agents mid-conversation", () => {
  it("stays fully editable before a thread has run with cross-provider sub-agents", async () => {
    const { onChange } = await open({
      mode: "open",
      capturedPolicy: null,
      policy: { enabled: false, maxConcurrent: 2, childAgents: { enabled: false, targets: [] } },
    });
    expect(screen.queryByText(/froze its destinations/)).not.toBeInTheDocument();
    expect(screen.getByText("Editing Chats & project defaults")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    onChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      childAgents: expect.objectContaining({
        enabled: true,
        targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
      }),
    }));
  });

  it("marks cross-provider reach as ready the moment it is configured", async () => {
    view({ mode: "open", capturedPolicy: null });
    expect(trigger()).toHaveTextContent("Sub-agents: 1 ↗");
  });
});

describe("SubAgentCommandCenter inside a sub-agent conversation", () => {
  const child = { mode: "child" as const, capturedPolicy: null, policy: { enabled: false, maxConcurrent: 1, childAgents: { enabled: false, targets: [] } } };

  it("reports delegation as off and offers no way to turn it on", async () => {
    await open(child);
    expect(trigger()).toHaveTextContent("Sub-agents off");
    expect(screen.getByText(/never starts sub-agents of its own/)).toBeInTheDocument();
    expect(screen.getAllByText("Off")).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow cross-provider sub-agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
  });

  it("never shows a roster it could delegate to, whatever is configured globally", async () => {
    await open({ ...child, policy: POLICY });
    expect(screen.getByText("A sub-agent cannot start sub-agents of its own.")).toBeInTheDocument();
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter live activity", () => {
  it("renders each worker's state and who is doing the work", async () => {
    await open({
      workers: [
        worker(),
        worker({ id: "child-2", status: "failed", title: "Broken build", detail: "OpenAI · gpt-5.6-terra", provider: "openai" }),
        worker({ id: "native-1", kind: "native", status: "completed", title: "Write tests", detail: "Same provider as this thread", provider: undefined, targetId: undefined }),
      ],
    });
    const rows = screen.getAllByRole("listitem").filter((row) => row.className.includes("sa-worker"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Review the diff");
    expect(rows[0]).toHaveTextContent("Working · Claude · claude-fable-5");
    expect(rows[1]).toHaveTextContent("Failed · OpenAI · gpt-5.6-terra");
    expect(rows[2]).toHaveTextContent("Completed · Same provider as this thread · model not reported");
  });

  it("gives every worker state its own row class so motion can differ", async () => {
    await open({
      workers: [
        worker({ id: "a", status: "working" }),
        worker({ id: "b", status: "starting" }),
        worker({ id: "c", status: "completed" }),
        worker({ id: "d", status: "cancelled" }),
        worker({ id: "e", status: "failed" }),
      ],
    });
    const classes = screen.getAllByRole("listitem")
      .filter((row) => row.className.includes("sa-worker"))
      .map((row) => row.className);
    for (const status of ["working", "starting", "completed", "cancelled", "failed"]) {
      expect(classes.some((value) => value.includes(status))).toBe(true);
    }
  });

  it("marks the destination tile of a worker that is actually busy", async () => {
    await open({ workers: [worker()] });
    const tile = screen.getByRole("button", { name: "Configure Reviewer" }).closest(".sa-tile");
    expect(tile?.className).toContain("busy");
  });

  it("leaves a tile still when its destination has only settled work", async () => {
    await open({ workers: [worker({ status: "completed" })] });
    const tile = screen.getByRole("button", { name: "Configure Reviewer" }).closest(".sa-tile");
    expect(tile?.className).not.toContain("busy");
  });

  it("says nothing has run yet on an empty crew", async () => {
    await open();
    expect(screen.getByText(/Sub-agents appear here the moment the model delegates/)).toBeInTheDocument();
  });

  it("keeps live state visible on a locked thread", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED, workers: [worker()] });
    expect(screen.getByText("Review the diff")).toBeInTheDocument();
  });

  it("stops exactly the selected live worker", async () => {
    const onStopWorker = vi.fn().mockResolvedValue(undefined);
    const selected = worker();
    await open({ workers: [selected], onStopWorker });
    await userEvent.click(screen.getByRole("button", { name: "Stop Review the diff" }));
    await waitFor(() => expect(onStopWorker).toHaveBeenCalledWith(selected));
  });

  it("offers only frozen, ready destinations when replacing a live worker", async () => {
    const onReplaceWorker = vi.fn().mockResolvedValue(undefined);
    const selected = worker();
    const policy = { ...POLICY, childAgents: { enabled: true, targets: [REVIEWER, BUILDER] } };
    await open({ policy, workers: [selected], onReplaceWorker });
    await userEvent.click(screen.getByRole("button", { name: "Replace Review the diff" }));
    expect(screen.getByRole("group", { name: "Replacement sub-agent for Review the diff" })).toBeInTheDocument();
    expect(screen.getByText("claude-fable-5 · restart")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace Review the diff with Terra builder" }));
    await waitFor(() => expect(onReplaceWorker).toHaveBeenCalledWith(selected, "builder"));
  });

  it("does not offer stop or replace controls for settled workers", async () => {
    await open({
      workers: [worker({ status: "completed" })],
      onStopWorker: vi.fn(),
      onReplaceWorker: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /^Stop / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Replace / })).not.toBeInTheDocument();
  });

  it("names each worker's task, state, provider and model on its row", async () => {
    await open({
      workers: [
        worker(),
        worker({
          id: "native-1",
          kind: "native",
          status: "starting",
          title: "Port the parser",
          provider: "openai",
          model: "gpt-5.6-terra",
          modelSource: "execution",
          detail: "OpenAI · gpt-5.6-terra",
          targetId: undefined,
        }),
      ],
    });
    expect(screen.getByText("Review the diff")).toBeInTheDocument();
    expect(screen.getByText("Working · Claude · claude-fable-5")).toBeInTheDocument();
    expect(screen.getByText("Port the parser")).toBeInTheDocument();
    expect(screen.getByText("Starting · OpenAI · gpt-5.6-terra")).toBeInTheDocument();
  });

  it("opens a worker's own conversation, live or settled, and closes the panel", async () => {
    const onOpenWorker = vi.fn().mockResolvedValue(undefined);
    const live = worker();
    const done = worker({ id: "child-2", title: "Finished audit", status: "completed" });
    await open({ workers: [live, done], onOpenWorker });
    expect(screen.getByRole("button", { name: "Open Finished audit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Review the diff" }));
    await waitFor(() => expect(onOpenWorker).toHaveBeenCalledWith(live));
    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "false"));
  });

  it("reports why a worker's conversation could not be opened", async () => {
    const onOpenWorker = vi.fn().mockRejectedValue(new Error("No conversation yet."));
    await open({ workers: [worker()], onOpenWorker });
    await userEvent.click(screen.getByRole("button", { name: "Open Review the diff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No conversation yet.");
  });

  it("omits the open action when the host offers no way to select a thread", async () => {
    await open({ workers: [worker()] });
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
  });
});


describe("saving the composer setup", () => {
  it("saves the named current policy without applying a different preset", async () => {
    const onSavePreset = vi.fn();
    const { onChange } = await open({ onSavePreset });
    await userEvent.type(screen.getByRole("textbox", { name: "New sub-agent preset name" }), "Review setup");
    await userEvent.click(screen.getByRole("button", { name: "Save as preset" }));
    expect(onSavePreset).toHaveBeenCalledWith("Review setup", POLICY);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "New sub-agent preset name" })).toHaveValue("");
  });
});

describe("SubAgentCommandCenter sub-agent system", () => {
  const nativeClaude = { engine: "native" as const, provider: "claude" as const, onEngineChange: vi.fn() };

  it("stays hidden until the host wires engine selection", async () => {
    await open();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("offers Mythra Code and the thread's native runtime as one radio group", async () => {
    const onEngineChange = vi.fn();
    await open({ provider: "openai", onEngineChange });
    const group = screen.getByRole("group", { name: "Sub-agent system" });
    expect(within(group).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
    const native = within(group).getByRole("radio", { name: /Native Codex/ });
    expect(native).not.toBeChecked();
    await userEvent.click(native);
    expect(onEngineChange).toHaveBeenCalledWith("native");
  });

  it("names Claude Code when the thread runs on Claude", async () => {
    await open({ provider: "claude", onEngineChange: vi.fn() });
    expect(screen.getByRole("radio", { name: /Native Claude Code/ })).toBeEnabled();
  });

  it("disables native mode with a reason on a provider without native agents", async () => {
    await open({ provider: "openrouter", onEngineChange: vi.fn() });
    const native = screen.getByRole("radio", { name: /Provider native/ });
    expect(native).toBeDisabled();
    expect(native).toHaveAccessibleDescription(/OpenRouter has no native sub-agents/);
  });

  it("explains a host-reported reason such as signing in", async () => {
    await open({ provider: "claude", onEngineChange: vi.fn(), nativeUnavailableReason: "Sign in to Claude Code to use native agents." });
    expect(screen.getByRole("radio", { name: /Native Claude Code/ })).toHaveAccessibleDescription("Sign in to Claude Code to use native agents.");
  });

  it("replaces the crew editor and presets with the native pane", async () => {
    await open({ ...nativeClaude, presets: [], onSavePreset: vi.fn() });
    expect(screen.getByText(/Claude Code decides when to start agents/)).toBeInTheDocument();
    expect(screen.getByText(/Stopping the parent stops them too/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Configured sub-agents" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sub-agent preset")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New sub-agent preset name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
  });

  it("does not touch the Mythra crew when switching systems", async () => {
    const onEngineChange = vi.fn();
    const { onChange } = await open({ provider: "openai", onEngineChange });
    await userEvent.click(screen.getByRole("radio", { name: /Native Codex/ }));
    expect(onEngineChange).toHaveBeenCalledWith("native");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the main switch independent of the system choice", async () => {
    const { onChange } = await open({ ...nativeClaude, policy: { ...POLICY, enabled: false } });
    expect(trigger()).toHaveTextContent("Sub-agents off");
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, childAgents: POLICY.childAgents }));
  });

  it("steps the native limit within 1–24, independent of the crew", async () => {
    const onNativeMaxConcurrentChange = vi.fn();
    await open({ ...nativeClaude, nativeMaxConcurrent: 24, onNativeMaxConcurrentChange });
    expect(screen.getByRole("button", { name: "More concurrent native agents" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Fewer concurrent native agents" }));
    expect(onNativeMaxConcurrentChange).toHaveBeenCalledWith(23);
    expect(screen.getByText(/caps parallel agents, not total usage/)).toBeInTheDocument();
  });

  it("defaults the native limit to six", async () => {
    view({ ...nativeClaude });
    expect(trigger()).toHaveTextContent("Native: 6");
  });

  it("summarizes native activity on the trigger", () => {
    view({ ...nativeClaude, nativeMaxConcurrent: 4, workers: [worker({ id: "n1", kind: "native", targetId: undefined })] });
    expect(trigger()).toHaveTextContent("Native 1/4");
  });

  it("locks system, switch and limits on an uncaptured thread while work runs", async () => {
    await open({ ...nativeClaude, mode: "open", parentActive: true, onNativeMaxConcurrentChange: vi.fn() });
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /concurrent native agents/ })).not.toBeInTheDocument();
    expect(screen.getByText(/unlock once the parent and every sub-agent are idle/)).toBeInTheDocument();
  });

  it("locks while a worker's status is unknown", async () => {
    await open({ provider: "openai", onEngineChange: vi.fn(), workers: [worker({ status: "unknown" })] });
    expect(screen.getByRole("radio", { name: /Mythra Code/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
  });

  it("offers nothing in a child conversation even if native is configured", async () => {
    await open({ ...nativeClaude, mode: "child", capturedPolicy: null });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Sub-agents off");
  });

  it("only shows per-agent open and stop when the worker supports them", async () => {
    const claudeAgent = worker({ id: "n1", kind: "native", title: "Scan logs", targetId: undefined, canOpen: false, canStop: false });
    const codexAgent = worker({ id: "n2", kind: "native", title: "Port parser", targetId: undefined, provider: "openai", canOpen: true, canStop: true });
    await open({ ...nativeClaude, workers: [claudeAgent, codexAgent], onOpenWorker: vi.fn(), onStopWorker: vi.fn(), onReplaceWorker: vi.fn() });
    expect(screen.queryByRole("button", { name: "Open Scan logs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scan logs" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Port parser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Port parser" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Replace / })).not.toBeInTheDocument();
  });

  it("closes when the host switches to another uncaptured conversation", async () => {
    const props: SubAgentCommandCenterProps = {
      policy: POLICY,
      capturedPolicy: null,
      mode: "open",
      readiness: READY,
      workers: [],
      scopeLabel: "Chats",
      projectOverride: false,
      onChange: vi.fn(),
      onOpenSettings: vi.fn(),
      contextKey: "draft-a",
    };
    const { rerender } = render(<SubAgentCommandCenter {...props} />);
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    rerender(<SubAgentCommandCenter {...props} contextKey="draft-b" />);
    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "false"));
  });
});

describe("SubAgentCommandCenter native options", () => {
  const SAVED: NativeSubagentOptions = {
    claude: { model: "claude-opus-5", autoCompactTokens: 200_000 },
    codex: { model: "gpt-5.6-luna", reasoningEffort: "high", autoCompactTokens: 500_000 },
  };
  const claudeNative = (overrides: Partial<SubAgentCommandCenterProps> = {}) => ({
    engine: "native" as const,
    provider: "claude" as const,
    onEngineChange: vi.fn(),
    claudeVersion: "2.1.293",
    nativeOptions: SAVED,
    onNativeOptionsChange: vi.fn(),
    onAutoCompactTokensChange: vi.fn(),
    ...overrides,
  });
  const codexNative = (overrides: Partial<SubAgentCommandCenterProps> = {}) => claudeNative({ provider: "openai", ...overrides });

  async function choose(menu: string, option: RegExp) {
    await userEvent.click(screen.getByRole("button", { name: menu }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: option }));
  }

  it("picks Haiku 5.5 for Claude children without touching Codex or delegation", async () => {
    const props = claudeNative();
    const { onChange } = await open(props);
    await choose("Child model", /^Haiku 5\.5/);
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({
      claude: { model: "claude-haiku-5-5", autoCompactTokens: 200_000 },
      codex: SAVED.codex,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lists Haiku 5.5 even when the catalog has not caught up", async () => {
    await open(claudeNative({ modelCatalogs: { claude: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } }));
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    expect(screen.getByRole("menuitemradio", { name: /^Haiku 5\.5\s*claude-haiku-5-5/ })).toBeEnabled();
    expect(screen.getByRole("menuitemradio", { name: /^Provider chooses/ })).toBeInTheDocument();
  });

  it.each([["2.1.292"], ["2.1.293-beta.1"], [null]])("keeps Haiku 5.5 unavailable on Claude Code %s and never substitutes Haiku 4.5", async (claudeVersion) => {
    const onUnavailable = vi.fn();
    const props = claudeNative({ claudeVersion, onUnavailable });
    await open(props);
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    const haiku = screen.getByRole("menuitemradio", { name: /^Haiku 5\.5\s*Needs Claude Code 2\.1\.293\+/ });
    expect(haiku).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(haiku);
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringMatching(/Haiku 5\.5 needs Claude Code 2\.1\.293 or newer/));
    expect(props.onNativeOptionsChange).not.toHaveBeenCalled();
  });

  it("explains a saved Haiku 5.5 on an outdated runtime and clears it back to the provider", async () => {
    const props = claudeNative({ claudeVersion: "2.1.200", nativeOptions: { claude: { model: "claude-haiku-5-5" }, codex: SAVED.codex } });
    await open(props);
    expect(screen.getByRole("button", { name: "Child model" })).toHaveTextContent("Haiku 5.5");
    expect(screen.getByText(/Update Claude Code to use it for child agents/)).toBeInTheDocument();
    await choose("Child model", /^Provider chooses/);
    const next = vi.mocked(props.onNativeOptionsChange!).mock.calls[0]![0];
    expect(next).toEqual({ codex: SAVED.codex });
    expect(next).not.toHaveProperty("claude");
  });

  it("prefers the native catalog over the crew catalog", async () => {
    await open(claudeNative({
      modelCatalogs: { claude: [{ id: "opus", label: "Crew alias" }] },
      nativeModelCatalogs: { claude: [{ id: "claude-opus-5", label: "Opus 5", detail: "claude-opus-5" }] },
    }));
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    expect(screen.getByRole("menuitemradio", { name: /^Opus 5/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: /Crew alias/ })).not.toBeInTheDocument();
  });

  it("keeps a previously configured model visible", async () => {
    await open(claudeNative({ nativeOptions: { claude: { model: "claude-custom-9" } } }));
    expect(screen.getByRole("button", { name: "Child model" })).toHaveTextContent("claude-custom-9");
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    expect(screen.getByRole("menuitemradio", { name: /claude-custom-9\s*Previously configured model/ })).toBeInTheDocument();
  });

  it("stores a 100K child model window as tokens for Claude only", async () => {
    const props = claudeNative({ nativeOptions: { claude: { model: "claude-haiku-5-5" }, codex: SAVED.codex } });
    await open(props);
    await choose("Child model compaction", /^100K tokens/);
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: { model: "claude-haiku-5-5", autoCompactTokens: 100_000 }, codex: SAVED.codex });
    expect(props.onAutoCompactTokensChange).not.toHaveBeenCalled();
  });

  it("offers the 100K, 200K, 500K and 1M presets beside the provider default", async () => {
    await open(claudeNative({ nativeOptions: { claude: { model: "claude-haiku-5-5", autoCompactTokens: 150_000 } } }));
    expect(screen.getByRole("button", { name: "Child model compaction" })).toHaveTextContent("150K tokens");
    await userEvent.click(screen.getByRole("button", { name: "Child model compaction" }));
    const labels = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(labels).toEqual([
      "Provider defaultThe runtime's own threshold",
      "150K tokensPreviously configured",
      "100K tokensPublished API price boundary; not a cost cap",
      "200K tokens",
      "500K tokens",
      "1M tokensRequested window; model limits still apply",
    ]);
  });

  it("resets each Codex default independently and keeps Claude's entry", async () => {
    const props = codexNative();
    await open(props);
    await choose("Default child model", /^Provider chooses/);
    await choose("Default child reasoning", /^Provider default/);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    const calls = vi.mocked(props.onNativeOptionsChange!).mock.calls.map(([next]) => next);
    expect(calls).toEqual([
      { claude: SAVED.claude, codex: { reasoningEffort: "high", autoCompactTokens: 500_000 } },
      { claude: SAVED.claude, codex: { model: "gpt-5.6-luna", autoCompactTokens: 500_000 } },
      { claude: SAVED.claude, codex: { model: "gpt-5.6-luna", reasoningEffort: "high" } },
    ]);
  });

  it("sets a Codex default model and reasoning level", async () => {
    const props = codexNative({
      nativeOptions: {},
      nativeDefaultModel: "gpt-5.6-luna",
      nativeReasoningEfforts: { "gpt-5.6-luna": ["low", "high"], "gpt-5.6-terra": ["low", "medium", "high"] },
    });
    await open(props);
    expect(screen.getByText(/Provider default inherits the parent's level unless your Codex config sets one/)).toBeInTheDocument();
    await choose("Default child model", /^Terra/);
    await choose("Default child reasoning", /^Low/);
    expect(vi.mocked(props.onNativeOptionsChange!).mock.calls.map(([next]) => next)).toEqual([
      { codex: { model: "gpt-5.6-terra" } },
      { codex: { reasoningEffort: "low" } },
    ]);
  });

  it("only offers the levels the default Codex model reports", async () => {
    const props = codexNative({ nativeReasoningEfforts: { "gpt-5.6-luna": ["low", "medium"] } });
    await open(props);
    expect(screen.getByText(/Luna does not offer this reasoning level/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Default child reasoning" }));
    expect(screen.getByRole("menuitemradio", { name: /^Medium/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("menuitemradio", { name: /^High\s*Not offered by Luna/ })).toHaveAttribute("aria-disabled", "true");
    // The saved level stays readable on the trigger until the user resets it.
    expect(screen.getByRole("button", { name: "Default child reasoning" })).toHaveTextContent("High");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^High/ }));
    expect(props.onNativeOptionsChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Provider default/ }));
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: SAVED.claude, codex: { model: "gpt-5.6-luna", autoCompactTokens: 500_000 } });
  });

  it("treats an empty reported list as no supported level, not unknown", async () => {
    await open(codexNative({ nativeReasoningEfforts: { "gpt-5.6-luna": [] } }));
    expect(screen.getByText(/Luna does not offer this reasoning level/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Default child reasoning" }));
    for (const level of ["Low", "Medium", "High"]) {
      expect(screen.getByRole("menuitemradio", { name: new RegExp(`^${level}\\s*Luna takes no reasoning level`) })).toHaveAttribute("aria-disabled", "true");
    }
    expect(screen.getByRole("menuitemradio", { name: /^Provider default\s*Luna's own default level/ })).not.toHaveAttribute("aria-disabled");
  });

  it("never offers a level nobody has reported, but keeps a saved one readable and clearable", async () => {
    const props = codexNative();
    await open(props);
    expect(screen.getByText(/Luna has not reported its reasoning levels, so this saved level is unconfirmed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default child reasoning" })).toHaveTextContent("High");
    await userEvent.click(screen.getByRole("button", { name: "Default child reasoning" }));
    expect(screen.getByRole("menuitemradio", { name: /^Low\s*Not confirmed for Luna/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Provider default/ }));
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: SAVED.claude, codex: { model: "gpt-5.6-luna", autoCompactTokens: 500_000 } });
  });

  it("clears a saved level in the same update when the new model reports it cannot take it", async () => {
    const onUnavailable = vi.fn();
    const props = codexNative({ onUnavailable, nativeReasoningEfforts: { "gpt-5.6-luna": ["high"], "gpt-5.6-terra": ["low", "medium"] } });
    await open(props);
    await choose("Default child model", /^Terra/);
    expect(props.onNativeOptionsChange).toHaveBeenCalledTimes(1);
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: SAVED.claude, codex: { model: "gpt-5.6-terra", autoCompactTokens: 500_000 } });
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringMatching(/Terra does not offer that reasoning level/));
  });

  it("keeps a saved level when the new model supports it or has not reported", async () => {
    const props = codexNative({ nativeReasoningEfforts: { "gpt-5.6-terra": ["high"] } });
    await open(props);
    await choose("Default child model", /^Terra/);
    await choose("Default child model", /^Astra/);
    expect(vi.mocked(props.onNativeOptionsChange!).mock.calls.map(([next]) => next.codex)).toEqual([
      { model: "gpt-5.6-terra", reasoningEffort: "high", autoCompactTokens: 500_000 },
      { model: "gpt-6-astra", reasoningEffort: "high", autoCompactTokens: 500_000 },
    ]);
  });

  it("checks levels against the parent's model when no default child model is set", async () => {
    await open(codexNative({
      nativeOptions: { codex: { reasoningEffort: "high" } },
      nativeDefaultModel: "gpt-5.6-terra",
      nativeReasoningEfforts: { "gpt-5.6-terra": ["low"] },
    }));
    expect(screen.getByText(/Terra does not offer this reasoning level/)).toBeInTheDocument();
  });

  it("leaves a problem the host already reports to the host's reason", async () => {
    await open(claudeNative({
      claudeVersion: "2.1.280",
      nativeOptions: { claude: { model: "claude-haiku-5-5-20261001" } },
      nativeUnavailableReason: "Haiku 5.5 native sub-agents require Claude Code 2.1.293 or newer.",
    }));
    expect(screen.queryByText(/Update Claude Code to use it for child agents/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    expect(screen.getByRole("menuitemradio", { name: /claude-haiku-5-5-20261001\s*Needs Claude Code 2\.1\.293\+/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers no Claude child effort control, only a short note", async () => {
    await open(claudeNative());
    expect(screen.queryByRole("button", { name: /reasoning|effort/i })).not.toBeInTheDocument();
    expect(screen.getByText(/there is no separate child effort/)).toBeInTheDocument();
    expect(screen.queryByText(/Haiku 4\.5/)).not.toBeInTheDocument();
  });

  it("describes the options in the intro and keeps the Claude stop note", async () => {
    await open(claudeNative());
    expect(screen.getByText(/decides when to start agents and which roles they take; the options below set this thread's defaults/)).toBeInTheDocument();
    expect(screen.getByText(/Stopping the parent stops them too/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Claude Code options for this thread" })).toBeInTheDocument();
  });

  it("explains child compaction limits behind an accessible disclosure", async () => {
    await open(claudeNative({ nativeOptions: { claude: { model: "claude-haiku-5-5" } } }));
    expect(screen.getByText("Automatic compaction, not a hard token or spending cap. Model limits still apply.")).toBeInTheDocument();
    const info = screen.getByRole("button", { name: "About child compaction and usage" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Subscription allowances are separate/)).not.toBeVisible();
    await userEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Subscription allowances are separate/)).toBeVisible();
    expect(screen.getByText(/1M requests a window and does not enlarge the model's context/)).toBeVisible();
  });

  it("keeps the Haiku 5.5 pricing note out of another Claude model", async () => {
    await open(claudeNative());
    await userEvent.click(screen.getByRole("button", { name: "About child compaction and usage" }));
    expect(screen.getByText(/compaction can\s+run late, overshoot or fail/)).toBeVisible();
    expect(screen.queryByText(/published API pricing changes above 100K/)).not.toBeInTheDocument();
  });

  it("offers Codex no child compaction disclosure or pricing note", async () => {
    await open(codexNative());
    expect(screen.queryByRole("button", { name: /About child compaction/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/published API pricing changes above 100K/)).not.toBeInTheDocument();
  });

  it.each([
    ["the parent is active", { parentActive: true }],
    ["a child is working", { workers: [worker({ id: "n1", kind: "native", targetId: undefined })] }],
    ["a child's status is unknown", { workers: [worker({ id: "n1", kind: "native", status: "unknown", targetId: undefined })] }],
    ["delegation is off", { policy: { ...POLICY, enabled: false } }],
  ])("locks every native option while %s", async (_label, overrides) => {
    const props = codexNative(overrides as Partial<SubAgentCommandCenterProps>);
    await open(props);
    for (const name of ["Default child model", "Default child reasoning"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Default child model" })).toHaveTextContent("Luna");
    expect(props.onNativeOptionsChange).not.toHaveBeenCalled();
  });

  it.each([
    ["the parent is active", { parentActive: true }],
    ["a child's status is unknown", { workers: [worker({ id: "n1", kind: "native", status: "unknown", targetId: undefined })] }],
  ])("locks the Claude child window while %s", async (_label, overrides) => {
    await open(claudeNative(overrides as Partial<SubAgentCommandCenterProps>));
    expect(screen.getByRole("button", { name: "Child model compaction" })).toBeDisabled();
  });

  it("shows no native options outside a native Codex or Claude Code thread", async () => {
    await open(claudeNative({ engine: "mythra" }));
    expect(screen.queryByRole("button", { name: "Child model" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Configured sub-agents" })).toBeInTheDocument();
  });

  it.each([
    ["an unsupported provider", { provider: "openrouter" as const }],
    ["an unknown provider", { provider: undefined }],
    ["an unwired host", { onNativeOptionsChange: undefined }],
  ])("exposes no native options for %s", async (_label, overrides) => {
    await open(claudeNative(overrides));
    expect(screen.queryByRole("button", { name: /Child model|Auto-compaction window/ })).not.toBeInTheDocument();
  });

  it("shows no native options in a child conversation", async () => {
    await open(claudeNative({ mode: "child" }));
    expect(screen.queryByRole("button", { name: /Child model|Auto-compaction window/ })).not.toBeInTheDocument();
  });

  it("keeps both native options and the Mythra crew when switching systems", async () => {
    const props = claudeNative();
    const { onChange } = await open(props);
    await userEvent.click(screen.getByRole("radio", { name: /Mythra Code/ }));
    expect(props.onEngineChange).toHaveBeenCalledWith("mythra");
    expect(props.onNativeOptionsChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets Escape close an open option menu before the panel", async () => {
    await open(claudeNative());
    await userEvent.click(screen.getByRole("button", { name: "Child model compaction" }));
    expect(screen.getByRole("menu", { name: "Child model compaction choices" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("names the built-in agents an explicit Claude model reaches without promising more", async () => {
    await open(claudeNative());
    expect(screen.getByText(/including the built-in Explore, Plan and general-purpose agents/)).toBeInTheDocument();
    expect(screen.getByText(/the parent keeps its model/)).toBeInTheDocument();
    expect(screen.queryByText(/may still choose their own/)).not.toBeInTheDocument();
  });

  it("says an explicit Codex model's own default applies when reasoning is left to the provider", async () => {
    await open(codexNative({ nativeOptions: { codex: { model: "gpt-5.6-luna" } } }));
    expect(screen.getByText(/Provider default uses Luna's own default/)).toBeInTheDocument();
    expect(screen.queryByText(/inherits the parent's level/)).not.toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter compaction windows", () => {
  async function choose(menu: string, option: RegExp) {
    await userEvent.click(screen.getByRole("button", { name: menu }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: option }));
  }
  const nativeWith = (provider: "claude" | "openai", overrides: Partial<SubAgentCommandCenterProps> = {}): Partial<SubAgentCommandCenterProps> => ({
    engine: "native",
    provider,
    onEngineChange: vi.fn(),
    claudeVersion: "2.1.293",
    onNativeOptionsChange: vi.fn(),
    onAutoCompactTokensChange: vi.fn(),
    ...overrides,
  });

  describe("this conversation's window", () => {
    it.each([
      ["Mythra Code", { provider: "openai" as const }],
      ["native", nativeWith("claude")],
    ])("stays editable with delegation off on %s", async (_label, base) => {
      const onAutoCompactTokensChange = vi.fn();
      const { onChange } = await open({ ...base, policy: { ...POLICY, enabled: false }, onAutoCompactTokensChange });
      expect(screen.getByRole("button", { name: "Conversation compaction" })).toBeEnabled();
      await choose("Conversation compaction", /^200K tokens/);
      expect(onAutoCompactTokensChange).toHaveBeenCalledWith(200_000);
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByText("Automatic compaction, not a hard token or spending cap. Model limits still apply.")).toBeInTheDocument();
    });

    it("clears to the provider default", async () => {
      const onAutoCompactTokensChange = vi.fn();
      await open({ provider: "claude", autoCompactTokens: 500_000, onAutoCompactTokensChange });
      expect(screen.getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("500K tokens");
      await choose("Conversation compaction", /^Provider default/);
      expect(onAutoCompactTokensChange).toHaveBeenCalledWith(undefined);
    });

    it.each([
      ["the parent is active", { parentActive: true }],
      ["a sub-agent is starting", { workers: [worker({ status: "starting" })] }],
      ["a worker's status is unknown", { workers: [worker({ status: "unknown" })] }],
    ])("locks while %s", async (_label, overrides) => {
      await open({ provider: "openai", onAutoCompactTokensChange: vi.fn(), ...overrides });
      expect(screen.getByRole("button", { name: "Conversation compaction" })).toBeDisabled();
    });

    it("shows a stored invalid zero as invalid, never as a working window", async () => {
      const onAutoCompactTokensChange = vi.fn();
      await open({ provider: "openai", autoCompactTokens: 0, onAutoCompactTokensChange });
      const control = screen.getByRole("button", { name: "Conversation compaction" });
      expect(control).toHaveTextContent("Invalid saved value");
      expect(control).not.toHaveTextContent("100K");
      expect(screen.getByText(/The saved compaction window is not valid/)).toBeInTheDocument();
      await choose("Conversation compaction", /^Provider default/);
      expect(onAutoCompactTokensChange).toHaveBeenCalledWith(undefined);
    });

    it("offers Cursor no window but still clears an old one", async () => {
      const onAutoCompactTokensChange = vi.fn();
      await open({ provider: "cursor", autoCompactTokens: 200_000, onAutoCompactTokensChange });
      expect(screen.getByText(/Cursor doesn't expose a compaction setting/)).toBeInTheDocument();
      expect(screen.getByText(/Cursor has no compaction setting. Choose Provider default/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Conversation compaction" }));
      expect(screen.getByRole("menuitemradio", { name: /^200K tokens\s*Not available for Cursor/ })).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(screen.getByRole("menuitemradio", { name: /^200K tokens/ }));
      expect(onAutoCompactTokensChange).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("menuitemradio", { name: /^Provider default/ }));
      expect(onAutoCompactTokensChange).toHaveBeenCalledWith(undefined);
    });

    it.each([
      ["in a sub-agent conversation", { mode: "child" as const, onAutoCompactTokensChange: vi.fn() }],
      ["while the host has not wired it", {}],
    ])("is absent %s", async (_label, overrides) => {
      await open(overrides);
      expect(screen.queryByRole("button", { name: "Conversation compaction" })).not.toBeInTheDocument();
    });
  });

  describe("each Mythra worker's window", () => {
    async function configure(target: ChildAgentTarget, overrides: Partial<SubAgentCommandCenterProps> = {}) {
      const handlers = await open({ policy: { ...POLICY, childAgents: { enabled: true, targets: [target] } }, onAutoCompactTokensChange: vi.fn(), ...overrides });
      await userEvent.click(screen.getByRole("button", { name: `Configure ${target.label}` }));
      return handlers;
    }
    const savedTarget = (onChange: ReturnType<typeof vi.fn>) => (onChange.mock.calls.at(-1)![0] as ProjectSubagentSettings).childAgents.targets[0]!;

    it("sets a worker's own window without touching the conversation's", async () => {
      const onAutoCompactTokensChange = vi.fn();
      const { onChange } = await configure(REVIEWER, { onAutoCompactTokensChange });
      await choose("Compaction for reviewer", /^500K tokens/);
      expect(savedTarget(onChange)).toEqual({ ...REVIEWER, autoCompactTokens: 500_000 });
      expect(onAutoCompactTokensChange).not.toHaveBeenCalled();
    });

    it("removes the key for provider default rather than inheriting or storing it empty", async () => {
      const { onChange } = await configure({ ...REVIEWER, autoCompactTokens: 200_000 });
      await choose("Compaction for reviewer", /^Provider default/);
      expect(savedTarget(onChange)).toEqual(REVIEWER);
      expect(savedTarget(onChange)).not.toHaveProperty("autoCompactTokens");
    });

    it("says an unset worker uses its provider default, not the conversation's window", async () => {
      await configure(REVIEWER, { autoCompactTokens: 1_000_000 });
      expect(screen.getByText("Compaction: provider default. It does not inherit this conversation's window.")).toBeInTheDocument();
    });

    it("keeps Cursor windows unavailable while still clearing an old one", async () => {
      const cursor: ChildAgentTarget = { ...REVIEWER, id: "cursor", provider: "cursor", model: "auto", label: "Cursor", autoCompactTokens: 200_000 };
      const { onChange } = await configure(cursor);
      expect(screen.getAllByText(/Cursor has no compaction setting|Cursor does not support a configurable auto-compaction window/).length).toBeGreaterThan(0);
      await userEvent.click(screen.getByRole("button", { name: "Compaction for cursor" }));
      expect(screen.getByRole("menuitemradio", { name: /^500K tokens\s*Not available for Cursor/ })).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(screen.getByRole("menuitemradio", { name: /^Provider default/ }));
      expect(savedTarget(onChange)).not.toHaveProperty("autoCompactTokens");
    });

    it("shows a worker's invalid stored window as invalid", async () => {
      await configure({ ...REVIEWER, autoCompactTokens: 0 });
      expect(screen.getByRole("button", { name: "Compaction for reviewer" })).toHaveTextContent("Invalid saved value");
      expect(screen.getByText(/The saved compaction window is not valid/)).toBeInTheDocument();
    });
  });

  describe("native child windows", () => {
    it("keeps the Claude child window separate from the conversation's", async () => {
      const props = nativeWith("claude", { autoCompactTokens: 1_000_000, nativeOptions: { claude: { model: "claude-haiku-5-5" } }, nativeDefaultModel: "claude-opus-5-5" });
      await open(props);
      await choose("Child model compaction", /^100K tokens/);
      expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: { model: "claude-haiku-5-5", autoCompactTokens: 100_000 } });
      expect(props.onAutoCompactTokensChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("1M tokens");
      expect(screen.queryByText(/so this window applies to it too/)).not.toBeInTheDocument();
    });

    it("blocks a child window without an explicit supported child model, as the runtime does", async () => {
      await open(nativeWith("claude", { nativeOptions: { claude: { autoCompactTokens: 100_000 } }, nativeDefaultModel: "claude-opus-5-5" }));
      expect(screen.getByText(/require an explicit supported child model/)).toBeInTheDocument();
      expect(screen.queryByText(/so they share it/)).not.toBeInTheDocument();
    });

    it("blocks a child window while the parent runs Provider default", async () => {
      await open(nativeWith("claude", { nativeOptions: { claude: { model: "haiku", autoCompactTokens: 100_000 } } }));
      expect(screen.getByText(/require an explicit supported parent model/)).toBeInTheDocument();
    });

    it("blocks a different window when aliases, dates and [1m] resolve to the parent's model", async () => {
      await open(nativeWith("claude", {
        autoCompactTokens: 1_000_000,
        nativeOptions: { claude: { model: "claude-opus-5-5-20260115[1m]", autoCompactTokens: 200_000 } },
        nativeDefaultModel: "opus",
      }));
      expect(screen.getByText(/same model share that model's auto-compact window/)).toBeInTheDocument();
      expect(screen.queryByText(/so they share it/)).not.toBeInTheDocument();
    });

    it("allows an equal window on the same model and says it is shared", async () => {
      await open(nativeWith("claude", { autoCompactTokens: 1_000_000, nativeOptions: { claude: { model: "claude-opus-5", autoCompactTokens: 1_000_000 } }, nativeDefaultModel: "claude-opus-5" }));
      expect(screen.getByText("The parent also runs Opus 5 with the same window, so they share it.")).toBeInTheDocument();
      expect(screen.queryByText(/auto-compact window/)).not.toBeInTheDocument();
    });

    it("keeps independent windows for different models without a warning", async () => {
      await open(nativeWith("claude", { autoCompactTokens: 1_000_000, nativeOptions: { claude: { model: "claude-haiku-5-5", autoCompactTokens: 100_000 } }, nativeDefaultModel: "claude-opus-5-5" }));
      expect(screen.queryByText(/auto-compact window/)).not.toBeInTheDocument();
      expect(screen.queryByText(/so they share it/)).not.toBeInTheDocument();
    });

    it("shows the host's conflict reason once", async () => {
      const reason = "Claude native parent and children using the same model share that model's auto-compact window. Choose a different child model, use the same window, or choose Mythra Code sub-agents.";
      await open(nativeWith("claude", {
        autoCompactTokens: 1_000_000, nativeUnavailableReason: reason,
        nativeOptions: { claude: { model: "claude-opus-5-5", autoCompactTokens: 200_000 } }, nativeDefaultModel: "claude-opus-5-5",
      }));
      expect(screen.getAllByText(reason)).toHaveLength(1);
    });

    it("describes the conversation window without claiming sub-agents set their own", async () => {
      await open(nativeWith("openai", { nativeDefaultModel: "gpt-5.6-luna" }));
      expect(screen.getByText("This conversation's own context window, from the next turn.")).toBeInTheDocument();
      expect(screen.queryByText(/Sub-agents set their own/)).not.toBeInTheDocument();
    });

    it("flags an invalid stored Claude child window", async () => {
      await open(nativeWith("claude", { nativeOptions: { claude: { model: "claude-haiku-5-5", autoCompactTokens: 0 } } }));
      expect(screen.getByRole("button", { name: "Child model compaction" })).toHaveTextContent("Invalid saved value");
      expect(screen.getByText(/The saved compaction window is not valid/)).toBeInTheDocument();
    });

    it("tells Codex users the child shares the parent window and offers no child selector", async () => {
      await open(nativeWith("openai", { autoCompactTokens: 200_000, nativeOptions: { codex: { model: "gpt-5.6-luna" } } }));
      expect(screen.getByText("Codex currently shares the parent compaction setting with native workers. Use Mythra Code for independent worker windows.")).toBeInTheDocument();
      expect(screen.getByText("Parent: 200K tokens")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Child model compaction|Child compaction/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    });

    it("clears a saved Codex child window even with delegation off, keeping model and effort", async () => {
      const props = nativeWith("openai", {
        policy: { ...POLICY, enabled: false },
        nativeOptions: { claude: { model: "claude-haiku-5-5" }, codex: { model: "gpt-5.6-luna", reasoningEffort: "low", autoCompactTokens: 500_000 } },
      });
      await open(props);
      expect(screen.getByText("A saved child window (500K tokens) is not used by Codex.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Reset" }));
      expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: { model: "claude-haiku-5-5" }, codex: { model: "gpt-5.6-luna", reasoningEffort: "low" } });
    });

    it("keeps the Codex reset locked while work runs", async () => {
      const props = nativeWith("openai", { parentActive: true, nativeOptions: { codex: { autoCompactTokens: 500_000 } } });
      await open(props);
      expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    });
  });
});

describe("SubAgentCommandCenter native selection readiness", () => {
  const OLD_HAIKU = "Haiku 5.5 native sub-agents require Claude Code 2.1.293 or newer; update Claude Code and refresh the runtime.";
  const base = (overrides: Partial<SubAgentCommandCenterProps> = {}): Partial<SubAgentCommandCenterProps> => ({
    provider: "claude",
    claudeVersion: "2.1.280",
    onEngineChange: vi.fn(),
    nativeOptions: { claude: { model: "claude-haiku-5-5", autoCompactTokens: 100_000 }, codex: { model: "gpt-5.6-luna" } },
    onNativeOptionsChange: vi.fn(),
    nativeUnavailableReason: OLD_HAIKU,
    nativeSelectionUnavailableReason: null,
    ...overrides,
  });

  it("lets an idle thread with an invalid saved model enter native and clear it", async () => {
    const props = base();
    const { onChange } = await open(props);
    const radio = screen.getByRole("radio", { name: /Native Claude Code/ });
    expect(radio).toBeEnabled();
    expect(screen.getByText(OLD_HAIKU)).toBeInTheDocument();
    await userEvent.click(radio);
    expect(props.onEngineChange).toHaveBeenCalledWith("native");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the full reason visible inside native and lets the model be reset there", async () => {
    const props = base({ engine: "native" });
    await open(props);
    expect(trigger()).toHaveTextContent("Native unavailable");
    expect(screen.getByText(OLD_HAIKU)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Child model" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Provider chooses/ }));
    expect(props.onNativeOptionsChange).toHaveBeenCalledWith({ claude: { autoCompactTokens: 100_000 }, codex: { model: "gpt-5.6-luna" } });
  });

  it("still blocks native selection on a runtime readiness reason", async () => {
    const reason = "Native sub-agents require Claude Code 2.1.267 or newer for inherited permissions; update Claude Code and start the next turn with the refreshed runtime.";
    const props = base({ nativeSelectionUnavailableReason: reason, nativeUnavailableReason: reason });
    await open(props);
    const radio = screen.getByRole("radio", { name: /Native Claude Code/ });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription(reason);
  });

  it("describes the selection reason when it differs from the next-turn reason", async () => {
    const reason = "Sign in to Claude Code to use native sub-agents.";
    await open(base({ nativeSelectionUnavailableReason: reason }));
    const radio = screen.getByRole("radio", { name: /Native Claude Code/ });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription(reason);
    expect(screen.getByText(OLD_HAIKU)).toBeInTheDocument();
  });

  it("falls back to the full reason when the host omits the selection reason", async () => {
    await open(base({ nativeSelectionUnavailableReason: undefined }));
    expect(screen.getByRole("radio", { name: /Native Claude Code/ })).toBeDisabled();
  });

  it("always blocks a provider without native agents", async () => {
    await open(base({ provider: "openrouter", nativeUnavailableReason: null }));
    expect(screen.getByRole("radio", { name: /Provider native/ })).toBeDisabled();
  });

  it("keeps the route locked while work runs even when selection is ready", async () => {
    const props = base({ parentActive: true });
    await open(props);
    expect(screen.getByRole("radio", { name: /Native Claude Code/ })).toBeDisabled();
  });
});

describe("SubAgentCommandCenter native worker rows", () => {
  const claudeAgent = (overrides: Partial<SubAgentWorker> = {}) => worker({
    id: "agent-1",
    kind: "native",
    title: "Scan logs",
    targetId: undefined,
    provider: "claude",
    model: undefined,
    detail: "Claude · provider managed",
    canOpen: false,
    canStop: false,
    ...overrides,
  });
  const nativeProps = { engine: "native" as const, provider: "claude" as const, onEngineChange: vi.fn() };

  it("shows a reported execution model as the model", async () => {
    await open({ ...nativeProps, workers: [claudeAgent({ model: "claude-haiku-5-5", modelSource: "execution", requestedModel: "claude-haiku-5-5" })] });
    expect(screen.getByText("Working · Claude · claude-haiku-5-5")).toBeInTheDocument();
  });

  it("marks a requested model as unconfirmed and never reports an unlabelled one", async () => {
    await open({
      ...nativeProps,
      workers: [
        claudeAgent({ requestedModel: "claude-haiku-5-5" }),
        claudeAgent({ id: "agent-2", title: "Map callers", model: "claude-opus-5" }),
        claudeAgent({ id: "agent-3", title: "Check docs", model: "claude-sonnet-5", modelSource: "configured" }),
      ],
    });
    expect(screen.getByText("Working · Claude · claude-haiku-5-5 requested, unconfirmed")).toBeInTheDocument();
    expect(screen.getByText("Working · Claude · model not reported")).toBeInTheDocument();
    expect(screen.getByText("Working · Claude · claude-sonnet-5 requested, unconfirmed")).toBeInTheDocument();
    expect(screen.queryByText(/claude-opus-5/)).not.toBeInTheDocument();
  });

  it("leads with the reported assignment and reveals assignment, progress and result in details", async () => {
    const task = "Audit the parser\nCheck every branch for unbounded recursion.";
    await open({
      ...nativeProps,
      workers: [claudeAgent({
        status: "completed",
        task,
        model: "claude-haiku-5-5",
        modelSource: "execution",
        requestedModel: "claude-sonnet-5",
        progress: "Read 4 of 6 files",
        result: "Two recursive paths lack a depth guard.",
      })],
    });
    expect(screen.getByText("Audit the parser")).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Details for Audit the parser" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read 4 of 6 files")).not.toBeInTheDocument();
    await userEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    const region = document.getElementById(details.getAttribute("aria-controls")!)!;
    expect(within(region).getByText((_, node) => node?.tagName === "DD" && node.textContent === task)).toBeInTheDocument();
    expect(within(region).getByText("Read 4 of 6 files")).toBeInTheDocument();
    expect(within(region).getByText("Two recursive paths lack a depth guard.")).toBeInTheDocument();
    expect(within(region).getByText(/claude-haiku-5-5 · reported by the run\s+claude-sonnet-5 · requested/)).toBeInTheDocument();
  });

  it("says plainly when only the assignment is known", async () => {
    await open({ ...nativeProps, workers: [claudeAgent({ task: "Summarize the changelog" })] });
    await userEvent.click(screen.getByRole("button", { name: "Details for Summarize the changelog" }));
    expect(screen.getByText("The provider has reported no progress or result yet.")).toBeInTheDocument();
  });

  it("offers no details button when the provider reported nothing beyond the title", async () => {
    await open({ ...nativeProps, workers: [claudeAgent()] });
    expect(screen.queryByRole("button", { name: /^Details for/ })).not.toBeInTheDocument();
  });

  it("does not carry an open details view into a newer activation", async () => {
    const props: SubAgentCommandCenterProps = {
      ...nativeProps,
      policy: POLICY,
      capturedPolicy: null,
      mode: "open",
      readiness: READY,
      scopeLabel: "Chats",
      projectOverride: false,
      onChange: vi.fn(),
      onOpenSettings: vi.fn(),
      workers: [claudeAgent({ status: "completed", activationId: "run-1", task: "Draft notes", result: "Old result" })],
    };
    const { rerender } = render(<SubAgentCommandCenter {...props} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "Details for Draft notes" }));
    expect(screen.getByText("Old result")).toBeInTheDocument();
    rerender(<SubAgentCommandCenter {...props} workers={[claudeAgent({ activationId: "run-2", task: "Draft notes", progress: "Starting over" })]} />);
    expect(screen.getByRole("button", { name: "Details for Draft notes" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();
    expect(screen.queryByText("Starting over")).not.toBeInTheDocument();
  });

  it("counts two working agents and a finished one, keeping Claude agents parent-stop only", async () => {
    const workers = [
      claudeAgent({ task: "Scan logs" }),
      claudeAgent({ id: "agent-2", title: "Map callers" }),
      claudeAgent({ id: "agent-3", title: "Check docs", status: "completed" }),
    ];
    await open({ ...nativeProps, nativeMaxConcurrent: 4, workers, onOpenWorker: vi.fn(), onStopWorker: vi.fn(), onReplaceWorker: vi.fn() });
    expect(trigger()).toHaveTextContent("Native 2/4");
    expect(screen.getByRole("status")).toHaveTextContent("2 working · 1 done");
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Replace / })).not.toBeInTheDocument();
  });

  it("keeps Codex agents individually openable and stoppable but never replaceable", async () => {
    const codexAgent = claudeAgent({ provider: "openai", title: "Port parser", canOpen: true, canStop: true, task: "Port parser to the new AST" });
    await open({ engine: "native", provider: "openai", onEngineChange: vi.fn(), workers: [codexAgent], onOpenWorker: vi.fn(), onStopWorker: vi.fn(), onReplaceWorker: vi.fn() });
    expect(screen.getByRole("button", { name: "Open Port parser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Port parser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details for Port parser to the new AST" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Replace / })).not.toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter viewport fit", () => {
  const originalHeight = window.innerHeight;
  const originalWidth = window.innerWidth;
  let triggerTop = 0;

  function placeTrigger(top: number, viewportHeight: number, zoom?: number, horizontal: { left?: number; viewportWidth?: number; panelWidth?: number } = {}) {
    triggerTop = top;
    const { left = 300, viewportWidth = 1400, panelWidth = 448 } = horizontal;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: viewportHeight });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
    if (zoom) Object.defineProperty(HTMLElement.prototype, "currentCSSZoom", { configurable: true, get: () => zoom });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("subagent-control")) return new DOMRect(0, 0, 0, 0);
      return new DOMRect(left, triggerTop, 120, 32);
    });
    // The panel's used width before any measured limit applies.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("subagent-panel")) return 0;
      const limit = Number.parseFloat(this.style.getPropertyValue("--sa-panel-max-width"));
      return Number.isFinite(limit) ? Math.min(panelWidth, limit) : panelWidth;
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    delete (HTMLElement.prototype as { currentCSSZoom?: number }).currentCSSZoom;
  });

  it("keeps the normal width and left alignment when the panel fits", async () => {
    placeTrigger(700, 900);
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-offset-x")).toBe("0px");
    expect(panel().style.getPropertyValue("--sa-panel-max-width")).toBe("1384px");
  });

  it("slides left just enough to keep the right margin at 125% scale", async () => {
    // Visual right edge allowed: 1050 - 8 = 1042. Layout room from the
    // trigger: (1042 - 700) / 1.25 = 273.6; width 448 (+1 rounding) needs
    // floor(273.6 - 449) = -176 layout px, so the right edge lands at
    // 700 + (449 - 176) * 1.25 = 1041.25.
    placeTrigger(700, 900, 1.25, { left: 700, viewportWidth: 1050 });
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-offset-x")).toBe("-176px");
    expect(panel().style.getPropertyValue("--sa-panel-max-width")).toBe("827px");
  });

  it("narrows to the viewport and keeps the left margin in a narrow window", async () => {
    placeTrigger(700, 900, undefined, { left: 20, viewportWidth: 300 });
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-max-width")).toBe("284px");
    expect(panel().style.getPropertyValue("--sa-panel-offset-x")).toBe("-12px");
  });

  function panel() {
    return screen.getByRole("dialog", { name: "Sub-agent command center" });
  }

  it("limits the panel to the room above a mid-window composer", async () => {
    placeTrigger(420, 900);
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("404px");
    expect(panel()).toHaveAttribute("data-placement", "above");
  });

  it("keeps the usual cap when the window has room to spare", async () => {
    placeTrigger(1200, 1300);
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("560px");
  });

  it("converts the room into layout pixels under app scaling", async () => {
    // 420 - 8 * 1.25 gap - 8 margin = 402 visual px = 321.6 layout px.
    placeTrigger(420, 900, 1.25);
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("321px");
  });

  it("opens below a trigger that sits too close to the top", async () => {
    placeTrigger(60, 900);
    await open();
    expect(panel()).toHaveAttribute("data-placement", "below");
    expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("560px");
  });

  it("re-fits when a composer reflow moves the trigger without any window event", async () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[]; disconnected: boolean }> = [];
    vi.stubGlobal("ResizeObserver", class {
      private record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [], disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {}
      disconnect() { this.record.disconnected = true; }
    });
    try {
      // Opened while scheduled prompts gave the composer extra room above it.
      placeTrigger(700, 900);
      await open();
      expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("560px");
      const control = trigger().closest(".subagent-control")!;
      const observer = observers.at(-1)!;
      // The trigger's whole ancestor chain is watched, never the panel itself.
      expect(observer.targets[0]).toBe(control);
      expect(observer.targets).toContain(control.parentElement);
      expect(observer.targets).not.toContain(document.body);
      expect(observer.targets.some((target) => panel().contains(target))).toBe(false);
      // The prompts leave: an ancestor shrinks and the trigger moves up.
      triggerTop = 300;
      observer.callback([], observer as unknown as ResizeObserver);
      expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("284px");
      await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
      expect(observer.disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows a window resize while open", async () => {
    placeTrigger(700, 900);
    await open();
    expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("560px");
    placeTrigger(300, 500);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(panel().style.getPropertyValue("--sa-panel-max-height")).toBe("284px"));
  });
});
