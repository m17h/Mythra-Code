import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { useWorkflowEngine } from "../../../hooks/useWorkflowEngine.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { createWorkflowExecution } from "./workflowExecution.ts";
import { rememberRemoteEngineOwner, finishRemoteEngineOwner, markRemoteEngineRetiring, remoteEngineStopped,
  isLiveRemoteEngineOwner, clearRemoteEngineOwners, remoteEngineOwner, remoteEngineOwnerThreads, finishRemoteThreadOwner } from "./engineOwners.ts";

const project = { id: "project", path: "/host/project", name: "Project" };
const device = "a".repeat(64);
const grant = { revision: 1, view: true, work: true, scope: { kind: "all" }, capabilities: { fullAccess: false, terminal: true } };
const owner = (handle) => ({ generation: 42, threadId: handle, runId: "run", kind: "workflow", ownerHandle: handle });
// Drive the real completion seam on the same store writes as useTurnRunner's
// mounted watcher (SSR renders the real workflow hook but does not run effects).
function watchOwnerCompletion() {
  return useTaskStore.subscribe((state, previous) => {
    if (state.tasks === previous.tasks) return;
    for (const threadId of remoteEngineOwnerThreads()) {
      const task = state.tasks[threadId];
      if (task !== previous.tasks[threadId] && task?.status !== "starting" && task?.status !== "running")
        void finishRemoteThreadOwner(threadId, Boolean(state.parentRuns[threadId]), state.workflowOwners[threadId]?.runId);
    }
  });
}

test("normal owner_finish retains an unconfirmed owner and releases it only after native completion", async () => {
  rememberRemoteEngineOwner(owner("finishing"));
  let calls = 0;
  const work = finishRemoteEngineOwner("finishing", { invoke: async (command, args) => {
    assert.equal(command, "remote_work_owner_finish"); assert.equal(args.generation, 42);
    calls++; return { confirmed: calls === 2 };
  } });
  assert.equal(isLiveRemoteEngineOwner("finishing"), true);
  assert.equal(await work, true);
  assert.equal(calls, 2);
  assert.equal(isLiveRemoteEngineOwner("finishing"), false);
});

test("explicit retirement cannot race a normal-finally into owner_finish", async () => {
  rememberRemoteEngineOwner(owner("stopping")); markRemoteEngineRetiring("stopping");
  let called = false;
  assert.equal(await finishRemoteEngineOwner("stopping", { invoke: async () => { called = true; } }), false);
  assert.equal(called, false);
  remoteEngineStopped("stopping");
});

test("generation disposal settles the bounded finalizer instead of leaking an awaited timer", async () => {
  rememberRemoteEngineOwner(owner("disposed"));
  const work = finishRemoteEngineOwner("disposed", { invoke: async () => ({ confirmed: false }) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearRemoteEngineOwners(42);
  assert.equal(await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error("Leaked finalizer")), 500))]), false);
});

test("workflow native step admission refuses before preparation when the command is absent", async () => {
  const oldWindow = globalThis.window, calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command) => {
    calls.push(command);
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_engine_step") throw "Command remote_work_engine_step not found";
    if (command === "remote_work_owner_finish") return { confirmed: true };
  } } };
  const sources = { getWorkspaces: () => [project], getGrant: () => grant, getSettings: () => ({ permission: "full" }),
    getProviderCatalog: () => [{ id: "openai", models: [{ id: "model" }] }] };
  const delivery = { openOwner: async () => "missing-step", accepted: async () => assert.fail("accepted unsupported workflow"), result: () => ({ state: "accepted" }) };
  const controller = createWorkflowExecution(sources, { context: { activeWorkspace: project, effectiveSettings: { permission: "ask" } }, generation: 42, identity: { device, opId: "root", opSeq: 1 }, delivery }, () => true);
  try {
    await assert.rejects(controller.execution.begin({ run: { provider: "openai", model: "model", permission: "full" } }, project, "run"), (error) => error.code === "unsupported");
    assert.equal(calls.some((command) => command === "codex_rpc"), false);
    await controller.execution.finish();
  } finally { clearRemoteEngineOwners(42); globalThis.window = oldWindow; }
});

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) {
  test(`real workflow hook: ${provider} carries owner and fresh step identities, then owner_finish`, async () => {
    resetTaskStore();
    const unwatch = watchOwnerCompletion();
    const oldWindow = globalThis.window;
    const calls = [], runs = [], errors = [];
    let stepNumber = 0;
    const makeTurn = (threadId) => {
      setTimeout(() => useTaskStore.getState().completeTurn(threadId, "turn", "completed"), 0);
      return { turn: { id: "turn" }, turnId: "turn", cursorSessionId: "cursor-session" };
    };
    globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === "preference_learning_list") return [];
      if (command.startsWith("local_transcript_") && command.endsWith("_write")) return { generation: 1, headSeq: 0, tailSeq: 0 };
      if (command === "remote_work_grant") return grant;
      if (command === "remote_work_owner_open") return { ownerHandle: `owner-${provider}` };
      if (command === "remote_work_owner_bind") return { bound: true };
      if (command === "remote_work_owner_finish") return { confirmed: true };
      if (command === "remote_work_engine_step") return { state: "preparing", ownerTracked: true, delivery: { device, opId: `step-${++stepNumber}`, opSeq: 100 + stepNumber, attemptId: `attempt-${stepNumber}`, messageId: `message-${stepNumber}` } };
      if (command === "codex_rpc") {
        if (args.method === "thread/start") return { thread: { id: "thread", cwd: project.path, modelProvider: provider }, model: "model" };
        if (args.method === "turn/start") return makeTurn(args.params.threadId);
        if (args.method === "command/exec") return { exitCode: 0, stdout: "host output", stderr: "" };
        return {};
      }
      if (command === "claude_turn_start" || command === "cursor_turn_start") return makeTurn(args.options.threadId);
      return null;
    } } };
    const settings = { ...DEFAULT_SETTINGS, provider, model: "model", permission: "full", subagentsEnabled: false, projectInstructionsEnabled: false, projectClaudeInstructionsEnabled: false };
    const workflow = { id: "workflow", name: "Fixture", description: "", projectId: project.id, enabled: false, trigger: { type: "manual" }, skillNames: [], variables: [], run: settings,
      steps: [{ id: "agent", name: "Agent", type: "agent", prompt: "Host prompt", continueOnError: false }, { id: "command", name: "Command", type: "command", command: "echo host", continueOnError: false }], createdAt: 1, updatedAt: 1 };
    const sources = { getWorkspaces: () => [project], getGrant: () => grant, getSettings: () => settings,
      getProviderCatalog: () => [{ id: provider, models: [{ id: "model" }] }] };
    const root = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: `root-${provider}`, opSeq: 1 }, workspaceId: project.id, permission: "ask",
      isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
    const controller = createWorkflowExecution(sources, { context: { activeWorkspace: project, effectiveSettings: { permission: "ask" } }, generation: 42, identity: root.identity, delivery: root }, () => true);
    let engine;
    function Fixture() {
      engine = useWorkflowEngine({ workflows: [workflow], projects: [project], runtimeAvailable: true, chatGptConnected: true, claudeReady: true, cursorReady: true, openRouterReady: true, lmStudioReady: true,
        customAgents: [], ensureSkillRoots: async () => {}, resolveSkillPrompt: async (text) => text, bindThreadToProject() {},
        beginRunCheckpoint: async () => { assert.fail("a remote workflow step ran an unstamped local checkpoint"); }, finalizeRunCheckpoint: async () => {}, discardRunCheckpoint() {}, updateWorkflow() {},
        recordRun: (run) => runs.push(run), onThreadStarted() {}, onError: (error) => errors.push(error) });
      return React.createElement("span");
    }
    try {
      await root.beforeCreate();
      renderToString(React.createElement(Fixture));
      const threadId = await engine.runWorkflow("workflow", "manual", {}, project.id, { remote: controller.execution });
      assert.ok(threadId, errors.join("\n"));
      assert.deepEqual(errors, []);
      assert.equal(runs.at(-1).status, "completed");
      assert.equal(useTaskStore.getState().tasks[threadId].activities.some((activity) => activity.title === "Automatic checkpoint not created"), true);
      const prompt = calls.find((call) => call.command === "claude_turn_start" || call.command === "cursor_turn_start" || call.command === "codex_rpc" && call.args.method === "turn/start");
      const params = prompt.args.options ?? prompt.args.params;
      assert.equal(params.remoteDelivery.ownerHandle, `owner-${provider}`);
      assert.equal(params.remoteDelivery.opId, "step-2");
      const command = calls.find((call) => call.command === "codex_rpc" && call.args.method === "command/exec");
      assert.equal(command.args.params.remoteDelivery.opId, "step-3");
      assert.equal(command.args.params.remoteDelivery.ownerHandle, `owner-${provider}`);
      assert.equal(calls.filter((call) => call.command === "remote_work_owner_finish").length, 1);
      const preparing = calls.find((call) => call.command === "remote_work_receipt" && call.args.opId === root.identity.opId);
      assert.equal(preparing.args.permission, "ask");
      const steps = calls.filter((call) => call.command === "remote_work_engine_step");
      assert.deepEqual(steps.map((call) => call.args.kind), ["prompt", "prompt", "command"]);
      assert.ok(steps.every((call) => call.args.permission === "ask"));
    } finally { unwatch(); clearRemoteEngineOwners(42); globalThis.window = oldWindow; }
  });
}

test("automatic parent continuation gets a new native identity and rechecks current authority", async () => {
  const previousWindow = globalThis.window;
  let liveGrant = grant, steps = 0;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command) => {
    if (command === "remote_work_grant") return liveGrant;
    if (command === "remote_work_owner_open") return { ownerHandle: "parent-owner" };
    if (command === "remote_work_engine_step") return { state: "preparing", delivery: { device, opId: `child-${++steps}`, opSeq: 1, attemptId: "child-attempt", messageId: "child-message" } };
    return null;
  } } };
  try {
    const root = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: "root-parent", opSeq: 1 }, workspaceId: "project", threadId: "thread", permission: "ask", provider: "openrouter",
      isCurrent: () => true, assertAllowed() {}, validateGrant: (grant) => { if (!grant?.work) throw new Error("authority removed"); } });
    await root.beforeCreate(); await root.openOwner("parent", "run", "thread"); await root.accepted({ threadId: "thread" });
    const child = await root.childStep("continuation-1", "thread");
    assert.equal(child.metadata().opId, "child-1");
    assert.equal(child.metadata().ownerHandle, "parent-owner");
    assert.notEqual(child.metadata().opId, root.metadata().opId);
    liveGrant = { ...grant, work: false };
    await assert.rejects(root.childStep("continuation-2", "thread"), /authority removed/);
    assert.equal(steps, 1);
  } finally { globalThis.window = previousWindow; }
});

test("tracking-only local lifetime survives a remote lease and uses the local finish API", async () => {
  const local = { ...owner("local-owner"), generation: 0, local: true };
  rememberRemoteEngineOwner(local);
  clearRemoteEngineOwners(42);
  assert.equal(isLiveRemoteEngineOwner("local-owner"), true);
  const calls = [];
  assert.equal(await finishRemoteEngineOwner("local-owner", { invoke: async (command, args) => { calls.push({ command, args }); return { confirmed: true }; } }), true);
  assert.equal(calls[0].command, "remote_local_owner_finish");
  assert.deepEqual(calls[0].args, { ownerHandle: "local-owner" });
});

test("journal records preparation permission and uses owner_bind only for a genuinely fresh thread", async () => {
  const before = globalThis.window, calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_owner_open") return { ownerHandle: "fresh-owner" };
    if (command === "remote_work_owner_bind") return { bound: true };
  } } };
  try {
    const delivery = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: "new", opSeq: 1 }, workspaceId: project.id, permission: "read-only", provider: "openai",
      isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
    await delivery.beforeCreate(); await delivery.openOwner("start", "attempt"); await delivery.bindOwner("new-thread"); await delivery.bindOwner("new-thread");
    assert.equal(calls.find((call) => call.command === "remote_work_receipt").args.permission, "read-only");
    assert.equal(calls.filter((call) => call.command === "remote_work_owner_bind").length, 1);
    await assert.rejects(delivery.bindOwner("different-thread"), /another thread/);
  } finally { globalThis.window = before; }
});

test("a native uncertain child cannot be downgraded to rejected before a renderer dispatch flag", async () => {
  const { HostReadError } = await import("./scope.ts");
  const before = globalThis.window, receipts = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { if (command === "remote_work_receipt") receipts.push(args); } } };
  try {
    const delivery = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: "root-with-uncertain-step", opSeq: 1 }, workspaceId: project.id,
      isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
    await delivery.failure(new HostReadError("uncertain", "A child may already have run."));
    assert.equal(delivery.result().state, "uncertain");
    assert.equal(receipts.at(-1).disposition, "uncertain");
    assert.equal(receipts.some((receipt) => receipt.disposition === "rejected"), false);
  } finally { globalThis.window = before; }
});

test("local-tracked workflow Stop uses its actual native owner, not a remote-start controller", async () => {
  const { createHostEngineAdapters } = await import("./engineAdapters.ts");
  resetTaskStore();
  rememberRemoteEngineOwner({ generation: 0, local: true, kind: "workflow", threadId: "local-thread", runId: "local-run", ownerHandle: "local-workflow-owner" });
  useTaskStore.getState().setWorkflowOwner("local-thread", { workflowId: "workflow", runId: "local-run" });
  const before = globalThis.window, calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push({ command, args }); return { confirmed: true }; } } };
  const engine = { stopWorkflowRun: async (workflowId, runId, stopRoot) => { assert.equal(workflowId, "workflow"); assert.equal(runId, "local-run"); await stopRoot(); return true; } };
  const actions = createHostEngineAdapters({ getWorkflowEngine: () => engine }, { revision: () => "r" }, () => {});
  try {
    const result = await actions.adapter.execute("workflows.stop", { workflowId: "workflow", runId: "local-run" }, { generation: 42, grantRevision: 1,
      identity: { device, opId: "stop-local", opSeq: 9 }, context: { activeThread: { id: "local-thread" }, activeWorkspace: project }, assertAllowed() {} });
    assert.equal(result.state, "accepted");
    assert.equal(calls[0].command, "remote_work_owner_retire");
    assert.equal(calls[0].args.ownerHandle, "local-workflow-owner");
    assert.equal(calls[0].args.stamp.opId, "stop-local");
    assert.equal(calls.some((call) => call.command === "codex_rpc"), false);
  } finally { actions.dispose(); remoteEngineStopped("local-workflow-owner"); globalThis.window = before; }
});

test("Run/Checks commands resolve the host recipe and report exact native acceptance; Stop fences its owner", async () => {
  const { appendHostCommandOutput, createHostCommandActions, hostCommandRows, useHostCommands } = await import("./commandActions.ts");
  const before = globalThis.window, calls = [];
  let complete;
  useHostCommands.setState({ records: new Map() });
  const hostProject = { ...project, overrides: { check: { command: "host-check", updatedAt: 1 } } };
  const sources = { getWorkspaces: () => [hostProject], getGrant: () => grant, isLocalCommandRunning: () => false, executionPathFor: () => "/host/isolated" };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_owner_open") return { ownerHandle: "checks-owner" };
    if (command === "remote_work_engine_step") return { state: "preparing", delivery: { device, opId: "checks-child", opSeq: 1, attemptId: "checks-attempt", messageId: "checks-message" } };
    if (command === "codex_rpc") return new Promise((resolve) => { complete = resolve; });
    if (command === "remote_work_recover") return { disposition: "accepted" };
    if (command === "remote_work_owner_retire") { complete({ exitCode: 130, stdout: "", stderr: "" }); return { confirmed: true }; }
    if (command === "remote_work_owner_finish") return { confirmed: true };
    return null;
  } } };
  const root = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: "start-checks", opSeq: 1 }, workspaceId: project.id, threadId: "thread", permission: "ask", provider: "claude",
    isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
  const context = { activeWorkspace: hostProject, activeThread: { id: "thread" }, effectiveSettings: { permission: "ask" } };
  const operation = { generation: 42, grantRevision: 1, identity: root.identity, context, delivery: root, assertAllowed() {} };
  const actions = createHostCommandActions(sources, () => true);
  try {
    await root.beforeCreate();
    const result = await actions.execute("checks.start", {}, operation);
    assert.ok(result.processHandle);
    const native = calls.find((call) => call.command === "codex_rpc");
    assert.equal(native.args.method, "command/exec");
    assert.equal(native.args.params.cwd, "/host/isolated");
    assert.ok(native.args.params.command.includes("host-check"));
    assert.equal(native.args.params.remoteDelivery.opId, "checks-child");
    assert.equal(native.args.params.remoteDelivery.ownerHandle, "checks-owner");
    assert.equal(useHostCommands.getState().records.get(result.processHandle).status, "running");
    assert.equal(appendHostCommandOutput("unowned", "some-local-process"), false);
    assert.equal(appendHostCommandOutput("A", `remote-command-${result.processHandle}`), true);
    assert.equal(appendHostCommandOutput("B", `remote-command-${result.processHandle}`), true);
    assert.equal(hostCommandRows("checks", context)[0].text, "AB");
    assert.deepEqual(hostCommandRows("checks", { ...context, activeThread: { id: "other" } }), []);
    appendHostCommandOutput("x".repeat(20000), `remote-command-${result.processHandle}`);
    assert.ok(hostCommandRows("checks", context)[0].text.length <= 12000);
    assert.equal("root" in hostCommandRows("checks", context)[0], false);
    await assert.rejects(actions.execute("checks.stop", { processHandle: result.processHandle }, { ...operation, context: { ...context, activeThread: { id: "other" } } }), (error) => error.code === "stale_target");
    const stopped = await actions.execute("checks.stop", { processHandle: result.processHandle }, { ...operation, identity: { device, opId: "stop-checks", opSeq: 2 } });
    assert.equal(stopped.state, "accepted");
    assert.equal(useHostCommands.getState().records.get(result.processHandle).status, "interrupted");
    assert.equal(calls.filter((call) => call.command === "codex_rpc").length, 1);
    assert.equal(calls.find((call) => call.command === "remote_work_owner_retire").args.stamp.opId, "stop-checks");
  } finally { actions.dispose(); remoteEngineStopped("checks-owner"); globalThis.window = before; }
});

test("real local command-only workflow exposes its owner before the first command and remote Stop never resurrects it", async () => {
  const { createHostEngineAdapters } = await import("./engineAdapters.ts");
  resetTaskStore();
  const unwatch = watchOwnerCompletion();
  const before = globalThis.window, calls = [], errors = [];
  let complete, ready;
  const commandReady = new Promise((resolve) => { ready = resolve; });
  globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "remote_local_owner_open") return { ownerHandle: "local-command-owner" };
    if (command === "codex_rpc" && args.method === "thread/start") return { thread: { id: "local-command-thread", cwd: project.path, modelProvider: "openai" }, model: "model" };
    if (command === "codex_rpc" && args.method === "command/exec") return new Promise((resolve) => { complete = resolve; ready(); });
    if (command === "remote_work_owner_retire") { complete({ exitCode: 130, stdout: "", stderr: "" }); return { confirmed: true }; }
    if (command === "remote_local_owner_finish") return { confirmed: true };
    return null;
  } } };
  const run = { ...DEFAULT_SETTINGS, provider: "openai", model: "model", permission: "ask", subagentsEnabled: false };
  const workflow = { id: "local-command-recipe", name: "Local fixture", projectId: project.id, enabled: false, trigger: { type: "manual" }, skillNames: [], variables: [], run,
    steps: [{ id: "command", name: "Command", type: "command", command: "echo local", continueOnError: false }], createdAt: 1, updatedAt: 1 };
  let engine, localCheckpoints = 0;
  function Fixture() {
    engine = useWorkflowEngine({ workflows: [workflow], projects: [project], trackNativeOwners: true, runtimeAvailable: true, chatGptConnected: true,
      customAgents: [], ensureSkillRoots: async () => {}, resolveSkillPrompt: async (text) => text, bindThreadToProject() {},
      beginRunCheckpoint: async () => { localCheckpoints += 1; return undefined; }, finalizeRunCheckpoint: async () => {}, discardRunCheckpoint() {}, updateWorkflow() {},
      recordRun() {}, onThreadStarted() {}, onError: (reason) => errors.push(reason) });
    return React.createElement("span");
  }
  let actions;
  try {
    renderToString(React.createElement(Fixture));
    const running = engine.runWorkflow(workflow.id, "manual", {}, project.id);
    await commandReady;
    const runId = useTaskStore.getState().workflowOwners["local-command-thread"].runId;
    assert.equal(remoteEngineOwner("local-command-thread", undefined, runId)?.ownerHandle, "local-command-owner");
    assert.equal(calls.find((call) => call.command === "codex_rpc" && call.args.method === "command/exec").args.params.localOwnerHandle, "local-command-owner");
    assert.equal(localCheckpoints, 1);
    actions = createHostEngineAdapters({ getWorkflowEngine: () => engine }, { revision: () => "r" }, () => {});
    const stopped = await actions.adapter.execute("workflows.stop", { workflowId: workflow.id, runId }, {
      generation: 42, grantRevision: 1, identity: { device, opId: "remote-stop-local-command", opSeq: 8 },
      context: { activeWorkspace: project, activeThread: { id: "local-command-thread" } }, assertAllowed() {} });
    assert.equal(stopped.state, "accepted");
    await running;
    assert.deepEqual(errors, []);
    assert.equal(remoteEngineOwner("local-command-thread", undefined, runId), undefined);
    assert.equal(useTaskStore.getState().workflowOwners["local-command-thread"], undefined);
    assert.equal(calls.some((call) => call.command === "codex_rpc" && call.args.method === "command/exec/terminate"), false);
    assert.equal(calls.some((call) => call.command === "remote_local_owner_finish"), false);
  } finally { unwatch(); actions?.dispose(); remoteEngineStopped("local-command-owner"); globalThis.window = before; }
});

test("two viewers cannot reserve the same checkout command while owner_open is awaiting", async () => {
  const { createHostCommandActions, useHostCommands } = await import("./commandActions.ts");
  const { HostReadError } = await import("./scope.ts");
  useHostCommands.setState({ records: new Map() });
  const hostProject = { ...project, overrides: { run: { command: "host-run", updatedAt: 1 } } };
  const sources = { getWorkspaces: () => [hostProject], getGrant: () => grant, isLocalCommandRunning: () => false, executionPathFor: () => project.path };
  let rejectOwner, ownersOpened = 0;
  const operation = { generation: 42, identity: { device, opId: "reservation", opSeq: 1 }, context: { activeWorkspace: hostProject, effectiveSettings: { permission: "ask" } },
    delivery: { assertAllowed() {}, childStep() {}, openOwner() { ownersOpened++; return new Promise((_, reject) => { rejectOwner = reject; }); } } };
  const a = createHostCommandActions(sources, () => true), b = createHostCommandActions(sources, () => true);
  try {
    const first = a.execute("run.start", {}, operation);
    await assert.rejects(b.execute("run.start", {}, operation), (error) => error.code === "busy");
    assert.equal(ownersOpened, 1);
    rejectOwner(new HostReadError("forbidden", "Grant revoked before admission"));
    await assert.rejects(first, (error) => error.code === "forbidden");
    operation.delivery.openOwner = async () => { ownersOpened++; throw new HostReadError("unsupported", "Native alias not installed"); };
    await assert.rejects(b.execute("run.start", {}, operation), (error) => error.code === "unsupported");
    assert.equal(ownersOpened, 2); // Refusal released the reservation.
    assert.equal(useHostCommands.getState().records.size, 0);
  } finally { a.dispose(); b.dispose(); }
});

test("discovery settings use the saved discovery catalog choice, not the thread model", async () => {
  const { resolveDiscoverySettings } = await import("./discoverySettings.ts");
  const { assertParityAuthority } = await import("./parityActions.ts");
  const sources = { getProviderCatalog: () => [
    { id: "openai", models: [{ id: "thread-model", efforts: ["low"] }] },
    { id: "claude", models: [{ id: "discovery-model", efforts: ["low", "high"], defaultEffort: "low" }] },
  ] };
  const saved = { provider: "claude", model: "discovery-model", effort: "low", fast: false };
  const next = resolveDiscoverySettings(sources, saved, { effort: "high" });
  assert.equal(next.provider, "claude"); assert.equal(next.model, "discovery-model"); assert.equal(next.effort, "high"); assert.equal(next.fast, false);
  assert.throws(() => resolveDiscoverySettings(sources, saved, { model: "viewer-invented-model" }), (error) => error.code === "unsupported");
  assert.throws(() => resolveDiscoverySettings(sources, saved, { effort: "max" }), (error) => error.code === "unsupported");
  const switched = resolveDiscoverySettings(sources, saved, { provider: "openai" });
  assert.equal(switched.model, "thread-model"); assert.equal(switched.effort, "low");
  assert.equal(switched.models.claude, "discovery-model");
  assert.doesNotThrow(() => assertParityAuthority("run.status", { view: true, work: false, capabilities: { terminal: false } }));
  assert.throws(() => assertParityAuthority("run.start", { view: true, work: true, capabilities: { terminal: false } }), (error) => error.code === "forbidden");
});

test("a recovery refusal cannot downgrade a native-latched command child into a retryable root rejection", async () => {
  const { createHostCommandActions, useHostCommands } = await import("./commandActions.ts");
  const before = globalThis.window;
  let complete;
  useHostCommands.setState({ records: new Map() });
  const hostProject = { ...project, overrides: { check: { command: "host-check", updatedAt: 1 } } };
  const sources = { getWorkspaces: () => [hostProject], getGrant: () => grant, isLocalCommandRunning: () => false, executionPathFor: () => project.path };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_owner_open") return { ownerHandle: "uncertain-command-owner" };
    if (command === "remote_work_engine_step") return { state: "preparing", delivery: { device, opId: "uncertain-command-child", opSeq: 1, attemptId: "attempt", messageId: "message" } };
    if (command === "codex_rpc") return new Promise((resolve) => { complete = resolve; });
    if (command === "remote_work_recover") throw "MYTHRA_REMOTE_REJECTED:forbidden";
    // Simulate native input already latched: it will not persist a rejection
    // of a child which may have executed, even if a later read loses authority.
    if (command === "remote_work_receipt" && args.opId === "uncertain-command-child" && args.disposition === "rejected") throw "Cannot reject a native-latched receipt";
    if (command === "remote_work_owner_finish") return { confirmed: true };
    return null;
  } } };
  const root = new RemoteDeliveryJournal({ generation: 42, identity: { device, opId: "uncertain-command-root", opSeq: 1 }, workspaceId: project.id, permission: "ask", provider: "openai",
    isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
  const actions = createHostCommandActions(sources, () => true);
  try {
    await root.beforeCreate();
    const operation = { generation: 42, identity: root.identity, context: { activeWorkspace: hostProject, effectiveSettings: { permission: "ask" } }, delivery: root };
    let failure;
    try { await actions.execute("checks.start", {}, operation); } catch (reason) { failure = reason; }
    assert.equal(failure?.code, "uncertain");
    await root.failure(failure);
    assert.equal(root.result().state, "uncertain");
    assert.equal([...useHostCommands.getState().records.values()][0].status, "uncertain");
    complete({ exitCode: 0, stdout: "done", stderr: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally { actions.dispose(); remoteEngineStopped("uncertain-command-owner"); globalThis.window = before; }
});
