import { beforeEach, describe, expect, it, vi } from "vitest";

const codex = vi.hoisted(() => ({ rpc: vi.fn() }));
const claude = vi.hoisted(() => ({ startClaudeTurn: vi.fn(), saveClaudeTranscript: vi.fn(), deleteClaudeTranscript: vi.fn() }));
const cursor = vi.hoisted(() => ({ startCursorTurn: vi.fn(), saveCursorTranscript: vi.fn(), deleteCursorTranscript: vi.fn() }));
vi.mock("./codex", () => codex);
vi.mock("./claude", () => claude);
vi.mock("./cursor", () => cursor);
const preferences = vi.hoisted(() => ({ scopes: {} as Record<string, Partial<{ enabled: boolean; markdown: string }>> }));
vi.mock("./preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => true,
  loadPreferenceLearning: async () => {},
  getPreferenceLearningScope: (scopeKey: string) => ({ scopeKey, enabled: false, markdown: "", ...preferences.scopes[scopeKey] }),
}));

import { childRunSettings, startChildAgentTurn, type ChildRunContext } from "./childRun";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";
import type { ChildAgentPolicy } from "./childAgents";
import type { ChildAgentTarget, SkillDependencyReport } from "../types";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "./skillDependencies";

const DEPENDENCIES: SkillDependencyReport = {
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [{ nodeId: "policy", channel: "system", name: "policy" }],
  nodes: [{ id: "policy", kind: "skill", name: "policy", path: "/skills/policy.md", status: "loaded", characterCount: 12, depth: 0 }], edges: [], issues: [],
};

const POLICY: ChildAgentPolicy = {
  sessionId: "session-1",
  rootThreadId: "root-1",
  maxConcurrent: 2,
  permission: "read-only",
  systemPrompt: "Be careful.",
  projectInstructionsEnabled: true,
  reasoningEffort: "high",
  serviceTier: "priority",
  targets: [],
  capturedAt: 1,
};

function context(overrides: Partial<ChildRunContext> = {}): ChildRunContext {
  return {
    policy: POLICY,
    executionPath: "/tmp/project/.worktrees/a",
    additionalWorkspaceRoots: ["/tmp/project/.git"],
    systemPrompt: "Be careful.",
    projectInstructionsEnabled: true,
    reasoningEffort: "high",
    serviceTier: "priority",
    serviceName: "Mythra Code",
    resolveSkillPrompt: async (message) => message,
    ...overrides,
  };
}

function target(overrides: Partial<ChildAgentTarget> = {}): ChildAgentTarget {
  return { id: "terra", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high", ...overrides };
}

describe("childRunSettings", () => {
  it("inherits the parent's permission mode and never the model's choice", () => {
    expect(childRunSettings(target(), context()).permission).toBe("read-only");
  });

  it("gives a child no sub-agent budget of its own", () => {
    const run = childRunSettings(target(), context());
    expect(run.subagentsEnabled).toBe(false);
    expect(run.subagentMax).toBe(1);
    expect(run.ultra).toBe(false);
  });

  it("resolves a blank model to the destination provider's default", () => {
    expect(childRunSettings(target({ provider: "claude", model: "" }), context()).model).toBe("claude-fable-5");
  });
});

describe("startChildAgentTurn", () => {
  beforeEach(() => {
    preferences.scopes = {};
    vi.clearAllMocks();
    claude.saveClaudeTranscript.mockResolvedValue(undefined);
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    claude.deleteClaudeTranscript.mockResolvedValue(undefined);
    cursor.deleteCursorTranscript.mockResolvedValue(undefined);
    claude.startClaudeTurn.mockResolvedValue({ turnId: "turn-claude" });
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-cursor", cursorSessionId: "cursor-1" });
    codex.rpc.mockImplementation(async (method: string) => (method === "thread/start"
      ? { thread: { id: "thread-child", name: null, preview: "", cwd: "/tmp", updatedAt: 0, modelProvider: "openai" } }
      : { turn: { id: "turn-codex", items: [] } }));
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("uses current root-project preferences after authored skills for a %s child", async (provider) => {
    preferences.scopes = {
      app: { enabled: true, markdown: "- App style with @trap" },
      "project:root-project": { enabled: true, markdown: "- Root project style" },
      "project:other": { enabled: true, markdown: "- Unrelated project style" },
    };
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Resolved inherited policy" }));
    const ctx = context({ projectId: "root-project", resolveSkillPrompts });
    await startChildAgentTurn(target({ provider }), "Review this", ctx);
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Review this", "Be careful.");
    const instructions = provider === "claude" ? claude.startClaudeTurn.mock.calls[0][0].systemPrompt
      : provider === "cursor" ? cursor.startCursorTurn.mock.calls[0][0].systemPrompt
        : codex.rpc.mock.calls.find(([method]) => method === "turn/start")![1].collaborationMode.settings.developer_instructions;
    expect(instructions).toContain("Resolved inherited policy");
    expect(instructions).toContain("App style with ＠trap");
    expect(instructions).toContain("Root project style");
    expect(instructions).not.toContain("Unrelated project style");
    expect(ctx.systemPrompt).toBe("Be careful.");
    expect(ctx.policy.systemPrompt).toBe("Be careful.");
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("does not start a %s child stopped while skill preparation waits", async (provider) => {
    let finish!: (value: { prompt: string; systemPrompt: string }) => void;
    let cancelled = false;
    const beginCheckpoint = vi.fn();
    const pending = startChildAgentTurn(target({ provider }), "Use @review", context({
      isStartCancelled: () => cancelled,
      beginCheckpoint,
      resolveSkillPrompts: () => new Promise((resolve) => { finish = resolve; }),
    }));
    cancelled = true;
    finish({ prompt: "resolved user skill", systemPrompt: "resolved system skill" });
    await expect(pending).rejects.toThrow(/stopped|cancelled/i);
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(claude.saveClaudeTranscript).not.toHaveBeenCalled();
    expect(cursor.saveCursorTranscript).not.toHaveBeenCalled();
    expect(beginCheckpoint).not.toHaveBeenCalled();
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("does not execute a %s child stopped while its checkpoint waits", async (provider) => {
    let cancelled = false;
    const discardCheckpoint = vi.fn();
    await expect(startChildAgentTurn(target({ provider }), "Use @review", context({
      isStartCancelled: () => cancelled,
      beginCheckpoint: async () => { cancelled = true; }, discardCheckpoint,
    }))).rejects.toThrow(/cancelled/i);
    expect(codex.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(discardCheckpoint).toHaveBeenCalledOnce();
    if (provider === "claude") expect(claude.deleteClaudeTranscript).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    else if (provider === "cursor") expect(cursor.deleteCursorTranscript).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    else expect(codex.rpc).toHaveBeenCalledWith("thread/archive", { threadId: "thread-child" });
  });

  it("archives only its newly created unused child when Stop lands during thread/start", async () => {
    let cancelled = false;
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        cancelled = true;
        return { thread: { id: "unused-child", modelProvider: "openai", cwd: "/tmp", updatedAt: 0 } };
      }
      return {};
    });
    const beginCheckpoint = vi.fn();
    await expect(startChildAgentTurn(target(), "Use @review", context({ isStartCancelled: () => cancelled, beginCheckpoint }))).rejects.toThrow(/cancelled/);
    expect(codex.rpc.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/archive"]);
    expect(codex.rpc).toHaveBeenLastCalledWith("thread/archive", { threadId: "unused-child" });
    expect(beginCheckpoint).not.toHaveBeenCalled();
  });

  it("surfaces failed early cleanup without pretending an unused child was removed", async () => {
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/archive") throw new Error("Archive refused");
      return { thread: { id: "unused-child", modelProvider: "openai", cwd: "/tmp", updatedAt: 0 } };
    });
    await expect(startChildAgentTurn(target(), "Do work", context({ beginCheckpoint: async () => { throw new Error("Checkpoint failed"); } })))
      .rejects.toThrow(/Checkpoint failed.*\n.*unused-child.*Archive refused/);
    expect(codex.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("never archives a thread after an ambiguous model turn/start error", async () => {
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start") throw new Error("Transport closed after send");
      return { thread: { id: "started-child", modelProvider: "openai", cwd: "/tmp", updatedAt: 0 } };
    });
    await expect(startChildAgentTurn(target(), "Do work", context())).rejects.toThrow("Transport closed after send");
    expect(codex.rpc.mock.calls.some(([method]) => method === "thread/archive")).toBe(false);
  });

  it.each(["openrouter", "lmstudio"] as const)("uses the actual reported default model for a blank-model %s child", async (provider) => {
    codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
      ? { thread: { id: "default-child", modelProvider: provider, cwd: "/tmp", updatedAt: 0 }, model: "actual/default-model" }
      : { turn: { id: "turn-default" } });
    const result = await startChildAgentTurn(target({ provider, model: "" }), "Use @review", context());
    const turn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")!;
    expect(turn[1].collaborationMode.settings.model).toBe("actual/default-model");
    expect(result.model).toBe("actual/default-model");
    expect(codex.rpc.mock.calls.some(([method]) => method === "thread/archive")).toBe(false);
  });

  it("cleans up an unused child if turn parameters fail before any model request", async () => {
    await expect(startChildAgentTurn(target({ provider: "lmstudio", model: "" }), "Do work", context()))
      .rejects.toThrow("could not identify this thread's current model");
    expect(codex.rpc.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/archive"]);
    expect(codex.rpc).toHaveBeenLastCalledWith("thread/archive", { threadId: "thread-child" });
  });

  it.each([
    "default",
    "opus[1m]",
    "claude-fable-5-1[1m]",
    "sonnet",
    "haiku",
  ])("starts a Claude catalog model (%s) unchanged, with no delegation bridge or inherited context", async (model) => {
    const result = await startChildAgentTurn(target({ provider: "claude", model }), "Review the diff.", context());

    expect(claude.startClaudeTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: "/tmp/project/.worktrees/a",
      prompt: "Review the diff.",
      // Provider aliases and decorated ids are model identities too. The
      // selected value must reach Claude Code unchanged.
      model,
      permission: "read-only",
      resume: false,
      attachments: [],
      subagentMax: 1,
      customAgents: [],
    }));
    expect(claude.startClaudeTurn.mock.calls[0][0]).not.toHaveProperty("subagentsEnabled");
    expect(claude.startClaudeTurn.mock.calls[0][0]).not.toHaveProperty("childAgentBridgeConfig");
    expect(result.provider).toBe("claude");
    expect(result.thread.modelProvider).toBe("claude");
    // The thread is persisted before the process starts, so a crash still
    // leaves an openable conversation behind.
    expect(claude.saveClaudeTranscript).toHaveBeenCalledWith(expect.objectContaining({ messages: [], activities: [] }));
  });

  it("starts a Cursor child and reports its session for later interruption", async () => {
    const result = await startChildAgentTurn(target({ provider: "cursor", model: "auto" }), "Rename the symbol.", context());

    expect(cursor.startCursorTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: "/tmp/project/.worktrees/a",
      model: "auto",
      permission: "read-only",
      attachments: [],
    }));
    expect(cursor.startCursorTurn.mock.calls[0][0]).not.toHaveProperty("childAgentBridge");
    expect(result.cursorSessionId).toBe("cursor-1");
  });

  it.each([
    { provider: "claude", model: "claude-fable-5" },
    { provider: "cursor", model: "auto" },
    { provider: "openai", model: "gpt-5.6-terra" },
    { provider: "openrouter", model: "x-ai/grok-4.5" },
    { provider: "lmstudio", model: "local/qwen3-coder" },
  ] as const)("delivers resolved Mythra skill context to a $provider child without changing its visible prompt", async ({ provider, model }) => {
    const resolveSkillPrompt = vi.fn(async () => "resolved skill context\n\n@review the diff");
    const result = await startChildAgentTurn(
      target({ provider, model }),
      "@review the diff",
      context({ resolveSkillPrompt, lmStudioBaseUrl: "http://127.0.0.1:1234/v1" }),
    );

    expect(resolveSkillPrompt).toHaveBeenCalledExactlyOnceWith("@review the diff");
    if (provider === "claude") {
      expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "resolved skill context\n\n@review the diff",
      }));
    } else if (provider === "cursor") {
      expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "resolved skill context\n\n@review the diff",
      }));
    } else {
      expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        input: [expect.objectContaining({ text: "resolved skill context\n\n@review the diff" })],
      }));
    }
    expect(result.thread.preview).toBe("@review the diff");
  });

  it.each([
    { provider: "claude", model: "claude-fable-5" },
    { provider: "cursor", model: "auto" },
    { provider: "openai", model: "gpt-5.6-terra" },
    { provider: "openrouter", model: "x-ai/grok-4.5" },
    { provider: "lmstudio", model: "local/qwen3-coder" },
  ] as const)("resolves authored system skills in the $provider system channel before the child starts", async ({ provider, model }) => {
    const skillReferences = [{ start: 0, end: 7, name: "review", path: "/skills/review.md" }];
    const resolveSkillPrompts = vi.fn(async () => ({ prompt: "resolved user skill", systemPrompt: "resolved system skill", skillReferences, skillsFolder: "/skills", skillDependencies: DEPENDENCIES }));
    const result = await startChildAgentTurn(
      target({ provider, model }),
      "@review the diff",
      context({ systemPrompt: "Always use @careful", resolveSkillPrompts }),
    );

    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("@review the diff", "Always use @careful");
    if (provider === "claude" || provider === "cursor") {
      const start = provider === "claude" ? claude.startClaudeTurn : cursor.startCursorTurn;
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: "resolved user skill", systemPrompt: expect.stringContaining("resolved system skill") }));
      expect(start.mock.calls[0][0].prompt).not.toContain("resolved system skill");
    } else {
      expect(codex.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({ baseInstructions: "" }));
      expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [expect.objectContaining({ text: "resolved user skill" })] }));
      expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ collaborationMode: expect.objectContaining({ settings: expect.objectContaining({ developer_instructions: expect.stringContaining("resolved system skill") }) }) }));
    }
    expect(result.thread.preview).toBe("@review the diff");
    expect(result.skillReferences).toEqual(skillReferences);
    expect(result.skillsFolder).toBe("/skills");
    expect(result.skillDependencies).toEqual(DEPENDENCIES);
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("blocks a %s child graph failure before any provider or checkpoint starts", async (provider) => {
    const beginCheckpoint = vi.fn();
    const error = new SkillDependencyError({ ...DEPENDENCIES, issues: [{ code: "missing-document", message: "Missing guide", chain: ["policy", "guide.md"] }] });
    await expect(startChildAgentTurn(target({ provider }), "Continue", context({
      resolveSkillPrompts: async () => { throw error; }, beginCheckpoint,
    }))).rejects.toBe(error);
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(beginCheckpoint).not.toHaveBeenCalled();
  });

  it("does not create a child or checkpoint when a system skill fails resolution", async () => {
    const beginCheckpoint = vi.fn();
    await expect(startChildAgentTurn(target(), "Do the work", context({
      resolveSkillPrompts: async () => { throw new Error("system skill missing"); }, beginCheckpoint,
    }))).rejects.toThrow("system skill missing");
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(beginCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", "gpt-5.6-terra", undefined],
    ["openrouter", "x-ai/grok-4.5", "openrouter"],
    ["lmstudio", "local/qwen3-coder", LM_STUDIO_RUNTIME_PROVIDER_ID],
  ])("starts an app-server %s child in the parent's folder", async (provider, model, modelProvider) => {
    const result = await startChildAgentTurn(
      target({ provider: provider as ChildAgentTarget["provider"], model }),
      "Do the work.",
      context({ modelContextWindow: 256_000, lmStudioBaseUrl: "http://127.0.0.1:1234/v1" }),
    );

    const [, startParams] = codex.rpc.mock.calls[0];
    expect(startParams).toMatchObject({
      cwd: "/tmp/project/.worktrees/a",
      runtimeWorkspaceRoots: ["/tmp/project/.worktrees/a", "/tmp/project/.git"],
      sandbox: "read-only",
      model,
      config: { agents: { max_threads: 1, max_depth: 1 }, features: { multi_agent: false } },
    });
    expect(startParams.modelProvider).toBe(modelProvider);
    if (provider === "lmstudio") {
      expect(startParams.config).toMatchObject({
        model_context_window: 256_000,
        model_providers: { [LM_STUDIO_RUNTIME_PROVIDER_ID]: { base_url: "http://127.0.0.1:1234/v1", wire_api: "responses" } },
      });
    }
    expect(startParams.config).not.toHaveProperty("mcp_servers");

    const [turnMethod, turnParams] = codex.rpc.mock.calls[1];
    expect(turnMethod).toBe("turn/start");
    expect(turnParams).toMatchObject({ threadId: "thread-child", input: [expect.objectContaining({ text: "Do the work." })] });
    expect(result.thread.id).toBe("thread-child");
    expect(result.turnId).toBe("turn-codex");
  });

  it("never starts a turn when the child's thread could not be created", async () => {
    codex.rpc.mockRejectedValueOnce(new Error("runtime unavailable"));
    await expect(startChildAgentTurn(target(), "Do the work.", context())).rejects.toThrow(/runtime unavailable/);
    expect(codex.rpc).toHaveBeenCalledTimes(1);
  });
});
