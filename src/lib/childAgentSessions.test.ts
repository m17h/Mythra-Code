import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  startChildAgentSession: vi.fn(),
  endChildAgentSession: vi.fn(),
}));
vi.mock("./agentBridge", () => bridge);

import { ensureChildAgentBridge, releaseChildAgentSessions, resetChildAgentLaunches } from "./childAgentSessions";
import type { ChildAgentBridgeLaunch } from "./agentBridge";
import type { ChildAgentLink, ChildAgentPolicy, ChildAgentReadiness } from "./childAgents";
import type { ChildAgentSettings, ChildAgentTarget } from "../types";

const READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  claudeReady: true,
  cursorReady: true,
};

const LAUNCH: ChildAgentBridgeLaunch = {
  name: "openkiwi",
  command: "/Applications/OpenKiwi.app/Contents/MacOS/openkiwi",
  args: ["--openkiwi-agent-bridge", "/data/child-agents/abc/session.json"],
  configPath: "/data/child-agents/abc/mcp.json",
  toolNames: ["spawn_agent", "agent_status", "collect_agent", "cancel_agent"],
};

const PROPOSAL_LAUNCH: ChildAgentBridgeLaunch = {
  ...LAUNCH,
  toolNames: ["propose_agent_settings"],
};

const TARGET: ChildAgentTarget = { id: "terra", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" };
const CHILD_AGENTS: ChildAgentSettings = { enabled: true, targets: [TARGET] };

function input(overrides: Partial<Parameters<typeof ensureChildAgentBridge>[0]> = {}) {
  return {
    policies: {},
    links: {},
    settings: { childAgents: CHILD_AGENTS, subagentsEnabled: true, subagentMax: 3 },
    permission: "ask" as const,
    systemPrompt: "Root instructions",
    projectInstructionsEnabled: true,
    reasoningEffort: "high" as const,
    serviceTier: null,
    readiness: READY,
    newSessionId: () => "session-1",
    ...overrides,
  };
}

function policy(overrides: Partial<ChildAgentPolicy> = {}): ChildAgentPolicy {
  return {
    sessionId: "session-existing",
    rootThreadId: "thread-1",
    maxConcurrent: 2,
    permission: "read-only",
    systemPrompt: "Frozen instructions",
    projectInstructionsEnabled: false,
    reasoningEffort: "medium",
    serviceTier: "priority",
    targets: [{ ...TARGET, id: "frozen" }],
    capturedAt: 10,
    ...overrides,
  };
}

function link(overrides: Partial<ChildAgentLink> = {}): ChildAgentLink {
  return {
    childThreadId: "child-1",
    rootThreadId: "thread-1",
    sessionId: "session-existing",
    targetId: "frozen",
    provider: "claude",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    title: "Review",
    createdAt: 1,
    ...overrides,
  };
}

describe("ensureChildAgentBridge", () => {
  beforeEach(() => {
    resetChildAgentLaunches();
    vi.clearAllMocks();
    bridge.startChildAgentSession.mockResolvedValue(LAUNCH);
    bridge.endChildAgentSession.mockResolvedValue(undefined);
  });

  it("registers a session and reports that the policy was captured", async () => {
    const result = await ensureChildAgentBridge(input());
    expect(result).toEqual({ policy: expect.objectContaining({ sessionId: "session-1", rootThreadId: "" }), launch: LAUNCH, captured: true });
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(1);
  });

  it("never gives a child thread a bridge, which is what caps depth at one", async () => {
    const result = await ensureChildAgentBridge(input({
      threadId: "child-1",
      links: { "child-1": link() },
    }));
    expect(result).toBeNull();
    expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
  });

  it("stays out of the way when the feature is off", async () => {
    expect(await ensureChildAgentBridge(input({
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }))).toBeNull();
    expect(await ensureChildAgentBridge(input({
      settings: { childAgents: { ...CHILD_AGENTS, enabled: false }, subagentsEnabled: true, subagentMax: 3 },
    }))).toBeNull();
    expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
  });

  it("keeps only project settings proposals available when delegation is off", async () => {
    bridge.startChildAgentSession.mockResolvedValueOnce(PROPOSAL_LAUNCH);
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      settingsProposalsEnabled: true,
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));

    expect(result).toEqual({
      policy: expect.objectContaining({ sessionId: "session-1", rootThreadId: "thread-1", targets: [] }),
      launch: PROPOSAL_LAUNCH,
      captured: true,
    });
    expect(bridge.startChildAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ targets: [] }),
      [],
    );
  });

  it("upgrades a proposal-only session to the approved live crew when enabled", async () => {
    const proposalOnly = policy({ targets: [] });
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      settingsProposalsEnabled: true,
      policies: { "session-existing": proposalOnly },
    }));

    expect(result?.policy).toEqual(expect.objectContaining({
      sessionId: "session-existing",
      rootThreadId: "thread-1",
      targets: [TARGET],
    }));
    expect(bridge.startChildAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-existing", targets: [TARGET] }),
      [],
    );
  });

  it("attaches delegation to a thread that started without it, bound to that thread", async () => {
    const result = await ensureChildAgentBridge(input({ threadId: "started-earlier" }));
    expect(result).toEqual({
      policy: expect.objectContaining({ sessionId: "session-1", rootThreadId: "started-earlier" }),
      launch: LAUNCH,
      captured: true,
    });
    expect(result?.policy.targets.map((entry) => entry.id)).toEqual(["terra"]);
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(1);
  });

  it("captures the settings live at that moment, not a pre-feature default", async () => {
    const result = await ensureChildAgentBridge(input({
      threadId: "started-earlier",
      permission: "read-only",
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: true, subagentMax: 5 },
    }));
    expect(result?.policy.permission).toBe("read-only");
    expect(result?.policy.maxConcurrent).toBe(5);
  });

  it("re-seeds a mid-conversation session with the children that thread already owns", async () => {
    await ensureChildAgentBridge(input({
      threadId: "thread-1",
      links: { "child-1": link({ sessionId: "session-1" }) },
    }));
    expect(bridge.startChildAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ rootThreadId: "thread-1" }),
      ["child-1"],
    );
  });

  it("reuses the policy a thread froze instead of the live settings", async () => {
    const frozen = policy();
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: { "session-existing": frozen },
      // The user has since replaced the roster and raised the budget.
      settings: { childAgents: { enabled: true, targets: [{ ...TARGET, id: "changed" }] }, subagentsEnabled: true, subagentMax: 9 },
    }));
    expect(result?.policy).toBe(frozen);
    expect(result?.captured).toBe(false);
    expect(result?.policy.targets.map((entry) => entry.id)).toEqual(["frozen"]);
    expect(result?.policy.maxConcurrent).toBe(2);
  });

  it("promotes an explicitly approved pending roster on the next bridge start", async () => {
    const approved = { ...TARGET, id: "approved-reviewer", provider: "claude" as const, model: "claude-fable-5" };
    const staged = policy({
      pendingRecapture: { maxConcurrent: 1, targets: [approved], approvedAt: 99 },
    });
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: { "session-existing": staged },
    }));
    expect(result?.captured).toBe(true);
    expect(result?.policy.pendingRecapture).toBeUndefined();
    expect(result?.policy.maxConcurrent).toBe(1);
    expect(result?.policy.targets.map((entry) => entry.id)).toEqual(["approved-reviewer"]);
    expect(bridge.startChildAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-existing", targets: [approved] }),
      [],
    );
  });

  it("ignores an approved roster that no longer has a usable destination", async () => {
    const staged = policy({
      pendingRecapture: { maxConcurrent: 1, targets: [], approvedAt: 99 },
    });
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: { "session-existing": staged },
    }));
    // Promoting an empty roster would build a policy the backend refuses,
    // turning the next prompt into a failed turn.
    expect(result?.captured).toBe(false);
    expect(result?.policy.maxConcurrent).toBe(2);
    expect(result?.policy.targets.map((entry) => entry.id)).toEqual(["frozen"]);
  });

  it("re-seeds the children a resumed thread already owns", async () => {
    await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: { "session-existing": policy() },
      links: { "child-1": link(), "other": link({ childThreadId: "other", rootThreadId: "thread-9" }) },
    }));
    expect(bridge.startChildAgentSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-existing" }), ["child-1"]);
  });

  it("registers each session once and reuses the cached launch descriptor", async () => {
    const policies = { "session-existing": policy() };
    const first = await ensureChildAgentBridge(input({ threadId: "thread-1", policies }));
    const second = await ensureChildAgentBridge(input({ threadId: "thread-1", policies }));
    expect(first?.launch).toBe(second?.launch);
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(1);
  });
});

describe("ensureChildAgentBridge revoking delegation", () => {
  const policies = () => ({ "session-existing": policy() });

  beforeEach(() => {
    resetChildAgentLaunches();
    vi.clearAllMocks();
    bridge.startChildAgentSession.mockResolvedValue(LAUNCH);
    bridge.endChildAgentSession.mockResolvedValue(undefined);
  });

  it("tears the live session down when sub-agents are switched off", async () => {
    const current = policies();
    await ensureChildAgentBridge(input({ threadId: "thread-1", policies: current }));
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));
    expect(result).toBeNull();
    // Ending the backend session is the revocation: a bridge process a
    // provider CLI is still holding open can no longer reach the app.
    expect(bridge.endChildAgentSession).toHaveBeenCalledExactlyOnceWith("session-existing");
  });

  it("tears the live session down when only cross-provider is switched off", async () => {
    const current = policies();
    await ensureChildAgentBridge(input({ threadId: "thread-1", policies: current }));
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settings: { childAgents: { ...CHILD_AGENTS, enabled: false }, subagentsEnabled: true, subagentMax: 3 },
    }));
    expect(result).toBeNull();
    expect(bridge.endChildAgentSession).toHaveBeenCalledExactlyOnceWith("session-existing");
  });

  it("still revokes a persisted session after renderer memory was lost", async () => {
    const result = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: policies(),
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));
    expect(result).toBeNull();
    expect(bridge.endChildAgentSession).toHaveBeenCalledExactlyOnceWith("session-existing");
  });

  it("brings the very same frozen destinations back when it is switched on again", async () => {
    const current = policies();
    await ensureChildAgentBridge(input({ threadId: "thread-1", policies: current }));
    await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));
    const restored = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      // The roster the user has configured since is still not what comes back.
      settings: { childAgents: { enabled: true, targets: [{ ...TARGET, id: "changed" }] }, subagentsEnabled: true, subagentMax: 9 },
    }));
    expect(restored?.policy.targets.map((entry) => entry.id)).toEqual(["frozen"]);
    expect(restored?.captured).toBe(false);
    // A fresh session, so the revoked token stays dead.
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(2);
  });

  it("keeps a saved project's frozen roster intact across a delegation off→on cycle", async () => {
    const current = policies();
    bridge.startChildAgentSession.mockResolvedValueOnce(PROPOSAL_LAUNCH);
    const proposalsOnly = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settingsProposalsEnabled: true,
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));
    // The emptied policy is for this session only: persisting it would
    // overwrite the frozen roster the off switch promises to preserve.
    expect(proposalsOnly?.captured).toBe(false);
    expect(proposalsOnly?.policy.targets).toEqual([]);
    expect(proposalsOnly?.launch.toolNames).toEqual(["propose_agent_settings"]);

    const restored = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settingsProposalsEnabled: true,
      // The roster the user has configured since is still not what comes back.
      settings: { childAgents: { enabled: true, targets: [{ ...TARGET, id: "changed" }] }, subagentsEnabled: true, subagentMax: 9 },
    }));
    // The proposal-only launch cached while delegation was off is not reused:
    // it has no spawn tool, so the thread would show destinations it cannot
    // reach. A fresh spawn-capable session replaces it.
    expect(restored?.launch.toolNames).toContain("spawn_agent");
    expect(restored?.policy.targets.map((entry) => entry.id)).toEqual(["frozen"]);
    expect(restored?.captured).toBe(false);
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(2);
    expect(bridge.endChildAgentSession).toHaveBeenCalledWith("session-existing");
  });

  it("preserves a pending approved roster through the delegation-off window", async () => {
    const approved = { ...TARGET, id: "approved-reviewer" };
    const current = {
      "session-existing": policy({ pendingRecapture: { maxConcurrent: 1, targets: [approved], approvedAt: 99 } }),
    };
    bridge.startChildAgentSession.mockResolvedValueOnce(PROPOSAL_LAUNCH);
    const proposalsOnly = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settingsProposalsEnabled: true,
      settings: { childAgents: CHILD_AGENTS, subagentsEnabled: false, subagentMax: 3 },
    }));
    // captured stays false, so the caller never persists the emptied policy —
    // the stored record, pendingRecapture included, is exactly what it was.
    expect(proposalsOnly?.captured).toBe(false);
    expect(current["session-existing"].pendingRecapture?.targets.map((entry) => entry.id)).toEqual(["approved-reviewer"]);

    const restored = await ensureChildAgentBridge(input({
      threadId: "thread-1",
      policies: current,
      settingsProposalsEnabled: true,
    }));
    expect(restored?.captured).toBe(true);
    expect(restored?.policy.pendingRecapture).toBeUndefined();
    expect(restored?.policy.targets.map((entry) => entry.id)).toEqual(["approved-reviewer"]);
    expect(restored?.launch.toolNames).toContain("spawn_agent");
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(2);
  });

  it("never hands a child thread a bridge, whatever the settings say", async () => {
    const result = await ensureChildAgentBridge(input({
      threadId: "child-1",
      links: { "child-1": link() },
      policies: { "session-child": policy({ sessionId: "session-child", rootThreadId: "child-1" }) },
    }));
    expect(result).toBeNull();
    expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
    expect(bridge.endChildAgentSession).not.toHaveBeenCalled();
  });
});

describe("releaseChildAgentSessions", () => {
  beforeEach(() => {
    resetChildAgentLaunches();
    vi.clearAllMocks();
    bridge.startChildAgentSession.mockResolvedValue(LAUNCH);
    bridge.endChildAgentSession.mockResolvedValue(undefined);
  });

  it("ends only the sessions belonging to that thread", async () => {
    const policies = {
      "session-existing": policy(),
      "session-other": policy({ sessionId: "session-other", rootThreadId: "thread-2" }),
    };
    expect(await releaseChildAgentSessions(policies, "thread-1")).toEqual(["session-existing"]);
    expect(bridge.endChildAgentSession).toHaveBeenCalledExactlyOnceWith("session-existing");
  });

  it("forces the next turn to register a fresh session", async () => {
    const policies = { "session-existing": policy() };
    await ensureChildAgentBridge(input({ threadId: "thread-1", policies }));
    await releaseChildAgentSessions(policies, "thread-1");
    await ensureChildAgentBridge(input({ threadId: "thread-1", policies }));
    expect(bridge.startChildAgentSession).toHaveBeenCalledTimes(2);
  });

  it("survives a backend that has already forgotten the session", async () => {
    bridge.endChildAgentSession.mockRejectedValue(new Error("gone"));
    await expect(releaseChildAgentSessions({ "session-existing": policy() }, "thread-1")).resolves.toEqual(["session-existing"]);
  });
});
