import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { ChildAgentLink, ChildAgentPolicy } from "../lib/childAgents";
import type { ChildAgentRequest } from "../lib/agentBridge";
import type { ChildAgentTarget, Thread } from "../types";

const bridge = vi.hoisted(() => ({
  onChildAgentRequest: vi.fn(),
  respondToChildAgentRequest: vi.fn(),
  reportChildAgentFinished: vi.fn(),
}));
const childRun = vi.hoisted(() => ({ startChildAgentTurn: vi.fn() }));
const codex = vi.hoisted(() => ({ rpc: vi.fn(), auditEvent: vi.fn() }));
const claude = vi.hoisted(() => ({ interruptClaudeTurn: vi.fn(), killClaudeTurn: vi.fn(), loadClaudeTranscript: vi.fn() }));
const cursor = vi.hoisted(() => ({ interruptCursorTurn: vi.fn(), killCursorTurn: vi.fn(), loadCursorTranscript: vi.fn() }));

vi.mock("../lib/agentBridge", () => bridge);
vi.mock("../lib/childRun", () => childRun);
vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", () => claude);
vi.mock("../lib/cursor", () => cursor);

import { activeChildThreadIds, childLifecycle, childLifecycleForLink, useChildAgents, waitForChildTerminalStatus, type ChildAgentContext } from "./useChildAgents";

const TARGETS: ChildAgentTarget[] = [
  { id: "terra", provider: "openai", model: "gpt-5.6-terra", label: "Terra", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" },
  { id: "reviewer", provider: "claude", model: "claude-fable-5", label: "Reviewer", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" },
  { id: "grok", provider: "openrouter", model: "x-ai/grok-4.5", label: "Grok", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" },
  { id: "fast", provider: "cursor", model: "auto", label: "Fast", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" },
];

const POLICY: ChildAgentPolicy = {
  sessionId: "session-1",
  rootThreadId: "root-1",
  maxConcurrent: 2,
  permission: "read-only",
  systemPrompt: "Be careful.",
  providerSystemPrompts: { openai: "Global then Codex", claude: "Global then Claude" },
  projectInstructionsEnabled: false,
  reasoningEffort: "medium",
  serviceTier: null,
  targets: TARGETS,
  capturedAt: 1,
};

function childThread(id: string, provider: string): Thread {
  return { id, name: null, preview: "child", cwd: "/tmp/project/.worktrees/a", updatedAt: 1, modelProvider: provider };
}

function link(overrides: Partial<ChildAgentLink> = {}): ChildAgentLink {
  return {
    childThreadId: "child-1",
    rootThreadId: "root-1",
    sessionId: "session-1",
    targetId: "terra",
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    title: "Delegated task",
    createdAt: 1,
    ...overrides,
  };
}

let persistedLinks: Record<string, ChildAgentLink> = {};

function context(overrides: Partial<ChildAgentContext> = {}): ChildAgentContext {
  return {
    policies: { "session-1": POLICY },
    links: persistedLinks,
    persistChildAgentLinks: ((update) => {
      persistedLinks = typeof update === "function" ? update(persistedLinks) : update;
    }) as ChildAgentContext["persistChildAgentLinks"],
    openRouterModels: [{ id: "x-ai/grok-4.5", name: "Grok", context_length: 256_000 }],
    readiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: true, claudeReady: true, cursorReady: true },
    projectPathForThread: () => "/tmp/project",
    executionPathFor: () => "/tmp/project/.worktrees/a",
    isolationGitDirFor: () => "/tmp/project/.git",
    serviceNameFor: () => "Mythra Code",
    bindThreadToProject: vi.fn(),
    beginRunCheckpoint: vi.fn(async () => undefined),
    discardRunCheckpoint: vi.fn(),
    rememberThread: vi.fn(),
    persistThreadModel: vi.fn(),
    persistThreadReasoning: vi.fn(),
    setThreads: vi.fn(),
    cursorSessionIdsRef: { current: {} },
    scheduleClaudeThreadSave: vi.fn(),
    scheduleCursorThreadSave: vi.fn(),
    projectSubagentSettingsForThread: () => ({ enabled: true, maxConcurrent: 2, childAgents: { enabled: true, targets: TARGETS } }),
    applyProjectSubagentSettings: vi.fn(),
    ...overrides,
  };
}

function request(overrides: Partial<ChildAgentRequest> = {}): ChildAgentRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    tool: "spawn_agent",
    arguments: { target: "terra", prompt: "Refactor the parser." },
    ...overrides,
  };
}

/** Render the hook and return the handler the backend would call into. */
async function mount(overrides: Partial<ChildAgentContext> = {}) {
  let deliver: ((request: ChildAgentRequest) => void) | undefined;
  bridge.onChildAgentRequest.mockImplementation(async (handler: (request: ChildAgentRequest) => void) => {
    deliver = handler;
    return () => {};
  });
  const view = renderHook((props: Partial<ChildAgentContext>) => useChildAgents(context(props)), { initialProps: overrides });
  await act(async () => { await Promise.resolve(); });
  return {
    ...view,
    send: async (payload: ChildAgentRequest) => {
      await act(async () => {
        deliver?.(payload);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function lastResponse() {
  return bridge.respondToChildAgentRequest.mock.calls.at(-1);
}

describe("useChildAgents", () => {
  beforeEach(() => {
    resetTaskStore();
    persistedLinks = {};
    vi.clearAllMocks();
    bridge.respondToChildAgentRequest.mockResolvedValue(undefined);
    bridge.reportChildAgentFinished.mockResolvedValue(undefined);
    claude.interruptClaudeTurn.mockResolvedValue(undefined);
    claude.killClaudeTurn.mockResolvedValue(undefined);
    claude.loadClaudeTranscript.mockResolvedValue(null);
    cursor.interruptCursorTurn.mockResolvedValue(undefined);
    cursor.killCursorTurn.mockResolvedValue(undefined);
    cursor.loadCursorTranscript.mockResolvedValue(null);
    codex.rpc.mockResolvedValue({});
    childRun.startChildAgentTurn.mockImplementation(async (target: ChildAgentTarget) => ({
      thread: childThread(`child-${target.id}`, target.provider),
      turnId: `turn-${target.id}`,
      provider: target.provider,
      model: target.model,
      ...(target.provider === "cursor" ? { cursorSessionId: "cursor-session" } : {}),
    }));
  });

  describe("routing", () => {
    it("keeps one bridge listener while live child state rerenders", async () => {
      const view = await mount();
      expect(bridge.onChildAgentRequest).toHaveBeenCalledTimes(1);

      await view.rerender({ links: { "child-1": link() } });
      await view.rerender({ links: { "child-1": link({ terminalStatus: "completed" }) } });

      expect(bridge.onChildAgentRequest).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["terra", "openai", "gpt-5.6-terra"],
      ["reviewer", "claude", "claude-fable-5"],
      ["grok", "openrouter", "x-ai/grok-4.5"],
      ["fast", "cursor", "auto"],
    ])("starts a %s child on the %s runtime", async (targetId, provider, model) => {
      const view = await mount();
      await view.send(request({ arguments: { target: targetId, prompt: "Do the work." } }));

      const [target, prompt, runContext] = childRun.startChildAgentTurn.mock.calls[0];
      expect(target.id).toBe(targetId);
      expect(target.provider).toBe(provider);
      expect(prompt).toBe("Do the work.");
      expect(lastResponse()).toEqual(["request-1", expect.objectContaining({
        childId: `child-${targetId}`,
        target: targetId,
        provider,
        model,
        status: "running",
      })]);
      // The child inherits the root thread's execution folder and permission
      // mode, and is given no conversation of its own to inherit.
      expect(runContext.executionPath).toBe("/tmp/project/.worktrees/a");
      expect(runContext.additionalWorkspaceRoots).toEqual(["/tmp/project/.git"]);
      expect(runContext.policy.permission).toBe("read-only");
    });

    it("passes the OpenRouter context window through for an OpenRouter destination", async () => {
      const view = await mount();
      await view.send(request({ arguments: { target: "grok", prompt: "Do the work." } }));
      expect(childRun.startChildAgentTurn.mock.calls[0][2].modelContextWindow).toBe(256_000);
    });

    it("uses an agent-selected reasoning level within the frozen user ceiling", async () => {
      const policy = {
        ...POLICY,
        targets: [{ ...TARGETS[0], reasoningMode: "agent" as const, reasoningMaxEffort: "high" as const }],
      };
      const view = await mount({ policies: { "session-1": policy } });
      await view.send(request({ arguments: { target: "terra", prompt: "Do the work.", reasoningEffort: "high" } }));

      expect(childRun.startChildAgentTurn.mock.calls[0][2].reasoningEffort).toBe("high");
      expect(persistedLinks["child-terra"].reasoningEffort).toBe("high");
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({ reasoningEffort: "high" }));
    });

    it("records ownership, timeline visibility, and the child's own task", async () => {
      const ctx = context();
      const view = await mount(ctx);
      await view.send(request());

      expect(persistedLinks["child-terra"]).toMatchObject({
        rootThreadId: "root-1",
        sessionId: "session-1",
        targetId: "terra",
        provider: "openai",
      });
      const store = useTaskStore.getState();
      expect(store.tasks["root-1"].agents).toEqual([expect.objectContaining({ id: "child-terra", status: "inProgress" })]);
      expect(store.tasks["root-1"].activities).toContainEqual(expect.objectContaining({
        id: "child-agent-child-terra",
        kind: "agent",
        status: "inProgress",
        agent: {
          action: "spawn",
          provider: "openai",
          model: "gpt-5.6-terra",
          task: "Refactor the parser.",
          count: 1,
          threadIds: ["child-terra"],
        },
      }));
      expect(store.statuses["child-terra"]).toBe("running");
      expect(store.tasks["child-terra"].workspacePath).toBe("/tmp/project/.worktrees/a");
      expect(store.tasks["child-terra"].messages[0]).toMatchObject({ role: "user", text: "Refactor the parser." });
      expect(ctx.persistThreadModel).toHaveBeenCalledWith("child-terra", "gpt-5.6-terra");
      expect(ctx.persistThreadReasoning).toHaveBeenCalledWith("child-terra", { reasoningEffort: "medium", ultra: false });
      expect(childRun.startChildAgentTurn.mock.calls[0][2].systemPrompt).toBe("Global then Codex");
    });

    it("stores model-supplied sub-agent titles as plain text", async () => {
      const view = await mount();
      await view.send(request({
        arguments: {
          target: "terra",
          prompt: "Audit the story and content systems.",
          title: "Story &amp; content audit",
        },
      }));

      expect(persistedLinks["child-terra"].title).toBe("Story & content audit");
      expect(useTaskStore.getState().tasks["root-1"].agents[0].prompt).toBe("Story & content audit");
      expect(useTaskStore.getState().tasks["root-1"].activities[0].detail).toContain("Story & content audit");
    });

    it("does not resurrect a child whose completion beat the start response", async () => {
      childRun.startChildAgentTurn.mockImplementationOnce(async (target: ChildAgentTarget) => {
        useTaskStore.getState().ensureTask("child-terra", "/tmp/project/.worktrees/a");
        useTaskStore.getState().completeMessage("child-terra", { id: "done", role: "assistant", text: "Already done." });
        useTaskStore.getState().completeTurn("child-terra", "turn-terra", "completed");
        return { thread: childThread("child-terra", target.provider), turnId: "turn-terra", provider: target.provider, model: target.model };
      });
      const view = await mount();
      await view.send(request());
      expect(useTaskStore.getState().statuses["child-terra"]).toBe("completed");
      expect(useTaskStore.getState().tasks["child-terra"].activeTurnId).toBeUndefined();
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({ status: "completed" }));
    });

    it("remembers the Cursor session so a child can be interrupted later", async () => {
      const ctx = context();
      bridge.onChildAgentRequest.mockImplementation(async (handler: (request: ChildAgentRequest) => void) => {
        queueMicrotask(() => handler(request({ arguments: { target: "fast", prompt: "Go." } })));
        return () => {};
      });
      renderHook(() => useChildAgents(ctx));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(ctx.cursorSessionIdsRef.current["child-fast"]).toBe("cursor-session");
    });

    it("queues a project-scoped settings proposal and applies it only after approval", async () => {
      const applyProjectSubagentSettings = vi.fn();
      const view = await mount({ applyProjectSubagentSettings });
      await view.send(request({
        tool: "propose_agent_settings",
        arguments: { reason: "Use one reviewer", maxConcurrent: 1 },
      }));

      const approval = useTaskStore.getState().tasks["root-1"].approvals[0];
      expect(approval).toMatchObject({ method: "openkiwi/subagents/change", threadId: "root-1" });
      expect(lastResponse()?.[1]).toMatchObject({ status: "awaiting_user", approved: false });
      expect(applyProjectSubagentSettings).not.toHaveBeenCalled();

      await act(async () => {
        await view.result.current.respondToSettingsProposal(approval, { decision: "accept" });
      });
      expect(applyProjectSubagentSettings).toHaveBeenCalledWith(
        "root-1",
        // The roster is a menu and the limit is a budget: keeping four
        // destinations available while allowing one at a time is a legitimate
        // request, and the number the user approves is the number they get.
        expect.objectContaining({ maxConcurrent: 1 }),
      );
    });

    it("keeps the current settings when the user declines a proposal", async () => {
      const applyProjectSubagentSettings = vi.fn();
      const view = await mount({ applyProjectSubagentSettings });
      await view.send(request({
        tool: "propose_agent_settings",
        arguments: { reason: "Use one reviewer", maxConcurrent: 1 },
      }));
      const approval = useTaskStore.getState().tasks["root-1"].approvals[0];

      await act(async () => {
        await view.result.current.respondToSettingsProposal(approval, { decision: "decline" });
      });
      expect(applyProjectSubagentSettings).not.toHaveBeenCalled();
      expect(useTaskStore.getState().tasks["root-1"].activities).toContainEqual(
        expect.objectContaining({ title: "Sub-agent change declined" }),
      );
    });

    it("only requires the destinations a proposal switches on to be ready", async () => {
      const parked = { ...TARGETS[1], enabled: false };
      const view = await mount({
        readiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: true, claudeReady: false, cursorReady: true },
        projectSubagentSettingsForThread: () => ({
          enabled: true,
          maxConcurrent: 2,
          childAgents: { enabled: true, targets: [TARGETS[0], parked] },
        }),
      });
      await view.send(request({
        tool: "propose_agent_settings",
        arguments: { reason: "Raise the parallel limit", maxConcurrent: 4 },
      }));

      const approval = useTaskStore.getState().tasks["root-1"].approvals[0];
      expect(approval).toMatchObject({ method: "openkiwi/subagents/change" });
      // A parked, signed-out destination is neither blocking nor advertised.
      expect(String(approval.params.command)).not.toContain("Reviewer");
      expect(lastResponse()?.[1]).toMatchObject({ status: "awaiting_user" });
    });

    it("allows a safe disable proposal while a saved destination is signed out", async () => {
      const view = await mount({
        readiness: { codexRuntimeAvailable: true, openAiSignedIn: false, openRouterReady: true, claudeReady: true, cursorReady: true },
      });
      await view.send(request({
        tool: "propose_agent_settings",
        arguments: { reason: "Pause all delegated work", enabled: false },
      }));

      expect(useTaskStore.getState().tasks["root-1"].approvals[0])
        .toMatchObject({ method: "openkiwi/subagents/change" });
      expect(lastResponse()?.[1]).toMatchObject({ status: "awaiting_user" });
    });

    it("refuses to stack a second project change on an unanswered one", async () => {
      const view = await mount();
      await view.send(request({
        tool: "propose_agent_settings",
        arguments: { reason: "First", maxConcurrent: 1 },
      }));
      await view.send(request({
        requestId: "request-2",
        tool: "propose_agent_settings",
        arguments: { reason: "Second", maxConcurrent: 3 },
      }));

      expect(useTaskStore.getState().tasks["root-1"].approvals).toHaveLength(1);
      expect(lastResponse()?.[2]).toMatch(/already waiting for the user/);
    });
  });

  describe("policy enforcement", () => {
    it("refuses a destination the thread never approved", async () => {
      const view = await mount();
      await view.send(request({ arguments: { target: "gemini", prompt: "Do the work." } }));
      expect(childRun.startChildAgentTurn).not.toHaveBeenCalled();
      expect(lastResponse()?.[2]).toMatch(/not an approved destination/);
    });

    it("refuses a session the app has no policy for", async () => {
      const view = await mount();
      await view.send(request({ sessionId: "session-unknown" }));
      expect(lastResponse()?.[2]).toMatch(/not allowed to start sub-agents/);
    });

    it("refuses an empty prompt", async () => {
      const view = await mount();
      await view.send(request({ arguments: { target: "terra", prompt: "   " } }));
      expect(lastResponse()?.[2]).toMatch(/`prompt` is required/);
    });

    it("refuses to spawn before the root thread has an identity", async () => {
      const view = await mount({ policies: { "session-1": { ...POLICY, rootThreadId: "" } } });
      await view.send(request());
      expect(lastResponse()?.[2]).toMatch(/not finished starting/);
    });

    it("keeps sub-agent depth at one", async () => {
      persistedLinks = { "root-1": link({ childThreadId: "root-1", rootThreadId: "grandparent" }) };
      const view = await mount();
      await view.send(request());
      expect(childRun.startChildAgentTurn).not.toHaveBeenCalled();
      expect(lastResponse()?.[2]).toMatch(/cannot start further sub-agents/);
    });

    it("enforces the captured concurrency budget", async () => {
      const view = await mount();
      await view.send(request({ arguments: { target: "terra", prompt: "One." } }));
      await view.rerender({});
      await view.send(request({ arguments: { target: "reviewer", prompt: "Two." } }));
      await view.rerender({});
      await view.send(request({ arguments: { target: "grok", prompt: "Three." } }));

      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(2);
      expect(lastResponse()?.[2]).toMatch(/configured maximum/);
    });

    it("shares the budget with same-provider native sub-agents", async () => {
      useTaskStore.getState().upsertAgent("root-1", {
        id: "native-child",
        prompt: "Native task",
        status: "inProgress",
      });
      const view = await mount();
      await view.send(request({ requestId: "r1", arguments: { target: "terra", prompt: "One." } }));
      await view.send(request({ requestId: "r2", arguments: { target: "reviewer", prompt: "Two." } }));
      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(1);
      expect(lastResponse()?.[2]).toMatch(/configured maximum/);
    });

    it("does not let the root itself consume a slot in its own budget", async () => {
      // A runtime that reports the root thread as one of its own agents would
      // otherwise leave a limit of two delivering only one real child.
      useTaskStore.getState().upsertAgent("root-1", {
        id: "root-1",
        prompt: "Delegated task",
        status: "inProgress",
      });
      const view = await mount();
      await view.send(request({ requestId: "r1", arguments: { target: "terra", prompt: "One." } }));
      await view.rerender({});
      await view.send(request({ requestId: "r2", arguments: { target: "reviewer", prompt: "Two." } }));
      await view.rerender({});
      await view.send(request({ requestId: "r3", arguments: { target: "grok", prompt: "Three." } }));

      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(2);
      expect(lastResponse()?.[2]).toMatch(/configured maximum/);
    });

    it("holds the budget against spawns that arrive before the next render", async () => {
      // No rerender between sends: the link map the hook can see is still empty
      // for both, so only the in-flight reservation can stop the third.
      const view = await mount();
      await view.send(request({ requestId: "r1", arguments: { target: "terra", prompt: "One." } }));
      await view.send(request({ requestId: "r2", arguments: { target: "reviewer", prompt: "Two." } }));
      await view.send(request({ requestId: "r3", arguments: { target: "grok", prompt: "Three." } }));

      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(2);
      expect(lastResponse()?.[2]).toMatch(/configured maximum/);
    });

    it("returns a reservation to the budget when the start fails", async () => {
      childRun.startChildAgentTurn.mockRejectedValueOnce(new Error("runtime unavailable"));
      const view = await mount();
      await view.send(request({ arguments: { target: "terra", prompt: "One." } }));
      await view.send(request({ arguments: { target: "reviewer", prompt: "Two." } }));
      await view.send(request({ arguments: { target: "grok", prompt: "Three." } }));
      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(3);
    });

    it("frees a slot once a child finishes", async () => {
      const view = await mount();
      await view.send(request({ arguments: { target: "terra", prompt: "One." } }));
      await view.rerender({});
      await view.send(request({ arguments: { target: "reviewer", prompt: "Two." } }));
      await view.rerender({});
      act(() => { useTaskStore.getState().setTaskStatus("child-terra", "completed"); });
      await view.rerender({});

      await view.send(request({ arguments: { target: "grok", prompt: "Three." } }));
      expect(childRun.startChildAgentTurn).toHaveBeenCalledTimes(3);
    });

    it("reports a failed start back to the model instead of failing the transport", async () => {
      childRun.startChildAgentTurn.mockRejectedValue(new Error("Sign in to Claude Code before sending a message."));
      const view = await mount();
      await view.send(request({ arguments: { target: "reviewer", prompt: "Review." } }));
      expect(lastResponse()).toEqual(["request-1", null, expect.stringContaining("Sign in to Claude Code")]);
      expect(persistedLinks).toEqual({});
    });
  });

  describe("lifecycle", () => {
    it("returns actionable failure details to the parent agent", async () => {
      persistedLinks = { "child-1": link() };
      const view = await mount();
      act(() => {
        useTaskStore.getState().ensureTask("child-1");
        useTaskStore.getState().setTaskStatus("child-1", "error", "Provider connection failed");
      });
      await view.send(request({ tool: "agent_status", arguments: { childId: "child-1" } }));
      expect(lastResponse()?.[1]).toEqual({
        children: [expect.objectContaining({
          childId: "child-1",
          status: "failed",
          error: "Provider connection failed",
          retryable: true,
          recovery: expect.stringContaining("spawn_agent"),
        })],
      });
    });

    it("kills an OpenAI child whose start resolves after global Stop", async () => {
      let resolveStart!: (value: unknown) => void;
      childRun.startChildAgentTurn.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
      const view = await mount();
      await view.send(request());
      await act(async () => { await view.result.current.cancelChildAgentsFor("root-1"); });
      await act(async () => {
        resolveStart({
          thread: childThread("late-child", "openai"),
          turnId: "late-turn",
          provider: "openai",
          model: "gpt-5.6-terra",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", { threadId: "late-child", turnId: "late-turn" });
      expect(lastResponse()?.[2]).toMatch(/stopped this run/);
    });

    it("keeps a late child visible when its post-Stop cutoff cannot be confirmed", async () => {
      let resolveStart!: (value: unknown) => void;
      childRun.startChildAgentTurn.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
      codex.rpc.mockRejectedValueOnce(new Error("runtime did not confirm interrupt"));
      const view = await mount();
      await view.send(request());
      await act(async () => { await view.result.current.cancelChildAgentsFor("root-1"); });
      await act(async () => {
        resolveStart({
          thread: childThread("late-child", "openai"),
          turnId: "late-turn",
          provider: "openai",
          model: "gpt-5.6-terra",
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(persistedLinks["late-child"]).toEqual(expect.objectContaining({ childThreadId: "late-child" }));
      expect(useTaskStore.getState().statuses["late-child"]).toBe("running");
      expect(lastResponse()?.[2]).toMatch(/could not confirm.*cutoff/i);
    });

    it("releases the backend slot exactly once per child", async () => {
      const view = await mount();
      await view.send(request());
      await view.rerender({});
      act(() => { useTaskStore.getState().setTaskStatus("child-terra", "completed"); });
      act(() => { useTaskStore.getState().setTaskStatus("child-terra", "completed"); });
      expect(bridge.reportChildAgentFinished).toHaveBeenCalledExactlyOnceWith("session-1", "child-terra");
      expect(useTaskStore.getState().tasks["root-1"].agents[0].status).toBe("completed");
      expect(useTaskStore.getState().tasks["root-1"].activities)
        .toContainEqual(expect.objectContaining({ id: "child-agent-child-terra", status: "completed" }));
    });

    it("reports each child's status to the parent", async () => {
      persistedLinks = { "child-1": link(), "child-2": link({ childThreadId: "child-2", sessionId: "other-session" }) };
      const view = await mount();
      act(() => { useTaskStore.getState().setTaskStatus("child-1", "running"); });
      await view.send(request({ tool: "agent_status", arguments: {} }));
      expect(lastResponse()?.[1]).toEqual({
        children: [expect.objectContaining({ childId: "child-1", provider: "openai", status: "running" })],
      });
    });

    it("can inspect and collect a child before its persisted link rerenders", async () => {
      const view = await mount();
      await view.send(request());
      await view.send(request({ requestId: "status-now", tool: "agent_status", arguments: { childId: "child-terra" } }));
      expect(lastResponse()?.[1]).toEqual({
        children: [expect.objectContaining({ childId: "child-terra", status: "running" })],
      });

      act(() => {
        useTaskStore.getState().completeMessage("child-terra", { id: "done", role: "assistant", text: "Done immediately." });
        useTaskStore.getState().setTaskStatus("child-terra", "completed");
      });
      await view.send(request({ requestId: "collect-now", tool: "collect_agent", arguments: { childId: "child-terra" } }));
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({ result: "Done immediately.", status: "completed" }));
    });

    it("preserves terminal outcomes across an app restart", async () => {
      persistedLinks = {
        "child-failed": link({ childThreadId: "child-failed", terminalStatus: "failed" }),
        "child-interrupted": link({ childThreadId: "child-interrupted" }),
      };
      const view = await mount();
      await view.send(request({ tool: "agent_status", arguments: {} }));
      expect(lastResponse()?.[1]).toEqual({
        children: expect.arrayContaining([
          expect.objectContaining({ childId: "child-failed", status: "failed" }),
          expect.objectContaining({ childId: "child-interrupted", status: "cancelled" }),
        ]),
      });
    });

    it("returns a finished child's last message to the parent", async () => {
      persistedLinks = { "child-1": link() };
      const view = await mount();
      act(() => {
        useTaskStore.getState().completeMessage("child-1", { id: "m1", role: "assistant", text: "Parser refactored." });
        useTaskStore.getState().setTaskStatus("child-1", "completed");
      });
      await view.send(request({ tool: "collect_agent", arguments: { childId: "child-1" } }));
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({
        childId: "child-1",
        status: "completed",
        result: "Parser refactored.",
        truncated: false,
      }));
    });

    // Real timers on purpose: this file's hook subscribes to the task store
    // and to React's scheduler, and a faked clock leaks into the tests that
    // follow. One real second is cheaper than that fragility.
    it("reports progress rather than blocking forever when a child is still working", async () => {
      persistedLinks = { "child-1": link() };
      const view = await mount();
      act(() => { useTaskStore.getState().setTaskStatus("child-1", "running"); });
      await act(async () => {
        const pending = new Promise<void>((resolve) => {
          bridge.respondToChildAgentRequest.mockImplementation(async () => { resolve(); });
        });
        await view.send(request({ tool: "collect_agent", arguments: { childId: "child-1", timeoutSeconds: 1 } }));
        await pending;
      });
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({ status: "running", note: expect.stringContaining("Still working") }));
      expect(useTaskStore.getState().statuses["child-1"]).toBe("running");
    });

    it("refuses to collect a child from another thread", async () => {
      persistedLinks = { "child-1": link({ sessionId: "other-session" }) };
      const view = await mount();
      await view.send(request({ tool: "collect_agent", arguments: { childId: "child-1" } }));
      expect(lastResponse()?.[2]).toMatch(/was not started from this thread/);
    });

    it.each([
      ["claude", () => claude.killClaudeTurn],
      ["cursor", () => cursor.killCursorTurn],
    ])("hard-stops a %s child through its own runtime", async (provider, stop) => {
      persistedLinks = { "child-1": link({ provider: provider as ChildAgentLink["provider"] }) };
      const view = await mount();
      act(() => { useTaskStore.getState().setTaskStatus("child-1", "running"); });
      await view.send(request({ tool: "cancel_agent", arguments: { childId: "child-1" } }));
      expect(stop()).toHaveBeenCalledWith("child-1");
      expect(useTaskStore.getState().statuses["child-1"]).toBe("interrupted");
      expect(lastResponse()?.[1]).toEqual({ childId: "child-1", status: "cancelled" });
    });

    it("cancels an app-server child through turn/interrupt", async () => {
      persistedLinks = { "child-1": link() };
      const view = await mount();
      act(() => {
        useTaskStore.getState().setActiveTurn("child-1", "turn-9");
        useTaskStore.getState().setTaskStatus("child-1", "running");
      });
      await view.send(request({ tool: "cancel_agent", arguments: { childId: "child-1" } }));
      expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", { threadId: "child-1", turnId: "turn-9" });
    });

    it("treats cancelling a finished child as a no-op", async () => {
      persistedLinks = { "child-1": link() };
      const view = await mount();
      act(() => { useTaskStore.getState().setTaskStatus("child-1", "completed"); });
      await view.send(request({ tool: "cancel_agent", arguments: { childId: "child-1" } }));
      expect(codex.rpc).not.toHaveBeenCalled();
      expect(lastResponse()?.[1]).toEqual(expect.objectContaining({ status: "completed" }));
    });

    it("lets the user stop one cross-provider child without stopping its siblings", async () => {
      persistedLinks = {
        "child-1": link({ provider: "claude" }),
        "child-2": link({ childThreadId: "child-2", provider: "cursor" }),
      };
      const view = await mount();
      act(() => {
        useTaskStore.getState().setTaskStatus("child-1", "running");
        useTaskStore.getState().setTaskStatus("child-2", "running");
        useTaskStore.getState().upsertActivity("root-1", {
          id: "child-agent-child-1",
          kind: "agent",
          title: "Spawned Claude sub-agent",
          status: "inProgress",
          agent: { action: "spawn", provider: "claude", threadIds: ["child-1"] },
        });
      });
      await act(async () => { await view.result.current.stopChildAgent("root-1", "child-1"); });
      expect(claude.killClaudeTurn).toHaveBeenCalledExactlyOnceWith("child-1");
      expect(cursor.killCursorTurn).not.toHaveBeenCalled();
      expect(useTaskStore.getState().statuses["child-1"]).toBe("interrupted");
      expect(useTaskStore.getState().statuses["child-2"]).toBe("running");
      expect(useTaskStore.getState().tasks["root-1"].activities[0].status).toBe("cancelled");
    });

    it("interrupts one Codex-native child when the runtime exposed its turn", async () => {
      const view = await mount();
      act(() => {
        useTaskStore.getState().upsertAgent("root-1", { id: "native-1", prompt: "Native task", status: "inProgress" });
        useTaskStore.getState().ensureTask("native-1", "/tmp/project");
        useTaskStore.getState().setActiveTurn("native-1", "native-turn");
        useTaskStore.getState().setTaskStatus("native-1", "running");
        useTaskStore.getState().upsertActivity("root-1", {
          id: "native-spawn",
          kind: "agent",
          title: "Sub-agent started",
          status: "inProgress",
          agent: { action: "spawn", provider: "openai", threadIds: ["native-1"] },
        });
      });
      await act(async () => { await view.result.current.stopChildAgent("root-1", "native-1"); });
      expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", { threadId: "native-1", turnId: "native-turn" });
      expect(useTaskStore.getState().statuses["native-1"]).toBe("interrupted");
      expect(useTaskStore.getState().tasks["root-1"].agents[0].status).toBe("interrupted");
      expect(useTaskStore.getState().tasks["root-1"].activities[0].status).toBe("cancelled");
    });

    it("fails closed when a native provider did not expose an individual turn", async () => {
      const view = await mount();
      act(() => {
        useTaskStore.getState().upsertAgent("root-1", { id: "native-1", prompt: "Native task", status: "inProgress" });
      });
      await expect(view.result.current.stopChildAgent("root-1", "native-1")).rejects.toThrow(/has not exposed/);
      expect(codex.rpc).not.toHaveBeenCalled();
    });

    it("rejects a tool the bridge does not implement", async () => {
      const view = await mount();
      await view.send(request({ tool: "delete_everything" as ChildAgentRequest["tool"] }));
      expect(lastResponse()?.[2]).toMatch(/is not a sub-agent tool/);
    });

    it("stops every running child when its parent is stopped", async () => {
      persistedLinks = {
        "child-1": link({ provider: "claude" }),
        "child-2": link({ childThreadId: "child-2", provider: "cursor" }),
        "child-3": link({ childThreadId: "child-3", provider: "claude" }),
      };
      const view = await mount();
      act(() => {
        useTaskStore.getState().setTaskStatus("child-1", "running");
        useTaskStore.getState().setTaskStatus("child-2", "running");
        useTaskStore.getState().setTaskStatus("child-3", "completed");
        useTaskStore.getState().upsertActivity("root-1", {
          id: "wave",
          kind: "agent",
          title: "Dispatched sub-agent wave",
          status: "inProgress",
          agent: { action: "spawn", count: 2, threadIds: ["child-1", "child-2"] },
        });
      });
      await act(async () => { await view.result.current.cancelChildAgentsFor("root-1"); });
      expect(claude.killClaudeTurn).toHaveBeenCalledExactlyOnceWith("child-1");
      expect(cursor.killCursorTurn).toHaveBeenCalledExactlyOnceWith("child-2");
      expect(useTaskStore.getState().statuses["child-3"]).toBe("completed");
      expect(useTaskStore.getState().tasks["root-1"].activities[0].status).toBe("cancelled");
    });

    it("does not claim a child stopped when its provider cutoff fails", async () => {
      persistedLinks = { "child-1": link({ provider: "cursor" }) };
      cursor.killCursorTurn.mockRejectedValueOnce(new Error("Cursor process would not exit"));
      const view = await mount();
      act(() => {
        useTaskStore.getState().setTaskStatus("child-1", "running");
        useTaskStore.getState().upsertAgent("root-1", { id: "child-1", prompt: "Review the parser", status: "inProgress" });
        useTaskStore.getState().upsertActivity("root-1", {
          id: "child-agent-child-1",
          kind: "agent",
          title: "Spawned Cursor sub-agent",
          status: "inProgress",
          agent: { action: "spawn", provider: "cursor", threadIds: ["child-1"] },
        });
      });

      await expect(view.result.current.cancelChildAgentsFor("root-1"))
        .rejects.toThrow(/Could not stop .*Cursor process would not exit/);
      expect(useTaskStore.getState().statuses["child-1"]).toBe("running");
      expect(useTaskStore.getState().tasks["root-1"].agents[0].status).toBe("inProgress");
      expect(useTaskStore.getState().tasks["root-1"].activities[0].status).toBe("inProgress");
    });

    it("settles provider-native children whatever word their runtime used", async () => {
      const view = await mount();
      act(() => {
        useTaskStore.getState().upsertAgent("root-1", { id: "native-1", prompt: "Queued native", status: "queued" });
        useTaskStore.getState().upsertAgent("root-1", { id: "native-2", prompt: "Running native", status: "inProgress" });
        useTaskStore.getState().ensureTask("native-2");
        useTaskStore.getState().setActiveTurn("native-2", "native-turn");
      });
      await act(async () => { await view.result.current.cancelChildAgentsFor("root-1"); });

      expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", { threadId: "native-2", turnId: "native-turn" });
      expect(useTaskStore.getState().tasks["root-1"].agents.map((agent) => agent.status))
        .toEqual(["interrupted", "interrupted"]);
    });
  });
});

describe("child lifecycle helpers", () => {
  beforeEach(() => resetTaskStore());

  it("maps task status onto words a model can act on", () => {
    expect(childLifecycle("completed")).toBe("completed");
    expect(childLifecycle("interrupted")).toBe("cancelled");
    expect(childLifecycle("error")).toBe("failed");
    expect(childLifecycle("starting")).toBe("starting");
    expect(childLifecycle("idle")).toBe("completed");
    expect(childLifecycleForLink(link({ terminalStatus: "failed" }), "idle")).toBe("failed");
    expect(childLifecycleForLink(link(), "idle")).toBe("cancelled");
  });

  it("counts only children of the requested session that are still working", () => {
    const links = {
      "child-1": link(),
      "child-2": link({ childThreadId: "child-2" }),
      "child-3": link({ childThreadId: "child-3", sessionId: "other" }),
    };
    useTaskStore.getState().setTaskStatus("child-1", "running");
    useTaskStore.getState().setTaskStatus("child-2", "completed");
    useTaskStore.getState().setTaskStatus("child-3", "running");
    expect(activeChildThreadIds("session-1", links)).toEqual(["child-1"]);
  });

  it("does not count a persisted child with no live in-memory task", () => {
    expect(activeChildThreadIds("session-1", { "child-1": link() })).toEqual([]);
  });

  it("resolves immediately for a child that already finished", async () => {
    useTaskStore.getState().setTaskStatus("child-1", "error");
    await expect(waitForChildTerminalStatus("child-1", 1000)).resolves.toBe("error");
  });
});
