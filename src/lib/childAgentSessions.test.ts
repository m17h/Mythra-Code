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

  it("does not retrofit delegation onto a thread that started without it", async () => {
    expect(await ensureChildAgentBridge(input({ threadId: "pre-feature-thread" }))).toBeNull();
    expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
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
