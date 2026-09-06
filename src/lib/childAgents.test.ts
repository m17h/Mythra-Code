import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import {
  childAgentLinksAfterThreadDeletion,
  DEFAULT_CHILD_AGENT_SETTINGS,
  MAX_CHILD_AGENT_TARGETS,
  MAX_SUBAGENT_CONCURRENCY,
  childAgentModel,
  childAgentPolicyFor,
  childAgentPolicyForThread,
  childAgentReasoningEffort,
  crewSafeConcurrency,
  childAgentSessionOptions,
  childAgentTargetIssue,
  describeChildAgentRoster,
  isValidChildAgentId,
  normalizeChildAgentId,
  projectSubagentSettingsFromApp,
  readyChildAgentTargets,
  safeSubagentConcurrency,
  sanitizeChildAgentIdInput,
  sanitizeChildAgentLinks,
  sanitizeChildAgentPresets,
  sanitizeChildAgentPolicies,
  sanitizeChildAgentSettings,
  sanitizeProjectSubagentSettings,
  settingsWithoutChildDelegation,
  settingsWithProjectSubagents,
  uniqueChildAgentId,
  uniqueChildAgentPresetId,
  type ChildAgentReadiness,
} from "./childAgents";
import type { ChildAgentTarget } from "../types";

const EVERYTHING_READY: ChildAgentReadiness = {
  codexRuntimeAvailable: true,
  openAiSignedIn: true,
  openRouterReady: true,
  lmStudioReady: true,
  claudeReady: true,
  cursorReady: true,
};

const NOTHING_READY: ChildAgentReadiness = {
  codexRuntimeAvailable: false,
  openAiSignedIn: false,
  openRouterReady: false,
  lmStudioReady: false,
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

  it("gives crew presets stable unique ids", () => {
    const policy = { enabled: true, maxConcurrent: 1, childAgents: { enabled: true, targets: [target()] } };
    const existing = [{ id: "review-team", name: "Review team", policy }];
    expect(uniqueChildAgentPresetId("Review team", existing)).toBe("review-team-2");
  });
});

describe("crew presets", () => {
  it("sanitizes complete reusable policies and returns fresh destination objects", () => {
    const source = [{
      id: "Review Team!",
      name: "  Review   team  ",
      policy: { enabled: true, maxConcurrent: 99, childAgents: { enabled: true, targets: [target()] } },
    }];

    const presets = sanitizeChildAgentPresets(source);

    expect(presets).toEqual([{
      id: "review-team",
      name: "Review team",
      policy: expect.objectContaining({
        enabled: true,
        maxConcurrent: 1,
        childAgents: expect.objectContaining({ targets: [expect.objectContaining({ id: "terra" })] }),
      }),
    }]);
    expect(presets[0].policy.childAgents.targets[0]).not.toBe(source[0].policy.childAgents.targets[0]);
  });

  it("drops malformed presets and implicitly enables the roster in older presets", () => {
    const valid = { id: "crew", name: "Crew", policy: { enabled: false, maxConcurrent: 2, childAgents: { enabled: false, targets: [] } } };
    expect(sanitizeChildAgentPresets([valid, { ...valid, name: "Duplicate" }, { id: "bad", name: "Bad" }])).toEqual([
      expect.objectContaining({
        id: "crew",
        name: "Crew",
        policy: expect.objectContaining({ childAgents: expect.objectContaining({ enabled: true }) }),
      }),
    ]);
  });
});

describe("destination models", () => {
  it("falls back to each provider's default when no model is pinned", () => {
    expect(childAgentModel({ provider: "claude", model: "" })).toBe("claude-fable-5");
    expect(childAgentModel({ provider: "cursor", model: "" })).toBe("auto");
    expect(childAgentModel({ provider: "openai", model: "" })).toBe("gpt-5.6-sol");
    // OpenRouter has no default: a fully qualified model is mandatory.
    expect(childAgentModel({ provider: "openrouter", model: "" })).toBe("");
    // LM Studio must use a model actually advertised by the local server.
    expect(childAgentModel({ provider: "lmstudio", model: "" })).toBe("");
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
      target({ provider: "lmstudio", model: "qwen/local-coder" }),
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
    expect(childAgentTargetIssue(target({ provider: "lmstudio", model: "" }), EVERYTHING_READY))
      .toMatch(/Choose a model/);
  });

  it("reports the missing sign-in for each provider", () => {
    expect(childAgentTargetIssue(target({ provider: "openai" }), { ...EVERYTHING_READY, openAiSignedIn: false }))
      .toMatch(/Sign in to ChatGPT/);
    expect(childAgentTargetIssue(target({ provider: "openrouter", model: "x-ai/grok-4.5" }), { ...EVERYTHING_READY, openRouterReady: false }))
      .toMatch(/OpenRouter API key/);
    expect(childAgentTargetIssue(target({ provider: "lmstudio", model: "qwen/local-coder" }), { ...EVERYTHING_READY, lmStudioReady: false }))
      .toMatch(/Start LM Studio/);
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

  it("freezes destinations, caps the budget to the visible crew, and inherits permission", () => {
    const policy = childAgentPolicyFor({
      sessionId: "s1", rootThreadId: "thread-1", childAgents: settings, subagentsEnabled: true,
      subagentMax: 2, permission: "read-only", readiness: EVERYTHING_READY, now: 1234, ...runtime,
    });
    expect(policy).toEqual({
      sessionId: "s1",
      rootThreadId: "thread-1",
      maxConcurrent: 1,
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

  it("clamps the concurrency budget to the supported range and visible crew", () => {
    const build = (subagentMax: number) => childAgentPolicyFor({
      sessionId: "s1", childAgents: settings, subagentsEnabled: true, subagentMax,
      permission: "ask", readiness: EVERYTHING_READY, ...runtime,
    })?.maxConcurrent;
    expect(build(0)).toBe(1);
    expect(build(99)).toBe(1);
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
      maxConcurrent: 1,
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
      sessionId: "session-1", rootThreadId: "thread-1", maxConcurrent: 1, permission: "ask",
      systemPrompt: "", projectInstructionsEnabled: false, reasoningEffort: "medium", serviceTier: null, capturedAt: 0,
    });
    expect(restored["session-2"]).toMatchObject({
      sessionId: "session-2", rootThreadId: "thread-2", maxConcurrent: 1,
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

  it("keeps old settled links because they are durable ownership records", () => {
    const now = Date.now();
    const old = now - 200 * 86_400_000;
    const restored = sanitizeChildAgentLinks({
      "child-old-settled": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "m", title: "Old done", createdAt: old, terminalStatus: "completed" },
      "child-old-open": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "m", title: "Old open", createdAt: old },
      "child-recent-settled": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "m", title: "Recent done", createdAt: now - 86_400_000, terminalStatus: "completed" },
    });
    expect(Object.keys(restored).sort()).toEqual(["child-old-open", "child-old-settled", "child-recent-settled"]);
  });

  it("keeps surviving children classified when their parent is deleted", () => {
    const links = sanitizeChildAgentLinks({
      "child-1": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "gpt-5.6-terra", title: "One", createdAt: 1 },
      "child-2": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "gpt-5.6-terra", title: "Two", createdAt: 2, terminalStatus: "completed" },
    });

    expect(childAgentLinksAfterThreadDeletion(links, "root-1")).toBe(links);
    expect(Object.keys(childAgentLinksAfterThreadDeletion(links, "root-1"))).toEqual(["child-1", "child-2"]);
  });

  it("removes only the classification record of a deleted child", () => {
    const links = sanitizeChildAgentLinks({
      "child-1": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "gpt-5.6-terra", title: "One", createdAt: 1 },
      "child-2": { rootThreadId: "root-1", sessionId: "session-1", targetId: "terra", provider: "openai", model: "gpt-5.6-terra", title: "Two", createdAt: 2 },
    });

    expect(Object.keys(childAgentLinksAfterThreadDeletion(links, "child-1"))).toEqual(["child-2"]);
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

describe("cross-provider ownership records", () => {
  const record = (childThreadId: string, rootThreadId: string) => ({
    childThreadId,
    rootThreadId,
    sessionId: "session-1",
    targetId: "terra",
    provider: "openai",
    model: "gpt-5.6-terra",
    title: "Work",
    createdAt: 1,
  });

  it("drops self and reversed records so a root can never be reclassified", () => {
    expect(sanitizeChildAgentLinks({ a: record("a", "a") })).toEqual({});
    const restored = sanitizeChildAgentLinks({
      child: record("child", "root"),
      root: record("root", "child"),
    });
    expect(Object.keys(restored)).toEqual(["child"]);
  });
});

describe("project sub-agent policies", () => {
  it("sanitizes a complete project policy", () => {
    expect(sanitizeProjectSubagentSettings({ enabled: true, maxConcurrent: 100, childAgents: { enabled: true, targets: [target()] } })).toMatchObject({
      enabled: true,
      maxConcurrent: 1,
      childAgents: { enabled: true, targets: [expect.objectContaining({ id: "terra" })] },
    });
  });

  it("keeps the parallel limit the user chose, however many destinations exist", () => {
    // The roster is a menu; the limit is a budget. A crew of three with a
    // limit of two means the model picks two of the three to run at a time.
    const restored = sanitizeProjectSubagentSettings({
      enabled: true,
      maxConcurrent: 2,
      childAgents: { enabled: true, targets: [target({ id: "one" }), target({ id: "two" }), target({ id: "three" })] },
    });
    expect(restored?.maxConcurrent).toBe(2);

    const single = sanitizeProjectSubagentSettings({
      enabled: true,
      maxConcurrent: 1,
      childAgents: { enabled: true, targets: [target({ id: "one" }), target({ id: "two" }), target({ id: "three" })] },
    });
    expect(single?.maxConcurrent).toBe(1);
  });

  it("carries a chosen limit of two through the app-settings projection", () => {
    expect(projectSubagentSettingsFromApp({
      subagentsEnabled: true,
      subagentMax: 2,
      childAgents: {
        enabled: true,
        targets: [target({ id: "one" }), target({ id: "two" }), target({ id: "three" })],
      },
    }).maxConcurrent).toBe(2);
  });

  it("clamps the parallel limit to 1–24 and fails closed on nonsense", () => {
    expect(safeSubagentConcurrency(2)).toBe(2);
    expect(safeSubagentConcurrency(2.9)).toBe(2);
    expect(safeSubagentConcurrency(0)).toBe(1);
    expect(safeSubagentConcurrency(-4)).toBe(1);
    expect(safeSubagentConcurrency(100)).toBe(MAX_SUBAGENT_CONCURRENCY);
    expect(safeSubagentConcurrency(Number.NaN)).toBe(1);
    expect(safeSubagentConcurrency("lots")).toBe(1);
    expect(safeSubagentConcurrency(undefined)).toBe(1);
  });

  it("never lets the live budget exceed the enabled crew", () => {
    const crew = { enabled: true, targets: [target({ id: "one" }), target({ id: "two" })] };
    expect(crewSafeConcurrency(3, crew)).toBe(2);
    expect(crewSafeConcurrency(1, crew)).toBe(1);
    expect(crewSafeConcurrency(3, { ...crew, targets: [crew.targets[0], { ...crew.targets[1], enabled: false }] })).toBe(1);
    expect(crewSafeConcurrency(3, { enabled: true, targets: [] })).toBe(1);
  });

  it("never lets an unreadable parallel limit escape as NaN", () => {
    expect(projectSubagentSettingsFromApp({
      subagentsEnabled: true,
      subagentMax: Number.NaN,
      childAgents: { enabled: true, targets: [target({ id: "one" }), target({ id: "two" })] },
    }).maxConcurrent).toBe(1);
    expect(sanitizeProjectSubagentSettings({ enabled: true, maxConcurrent: "lots", childAgents: DEFAULT_CHILD_AGENT_SETTINGS })?.maxConcurrent).toBe(1);
  });

  it("freezes the exact limit the user chose into a thread policy", () => {
    const policy = childAgentPolicyFor({
      sessionId: "s1",
      childAgents: { enabled: true, targets: [target({ id: "one" }), target({ id: "two" }), target({ id: "three" })] },
      subagentsEnabled: true,
      subagentMax: 2,
      permission: "ask",
      systemPrompt: "",
      projectInstructionsEnabled: false,
      reasoningEffort: "medium",
      serviceTier: null,
      readiness: EVERYTHING_READY,
    });
    expect(policy?.maxConcurrent).toBe(2);
    expect(policy?.targets).toHaveLength(3);
  });

  it("overrides only sub-agent fields and otherwise inherits app settings", () => {
    const next = settingsWithProjectSubagents(DEFAULT_SETTINGS, {
      enabled: true,
      maxConcurrent: 7,
      childAgents: { enabled: true, targets: [target({ id: "reviewer" })] },
    });
    expect(next).toMatchObject({ subagentsEnabled: true, subagentMax: 1 });
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


it("preserves an explicitly cleared thread roster across storage reloads", () => {
  const restored = sanitizeChildAgentPolicies({ session: {
    rootThreadId: "thread", targets: [],
    pendingRecapture: { targets: [], maxConcurrent: 1, approvedAt: 42 },
  } });
  expect(restored.session.pendingRecapture).toEqual({ targets: [], maxConcurrent: 1, approvedAt: 42 });
  expect(sanitizeChildAgentPolicies({ session: { targets: [], pendingRecapture: {} } }).session.pendingRecapture).toBeUndefined();
});
