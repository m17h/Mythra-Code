import { beforeEach, describe, expect, it, vi } from "vitest";

const codex = vi.hoisted(() => ({ rpc: vi.fn() }));
const claude = vi.hoisted(() => ({ startClaudeTurn: vi.fn(), saveClaudeTranscript: vi.fn() }));
const cursor = vi.hoisted(() => ({ startCursorTurn: vi.fn(), saveCursorTranscript: vi.fn() }));
vi.mock("./codex", () => codex);
vi.mock("./claude", () => claude);
vi.mock("./cursor", () => cursor);

import { childRunSettings, startChildAgentTurn, type ChildRunContext } from "./childRun";
import { LM_STUDIO_CODEX_PROVIDER_ID } from "./appConfig";
import type { ChildAgentPolicy } from "./childAgents";
import type { ChildAgentTarget } from "../types";

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
    serviceName: "OpenKiwi",
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
    vi.clearAllMocks();
    claude.saveClaudeTranscript.mockResolvedValue(undefined);
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    claude.startClaudeTurn.mockResolvedValue({ turnId: "turn-claude" });
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-cursor", cursorSessionId: "cursor-1" });
    codex.rpc.mockImplementation(async (method: string) => (method === "thread/start"
      ? { thread: { id: "thread-child", name: null, preview: "", cwd: "/tmp", updatedAt: 0, modelProvider: "openai" } }
      : { turn: { id: "turn-codex", items: [] } }));
  });

  it("starts a Claude child with no delegation bridge and no inherited context", async () => {
    const result = await startChildAgentTurn(target({ provider: "claude", model: "claude-fable-5" }), "Review the diff.", context());

    expect(claude.startClaudeTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: "/tmp/project/.worktrees/a",
      prompt: "Review the diff.",
      model: "claude-fable-5",
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
    ["openai", "gpt-5.6-terra", undefined],
    ["openrouter", "x-ai/grok-4.5", "openrouter"],
    ["lmstudio", "qwen/local-coder", LM_STUDIO_CODEX_PROVIDER_ID],
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
        model_providers: { [LM_STUDIO_CODEX_PROVIDER_ID]: { base_url: "http://127.0.0.1:1234/v1", wire_api: "responses" } },
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
