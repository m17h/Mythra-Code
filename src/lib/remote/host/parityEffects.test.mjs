import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { createHostEngineAdapters } from "./engineAdapters.ts";
import { executeParityMutation } from "./parityActions.ts";
import { executeQueueSteer } from "./queueSteer.ts";
const device = "b".repeat(64), workspace = { id: "project", path: "/host/project", name: "Host" };
const grant = { view: true, work: true, revision: 1, scope: { kind: "all" }, capabilities: { fullAccess: false, terminal: true } };
function harness(provider = "openai", options = {}) {
  resetTaskStore(); const oldWindow = globalThis.window, calls = [], events = [], values = { "kiwi.queuedTurns": options.queue ?? {} };
  const settings = { ...DEFAULT_SETTINGS, provider, model: "model", permission: "ask", subagentsEnabled: false };
  let alive = true, known = {};
  const identity = { device, opId: "root", opSeq: 1 };
  const delivery = new RemoteDeliveryJournal({ generation: 10, identity, workspaceId: workspace.id, provider, permission: "ask", targetHandle: "target",
    isCurrent: () => alive, assertAllowed() {}, validateGrant(g) { if (!g?.work) throw new Error("Revoked"); } });
  const context = { activeThread: null, activeWorkspace: workspace, activeProject: workspace, effectiveSettings: settings,
    customAgents: [], openRouterModels: [], lmStudioModels: [], ensureSkillRoots: async () => {},
    onCodexRuntimeOwned: (id) => events.push(`runtime:${id}`),
    bindThreadToProject(id) { events.push(`bind:${id}`); }, rememberThread(thread) { known[thread.id] = thread; },
    onThreadCreated(id, details) { assert.equal(details.deferred, true); events.push(`created:${id}`); },
    persistThreadModel() {}, persistThreadReasoning() {},
  };
  const operation = { context, identity, generation: 10, grantRevision: 1, assertAllowed() {}, delivery };
  globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_receipt" || command === "state_write") return null;
    if (command === "remote_work_owner_open") return { ownerHandle: "owner" };
    if (command === "remote_work_owner_bind") return { bound: true };
    if (command === "remote_work_queue_authorize") return { ready: true };
    if (command === "remote_state_snapshot") return { rows: args.keys.map((key) => ({ key, value: structuredClone(values[key]), revision: 1 })) };
    if (command === "remote_state_commit") {
      for (const write of args.writes) {
        if (!options.oldScheduling && args.queued && write.key === "kiwi.queuedTurns") for (const entries of Object.values(write.value)) for (const entry of entries) delete entry.remoteDelivery?.ownerHandle;
        values[write.key] = structuredClone(write.value);
      }
      return { result: { state: args.queued ? "queued" : "accepted" }, rows: args.writes.map((row) => ({ key: row.key, value: row.value, revision: 2 })) };
    }
    if (command === "remote_work_queue_steer_claim") {
      if (options.noClaim) throw "Command remote_work_queue_steer_claim not found";
      const entry = values["kiwi.queuedTurns"].thread[0];
      entry.status = "sending"; entry.remoteDelivery = { ...identity, workspaceId: workspace.id, attemptId: delivery.attemptId, messageId: delivery.messageId, disposition: "dispatched" };
      return { rows: [{ key: "kiwi.queuedTurns", revision: 2, value: structuredClone(values["kiwi.queuedTurns"]) }] };
    }
    if (command.startsWith("local_transcript_") && command.endsWith("_write")) return { generation: 1, headSeq: 0, tailSeq: 0 };
    if (command === "codex_rpc") {
      assert.equal(args.method, "thread/start", "Scheduling must not deliver provider input");
      return { thread: { id: "thread", cwd: workspace.path, modelProvider: provider, preview: "", updatedAt: 1 }, runtimeInstance: "runtime" };
    }
    assert.fail(`Unexpected command ${command}`);
  } } };
  const fallback = { revision: () => "revision", read: async () => ({ revision: "revision", rows: [] }), execute: async () => assert.fail("Raw App fallback") };
  const engines = createHostEngineAdapters({}, fallback, () => {});
  return { calls, events, operation, values, known: () => known, engines, context,
    close() { alive = false; engines.dispose(); globalThis.window = oldWindow; } };
}
for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) {
  test(`${provider} scheduleNew prepares an empty destination and admits a durable timed instruction without selecting or sending`, async () => {
    const h = harness(provider);
    try {
      const result = await executeParityMutation("prompt.scheduleNew", { workspaceId: workspace.id, revision: "revision", text: "Later", deliverAt: Date.now() + 60_000 }, h.engines.adapter,
        h.context, h.operation.identity, 10, h.operation.delivery, () => {});
      assert.equal(result.state, "queued", JSON.stringify(result)); assert.ok(result.threadId);
      const entry = h.values["kiwi.queuedTurns"][result.threadId][0];
      assert.equal(entry.text, "Later"); assert.equal(entry.remoteDelivery.opId, "root"); assert.equal(entry.remoteDelivery.provenance.kind, "schedule");
      assert.ok(entry.deliverAt > Date.now()); assert.ok(h.known()[result.threadId]);
      assert.equal(useTaskStore.getState().activeThreadId, null); assert.equal(useTaskStore.getState().tasks[result.threadId].messages.length, 0);
      const authorize = h.calls.find((call) => call.command === "remote_work_queue_authorize"); assert.equal(authorize.args.permission, "ask");
      assert.equal(h.calls.some((call) => /turn_start|turn\/start/.test(call.command) || call.args.method === "turn/start"), false);
    } finally { h.close(); }
  });
}
test("scheduleNew refuses isolation instead of silently scheduling in the shared folder", async () => {
  const h = harness(); h.context.draftThreadIsolated = true;
  try {
    await assert.rejects(h.engines.adapter.execute("prompt.scheduleNew", {}, h.operation), (reason) => reason.code === "unsupported");
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
for (const noClaim of [true, false]) test(`queued steering ${noClaim ? "refuses missing atomic claim before input" : "holds natively before input, consumes only after confirmation"}`, async () => {
  const h = harness("openai", { noClaim, queue: { thread: [{ id: "queue", threadId: "thread", text: "Steer", attachments: [], createdAt: 1, status: "queued" }] } });
  h.context.activeThread = { id: "thread", cwd: workspace.path };
  let called = false;
  try {
    const work = executeQueueSteer({ queueId: "queue", target: "target" }, h.operation, async (entry) => {
      called = true; assert.equal(entry.remoteDelivery.disposition, "dispatched");
      assert.equal(h.values["kiwi.queuedTurns"].thread[0].remoteDelivery.opId, "root");
      return { opId: "root", state: "accepted" };
    });
    if (noClaim) { await assert.rejects(work, (reason) => reason.code === "unsupported"); assert.equal(called, false); }
    else { assert.equal((await work).state, "accepted"); assert.equal(called, true); assert.deepEqual(h.values["kiwi.queuedTurns"].thread, []); }
  } finally { h.close(); }
});
test("unconfirmed queued steering remains held, not ordinary queued delivery", async () => {
  const h = harness("openai", { queue: { thread: [{ id: "queue", threadId: "thread", text: "Steer", attachments: [], createdAt: 1, status: "queued" }] } });
  h.context.activeThread = { id: "thread", cwd: workspace.path };
  try {
    await assert.rejects(executeQueueSteer({ queueId: "queue", target: "target" }, h.operation, async () => ({ state: "uncertain" })), (reason) => reason.code === "uncertain");
    assert.equal(h.values["kiwi.queuedTurns"].thread[0].remoteDelivery.disposition, "dispatched");
    assert.equal(h.calls.some((call) => call.command === "remote_state_commit"), false);
  } finally { h.close(); }
});
for (const op of ["agents.stop"]) test(`${op} refuses before old untagged App callback or dispatch latch`, async () => {
  const h = harness();
  try {
    const result = await executeParityMutation(op, { workspaceId: workspace.id, revision: "revision" }, h.engines.adapter,
      h.context, h.operation.identity, 10, h.operation.delivery, () => {});
    assert.equal(result.state, "rejected"); assert.equal(result.error.code, "unsupported");
    assert.equal(h.calls.some((call) => call.command === "remote_work_receipt" && call.args.disposition === "dispatched"), false);
  } finally { h.close(); }
});
test("authoritative rollback does not reinsert persisted questions or optimistic rows and retains unread", async () => {
  const h = harness();
  try {
    const { saveQuestionRequest } = await import("../../agentQuestionRecords.ts");
    useTaskStore.getState().ensureTask("thread", workspace.path);
    saveQuestionRequest("thread", { id: "rolled-back-question", role: "assistant", text: "Removed", turnId: "removed-turn", questions: [{ id: "q", title: "Private?", secret: true, options: [] }] });
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, thread: { ...state.tasks.thread, unread: true,
      messages: [{ id: "optimistic", role: "user", text: "Not delivered" }], approvals: [{ id: "old", method: "item/tool/requestUserInput", threadId: "thread", params: {}, receivedAt: 1 }] } } }));
    const token = useTaskStore.getState().approvalQueryToken;
    useTaskStore.getState().hydrateTask("thread", [], [], workspace.path, { hasMore: false, nextCursor: null, loading: false, paginated: false }, undefined, { preserveUnread: true, replaceTimeline: true });
    const task = useTaskStore.getState().tasks.thread;
    assert.deepEqual(task.messages, []); assert.deepEqual(task.approvals, []); assert.equal(task.unread, true);
    assert.notEqual(useTaskStore.getState().approvalQueryToken, token);
  } finally { h.close(); }
});
test("authoritative rollback hydration refuses to overwrite a newly running turn", () => {
  const h = harness();
  try {
    useTaskStore.getState().ensureTask("thread", workspace.path); useTaskStore.getState().setTaskStatus("thread", "running");
    assert.throws(() => useTaskStore.getState().hydrateTask("thread", [], [], workspace.path, undefined, undefined, { replaceTimeline: true }), /live turn/);
    assert.equal(useTaskStore.getState().tasks.thread.status, "running");
  } finally { h.close(); }
});

test("old scheduled preparation ownership is refused before any provider input", async () => {
  const h = harness("openai", { oldScheduling: true });
  try {
    const result = await executeParityMutation("prompt.scheduleNew", { workspaceId: workspace.id, revision: "revision", text: "Later", deliverAt: Date.now() + 60_000 }, h.engines.adapter,
      h.context, h.operation.identity, 10, h.operation.delivery, () => {});
    assert.equal(result.state, "rejected"); assert.equal(result.error.code, "unsupported");
    assert.equal(h.calls.some((call) => call.args.method === "turn/start"), false);
  } finally { h.close(); }
});
