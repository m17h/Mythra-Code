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
  isLiveRemoteEngineOwner, clearRemoteEngineOwners } from "./engineOwners.ts";

const project = { id: "project", path: "/host/project", name: "Project" };
const device = "a".repeat(64);
const grant = { revision: 1, view: true, work: true, scope: { kind: "all" }, capabilities: { fullAccess: false, terminal: true } };
const owner = (handle) => ({ generation: 42, threadId: handle, runId: "run", kind: "workflow", ownerHandle: handle });

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
        beginRunCheckpoint: async () => undefined, finalizeRunCheckpoint: async () => {}, discardRunCheckpoint() {}, updateWorkflow() {},
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
    } finally { clearRemoteEngineOwners(42); globalThis.window = oldWindow; }
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
