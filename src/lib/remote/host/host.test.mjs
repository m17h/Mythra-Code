// No extra runner/dependency. Bundle with Vite's authorized SSR build, then
// run the emitted entry with node --test. Does not contact a native runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { saveQuestionAnswers } from "../../agentQuestionRecords.ts";
import { resetTaskStore, sanitizeStoredQueuedTurns, useTaskStore } from "../../taskStore.ts";
import { projectActivity, projectMessage } from "./projection.ts";
import { diffProjection } from "./diff.ts";
import { HostWindows } from "./window.ts";
import { HostPublishers } from "./publisher.ts";
import { remoteApprovalResponse, approvalPolicy } from "./approvalActions.ts";
import { requestQuestions, remoteQuestionResponse } from "./questionActions.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { resolveThreadExecutionContext } from "./executionContext.ts";
import { threadEligible } from "./scope.ts";
import { assertParityAuthority, projectParityRead, validateParityArgs } from "./parityActions.ts";
import { createRemoteWork } from "./workActions.ts";
import { WorkTargets } from "./targetHandles.ts";

const grant = { revision: 1, scope: { kind: "all" }, view: true, work: true,
  capabilities: { fullAccess: false, terminal: false, gitWrite: false, checkpointRestore: false, manageProjects: false } };
const project = { id: "p", name: "Host project", path: "/host/project", overrides: { systemPrompt: "project prompt", systemPromptMode: "replace" } };
const thread = { id: "t", cwd: project.path, modelProvider: "openai", preview: "", updatedAt: 0 };
const sources = () => ({
  getWorkspaces: () => [project], getKnownThreads: () => ({ t: thread }), getBindings: () => ({ t: project.path }),
  getOwnershipLinks: () => ({}), getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(),
  getRuntime: () => ({ available: true }), getGrant: () => grant, executionPathFor: (_id, path) => path,
  getSettings: () => ({ ...DEFAULT_SETTINGS, permission: "full" }), getThreadModels: () => ({ t: "saved-model" }),
  getThreadReasoning: () => ({ t: { reasoningEffort: "high", ultra: false } }), getThreadSubagents: () => ({}),
  getRuntimeModels: () => [], getBaseContext: () => ({ activeThread: { id: "wrong" }, effectiveSettings: { provider: "cursor" } }),
  getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false, onRemoteCodexRuntimeOwned: () => {},
});
const approval = (method, params = {}) => ({ id: 1, threadId: "t", receivedAt: 1, method, params });
const snapshot = (messages = [], activities = []) => ({ status: "running", availability: "ready", activeTurnId: "turn", workingStartedAt: 1,
  error: null, messages, activities, approvals: [], queuedTurns: [], history: { hasMore: false } });
const message = (text, order = 1, id = "m") => ({ id, text, order, role: "assistant", turnId: "turn", turnStatus: null, streaming: true });

test("append delta is used only for append-only text; rewrite, reorder, prepend and sealing are represented", () => {
  const a = snapshot([message("a")]);
  assert.deepEqual(diffProjection(a, snapshot([message("abc")])).appendMessageText, [{ id: "m", text: "bc" }]);
  assert.ok(diffProjection(a, snapshot([message("rewritten")])).reset);
  assert.ok(diffProjection(a, snapshot([message("a", 7)])).reset);
  assert.ok(diffProjection(a, snapshot([message("older", 0, "old"), message("a")])).reset);
  const sealed = { ...message("a"), streaming: false, turnStatus: "interrupted" };
  assert.deepEqual(diffProjection(a, { ...snapshot([sealed]), status: "interrupted" }).upsertMessages, [sealed]);
  assert.equal(diffProjection(a, structuredClone(a)), null);
});

test("multiple viewers share a drain/project boundary without consuming one another's baseline", () => {
  resetTaskStore();
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.getState().appendUserMessage("t", { id: "one", role: "user", text: "one" });
  const frames = [];
  const windows = new HostWindows();
  const publisher = new HostPublishers(sources(), { thread: () => thread, eligible: () => true, ownership: () => ({}) },
    { availability: () => "ready" }, windows, { generation: 1, publish: (p) => frames.push(p), invalidate: () => assert.fail("scope changed"), retired: () => {} });
  try {
    const first = publisher.subscribe("t", "A", grant, {});
    const second = publisher.subscribe("t", "B", grant, {});
    assert.equal(first.seq, second.seq); assert.equal(frames.length, 1);
    publisher.subscribers("t", 2);
    useTaskStore.getState().appendUserMessage("t", { id: "two", role: "user", text: "two" });
    publisher.tick();
    const third = publisher.subscribe("t", "C", grant, {});
    assert.equal(third.seq, 2); assert.equal(frames.length, 2);
    assert.deepEqual(third.snapshot.messages.map((m) => m.id), ["one", "two"]);
  } finally { publisher.dispose(); }
});

test("projection redacts secret answers and diagnostic exceptions", () => {
  saveQuestionAnswers("t", "secret-question", { password: ["DO-NOT-SERIALIZE"] });
  const projected = projectMessage("t", { id: "secret-question", role: "assistant", text: "Question", questions: [{ id: "password", title: "Password", secret: true }] }, 1);
  assert.equal(JSON.stringify(projected).includes("DO-NOT-SERIALIZE"), false);
  assert.deepEqual(projected.questions[0].answers, ["[Redacted]"]);
  const activity = projectActivity({ id: "e", kind: "warning", title: "credentials", detail: "DO-NOT-SERIALIZE" }, 1);
  assert.equal(JSON.stringify(activity).includes("DO-NOT-SERIALIZE"), false);
});

test("remote queue restore holds dispatched and malformed entries, never silently converts them to local", () => {
  const base = { id: "q", threadId: "t", text: "hi", attachments: [], status: "sending", createdAt: 1 };
  const remote = { device: "device", opId: "op", opSeq: 1, workspaceId: "p", attemptId: "attempt", messageId: "message", disposition: "dispatched" };
  const restored = sanitizeStoredQueuedTurns({ t: [{ ...base, remoteDelivery: remote }] }).t[0];
  assert.equal(restored.status, "failed"); assert.equal(restored.remoteDelivery.disposition, "uncertain");
  assert.equal(sanitizeStoredQueuedTurns({ t: [{ ...base, remoteDelivery: null }] }).t[0].status, "failed");
  const queued = sanitizeStoredQueuedTurns({ t: [{ ...base, remoteDelivery: { ...remote, disposition: "queued" } }] }).t[0];
  assert.equal(queued.remoteDelivery.needsRecovery, true);
});

test("Cursor cannot fall back to stronger permissions; unsupported methods and escalation fail closed", () => {
  const cursor = approval("cursor/request_permission", { options: [{ kind: "allow_always", optionId: "strong" }, { kind: "reject_once", optionId: "deny" }] });
  assert.equal(approvalPolicy(cursor).canAllowOnce, false);
  assert.throws(() => remoteApprovalResponse(cursor, "allowOnce"));
  assert.deepEqual(remoteApprovalResponse(cursor, "deny"), { outcome: { outcome: "selected", optionId: "deny" } });
  assert.throws(() => remoteApprovalResponse(approval("item/permissions/requestApproval"), "allowOnce"));
  assert.throws(() => remoteApprovalResponse(approval("new/unknown"), "deny"));
  assert.equal("updatedPermissions" in remoteApprovalResponse(approval("claude/can_use_tool", { input: {}, permission_suggestions: ["escalate"] }), "allowOnce"), false);
});

test("question forms are allowlisted and secret values never occur in question projections", () => {
  const pending = approval("item/tool/requestUserInput", { questions: [{ id: "secret", question: "Secret?", isSecret: true, answers: ["DO-NOT-SERIALIZE"], options: [{ label: "Yes", hidden: "DO-NOT-SERIALIZE" }] }] });
  assert.equal(JSON.stringify(requestQuestions(pending)).includes("DO-NOT-SERIALIZE"), false);
  assert.deepEqual(remoteQuestionResponse(pending, { secret: ["transient answer"] }), { answers: { secret: { answers: ["transient answer"] } } });
  assert.throws(() => remoteQuestionResponse(pending, { wrong: ["value"] }));
  assert.deepEqual(remoteQuestionResponse(pending, undefined, true), { answers: {} });
});

test("all five providers resolve host target settings, not selected renderer settings; ceiling preserves read-only", () => {
  for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) {
    const src = sources();
    src.getKnownThreads = () => ({ t: { ...thread, modelProvider: provider } });
    src.getThreadModels = () => ({ t: provider === "openrouter" ? "vendor/model" : "saved-model" });
    const resolved = resolveThreadExecutionContext(src, { threadId: "t" }, "remote");
    assert.equal(resolved.activeThread.id, "t"); assert.equal(resolved.effectiveSettings.provider, provider);
    assert.equal(resolved.effectiveSettings.permission, "ask"); assert.equal(resolved.effectiveSettings.reasoningEffort, "high");
    src.getSettings = () => ({ ...DEFAULT_SETTINGS, permission: "read-only" });
    assert.equal(resolveThreadExecutionContext(src, { threadId: "t" }, "remote").effectiveSettings.permission, "read-only");
  }
  const src = sources();
  src.getArchivedThreadIds = () => new Set(["t"]); src.getOwnershipLinks = () => ({ t: { rootThreadId: "root" } });
  assert.equal(threadEligible(src, thread), true);
  src.getUnavailableThreadIds = () => new Set(["t"]); assert.equal(threadEligible(src, thread), false);
});

test("journal dispatch latch precedes native work, forwards exact target, and uncertainty cannot be downgraded", async () => {
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_receipt" && args.disposition === "accepted") throw new Error("lost acknowledgement");
    return undefined;
  } } };
  try {
    const journal = new RemoteDeliveryJournal({ generation: 1, identity: { device: "d", opId: "op", opSeq: 1 }, workspaceId: "p",
      threadId: "t", targetHandle: "opaque", isCurrent: () => true, assertAllowed: () => {}, validateGrant: () => {} });
    await journal.beforeCreate();
    await journal.beforeDispatch({ threadId: "t", messageId: journal.messageId, provider: "openai" });
    await journal.invokeSteer("question_answer", { result: { answers: { secret: ["TRANSIENT-SECRET"] } } });
    const native = calls.findIndex((c) => c.command === "remote_work_dispatch");
    assert.ok(calls.slice(0, native).some((c) => c.args.disposition === "dispatched"));
    assert.equal(calls[native].args.targetHandle, "opaque");
    assert.equal(JSON.stringify(calls.filter((c) => c.command === "remote_work_receipt")).includes("TRANSIENT-SECRET"), false);
    await journal.accepted({ threadId: "t", turnId: "turn" });
    await journal.rejected("forbidden");
    assert.equal(journal.result().state, "uncertain");
  } finally { delete globalThis.window; }
});

test("parity routes reject paths, unconfirmed destruction and missing capability; projections drop raw fields", () => {
  assert.throws(() => validateParityArgs("queue.remove", { workspaceId: "p", threadId: "t", queueId: "q", revision: "r", cwd: "/wrong" }));
  assert.throws(() => validateParityArgs("thread.rollback", { workspaceId: "p", threadId: "t", revision: "r", messageId: "m" }));
  assert.throws(() => assertParityAuthority("projects.instructions.set", grant));
  assert.throws(() => assertParityAuthority("projects.run.set", grant));
  const result = projectParityRead({ revision: "r", rows: [{ id: "x", name: "Name", absolutePath: "/private", rawParams: { password: "SECRET" } }], truncated: false });
  assert.deepEqual(result.rows, [{ id: "x", name: "Name" }]);
});

test("an approval with reused id and receivedAt cannot answer the replaced request", async () => {
  resetTaskStore();
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async () => ({ handle: "opaque-request" }) } };
  const original = approval("execCommandApproval");
  const targets = new WorkTargets(1, () => true);
  try {
    useTaskStore.getState().enqueueApproval(original);
    const handle = await targets.register({ device: "d", workspaceId: "p", provider: "openai", approval: original }, "approval");
    useTaskStore.getState().resolveApproval("t", 1);
    useTaskStore.getState().enqueueApproval({ ...original, params: { replacement: true } });
    assert.throws(() => targets.resolve(handle.handle, "d", "t"));
  } finally { targets.dispose(); delete globalThis.window; }
});

test("a native-confirmed undelivered queue is rejected, not pumped, after Work is removed", async () => {
  resetTaskStore();
  const src = sources();
  src.getGrant = () => ({ ...grant, work: false });
  const remote = { device: "d", opId: "original", opSeq: 1, workspaceId: "p", attemptId: "attempt", messageId: "message", disposition: "queued" };
  const entry = useTaskStore.getState().enqueueTurn("t", "queued instruction", [], { remoteDelivery: remote });
  const receipts = [];
  let pumps = 0;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "remote_work_recover") return { disposition: "queued", threadId: "t", queuedTurnId: entry.id, attemptId: "attempt", messageId: "message" };
    if (command === "remote_work_grant") return { ...grant, work: false };
    if (command === "remote_work_receipt") receipts.push(args);
  } } };
  const work = createRemoteWork({ generation: 1, sources: src, isCurrent: () => true, findThread: () => thread,
    ensureHydrated: async () => {}, getRunner: () => ({ pumpRemoteQueue: () => { pumps++; } }), stop: {} });
  try {
    await work.reconcileQueues();
    assert.equal(pumps, 0);
    assert.equal(useTaskStore.getState().tasks.t.queuedTurns[0].remoteDelivery.disposition, "rejected");
    assert.ok(receipts.some((r) => r.opId === "original" && r.disposition === "rejected" && r.errorCode === "forbidden"));
  } finally { work.dispose(); delete globalThis.window; }
});

test("worktree replacement during preparation is detected before provider dispatch", async () => {
  resetTaskStore();
  const src = sources();
  let checkout = "/host/owned-worktree";
  src.executionPathFor = () => checkout;
  const receipts = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_receipt") receipts.push(args);
  } } };
  const work = createRemoteWork({ generation: 1, sources: src, isCurrent: () => true, findThread: () => thread,
    ensureHydrated: async () => {}, getRunner: () => ({ sendPromptTo: async (ctx) => {
      await ctx.remoteDelivery.beforeCreate();
      checkout = "/host/replacement";
      await ctx.remoteDelivery.beforeDispatch({ threadId: "t", messageId: ctx.remoteDelivery.messageId, provider: "openai" });
      assert.fail("dispatch must not reach this point");
    } }), stop: {} });
  try {
    const result = await work.dispatch({ generation: 1, requestId: "request", device: "d", grant, op: "prompt.send", opId: "op", opSeq: 1,
      args: { opId: "op", opSeq: 1, threadId: "t", text: "hello" } });
    assert.equal(result.state, "rejected");
    assert.equal(result.error.code, "stale_target");
    assert.equal(receipts.some((r) => r.disposition === "dispatched"), false);
  } finally { work.dispose(); delete globalThis.window; }
});
