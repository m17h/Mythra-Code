// No extra runner/dependency. Bundle with Vite's authorized SSR build, then
// run the emitted entry with node --test. Does not contact a native runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { saveQuestionAnswers } from "../../agentQuestionRecords.ts";
import { resetTaskStore, sanitizeStoredQueuedTurns, useTaskStore } from "../../taskStore.ts";
import { projectActivity, projectMessage, projectApprovals } from "./projection.ts";
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
import { mountRemoteDevice, refreshRemoteDevice, useRemoteStore } from "../remoteStore.ts";
import { DraftTokens } from "./draftTokens.ts";
import { validateExecutionSettings, applyHostExecutionPreferences } from "./executionPreferences.ts";
import { reconcilePendingRequests } from "./pendingRequests.ts";
import { commitHostState, reconcileRemoteStateCommits } from "./stateCommit.ts";
import { flushPendingStateWrites, hasPendingStateWrites, loadStored, storeValue, subscribeRemoteStateAdoption } from "../../storage.ts";
import { rebasePersistedIntent } from "../../../hooks/usePersistedState.ts";
import { createHostSettingsActions } from "./settingsActions.ts";
import { createHostQueueActions } from "./queueActions.ts";

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

test("integration: real host publisher/projection -> real viewer store, gap resubscribe and lease replacement", async () => {
  resetTaskStore(); useRemoteStore.setState({ devices: {} });
  const device = "a".repeat(64), callbacks = new Map(), listeners = new Map();
  let callbackId = 0, subscriptions = 0, dropNext = false, lease = true;
  const emitted = [];
  const emit = (event, payload) => { const id = listeners.get(event); if (id) callbacks.get(id)?.({ event, payload }); };
  const windows = new HostWindows();
  const src = sources();
  const makePublisher = () => new HostPublishers(src, { thread: () => thread, eligible: () => true, ownership: () => ({}) },
    { availability: () => "ready" }, windows, { generation: 1,
      publish: (payload) => { for (const f of payload.frames) {
        emitted.push(f);
        if (dropNext) { dropNext = false; continue; }
        if (lease) emit("remote-viewer-frame", { device, threadId: payload.threadId, epoch: payload.epoch, ...f });
      } }, invalidate: () => { lease = false; emit("remote-viewer-state", { device, threadId: "t", state: "recovering" }); }, retired: () => {} });
  let publisher = makePublisher();
  globalThis.window = {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event) => listeners.delete(event) },
    __TAURI_INTERNALS__: {
      transformCallback: (fn) => { callbacks.set(++callbackId, fn); return callbackId; },
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return args.handler; }
        if (command === "plugin:event|unlisten") { listeners.delete(args.event); return; }
        if (command !== "remote_request") return;
        if (!lease) throw { code: "host_unavailable" };
        if (args.op === "workspaces.list") return { workspaces: [{ id: "p", name: "Host project", isChat: false }] };
        if (args.op === "threads.list") return { threads: [{ id: "t", workspaceId: "p", provider: "openai", title: "Thread", preview: "", updatedAt: 1, status: "running" }] };
        if (args.op === "timeline.unsubscribe") { publisher.subscribers("t", 0); return; }
        if (args.op === "timeline.subscribe") {
          subscriptions++;
          const reply = publisher.subscribe("t", device, grant, { epoch: args.args.epoch, needSnapshot: !args.args.epoch });
          publisher.subscribers("t", 1);
          if (!reply.snapshot) reply.frames = emitted.filter((f) => f.seq > args.args.afterSeq);
          return reply;
        }
        throw new Error(`Unexpected operation ${args.op}`);
      },
    },
  };
  const waitFor = async (predicate) => {
    const until = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > until) assert.fail("in-memory bridge did not converge"); await new Promise((r) => setTimeout(r, 5)); }
  };
  const view = () => useRemoteStore.getState().devices[device]?.timelines.get("t");
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.getState().setActiveTurn("t", "turn");
  useTaskStore.getState().setTaskStatus("t", "running");
  useTaskStore.getState().startAssistantMessage("t", { id: "assistant", role: "assistant", text: "A", turnId: "turn", streaming: true });
  const release = mountRemoteDevice(device);
  try {
    await waitFor(() => view()?.state === "live");
    useTaskStore.getState().queueAssistantDelta("t", "assistant", "B", "turn"); publisher.tick();
    assert.equal(view().messages[0].text, "AB");
    assert.ok(emitted.some((f) => f.frame.appendMessageText));
    // Authoritative non-append-only rewrite must become a reset, not duplicate text.
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, messages: state.tasks.t.messages.map((m) => ({ ...m, text: "rewritten" })) } } }));
    publisher.tick();
    assert.equal(view().messages[0].text, "rewritten"); assert.ok(emitted.at(-1).frame.reset);
    // Explicit nulls clear known identities/times/errors; omission cannot do that.
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, activeTurnId: undefined, workingStartedAt: undefined, error: undefined, status: "completed" } } }));
    publisher.tick();
    assert.equal(view().activeTurnId, null); assert.equal(view().workingStartedAt, null); assert.equal(view().error, null);
    const before = subscriptions;
    dropNext = true;
    useTaskStore.getState().appendUserMessage("t", { id: "dropped", role: "user", text: "not delivered" }); publisher.tick();
    useTaskStore.getState().appendUserMessage("t", { id: "after-gap", role: "user", text: "gap marker" }); publisher.tick();
    assert.equal(view().state, "stale"); assert.equal(view().replayable, false);
    await waitFor(() => subscriptions > before && view()?.state === "live");
    assert.deepEqual(view().messages.map((m) => m.id), ["assistant", "dropped", "after-gap"]);
    const oldEpoch = view().epoch;
    lease = false; emit("remote-viewer-state", { device, threadId: "t", state: "recovering" });
    assert.equal(view().state, "recovering"); assert.equal(view().messages[0].text, "rewritten");
    publisher.dispose(); windows.clear(); emitted.length = 0; publisher = makePublisher(); lease = true;
    refreshRemoteDevice(device);
    await waitFor(() => view()?.state === "live" && view().epoch !== oldEpoch);
    assert.equal(view().seq, 1); assert.equal(view().messages.length, 3);
  } finally { release(); publisher.dispose(); await new Promise((r) => setTimeout(r, 20)); delete globalThis.window; }
});

test("draft tokens are one-use, device/workspace/generation bound, and cancellation can precede admission", () => {
  let current = true;
  const drafts = new DraftTokens(() => current);
  const token = drafts.set("d", "p", { provider: "claude", model: "chosen", permission: "ask" });
  assert.throws(() => drafts.get(token.handle, "another-device", "p"));
  assert.throws(() => drafts.get(token.handle, "d", "another-workspace"));
  drafts.cancel(token.startTarget, "d", "p");
  assert.throws(() => drafts.claim(token, { device: "d", opId: "send", opSeq: 2 }));
  const next = drafts.set("d", "p", {});
  drafts.claim(next, { device: "d", opId: "send", opSeq: 2 });
  assert.throws(() => drafts.claim(next, { device: "d", opId: "duplicate", opSeq: 3 }));
  current = false; assert.throws(() => drafts.get(next.handle, "d", "p"));
});

test("execution preferences allowlist policy and never widen host read-only/Ask ceilings", () => {
  assert.throws(() => validateExecutionSettings({ apiKey: "secret" }));
  assert.throws(() => validateExecutionSettings({ subagents: { enabled: true, engine: "native", maxConcurrent: 25 } }));
  const values = validateExecutionSettings({ permission: "full", serviceTier: "fast", subagents: { enabled: true, engine: "native", maxConcurrent: 3 } });
  assert.equal(applyHostExecutionPreferences({ ...DEFAULT_SETTINGS, permission: "read-only" }, values).permission, "read-only");
  assert.equal(applyHostExecutionPreferences({ ...DEFAULT_SETTINGS, permission: "ask" }, values).permission, "ask");
  assert.equal(applyHostExecutionPreferences({ ...DEFAULT_SETTINGS, permission: "full" }, values).permission, "full");
  assert.equal(applyHostExecutionPreferences(DEFAULT_SETTINGS, values).nativeSubagentMax, 3);
});

test("unrecoverable pending requests become expired read-only notices, not idle work", async () => {
  resetTaskStore();
  useTaskStore.getState().enqueueApproval(approval("item/tool/requestUserInput", { questions: [{ question: "Private", isSecret: true }] }));
  await reconcilePendingRequests(2, () => true, async () => ({ complete: true, requests: [] }));
  const task = useTaskStore.getState().tasks.t;
  assert.equal(task.approvals.length, 0); assert.equal(task.status, "interrupted");
  const expired = projectApprovals(task);
  assert.equal(expired[0].hostOnly, true); assert.match(expired[0].summary, /expired/);
  assert.equal(JSON.stringify(expired).includes("Private"), false);
});

test("stamped commit drains old writes, fences late blind saves, adopts native state then rebases local intents", async () => {
  const key = "kiwi.projects", calls = [];
  let value = [{ id: "p", name: "Old", pinned: false }], adopted;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push(command);
    if (command === "state_write") { value = args.value; return; }
    if (command === "remote_state_snapshot") return { rows: [{ key, value: structuredClone(value), revision: 1 }] };
    if (command === "remote_state_commit") {
      storeValue(key, [{ id: "p", name: "STALE BLIND SAVE", pinned: false }]);
      value = args.writes[0].value;
      return { result: { state: "accepted" }, rows: [{ key, value, revision: 2 }], replayed: false };
    }
  } } };
  const stop = subscribeRemoteStateAdoption(key, (value) => { adopted = value; });
  try {
    storeValue(key, value);
    await commitHostState({ generation: 1, grantRevision: 1, identity: { device: "d", opId: "edit", opSeq: 1 },
      context: { activeWorkspace: project }, assertAllowed: () => {} }, [key], (rows) => ({ [key]: [{ ...rows[0].value[0], name: "Remote accepted" }] }));
    await flushPendingStateWrites();
    assert.equal(value[0].name, "Remote accepted"); assert.deepEqual(adopted, value); assert.deepEqual(loadStored(key, []), value);
    assert.ok(calls.indexOf("state_write") < calls.indexOf("remote_state_snapshot"));
    assert.equal(calls.filter((c) => c === "state_write").length, 1);
    const rebase = rebasePersistedIntent([{ id: "p", name: "Old", pinned: false }], [{ id: "p", name: "Old", pinned: true }], value);
    assert.deepEqual(rebase, [{ id: "p", name: "Remote accepted", pinned: true }]);
  } finally { stop(); delete globalThis.window; }
});

test("String stale_target refuses once, releases the fence, and never becomes held uncertainty", async () => {
  let commits = 0;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "remote_state_snapshot") return { rows: [{ key: "kiwi.projects", value: [], revision: 1 }] };
    if (command === "remote_state_commit") { commits++; throw "MYTHRA_REMOTE_REJECTED:stale_target"; }
  } } };
  try {
    await assert.rejects(commitHostState({ generation: 1, grantRevision: 1, identity: { device: "d", opId: "conflict", opSeq: 20 }, context: { activeWorkspace: project }, assertAllowed: () => {} },
      ["kiwi.projects"], () => ({ "kiwi.projects": [] })), (reason) => reason === "MYTHRA_REMOTE_REJECTED:stale_target");
    assert.equal(commits, 1); await flushPendingStateWrites();
  } finally { delete globalThis.window; }
});

test("lost commit acknowledgement fences stale saves without hanging close; SAME-op recovery adopts the confirmed row", async () => {
  let recover = false, native = { marker: "before" }, commits = 0;
  const key = "kiwi.projects";
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "state_write") { native = args.value; return; }
    if (command === "state_read") return native;
    if (command === "remote_state_snapshot") return { rows: [{ key, value: native, revision: 1 }] };
    if (command === "remote_state_commit") {
      commits++; native = args.writes[0].value;
      if (!recover) throw "MYTHRA_DELIVERY_UNCERTAIN: ack lost";
      return { result: { state: "accepted" }, rows: [{ key, value: native, revision: 2 }], replayed: true };
    }
  } } };
  try {
    await assert.rejects(commitHostState({ generation: 1, grantRevision: 1, identity: { device: "d", opId: "uncertain-state", opSeq: 21 }, context: { activeWorkspace: project }, assertAllowed: () => {} },
      [key], () => ({ [key]: { marker: "accepted" } })), (error) => error.holdRemoteState === true);
    assert.equal(commits, 3); assert.equal(hasPendingStateWrites(), true);
    storeValue(key, { marker: "STALE" });
    await assert.rejects(flushPendingStateWrites(), /recovered/);
    recover = true; await reconcileRemoteStateCommits(); await flushPendingStateWrites();
    assert.equal(native.marker, "accepted"); assert.equal(loadStored(key, {}).marker, "accepted");
  } finally { delete globalThis.window; }
});

test("wire sub-agent maxConcurrent is translated to nativeMaxConcurrent in the stamped host settings", async () => {
  let saved;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "remote_state_snapshot") return { rows: args.keys.map((key) => ({ key, value: {}, revision: null })) };
    if (command === "remote_state_commit") { saved = args.writes; return { result: { state: "accepted" }, rows: args.writes.map((w) => ({ key: w.key, value: w.value, revision: 1 })), replayed: false }; }
  } } };
  try {
    await createHostSettingsActions().set("settings-thread", { subagents: { enabled: true, engine: "native", maxConcurrent: 4 }, permission: "ask", serviceTier: "fast" },
      { generation: 1, grantRevision: 1, identity: { device: "d", opId: "subagents", opSeq: 22 }, context: { activeWorkspace: project }, assertAllowed: () => {} });
    const policy = saved.find((row) => row.key === "kiwi.threadSubagentSettings").value["settings-thread"];
    assert.equal(policy.nativeMaxConcurrent, 4); assert.equal(policy.maxConcurrent, undefined);
    assert.equal(saved.find((row) => row.key === "kiwi.threadExecutionPreferences").value["settings-thread"].permission, "ask");
  } finally { delete globalThis.window; }
});

test("queue edit holds are stamped, device-bound, and cancellation preserves original delivery identity", async () => {
  resetTaskStore();
  const key = "kiwi.queuedTurns"; let native = {};
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "state_write" && args.key === key) native = args.value;
    if (command === "remote_state_snapshot") return { rows: [{ key, value: native, revision: 1 }] };
    if (command === "remote_state_commit") { native = args.writes[0].value; return { result: { state: "accepted" }, rows: [{ key, value: native, revision: 2 }], replayed: false }; }
  } } };
  const entry = useTaskStore.getState().enqueueTurn("t", "original", [], { remoteDelivery: { device: "origin", opId: "original-op", opSeq: 1, workspaceId: "p", attemptId: "attempt", messageId: "message", disposition: "queued" } });
  const adapter = createHostQueueActions(() => {});
  const operation = { generation: 1, grantRevision: 1, identity: { device: "editor", opId: "begin-edit", opSeq: 23 }, context: { activeWorkspace: project, activeThread: thread }, assertAllowed: () => {} };
  try {
    const opened = await adapter.execute("queue.edit.begin", { queueId: entry.id }, operation);
    assert.ok(opened.editHandle); assert.equal(useTaskStore.getState().tasks.t.queuedTurns[0].editing, true);
    await assert.rejects(adapter.execute("queue.edit.finish", { queueId: entry.id, editHandle: opened.editHandle, cancel: true }, { ...operation, identity: { ...operation.identity, device: "wrong" } }), /owned by this device/);
    await adapter.execute("queue.edit.finish", { queueId: entry.id, editHandle: opened.editHandle, cancel: true }, operation);
    const current = useTaskStore.getState().tasks.t.queuedTurns[0];
    assert.equal(current.editing, undefined); assert.equal(current.text, "original"); assert.equal(current.remoteDelivery.opId, "original-op");
  } finally { adapter.dispose(); delete globalThis.window; }
});

// The host must reach stamped native boundaries, never a generic shell bridge.
test("terminal mutations bind the execution checkout, ceiling and exact native session", async () => {
  const { executeTerminal } = await import("./nativeActions.ts");
  const device = "a".repeat(64), nativeGrant = { ...grant, capabilities: { ...grant.capabilities, terminal: true } };
  const host = { ...sources(), getGrant: () => nativeGrant, executionPathFor: (id, root) => id === "t" ? "/host/private-checkout" : root };
  const calls = [], transport = { invoke: async (command, args) => { calls.push({ command, args }); return { opId: args.stamp.opId, state: "accepted", terminalId: "session" }; } };
  const request = (op, args) => ({ op, args, device, grant: nativeGrant, generation: 4 });
  const identity = { device, opId: "open", opSeq: 1 };
  const result = await executeTerminal(host, request("terminal.open"), { workspaceId: "p", threadId: "t", command: "echo hello", columns: 80, rows: 24 }, identity, () => true, transport);
  assert.equal(result.terminalId, "session");
  assert.equal(calls[0].command, "remote_terminal_start");
  assert.equal(calls[0].args.root, "/host/private-checkout");
  assert.equal(calls[0].args.permission, "ask");
  assert.equal(calls[0].args.stamp.threadId, "t");
  await executeTerminal(host, request("terminal.write"), { workspaceId: "p", terminalId: "session", data: "aGk=" }, { ...identity, opId: "write", opSeq: 2 }, () => true, transport);
  assert.equal(calls[1].command, "remote_terminal_action");
  assert.equal(calls[1].args.terminalId, "session");
  assert.equal(calls[1].args.action, "write");
  await assert.rejects(executeTerminal(host, request("terminal.resize"), { workspaceId: "p", terminalId: "session", columns: 0, rows: 24 }, identity, () => true, transport));
  await assert.rejects(executeTerminal(host, request("terminal.open"), { workspaceId: "p", command: "echo hi", columns: 80, rows: 24, root: "/viewer" }, identity, () => true, transport));
  assert.equal(calls.length, 2);
});

test("terminal authority loss refuses before native start; native String refusals stay definitive", async () => {
  const { executeTerminal } = await import("./nativeActions.ts");
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true } };
  let live = allowed, called = 0;
  const host = { ...sources(), getGrant: () => live };
  const request = { op: "terminal.open", device, generation: 1, grant: allowed };
  const args = { workspaceId: "p", command: "pwd", columns: 80, rows: 24 };
  const identity = { device, opId: "terminal", opSeq: 1 };
  const transport = { invoke: async () => { called++; throw "MYTHRA_REMOTE_REJECTED:stale_target"; } };
  live = { ...allowed, capabilities: { ...allowed.capabilities, terminal: false } };
  await assert.rejects(executeTerminal(host, request, args, identity, () => true, transport), (error) => error.code === "forbidden");
  assert.equal(called, 0);
  live = allowed;
  await assert.rejects(executeTerminal(host, request, args, identity, () => true, transport), (error) => error.code === "stale_target");
});

test("Git writes resolve opaque per-viewer changes and send only host-built stamped arguments", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true, gitWrite: true } };
  const host = { ...sources(), getGrant: () => allowed }, calls = [];
  const snapshot = { headOid: "host-head", branch: "main", isRoot: true };
  const transport = { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_studio_git_snapshot") return snapshot;
    if (command === "remote_studio_git_metadata") return { repository: "host/repo", remoteUrl: "https://private-token@example/repo" };
    if (command === "remote_studio_git_status") return { rows: [{ path: "file.ts", area: "unstaged", status: " M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
    if (command === "remote_domain_execute") return { result: { opId: args.stamp.opId, state: "accepted" }, payload: { stdout: "/secret/path", stderr: "token" } };
    throw new Error(command);
  } };
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, transport);
  const request = { op: "git.status", device, generation: 1, grant: allowed, args: { workspaceId: "p", threadId: "t" } };
  const listed = await domains.read(request, request.args);
  const args = { workspaceId: "p", threadId: "t", revision: "r", action: "stage", resourceId: listed.changes[0].id };
  const identity = { device, opId: "stage", opSeq: 1 };
  const result = await domains.mutate({ ...request, op: "git.write" }, args, identity);
  const executed = calls.find((call) => call.command === "remote_domain_execute");
  assert.equal(executed.args.root, project.path);
  assert.equal(executed.args.action, "git.stage");
  assert.deepEqual(executed.args.args, { expectedHeadOid: "host-head", expectedBranch: "main", path: "file.ts" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("token"), false);
  await assert.rejects(domains.mutate({ ...request, op: "git.write", device: "b".repeat(64) }, args, { ...identity, device: "b".repeat(64) }));
  domains.dispose();
});

test("checkpoint mutations refuse before filesystem dispatch without versioned bookkeeping", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true } };
  const host = { ...sources(), getGrant: () => allowed }, calls = [];
  resetTaskStore();
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, { invoke: async (command) => { calls.push(command); throw "Command remote_domain_snapshot not found"; } });
  const request = { op: "checkpoint.create", device, generation: 1, grant: allowed };
  await assert.rejects(domains.mutate(request, { workspaceId: "p", threadId: "t", revision: "r", checkpointId: "cp", label: "Manual" }, { device, opId: "create", opSeq: 1 }), (error) => error.code === "unsupported");
  assert.deepEqual(calls, ["remote_domain_snapshot"]);
  assert.equal(hasPendingStateWrites(), false);
  domains.dispose();
});

test("native engine ownership is threaded through delivery metadata and the exact Stop target only", async () => {
  const commands = [];
  const priorWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    commands.push({ command, args });
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_owner_open") return { ownerHandle: "native-owner" };
    if (command === "remote_work_target_register") return { handle: "target" };
    return null;
  } } };
  try {
    const delivery = new RemoteDeliveryJournal({ generation: 1, identity: { device: "d", opId: "first", opSeq: 1 }, workspaceId: "p", threadId: "t",
      isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
    await delivery.beforeCreate();
    await delivery.openOwner("parent", "run", "t");
    assert.equal(delivery.metadata().ownerHandle, "native-owner");
    assert.equal(commands.find((call) => call.command === "remote_work_owner_open").args.stamp.threadId, "t");
    assert.equal(commands.filter((call) => call.command === "remote_work_receipt").at(-1).args.ownerHandle, "native-owner");
    const targets = new WorkTargets(1, () => true);
    const stop = { threadId: "t", turnId: "turn", parentRunId: "run", ownerHandle: "native-owner", ownerRunId: "run" };
    await targets.register({ device: "d", workspaceId: "p", provider: "openai", stop }, "parent");
    await targets.register({ device: "d", workspaceId: "p", provider: "openai", stop }, "turn");
    const registrations = commands.filter((call) => call.command === "remote_work_target_register");
    assert.equal(registrations[0].args.ownerHandle, "native-owner");
    assert.equal(registrations[0].args.ownerRunId, "run");
    assert.equal(registrations[1].args.ownerHandle, undefined);
    assert.equal(registrations[1].args.ownerRunId, undefined);
    targets.dispose();
  } finally { globalThis.window = priorWindow; }
});

test("malformed provenance and restored generation-only owner tokens cannot turn into runnable queues", () => {
  const base = { id: "q", threadId: "t", text: "hello", attachments: [], createdAt: 1, status: "queued",
    remoteDelivery: { device: "d", opId: "op", opSeq: 1, workspaceId: "p", attemptId: "a", messageId: "m", disposition: "queued" } };
  const malformed = sanitizeStoredQueuedTurns({ t: [{ ...base, remoteDelivery: { ...base.remoteDelivery, provenance: { permissionCeiling: "full", evil: true } } }] });
  assert.equal(malformed.t[0].remoteDelivery.disposition, "uncertain");
  const owner = sanitizeStoredQueuedTurns({ t: [{ ...base, remoteDelivery: { ...base.remoteDelivery, ownerHandle: "prior-generation" } }] });
  assert.equal(owner.t[0].remoteDelivery.disposition, "uncertain");
});

test("the real shared Studio preview token is consumed once by the real Git write adapter", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true, gitWrite: true } };
  const host = { ...sources(), getGrant: () => allowed }, calls = [];
  const transport = { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_studio_git_snapshot") return { headOid: "head", branch: "main", isRoot: true };
    if (command === "remote_studio_git_metadata") return {};
    if (command === "remote_studio_git_status") return { rows: [{ path: "file.ts", area: "unstaged", status: " M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
    if (command === "remote_studio_revert_preview") return { token: "host-only-token", restorePaths: ["file.ts"], preservedPaths: [] };
    if (command === "remote_domain_execute") return { result: { state: "accepted", opId: args.stamp.opId } };
    throw new Error(command);
  } };
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, transport);
  const target = { workspaceId: "p", threadId: "t" }, request = { device, generation: 1, grant: allowed };
  const status = await domains.read({ ...request, op: "git.status", args: target }, target);
  const preview = await domains.studioReads.execute({ ...request, op: "git.revert.preview", args: { ...target, changeId: status.changes[0].id } });
  assert.equal(JSON.stringify(preview).includes("host-only-token"), false);
  const args = { ...target, revision: "r", action: "revert", confirmed: true, resourceId: preview.previewId };
  await domains.mutate({ ...request, op: "git.write" }, args, { device, opId: "revert", opSeq: 1 });
  const dispatched = calls.find((call) => call.command === "remote_domain_execute");
  assert.equal(dispatched.args.args.path, "file.ts");
  assert.equal(dispatched.args.args.confirmationToken, "host-only-token");
  await assert.rejects(domains.mutate({ ...request, op: "git.write" }, args, { device, opId: "second", opSeq: 2 }), (error) => error.code === "stale_target");
  assert.equal(calls.filter((call) => call.command === "remote_domain_execute").length, 1);
  domains.dispose();
});

test("versioned domain bookkeeping is fenced and adopted without leaking native rows", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  resetTaskStore();
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true } };
  const host = { ...sources(), getGrant: () => allowed }, calls = [];
  const transport = { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_domain_snapshot") return { version: 1, rows: [{ key: "kiwi.checkpoints", value: [], revision: null }, { key: "kiwi.checkpointHeads", value: {}, revision: null }] };
    if (command === "remote_domain_execute") return { result: { state: "accepted", opId: args.stamp.opId }, rows: [
      { key: "kiwi.checkpoints", value: [{ id: "cp", threadId: "t", workspacePath: "/host/private", repoRoot: "/host/private", label: "Manual", createdAt: 1 }], revision: 1 },
      { key: "kiwi.checkpointHeads", value: {}, revision: 1 }], replayed: false };
    throw new Error(command);
  } };
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, transport);
  const result = await domains.mutate({ device, generation: 1, grant: allowed, op: "checkpoint.create" },
    { workspaceId: "p", threadId: "t", revision: "r", checkpointId: "cp", label: "Manual" }, { device, opId: "create", opSeq: 1 });
  assert.equal(result.state, "accepted");
  assert.equal(JSON.stringify(result).includes("/host"), false);
  assert.equal(loadStored("kiwi.checkpoints", [])[0].workspacePath, "/host/private");
  assert.equal(calls[1].args.bookkeeping.version, 1);
  assert.equal(hasPendingStateWrites(), false);
  domains.dispose();
});

test("native checkpoint/worktree writes fence the complete installed safety-record key sets", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const device = "a".repeat(64), allowed = { ...grant, capabilities: { ...grant.capabilities, terminal: true, checkpointRestore: true } };
  const cp = { id: "checkpoint", threadId: "t", workspacePath: project.path, label: "Checkpoint", createdAt: 1, beforeCommit: "before", afterCommit: "after", status: "ready" };
  const worktree = { threadId: "t", projectId: "p", projectPath: project.path, path: "/host/worktree", branch: "private", baseCommit: "base", gitDir: "/host/git", createdAt: 1, status: "active" };
  const cases = [
    ["checkpoint.restore", ["kiwi.checkpoints", "kiwi.checkpointHeads", "kiwi.threadWorktrees"], { checkpointId: "checkpoint", target: "before" }],
    ["worktree.apply", ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"], {}],
    ["worktree.merge", ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"], {}],
    ["worktree.remove", ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"], {}],
    ["worktree.remove", ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"], { force: true }],
    ["worktree.returnShared", ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"], { force: true }],
    ["worktree.continueShared", ["kiwi.threadWorktrees"], {}],
  ];
  resetTaskStore();
  for (const [op, keys, extra] of cases) {
    const calls = [], values = { "kiwi.checkpoints": [cp], "kiwi.checkpointHeads": {}, "kiwi.threadWorktrees": { t: worktree } };
    const host = { ...sources(), getGrant: () => allowed, getBaseContext: () => ({ threadWorktreesRef: { current: { t: worktree } } }) };
    const transport = { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "remote_domain_snapshot") return { version: 1, rows: keys.map((key) => ({ key, value: values[key], revision: 1 })) };
      if (command === "remote_studio_git_snapshot") return { branch: "main", headOid: "host-head", isRoot: true };
      if (command === "remote_domain_execute") return { result: { opId: op, state: "accepted" }, rows: keys.map((key) => ({ key, value: values[key], revision: 2 })) };
      throw new Error(command);
    } };
    const domains = new HostDomains(host, 1, () => true, { revision: () => "revision" }, transport);
    try {
      const result = await domains.mutate({ generation: 1, device, grant: allowed, op }, { workspaceId: "p", threadId: "t", revision: "revision", confirmed: true, ...extra }, { device, opId: op, opSeq: 1 });
      assert.equal(result.state, "accepted");
      const dispatched = calls.find((call) => call.command === "remote_domain_execute").args;
      assert.deepEqual(dispatched.bookkeeping.rows.map((row) => row.key), keys);
      assert.equal(dispatched.root, project.path);
      if (op.startsWith("worktree.") && op !== "worktree.continueShared") assert.equal(dispatched.args.worktreePath, worktree.path);
      if (op === "worktree.remove" || op === "worktree.returnShared") assert.equal(dispatched.args.force, extra.force === true, "only an explicit confirmed choice deletes unsaved work");
      assert.equal(JSON.stringify(result).includes("/host/"), false);
    } finally { domains.dispose(); }
  }
});

test("pure row pins use stamped state adoption and preserve unrelated host pins", async () => {
  const { executeRowState } = await import("./rowStateActions.ts");
  const previous = globalThis.window, calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_state_snapshot") return { rows: [{ key: "kiwi.pinnedThreads", value: ["other"], revision: 9 }] };
    if (command === "remote_state_commit") return { result: { opId: "pin", state: "accepted" }, rows: args.writes.map((row) => ({ ...row, revision: 10 })), replayed: false };
  } } };
  try {
    const result = await executeRowState("thread.pin", { pinned: true }, { generation: 1, grantRevision: 1, identity: { device: "d", opId: "pin", opSeq: 1 }, context: { activeThread: thread, activeWorkspace: project }, assertAllowed() {} });
    assert.equal(result.state, "accepted");
    assert.deepEqual(loadStored("kiwi.pinnedThreads", []), ["other", "t"]);
    assert.equal(calls.find((call) => call.command === "remote_state_commit").args.writes[0].expectedRevision, 9);
  } finally { globalThis.window = previous; }
});

test("an unfenced App fork adapter is rejected before marking dispatch or invoking its local RPC", async () => {
  const previous = globalThis.window, receipts = [];
  let forked = false;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_receipt") receipts.push(args);
  } } };
  const work = createRemoteWork({ generation: 1, sources: sources(), isCurrent: () => true, findThread: () => thread, ensureHydrated: async () => {},
    getRunner: () => ({}), stop: {}, rows: { archivedThread: () => null, execute: async () => { forked = true; return { state: "accepted" }; } } });
  try {
    const result = await work.dispatch({ requestId: "request", generation: 1, device: "d", grant, opId: "fork", opSeq: 1,
      op: "thread.fork", args: { opId: "fork", opSeq: 1, threadId: "t" } });
    assert.equal(result.state, "rejected");
    assert.equal(result.error.code, "unsupported");
    assert.equal(forked, false);
    assert.equal(receipts.some((receipt) => receipt.disposition === "dispatched"), false);
  } finally { work.dispose(); globalThis.window = previous; }
});

test("View-only domain Git reads refuse before invoking unrestricted local Git helpers", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const viewOnly = { ...grant, work: false }, device = "a".repeat(64), calls = [];
  const host = { ...sources(), getGrant: () => viewOnly };
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, { invoke: async (command, args) => {
    calls.push({ command, args });
    throw "Command remote_studio_git_snapshot not found";
  } });
  const args = { workspaceId: "p", threadId: "t" };
  try {
    await assert.rejects(domains.read({ op: "git.status", device, generation: 1, grant: viewOnly, args }, args), (error) => error.code === "unsupported");
    assert.equal(calls.some((call) => call.command === "git_workspace_snapshot" || call.command === "github_repo_status"), false);
    assert.deepEqual(calls, [{ command: "remote_studio_git_snapshot", args: { root: project.path } }]);
  } finally { domains.dispose(); }
});

test("a successful View-only Git baseline uses only anchored guarded reads and keeps metadata host-only", async () => {
  const { HostDomains } = await import("./domainActions.ts");
  const viewOnly = { ...grant, work: false }, device = "a".repeat(64), calls = [];
  const host = { ...sources(), getGrant: () => viewOnly };
  const domains = new HostDomains(host, 1, () => true, { revision: () => "r" }, { invoke: async (command, args) => {
    calls.push({ command, args });
    assert.deepEqual(args.root, project.path);
    assert.equal("cwd" in args, false);
    if (command === "remote_studio_git_snapshot") return { branch: "main", headOid: "host-only-head", isRoot: true, rootPath: "/host/private" };
    if (command === "remote_studio_git_status") return { rows: [], changedFiles: 0, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, truncated: false };
    if (command === "remote_studio_git_metadata") return { repository: "private/repo", remoteUrl: "https://token@github.com/private/repo" };
    assert.fail(`Unexpected remote read: ${command}`);
  } });
  const args = { workspaceId: "p", threadId: "t" };
  try {
    const result = await domains.read({ op: "git.status", device, generation: 1, grant: viewOnly, args }, args);
    assert.equal(result.changedFiles, 0);
    assert.deepEqual(calls.map((call) => call.command), ["remote_studio_git_snapshot", "remote_studio_git_status", "remote_studio_git_snapshot", "remote_studio_git_metadata"]);
    for (const secret of ["host-only-head", "/host/private", "token@", "private/repo"]) assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { domains.dispose(); }
});
