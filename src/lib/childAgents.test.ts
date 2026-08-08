import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import {
  DEFAULT_CHILD_AGENT_SETTINGS,
  MAX_CHILD_AGENT_TARGETS,
  MAX_SUBAGENT_CONCURRENCY,
  childAgentModel,
  childAgentPolicyFor,
  childAgentPolicyForThread,
  childAgentReasoningEffort,
  childAgentSessionOptions,
  childAgentTargetIssue,
  describeChildAgentRoster,
  isValidChildAgentId,
  normalizeChildAgentId,
  readyChildAgentTargets,
  sanitizeChildAgentIdInput,
  sanitizeChildAgentLinks,
  sanitizeChildAgentPolicies,
  sanitizeChildAgentSettings,
  sanitizeProjectSubagentSettings,
  settingsWithoutChildDelegation,
  settingsWithProjectSubagents,
  uniqueChildAgentId,
  type ChildAgentReadiness,
} from "./childAgents";
import type { ChildAgentTarget } from "../types";

const EVERYTHING_READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  claudeReady: true,
  cursorReady: true,
};

const NOTHING_READY: ChildAgentReadiness = {
  codexRuntimeAvailable: false,
  openAiSignedIn: false,
  openRouterReady: false,
  claudeReady: false,
  cursorReady: false,
};

function target(overrides: Partial<ChildAgentTarget> = {}): ChildAgentTarget {
  return { id: "terra", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high", ...overrides };
}

describe("child agent identities", () => {
  it("normalizes free text into a slug a model can write verbatim", () => {
    expect(normalizeChildAgentId("Grok 4.5 Reviewer!")).toBe("grok-4-5-reviewer");
    expect(normalizeChildAgentId("--leading")).toBe("leading");
    expect(normalizeChildAgentId("###")).toBe("");
  });

  it("keeps a trailing separator while the name is still being typed", () => {
    // Stripping it per keystroke would make "grok fast" impossible to type.
    expect(sanitizeChildAgentIdInput("Grok ")).toBe("grok-");
    expect(sanitizeChildAgentIdInput("Grok Fast")).toBe("grok-fast");
    expect(normalizeChildAgentId(sanitizeChildAgentIdInput("Grok "))).toBe("grok");
  });

  it("accepts only slugs the backend tool enum can carry", () => {
    expect(isValidChildAgentId("terra")).toBe(true);
    expect(isValidChildAgentId("terra_2-b")).toBe(true);
    expect(isValidChildAgentId("-terra")).toBe(false);
    expect(isValidChildAgentId("Terra")).toBe(false);
    expect(isValidChildAgentId("")).toBe(false);
    expect(isValidChildAgentId("a".repeat(41))).toBe(false);
  });

  it("never hands out a name that already exists", () => {
    const existing = [target({ id: "claude" })];
    expect(uniqueChildAgentId("claude", existing)).toBe("claude-2");
    expect(uniqueChildAgentId("fresh", existing)).toBe("fresh");
  });
});

describe("destination models", () => {
  it("falls back to each provider's default when no model is pinned", () => {
    expect(childAgentModel({ provider: "claude", model: "" })).toBe("claude-fable-5");
    expect(childAgentModel({ provider: "cursor", model: "" })).toBe("auto");
    expect(childAgentModel({ provider: "openai", model: "" })).toBe("gpt-5.6-sol");
    // OpenRouter has no default: a fully qualified model is mandatory.
    expect(childAgentModel({ provider: "openrouter", model: "" })).toBe("");
  });

  it("keeps an explicitly chosen model", () => {
    expect(childAgentModel({ provider: "openai", model: " gpt-5.6-terra " })).toBe("gpt-5.6-terra");
  });
});

describe("destination readiness", () => {
  it("accepts a fully configured destination on every provider", () => {
    for (const entry of [
      target({ provider: "openai", model: "gpt-5.6-terra" }),
      target({ provider: "openrouter", model: "x-ai/grok-4.5" }),
      target({ provider: "claude", model: "claude-fable-5" }),
      target({ provider: "cursor", model: "auto" }),
    ]) {
      expect(childAgentTargetIssue(entry, EVERYTHING_READY)).toBeNull();
    }
  });

  it("rejects a model the chosen provider cannot address", () => {
    expect(childAgentTargetIssue(target({ provider: "openrouter", model: "grok-4.5" }), EVERYTHING_READY))
      .toMatch(/fully qualified/);
    expect(childAgentTargetIssue(target({ provider: "claude", model: "gpt-5.6-terra" }), EVERYTHING_READY))
      .toMatch(/Claude model/);
    expect(childAgentTargetIssue(target({ provider: "openai", model: "x-ai/grok-4.5" }), EVERYTHING_READY))
      .toMatch(/not addressable/);
  });

  it("reports the missing sign-in for each provider", () => {
    expect(childAgentTargetIssue(target({ provider: "openai" }), { ...EVERYTHING_READY, openAiSignedIn: false }))
      .toMatch(/Sign in to ChatGPT/);
    expect(childAgentTargetIssue(target({ provider: "openrouter", model: "x-ai/grok-4.5" }), { ...EVERYTHING_READY, openRouterReady: false }))
      .toMatch(/OpenRouter API key/);
    expect(childAgentTargetIssue(target({ provider: "claude", model: "claude-fable-5" }), { ...EVERYTHING_READY, claudeReady: false }))
      .toMatch(/Claude Code/);
    expect(childAgentTargetIssue(target({ provider: "cursor", model: "auto" }), { ...EVERYTHING_READY, cursorReady: false }))
      .toMatch(/Cursor Agent/);
  });

  it("reports the missing runtime before the missing sign-in", () => {
    expect(childAgentTargetIssue(target({ provider: "openai" }), NOTHING_READY)).toMatch(/runtime is not installed/);
  });

  it("keeps only enabled, usable destinations", () => {
    const settings = {
      enabled: true,
      targets: [
        target({ id: "terra" }),
        target({ id: "off", enabled: false }),
        target({ id: "blocked", provider: "cursor", model: "auto" }),
      ],
    };
    const ready = readyChildAgentTargets(settings, { ...EVERYTHING_READY, cursorReady: false });
    expect(ready.map((entry) => entry.id)).toEqual(["terra"]);
  });
});

describe("policy capture", () => {
  const settings = { enabled: true, targets: [target()] };
  const runtime = {
    systemPrompt: "Root instructions",
    projectInstructionsEnabled: false,
    reasoningEffort: "medium" as const,
    serviceTier: "priority",
  };

  it("returns null unless sub-agents and cross-provider delegation are both on", () => {
    const base = { ...runtime, sessionId: "s1", childAgents: settings, subagentMax: 3, permission: "ask" as const, readiness: EVERYTHING_READY };
    expect(childAgentPolicyFor({ ...base, subagentsEnabled: false })).toBeNull();
    expect(childAgentPolicyFor({ ...base, subagentsEnabled: true, childAgents: { ...settings, enabled: false } })).toBeNull();
    expect(childAgentPolicyFor({ ...base, subagentsEnabled: true })).not.toBeNull();
  });

  it("returns null when nothing in the roster is currently usable", () => {
    expect(childAgentPolicyFor({
      sessionId: "s1", childAgents: settings, subagentsEnabled: true, subagentMax: 3,
      permission: "ask", readiness: NOTHING_READY, ...runtime,
    })).toBeNull();
  });

  it("freezes the destinations, the budget, and the inherited permission mode", () => {
    const policy = childAgentPolicyFor({
      sessionId: "s1", rootThreadId: "thread-1", childAgents: settings, subagentsEnabled: true,
      subagentMax: 2, permission: "read-only", readiness: EVERYTHING_READY, now: 1234, ...runtime,
    });
    expect(policy).toEqual({
      sessionId: "s1",
      rootThreadId: "thread-1",
      maxConcurrent: 2,
      permission: "read-only",
      ...runtime,
      targets: [target()],
      capturedAt: 1234,
    });
    // A later edit to the live roster cannot reach the captured copy.
    settings.targets[0].model = "changed";
    expect(policy?.targets[0].model).toBe("gpt-5.6-terra");
    settings.targets[0].model = "gpt-5.6-terra";
  });

  it("clamps the concurrency budget to the supported range", () => {
    const build = (subagentMax: number) => childAgentPolicyFor({
      sessionId: "s1", childAgents: settings, subagentsEnabled: true, subagentMax,
      permission: "ask", readiness: EVERYTHING_READY, ...runtime,
    })?.maxConcurrent;
    expect(build(0)).toBe(1);
    expect(build(99)).toBe(24);
  });

  it("finds the policy a thread already owns and ignores unattached sessions", () => {
    const policies = {
      s1: { ...runtime, sessionId: "s1", rootThreadId: "", maxConcurrent: 1, permission: "ask" as const, targets: [target()], capturedAt: 0 },
      s2: { ...runtime, sessionId: "s2", rootThreadId: "thread-2", maxConcurrent: 1, permission: "ask" as const, targets: [target()], capturedAt: 0 },
    };
    expect(childAgentPolicyForThread(policies, "thread-2")?.sessionId).toBe("s2");
    expect(childAgentPolicyForThread(policies, "thread-1")).toBeUndefined();
    expect(childAgentPolicyForThread(policies, undefined)).toBeUndefined();
  });

  it("sends the backend only the destination shape, with resolved models", () => {
    const policy = childAgentPolicyFor({
      sessionId: "s1", rootThreadId: "thread-1", subagentsEnabled: true, subagentMax: 3,
      permission: "ask", readiness: EVERYTHING_READY, ...runtime,
      childAgents: { enabled: true, targets: [target({ id: "sonnet", provider: "claude", model: "" })] },
    })!;
    expect(childAgentSessionOptions(policy, ["child-1"])).toEqual({
      sessionId: "s1",
      maxConcurrent: 3,
      knownChildren: ["child-1"],
      targets: [{ id: "sonnet", provider: "claude", model: "claude-fable-5", label: "Terra", description: "", reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" }],
    });
  });
});

describe("persistence and migration", () => {
  it("defaults to the pre-1.5 behaviour when nothing was stored", () => {
    expect(DEFAULT_SETTINGS.childAgents).toEqual(DEFAULT_CHILD_AGENT_SETTINGS);
    expect(sanitizeChildAgentSettings(undefined)).toEqual({ enabled: false, targets: [] });
    expect(sanitizeChildAgentSettings("nonsense")).toEqual({ enabled: false, targets: [] });
    expect(sanitizeChildAgentSettings({})).toEqual({ enabled: false, targets: [] });
  });

  it("drops entries that could not be honoured and de-duplicates names", () => {
    const restored = sanitizeChildAgentSettings({
      enabled: true,
      targets: [
        { id: "Terra Two", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "Implementation" },
        { id: "terra-two", provider: "claude", model: "claude-fable-5" },
        { id: "bogus", provider: "gemini", model: "x" },
        { id: "###", provider: "openai" },
        "not an object",
      ],
    });
    expect(restored.enabled).toBe(true);
    expect(restored.targets).toEqual([
      { id: "terra-two", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "Implementation", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" },
    ]);
  });

  it("treats an entry written before the enable flag existed as enabled", () => {
    const restored = sanitizeChildAgentSettings({ enabled: true, targets: [{ id: "terra", provider: "openai" }] });
    expect(restored.targets[0].enabled).toBe(true);
    expect(restored.targets[0].label).toBe("terra");
  });

  it("caps the roster size", () => {
    const targets = Array.from({ length: MAX_CHILD_AGENT_TARGETS + 5 }, (_, index) => ({ id: `agent-${index}`, provider: "openai" }));
    expect(sanitizeChildAgentSettings({ enabled: true, targets }).targets).toHaveLength(MAX_CHILD_AGENT_TARGETS);
  });

  it("restores per-thread policies and repairs impossible values", () => {
    const restored = sanitizeChildAgentPolicies({
      "session-1": { rootThreadId: "thread-1", maxConcurrent: 2.9, permission: "nonsense", capturedAt: "x", targets: [{ id: "terra", provider: "openai" }] },
      "session-2": { rootThreadId: "thread-2", maxConcurrent: 500, permission: "full", targets: [] },
      "": { targets: [{ id: "terra", provider: "openai" }] },
    });
    expect(Object.keys(restored)).toEqual(["session-1", "session-2"]);
    expect(restored["session-1"]).toMatchObject({
      sessionId: "session-1", rootThreadId: "thread-1", maxConcurrent: 2, permission: "ask",
      systemPrompt: "", projectInstructionsEnabled: false, reasoningEffort: "medium", serviceTier: null, capturedAt: 0,
    });
    expect(restored["session-2"]).toMatchObject({
      sessionId: "session-2", rootThreadId: "thread-2", maxConcurrent: MAX_SUBAGENT_CONCURRENCY,
      permission: "full", targets: [],
    });
  });

  it("restores parent/child ownership and drops incomplete records", () => {
    const restored = sanitizeChildAgentLinks({
      "child-1": { rootThreadId: "thread-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "gpt-5.6-terra", title: "Do the thing", createdAt: 7, terminalStatus: "failed" },
      "child-2": { rootThreadId: "", provider: "openai" },
      "child-3": { rootThreadId: "thread-1", provider: "gemini" },
      "child-4": { rootThreadId: "thread-1", sessionId: "", targetId: "terra", provider: "openai" },
      "child-5": { rootThreadId: "thread-1", sessionId: "session-1", targetId: "", provider: "openai" },
    });
    expect(Object.keys(restored)).toEqual(["child-1"]);
    expect(restored["child-1"].sessionId).toBe("session-1");
    expect(restored["child-1"].terminalStatus).toBe("failed");
  });
});

describe("child reasoning policy", () => {
  it("preserves the legacy behavior by inheriting the parent effort", () => {
    expect(childAgentReasoningEffort(target(), "xhigh", "low")).toBe("xhigh");
  });

  it("lets the user fix a level regardless of what the parent requests", () => {
    expect(childAgentReasoningEffort(target({ reasoningMode: "fixed", reasoningEffort: "high" }), "low", "ultra")).toBe("high");
  });

  it("lets the main agent choose without crossing the user's ceiling", () => {
    const controlled = target({ reasoningMode: "agent", reasoningMaxEffort: "high" });
    expect(childAgentReasoningEffort(controlled, "medium", "high")).toBe("high");
    expect(childAgentReasoningEffort(controlled, "ultra", "ultra")).toBe("high");
  });
});

describe("project sub-agent policies", () => {
  it("sanitizes a complete project policy", () => {
    expect(sanitizeProjectSubagentSettings({ enabled: true, maxConcurrent: 100, childAgents: { enabled: true, targets: [target()] } })).toMatchObject({
      enabled: true,
      maxConcurrent: 24,
      childAgents: { enabled: true, targets: [expect.objectContaining({ id: "terra" })] },
    });
  });

  it("overrides only sub-agent fields and otherwise inherits app settings", () => {
    const next = settingsWithProjectSubagents(DEFAULT_SETTINGS, {
      enabled: true,
      maxConcurrent: 7,
      childAgents: { enabled: true, targets: [target({ id: "reviewer" })] },
    });
    expect(next).toMatchObject({ subagentsEnabled: true, subagentMax: 7 });
    expect(next.childAgents.targets[0].id).toBe("reviewer");
    expect(next.provider).toBe(DEFAULT_SETTINGS.provider);
  });
});

describe("child thread delegation clamp", () => {
  it("keeps later child turns at depth one even when the project enables agents", () => {
    const next = settingsWithoutChildDelegation({
      ...DEFAULT_SETTINGS,
      subagentsEnabled: true,
      subagentMax: 9,
      childAgents: { enabled: true, targets: [target()] },
    });

    expect(next.subagentsEnabled).toBe(false);
    expect(next.subagentMax).toBe(1);
    expect(next.childAgents).toEqual({ enabled: false, targets: [] });
  });
});

describe("roster summary", () => {
  it("describes the state the composer shows without exposing the roster", () => {
    const settings = { enabled: true, targets: [target({ id: "a" }), target({ id: "b", provider: "cursor", model: "auto" })] };
    expect(describeChildAgentRoster({ ...settings, enabled: false }, EVERYTHING_READY)).toBe("Cross-provider off");
    expect(describeChildAgentRoster({ enabled: true, targets: [] }, EVERYTHING_READY)).toBe("No destinations");
    expect(describeChildAgentRoster(settings, EVERYTHING_READY)).toBe("2 destinations");
    expect(describeChildAgentRoster(settings, { ...EVERYTHING_READY, cursorReady: false })).toBe("1 of 2 ready");
    expect(describeChildAgentRoster(settings, NOTHING_READY)).toBe("No destination ready");
  });
});
