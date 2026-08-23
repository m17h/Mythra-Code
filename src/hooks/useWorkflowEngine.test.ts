import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  auditEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/codex", () => codex);

import { useWorkflowEngine, waitForWorkflowTurn } from "./useWorkflowEngine";

type WorkflowEngineDeps = Parameters<typeof useWorkflowEngine>[0];

function testWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Workflow",
    description: "",
    projectId: "project-1",
    enabled: false,
    trigger: { type: "manual" },
    steps: [{ id: "step-1", type: "command", name: "Run", command: "true", continueOnError: false }],
    skillNames: [],
    run: scheduleRunSnapshot(DEFAULT_SETTINGS),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function testEngineDeps(
  workflow: WorkflowDefinition,
  runs: WorkflowRunRecord[],
  overrides: Partial<WorkflowEngineDeps> = {},
): WorkflowEngineDeps {
  return {
    workflows: [workflow],
    projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
    runtimeAvailable: true,
    chatGptConnected: true,
    openRouterReady: false,
    customAgents: [],
    ensureSkillRoots: vi.fn(async () => undefined),
    bindThreadToProject: vi.fn(),
    beginRunCheckpoint: vi.fn(async () => undefined),
    finalizeRunCheckpoint: vi.fn(async () => undefined),
    discardRunCheckpoint: vi.fn(),
    updateWorkflow: vi.fn(),
    recordRun: (run) => {
      const index = runs.findIndex((item) => item.id === run.id);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
    },
    onThreadStarted: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe("workflow turn waiting", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.useFakeTimers();
    codex.rpc.mockReset();
    codex.auditEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the agent turn completes", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    const pending = waitForWorkflowTurn("thread-1", "turn-1");
    useTaskStore.getState().completeTurn("thread-1", "turn-1", "completed");
    await expect(pending).resolves.toBe("completed");
  });

  it("rejects interrupted turns", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    const pending = waitForWorkflowTurn("thread-1", "turn-1");
    useTaskStore.getState().completeTurn("thread-1", "turn-1", "interrupted");
    await expect(pending).rejects.toThrow("stopped");
  });

  it("ignores a different turn completing in the same thread", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    const pending = waitForWorkflowTurn("thread-1", "workflow-turn");
    useTaskStore.getState().completeTurn("thread-1", "other-turn", "completed");
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    useTaskStore.getState().completeTurn("thread-1", "workflow-turn", "completed");
    await expect(pending).resolves.toBe("completed");
  });

  it("times out a specific turn wait", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    const pending = waitForWorkflowTurn("thread-1", "turn-1", undefined, 1_000);
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("runs deterministic command recipes in a named project thread", async () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Run checks",
      description: "",
      projectId: "project-1",
      enabled: true,
      trigger: { type: "manual" },
      steps: [{
        id: "step-1",
        type: "command",
        name: "Tests",
        command: "npm test",
        continueOnError: false,
      }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: "passed\n", stderr: "" });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine({
      workflows: [workflow],
      projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
      runtimeAvailable: true,
      chatGptConnected: true,
      openRouterReady: false,
      customAgents: [],
      ensureSkillRoots: vi.fn(async () => undefined),
      bindThreadToProject: vi.fn(),
      beginRunCheckpoint: vi.fn(async () => undefined),
      finalizeRunCheckpoint: vi.fn(async () => undefined),
      discardRunCheckpoint: vi.fn(),
      updateWorkflow: vi.fn(),
      recordRun: (run) => {
        const index = runs.findIndex((item) => item.id === run.id);
        if (index >= 0) runs[index] = run;
        else runs.push(run);
      },
      onThreadStarted: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({
      command: ["/bin/zsh", "-lc", "npm test"],
      cwd: "/tmp/project",
    }));
    expect(runs.at(-1)).toMatchObject({ status: "completed", threadId: "thread-1", currentStep: 1 });
  });

  it("interpolates variables, retries failures, and records skipped conditions", async () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Release",
      description: "",
      projectId: "project-1",
      enabled: true,
      trigger: { type: "manual" },
      variables: [{ id: "variable-1", name: "branch", value: "main", promptOnRun: false }],
      steps: [{
        id: "step-1",
        type: "command",
        name: "Check branch",
        command: "echo ${branch}",
        continueOnError: false,
        retryCount: 1,
        retryDelaySeconds: 0,
      }, {
        id: "step-2",
        type: "command",
        name: "Only develop",
        command: "echo develop",
        continueOnError: false,
        condition: { type: "variable-equals", variable: "branch", value: "develop" },
      }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    const runs: WorkflowRunRecord[] = [];
    let commandAttempt = 0;
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") {
        commandAttempt += 1;
        return Promise.resolve(commandAttempt === 1
          ? { exitCode: 1, stdout: "", stderr: "not yet" }
          : { exitCode: 0, stdout: "main\n", stderr: "" });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine({
      workflows: [workflow],
      projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
      runtimeAvailable: true,
      chatGptConnected: true,
      openRouterReady: false,
      customAgents: [],
      ensureSkillRoots: vi.fn(async () => undefined),
      bindThreadToProject: vi.fn(),
      beginRunCheckpoint: vi.fn(async () => undefined),
      finalizeRunCheckpoint: vi.fn(async () => undefined),
      discardRunCheckpoint: vi.fn(),
      updateWorkflow: vi.fn(),
      recordRun: (run) => {
        const index = runs.findIndex((item) => item.id === run.id);
        if (index >= 0) runs[index] = run;
        else runs.push(run);
      },
      onThreadStarted: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => {
      await result.current.runWorkflow("workflow-1", "manual", { branch: "main" });
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({
      command: ["/bin/zsh", "-lc", "echo main"],
    }));
    expect(commandAttempt).toBe(2);
    expect(runs.at(-1)?.steps).toMatchObject([
      { status: "completed", attempts: 2 },
      { status: "skipped", attempts: 0 },
    ]);
  });

  it("terminates an active shell process when a workflow is stopped", async () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Long task",
      description: "",
      projectId: "project-1",
      enabled: false,
      trigger: { type: "interval", intervalMinutes: 60 },
      nextRunAt: 123_456,
      steps: [{ id: "step-1", type: "command", name: "Wait", command: "sleep 30", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    const runs: WorkflowRunRecord[] = [];
    const updates: WorkflowDefinition[] = [];
    const updateWorkflow = vi.fn((_id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => {
      updates.push(patch(workflow));
    });
    let rejectCommand: ((reason: Error) => void) | undefined;
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return new Promise((_resolve, reject) => { rejectCommand = reject; });
      if (method === "command/exec/terminate") {
        rejectCommand?.(new Error("terminated"));
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine({
      workflows: [workflow],
      projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
      runtimeAvailable: true,
      chatGptConnected: true,
      openRouterReady: false,
      customAgents: [],
      ensureSkillRoots: vi.fn(async () => undefined),
      bindThreadToProject: vi.fn(),
      beginRunCheckpoint: vi.fn(async () => undefined),
      finalizeRunCheckpoint: vi.fn(async () => undefined),
      discardRunCheckpoint: vi.fn(),
      updateWorkflow,
      recordRun: (run) => {
        const index = runs.findIndex((item) => item.id === run.id);
        if (index >= 0) runs[index] = run;
        else runs.push(run);
      },
      onThreadStarted: vi.fn(),
      onError: vi.fn(),
    }));

    let pending: Promise<string | undefined>;
    await act(async () => {
      pending = result.current.runWorkflow("workflow-1", "interval");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      expect(await result.current.stopWorkflow("workflow-1")).toBe(true);
      await pending!;
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec/terminate", expect.objectContaining({
      processId: expect.stringContaining("workflow-"),
    }));
    expect(runs.at(-1)).toMatchObject({ status: "interrupted", stopRequestedAt: expect.any(Number) });
    expect(runs.at(-1)?.steps?.[0]).toMatchObject({ status: "interrupted" });
    expect(updates[0].nextRunAt! - updates[0].lastRunAt!).toBe(60 * 60_000);
  });

  it("interrupts an agent turn when stop is requested before turn/start resolves", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "agent",
        name: "Review",
        prompt: "Review it",
        continueOnError: false,
        retryCount: 1,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    let resolveTurn: ((value: { turn: { id: string } }) => void) | undefined;
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") return new Promise((resolve) => { resolveTurn = resolve; });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    let pending: Promise<string | undefined>;
    await act(async () => {
      pending = result.current.runWorkflow("workflow-1");
      await flushMicrotasks();
    });
    await act(async () => {
      expect(await result.current.stopWorkflow("workflow-1")).toBe(true);
      resolveTurn?.({ turn: { id: "turn-1" } });
      await pending!;
    });

    expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(runs.at(-1)).toMatchObject({ status: "interrupted" });
  });

  it("interrupts the exact outstanding turn before a timed-out step fails", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "agent",
        name: "Review",
        prompt: "Review it",
        continueOnError: false,
        retryCount: 1,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") return Promise.resolve({ turn: { id: "turn-1" } });
      return Promise.resolve({});
    });
    const deps = testEngineDeps(workflow, runs, { turnTimeoutMs: 1_000 });
    const { result } = renderHook(() => useWorkflowEngine(deps));

    let pending: Promise<string | undefined>;
    await act(async () => {
      pending = result.current.runWorkflow("workflow-1");
      await flushMicrotasks();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect({
      turnStarts: codex.rpc.mock.calls.filter(([method]) => method === "turn/start").length,
      run: runs.at(-1),
    }).toMatchObject({
      turnStarts: 1,
      run: { status: "failed" },
    });
    await act(async () => {
      await pending!;
    });
    expect(runs.at(-1)).toMatchObject({
      status: "failed",
      error: "The runtime took too long to respond. Check that it is running, then try again.",
    });
  });

  it("does not strand the workflow thread in starting when turn/start fails terminally", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "agent",
        name: "Review",
        prompt: "Review it",
        continueOnError: false,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") return Promise.reject(new Error("model unavailable"));
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(runs.at(-1)).toMatchObject({ status: "failed" });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("error");
  });

  it("leaves the thread status to a successful retry after a failed turn/start", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "agent",
        name: "Review",
        prompt: "Review it",
        continueOnError: false,
        retryCount: 1,
        retryDelaySeconds: 0,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    let turnAttempt = 0;
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        turnAttempt += 1;
        if (turnAttempt === 1) return Promise.reject(new Error("model unavailable"));
        queueMicrotask(() => useTaskStore.getState().completeTurn("thread-1", "turn-1", "completed"));
        return Promise.resolve({ turn: { id: "turn-1" } });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(turnAttempt).toBe(2);
    expect(runs.at(-1)).toMatchObject({ status: "completed" });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("completed");
  });

  it("silently waits for runtime readiness before firing an app-start workflow", async () => {
    const workflow = testWorkflow({
      enabled: true,
      trigger: { type: "app-start" },
    });
    const runs: WorkflowRunRecord[] = [];
    const onError = vi.fn();
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      return Promise.resolve({});
    });
    const initial = testEngineDeps(workflow, runs, { runtimeAvailable: false, onError });
    const { rerender } = renderHook(
      ({ deps }: { deps: WorkflowEngineDeps }) => useWorkflowEngine(deps),
      { initialProps: { deps: initial } },
    );
    expect(onError).not.toHaveBeenCalled();
    expect(codex.rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());

    await act(async () => {
      rerender({ deps: { ...initial, runtimeAvailable: true } });
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("thread/start", expect.anything());
    expect(onError).not.toHaveBeenCalled();
  });

  it("advances a permanently invalid background workflow instead of retrying every tick", () => {
    const workflow = testWorkflow({
      enabled: true,
      projectId: "missing-project",
      trigger: { type: "interval", intervalMinutes: 60 },
      nextRunAt: 0,
    });
    const runs: WorkflowRunRecord[] = [];
    const updateWorkflow = vi.fn();
    const onError = vi.fn();
    renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs, { updateWorkflow, onError })));

    expect(codex.rpc).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(updateWorkflow).toHaveBeenCalledWith("workflow-1", expect.any(Function));
    const patch = updateWorkflow.mock.calls[0][1] as (current: WorkflowDefinition) => WorkflowDefinition;
    expect(patch(workflow).nextRunAt).toBeGreaterThan(Date.now());
  });

  it("records a permanently invalid app-start workflow only once per launch", async () => {
    const workflow = testWorkflow({
      enabled: true,
      projectId: "missing-project",
      trigger: { type: "app-start" },
    });
    const runs: WorkflowRunRecord[] = [];
    const onError = vi.fn();
    renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs, { onError })));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "app-start", status: "failed" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(runs).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("fires a due interval workflow once and advances its schedule", async () => {
    const workflow = testWorkflow({
      enabled: true,
      trigger: { type: "interval", intervalMinutes: 60 },
      nextRunAt: 0,
    });
    const runs: WorkflowRunRecord[] = [];
    const updates: WorkflowDefinition[] = [];
    const updateWorkflow = vi.fn((_id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => {
      updates.push(patch(workflow));
    });
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: "done", stderr: "" });
      return Promise.resolve({});
    });
    renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs, { updateWorkflow })));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(codex.rpc.mock.calls.filter(([method]) => method === "command/exec")).toHaveLength(1);
    expect(runs.at(-1)).toMatchObject({ source: "interval", status: "completed" });
    expect(updates.at(-1)?.nextRunAt! - updates.at(-1)?.lastRunAt!).toBe(60 * 60_000);
  });

  it("backs off scheduled failures without changing the timing of manual runs", async () => {
    const workflow = testWorkflow({
      trigger: { type: "interval", intervalMinutes: 60 },
      nextRunAt: 123_456,
      consecutiveFailures: 1,
    });
    const runs: WorkflowRunRecord[] = [];
    const updates: WorkflowDefinition[] = [];
    const updateWorkflow = vi.fn((_id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => {
      updates.push(patch(workflow));
    });
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return Promise.resolve({ exitCode: 1, stdout: "", stderr: "failed" });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs, { updateWorkflow })));

    await act(async () => {
      await result.current.runWorkflow("workflow-1", "interval");
    });
    expect(updates[0].consecutiveFailures).toBe(2);
    expect(updates[0].nextRunAt! - updates[0].lastRunAt!).toBe(2 * 60 * 60_000);

    updates.length = 0;
    await act(async () => {
      await result.current.runWorkflow("workflow-1", "manual");
    });
    expect(updates[0].nextRunAt).toBe(123_456);
    expect(updates[0].consecutiveFailures).toBe(1);
  });

  it("runs previous-failed branches after a continued command failure", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "command",
        name: "May fail",
        command: "first",
        continueOnError: true,
      }, {
        id: "step-2",
        type: "command",
        name: "Recover",
        command: "recover ${previousExitCode}",
        continueOnError: false,
        condition: { type: "previous-failed" },
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string, params: { command?: string[] }) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec" && params.command?.[2] === "first") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "failed" });
      }
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: "recovered", stderr: "" });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({
      command: ["/bin/zsh", "-lc", "recover 1"],
    }));
    expect(runs.at(-1)?.steps).toMatchObject([
      { status: "failed" },
      { status: "completed" },
    ]);
    expect(runs.at(-1)?.status).toBe("completed");
  });

  it("keeps previousExitCode stable across retries of the same step", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "command",
        name: "Initial check",
        command: "initial",
        continueOnError: false,
      }, {
        id: "step-2",
        type: "command",
        name: "Retry",
        command: "retry:${previousExitCode}",
        continueOnError: false,
        retryCount: 1,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    let retryAttempt = 0;
    codex.rpc.mockImplementation((method: string, params: { command?: string[] }) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec" && params.command?.[2] === "initial") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (method === "command/exec") {
        retryAttempt += 1;
        return Promise.resolve({
          exitCode: retryAttempt === 1 ? 1 : 0,
          stdout: "",
          stderr: retryAttempt === 1 ? "retry" : "",
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    const retryCommands = codex.rpc.mock.calls
      .filter(([method]) => method === "command/exec")
      .map(([, params]) => (params as { command: string[] }).command[2])
      .filter((command) => command.startsWith("retry:"));
    expect(retryCommands).toEqual(["retry:0", "retry:0"]);
    expect(runs.at(-1)?.status).toBe("completed");
  });

  it("clears previousExitCode after a non-command step", async () => {
    const workflow = testWorkflow({
      steps: [{
        id: "step-1",
        type: "command",
        name: "Check",
        command: "first",
        continueOnError: false,
      }, {
        id: "step-2",
        type: "agent",
        name: "Review",
        prompt: "The previous exit was ${previousExitCode}",
        continueOnError: false,
      }, {
        id: "step-3",
        type: "command",
        name: "After review",
        command: "after:${previousExitCode}",
        continueOnError: false,
      }],
    });
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string, params: { command?: string[] }) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        queueMicrotask(() => useTaskStore.getState().completeTurn("thread-1", "turn-1", "completed"));
        return Promise.resolve({ turn: { id: "turn-1" } });
      }
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: params.command?.[2] ?? "", stderr: "" });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine(testEngineDeps(workflow, runs)));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({
      command: ["/bin/zsh", "-lc", "after:"],
    }));
  });
});
