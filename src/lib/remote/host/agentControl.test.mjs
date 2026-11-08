import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { executeHostAgentControl } from "./agentControl.ts";
import { WorkTargets } from "./targetHandles.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { HostReadError } from "./scope.ts";

function fixture(provider = "openai", options = {}) {
  resetTaskStore();
  const previous = globalThis.window;
  const calls = [], project = { id: "p", name: "Project", path: "/host/project" };
  let allowed = true, finished = 0, hook = async (_root, _worker, cutoff, check) => { check(); await cutoff(); check(); finished++; };
  const grant = { revision: 1, scope: { kind: "all" }, view: true, work: true, capabilities: { fullAccess: false, terminal: false } };
  const threads = Object.fromEntries(["root", "child"].map((id) => [id, { id, cwd: project.path, modelProvider: provider, preview: "", updatedAt: 1 }]));
  for (const id of ["root", "child"]) {
    useTaskStore.getState().ensureTask(id, project.path);
    useTaskStore.getState().setActiveTurn(id, `${id}-turn`);
    useTaskStore.getState().setTaskStatus(id, "running");
  }
  useTaskStore.getState().appendUserMessage("child", { id: "child-msg", role: "user", text: "Child work", turnId: "child-turn" });
  if (options.idle) { useTaskStore.getState().completeTurn("root", "root-turn", "completed"); }
  const worker = { id: "child", kind: "cross-provider", status: "working", provider, title: "Handle @literal evidence", createdAt: 1, activationId: "activation", canStop: true };
  const sources = {
    getWorkspaces: () => [project], getKnownThreads: () => threads, getBindings: () => ({ root: project.path, child: project.path }),
    getOwnershipLinks: () => ({ child: { rootThreadId: "root" } }), getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(),
    getRuntime: () => ({ available: true }), getGrant: () => allowed ? grant : null, executionPathFor: (_id, path) => path,
    getSettings: () => ({ ...DEFAULT_SETTINGS, provider }), getThreadModels: () => ({}), getThreadReasoning: () => ({}), getThreadSubagents: () => ({}),
    getRuntimeModels: () => [], getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false,
    getBaseContext: () => ({ scheduleClaudeThreadSave: (id) => calls.push(["save-claude", id]), scheduleCursorThreadSave: (id) => calls.push(["save-cursor", id]) }),
    getThreadCrew: () => ({ maxConcurrent: 2, targets: [{ id: "approved", provider, label: "Host approved", enabled: true, model: "host-model" }] }),
    getAgentLifecycle: () => ({ stopWorker: (...args) => hook(...args) }),
  };
  const check = () => { if (!allowed) throw new HostReadError("forbidden", "Revoked"); };
  const snapshot = (id) => { const task = useTaskStore.getState().tasks[id]; return { threadId: id, turnId: task.activeTurnId, agentRunId: task.agentRunId, runStartedAt: task.agentRunStartedAt }; };
  const childDelivery = { identity: { device: "device", opId: "fresh-child", opSeq: 1 }, messageId: "child-message", metadata: () => ({ ownerHandle: "owner" }) };
  const delivery = { identity: { device: "device", opId: "op", opSeq: 1 }, attemptId: "attempt", messageId: "message", state: "preparing", assertAllowed: check,
    async beforeDispatch(info) { check(); calls.push(["root-latch", info]); this.state = "dispatched"; },
    async accepted(info) { calls.push(["accepted", info]); this.state = "accepted"; },
    async uncertain() { calls.push(["uncertain"]); this.state = "uncertain"; },
    async openOwner(...args) { check(); calls.push(["owner", ...args]); return "owner"; },
    async childStep(...args) { check(); calls.push(["step", ...args]); return childDelivery; },
  };
  let cutoff = async () => ({ confirmed: true });
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "remote_work_target_register") return { handle: `${args.threadId}-native-target` };
    if (command === "remote_agent_stop") return cutoff(args);
    if (command === "remote_work_owner_finish") return { confirmed: true };
    assert.fail(`Unexpected native operation ${command}`);
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke } };
  const runner = { getThreadStopTarget: snapshot,
    async steerThread(context, text, expected) { calls.push(["steer", context, text, expected]); return { state: "accepted", threadId: "root" }; },
    async sendPromptTo(context, text) { calls.push(["send", context, text]); return { state: "accepted", threadId: "root" }; } };
  const context = { activeThread: threads.root, activeWorkspace: project, activeProject: project, effectiveSettings: { ...DEFAULT_SETTINGS, provider } };
  const assignment = { rootThreadId: "root", childThreadId: "child", activationId: "activation", activationTurnId: "child-turn" };
  const resources = { resolveWorker(handle, device, root) { assert.equal(handle, "worker-target"); assert.equal(device, "device"); assert.equal(root, "root"); return worker; },
    input: () => ({ links: worker.kind === "native" ? {} : { child: assignment } }) };
  const targets = new WorkTargets(1, () => true);
  const operation = { context, identity: delivery.identity, generation: 1, grantRevision: 1, delivery, assertAllowed: check };
  return { calls, sources, worker, runner, delivery, operation, resources, assignment, get finished() { return finished; }, revoke() { allowed = false; },
    setHook(value) { hook = value; }, setCutoff(value) { cutoff = value; },
    execute(op = "agents.stop", args = {}) { return executeHostAgentControl(op, { agentId: "child", target: "worker-target", targetId: "approved", ...args }, operation,
      { sources, resources, runner, targets, ensureHydrated: async () => {}, transport: { invoke } }); },
    close() { targets.dispose(); globalThis.window = previous; resetTaskStore(); } };
}

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) test(`${provider} exact-child Stop uses only stamped native cutoff and shared settlement`, async () => {
  const f = fixture(provider); try {
    assert.equal((await f.execute()).state, "accepted");
    const stop = f.calls.find(([name]) => name === "remote_agent_stop")[1];
    assert.equal(stop.stamp.threadId, "root"); assert.equal(stop.childThreadId, "child"); assert.equal(stop.targetHandle, "child-native-target");
    assert.equal(f.calls.filter(([name]) => name === "remote_agent_stop").length, 1);
    assert.equal(f.finished, 1); assert.equal(useTaskStore.getState().tasks.child.status, "interrupted");
    assert.equal(useTaskStore.getState().tasks.root.activeTurnId, "root-turn");
    assert.equal(f.calls.some(([name]) => name === "remote_work_target_claim"), false);
  } finally { f.close(); }
});

test("revocation before cutoff does not dispatch or settle a child", async () => {
  const f = fixture(); try {
    f.setHook(async (_root, _worker, cutoff) => { f.revoke(); await cutoff(); });
    await assert.rejects(f.execute(), /Revoked/);
    assert.equal(f.calls.some(([name]) => name === "remote_agent_stop"), false);
    assert.equal(useTaskStore.getState().tasks.child.status, "running");
  } finally { f.close(); }
});

test("confirmed Stop still settles under host control if the grant disappears afterward", async () => {
  const f = fixture(); try {
    f.setCutoff(async () => { f.revoke(); return { confirmed: true }; });
    assert.equal((await f.execute()).state, "accepted"); assert.equal(f.finished, 1);
  } finally { f.close(); }
});

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) test(`${provider} Replace stops first, admits a fresh step, and steers the captured parent with literal host recipe`, async () => {
  const f = fixture(provider); try {
    assert.equal((await f.execute("agents.replace")).state, "accepted");
    const names = f.calls.map(([name]) => name);
    assert.ok(names.indexOf("remote_agent_stop") < names.indexOf("owner"));
    assert.ok(names.indexOf("owner") < names.indexOf("step"));
    const step = f.calls.find(([name]) => name === "step");
    assert.deepEqual(step.slice(1), ["replacement-instruction", "root", "prompt", "root-native-target"]);
    const steer = f.calls.find(([name]) => name === "steer");
    assert.equal(steer[1].remoteDelivery.identity.opId, "fresh-child"); assert.equal(steer[1].skillInvocationText, "");
    assert.equal(steer[1].resolveSkillMentions, false); assert.match(steer[2], /Host approved/); assert.match(steer[2], /fresh child/);
    assert.equal(steer[3].threadId, "root");
    assert.equal(names.filter((name) => name === "remote_work_owner_finish").length, 1);
  } finally { f.close(); }
});

test("idle-parent Replace uses a fresh prompt, refuses raced queueing, and never steals a selected draft", async () => {
  const f = fixture("openai", { idle: true }); try {
    assert.equal((await f.execute("agents.replace")).state, "accepted");
    const send = f.calls.find(([name]) => name === "send");
    assert.equal(send[1].activeThread.id, "root"); assert.equal(send[1].remoteRequireIdle, true);
    assert.deepEqual(send[1].attachments, []); assert.equal(f.calls.some(([name]) => name === "steer"), false);
  } finally { f.close(); }
});

test("Replace rejects an unapproved destination before stopping real work", async () => {
  const f = fixture(); try {
    await assert.rejects(f.execute("agents.replace", { targetId: "viewer-invented" }), /not approved/);
    assert.equal(f.calls.some(([name]) => name === "remote_agent_stop"), false);
  } finally { f.close(); }
});

test("a parent turn change during Stop holds Replace uncertain and never sends an instruction", async () => {
  const f = fixture(); try {
    f.setCutoff(async () => { useTaskStore.getState().setActiveTurn("root", "new-turn"); return { confirmed: true }; });
    await assert.rejects(f.execute("agents.replace"), /changed/);
    assert.equal(f.delivery.state, "uncertain"); assert.equal(f.calls.some(([name]) => name === "step"), false);
  } finally { f.close(); }
});

test("uncertain replacement input is never retried or queued under another identity", async () => {
  const f = fixture(); try {
    f.runner.steerThread = async () => ({ state: "uncertain" });
    await assert.rejects(f.execute("agents.replace"), /not confirmed/);
    assert.equal(f.delivery.state, "uncertain"); assert.equal(f.calls.filter(([name]) => name === "step").length, 1);
    assert.equal(f.calls.some(([name]) => name === "send"), false);
  } finally { f.close(); }
});

test("a synthetic Claude native child retains the same explicit root-Stop-only boundary as local", async () => {
  const f = fixture(); try {
    f.worker.nativeRuntime = "claude";
    await assert.rejects(f.execute(), /share their root process/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) test(`${provider} fresh engine steer preserves provider and exact target through the real delivery journal`, async () => {
  const old = globalThis.window, calls = [];
  const grant = { revision: 1, work: true, view: true };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_engine_step") return { state: "preparing", delivery: { device: "d", opId: "engine:child", opSeq: 1, attemptId: "ca", messageId: "cm" } };
    if (command === "remote_work_dispatch") return {};
    assert.fail(command);
  } } };
  try {
    const root = new RemoteDeliveryJournal({ identity: { device: "d", opId: "root", opSeq: 9 }, generation: 1, workspaceId: "p", permission: "ask", provider, owner: { kind: "start", runId: "run", handle: "owner", threadId: "root" },
      isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
    const child = await root.childStep("replace", "root", "prompt", "observed-parent");
    await child.invokeSteer("claude_turn_steer", { threadId: "root", prompt: "literal" });
    assert.equal(calls.find(([name]) => name === "remote_work_engine_step")[1].targetHandle, "observed-parent");
    assert.equal(calls.find(([name]) => name === "remote_work_engine_step")[1].provider, provider);
    const dispatch = calls.find(([name]) => name === "remote_work_dispatch")[1];
    assert.equal(dispatch.targetHandle, "observed-parent"); assert.equal(dispatch.opId, "engine:child"); assert.equal(dispatch.ownerHandle, "owner");
  } finally { globalThis.window = old; }
});

test("Codex-native Stop uses the same stamped owner boundary rather than the parent's provider stop", async () => {
  const f = fixture(); try {
    f.worker.kind = "native"; f.worker.nativeRuntime = "codex";
    assert.equal((await f.execute()).state, "accepted");
    assert.equal(f.calls.find(([name]) => name === "remote_agent_stop")[1].childThreadId, "child");
    assert.equal(useTaskStore.getState().tasks.root.activeTurnId, "root-turn");
  } finally { f.close(); }
});

test("a child still starting uses its managed activationStartRequestId, not the unrelated runner's registry", async () => {
  const f = fixture("cursor"); try {
    f.worker.status = "starting";
    f.assignment.activationTurnId = undefined; f.assignment.activationStartRequestId = "child-start";
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, child: { ...state.tasks.child, activeTurnId: undefined, status: "starting" } }, statuses: { ...state.statuses, child: "starting" } }));
    assert.equal((await f.execute()).state, "accepted");
    const target = f.calls.find(([name]) => name === "remote_work_target_register")[1];
    assert.equal(target.kind, "start"); assert.equal(target.startRequestId, "child-start"); assert.equal(target.turnId, undefined);
    assert.equal(useTaskStore.getState().tasks.child.status, "interrupted");
  } finally { f.close(); }
});

test("streaming parent rows do not invalidate an exact child's Stop after admission", async () => {
  const f = fixture(); try {
    f.operation.assertAllowed = () => { throw new Error("Old public row revision"); };
    f.setHook(async (_root, _worker, cutoff, check) => {
      useTaskStore.getState().appendUserMessage("root", { id: "streamed-row", role: "assistant", text: "More parent activity" });
      check(); await cutoff(); check();
    });
    assert.equal((await f.execute()).state, "accepted");
    assert.equal(useTaskStore.getState().tasks.root.activeTurnId, "root-turn");
  } finally { f.close(); }
});
