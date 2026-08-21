import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubAgentCommandCenter, type SubAgentCommandCenterProps } from "./SubAgentCommandCenter";
import type { ChildAgentPolicy, ChildAgentReadiness } from "../lib/childAgents";
import type { SubAgentWorker } from "../lib/subAgentActivity";
import type { ChildAgentTarget, ProjectSubagentSettings } from "../types";

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
  return screen.getByRole("button", { name: /Agents/ });
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
    expect(trigger()).toHaveTextContent("Agents: 1");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("says agents are off when delegation is disabled", () => {
    view({ policy: { ...POLICY, enabled: false, childAgents: { enabled: false, targets: [] } } });
    expect(trigger()).toHaveTextContent("Agents off");
    expect(trigger()).not.toHaveClass("enabled");
  });

  it("stays neutral when an old cross-provider setting remains on", () => {
    view({ policy: { ...POLICY, enabled: false, childAgents: { enabled: true, targets: [REVIEWER] } } });
    expect(trigger()).toHaveTextContent("Agents off");
    expect(trigger()).not.toHaveClass("enabled");
  });

  it("shows a live count and an announced status while children work", () => {
    view({ workers: [worker(), worker({ id: "child-2", status: "completed" })] });
    expect(trigger()).toHaveTextContent("Agents 1/1");
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
    await userEvent.click(screen.getByText("Sub-agent crew"));
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
    expect(screen.getByText(/chosen from 3 destinations/)).toBeInTheDocument();
  });

  it("toggles cross-provider delegation", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Allow cross-provider sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ enabled: false }),
    }));
  });

  it("cannot enable cross-provider delegation while delegation itself is off", async () => {
    await open({ policy: { ...POLICY, enabled: false } });
    expect(screen.getByRole("switch", { name: "Allow cross-provider sub-agents" })).toBeDisabled();
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
    await userEvent.click(screen.getByRole("button", { name: "Add OpenRouter destination" }));
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      maxConcurrent: 1,
      childAgents: {
        enabled: true,
        targets: [expect.objectContaining({ id: "openrouter", provider: "openrouter", label: "OpenRouter", enabled: true })],
      },
    });
  });

  it("gives a second destination on the same provider a unique name", async () => {
    const { onChange } = await open({
      policy: { ...POLICY, childAgents: { enabled: true, targets: [{ ...REVIEWER, id: "cursor", provider: "cursor" }] } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Add Cursor destination" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Add Cursor destination" }));
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

  it("still allows a lower limit when cross-provider is switched off", async () => {
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

  it("labels the primary switch as sub-agents", async () => {
    await open();
    expect(screen.getByText("Sub-agents")).toBeInTheDocument();
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
    expect(screen.getByText("Main agent decides · up to high")).toBeInTheDocument();
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

  it("explains why an unusable destination will not be offered to the model", async () => {
    await open({ readiness: { ...READY, claudeReady: false } });
    expect(screen.getByText(/Install and sign in to Claude Code first/)).toBeInTheDocument();
    expect(screen.getByText("0 of 1 destination ready")).toBeInTheDocument();
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
    expect(screen.getByText("No destinations switched on.")).toBeInTheDocument();
  });

  it("invites a first destination when the roster is empty", async () => {
    await open({ policy: { ...POLICY, childAgents: { enabled: true, targets: [] } } });
    expect(screen.getByText(/No destinations yet/)).toBeInTheDocument();
  });
});

describe("SubAgentCommandCenter on a thread that froze a roster", () => {
  it("shows the captured destinations read-only and never offers to change them", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED });
    expect(screen.getByText("Destinations locked for this thread")).toBeInTheDocument();
    expect(screen.getByText(/froze its destinations on the first run where cross-provider sub-agents were available/)).toBeInTheDocument();
    expect(screen.getByText("Frozen reviewer")).toBeInTheDocument();
    expect(screen.getByText("Captured on the first run with cross-provider sub-agents.")).toBeInTheDocument();

    expect(screen.queryByRole("switch", { name: /^Enable / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });

  it("shows the captured limit rather than the limit configured since", async () => {
    await open({ mode: "captured", capturedPolicy: CAPTURED });
    expect(trigger()).toHaveTextContent("Agents: 2");
  });

  it("keeps the switches live so a frozen thread can always be switched off", async () => {
    const { onChange } = await open({ mode: "captured", capturedPolicy: CAPTURED });
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));

    onChange.mockClear();
    await userEvent.click(screen.getByRole("switch", { name: "Allow cross-provider sub-agents" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      childAgents: expect.objectContaining({ enabled: false }),
    }));
  });

  it("never claims a frozen thread still has agents once they are switched off", async () => {
    await open({
      mode: "captured",
      capturedPolicy: CAPTURED,
      policy: { ...POLICY, enabled: false, childAgents: { enabled: false, targets: [] } },
    });
    expect(trigger()).toHaveTextContent("Agents off");
    expect(screen.getByText("No sub-agent tools are exposed.")).toBeInTheDocument();
    expect(screen.getByText("Children stay inside this thread's own provider.")).toBeInTheDocument();
  });

  it("stops promising cross-provider reach when only cross-provider is switched off", async () => {
    await open({
      mode: "captured",
      capturedPolicy: CAPTURED,
      policy: { ...POLICY, enabled: true, childAgents: { enabled: false, targets: [REVIEWER] } },
    });
    expect(trigger()).toHaveTextContent("Agents: 2");
    expect(trigger()).not.toHaveTextContent("↗");
    expect(screen.getByText("Children stay inside this thread's own provider.")).toBeInTheDocument();
    // The frozen roster is still what would come back, so it stays on show.
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
    await userEvent.click(screen.getByRole("button", { name: "Add Claude destination" }));
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
    expect(trigger()).toHaveTextContent("Agents: 1 ↗");
  });
});

describe("SubAgentCommandCenter inside a sub-agent conversation", () => {
  const child = { mode: "child" as const, capturedPolicy: null, policy: { enabled: false, maxConcurrent: 1, childAgents: { enabled: false, targets: [] } } };

  it("reports delegation as off and offers no way to turn it on", async () => {
    await open(child);
    expect(trigger()).toHaveTextContent("Agents off");
    expect(screen.getByText(/never starts sub-agents of its own/)).toBeInTheDocument();
    expect(screen.getAllByText("Off")).toHaveLength(2);
    expect(screen.queryByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow cross-provider sub-agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
  });

  it("never shows a roster it could delegate to, whatever is configured globally", async () => {
    await open({ ...child, policy: POLICY });
    expect(screen.getByText("A sub-agent has no destinations of its own.")).toBeInTheDocument();
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
    expect(rows[2]).toHaveTextContent("Completed · Same provider as this thread");
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
    expect(screen.getByRole("group", { name: "Replacement destination for Review the diff" })).toBeInTheDocument();
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
