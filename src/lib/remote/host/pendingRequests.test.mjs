import test from "node:test";
import assert from "node:assert/strict";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { reconcilePendingRequests } from "./pendingRequests.ts";
import { HostHistory } from "./history.ts";

const request = (threadId = "local", id = 1) => ({ threadId, id, method: "item/commandExecution/requestApproval",
  receivedAt: 123, params: { command: "echo waiting", turnId: "turn" } });
const seedLocal = () => {
  resetTaskStore();
  useTaskStore.getState().enqueueApproval(request());
  useTaskStore.getState().setTaskStatus("local", "running");
  return useTaskStore.getState();
};
const reconcile = (inventory, recovery) => reconcilePendingRequests(1, () => true, async () => inventory, recovery);

for (const [label, inventory] of [
  ["incomplete", { complete: false, requests: [] }],
  ["incomplete with usable bodies", { complete: false, requests: [request("other")] }],
  ["missing requests", { complete: true }],
  ["malformed omitted list", { complete: true, requests: [], present: null }],
  ["null inventory", null],
]) test(`${label} inventory leaves the entire local store exactly untouched`, async () => {
  const before = seedLocal();
  assert.equal(await reconcile(inventory), false);
  assert.equal(useTaskStore.getState(), before);
  assert.equal(before.tasks.local.approvals[0].receivedAt, 123);
});

test("IPC failure disables recovery without changing local requests, status, unread or query token", async () => {
  const before = seedLocal(), callbacks = [];
  assert.equal(await reconcilePendingRequests(1, () => true, async () => { throw new Error("locked/busy"); }, (...args) => callbacks.push(args)), false);
  assert.equal(useTaskStore.getState(), before);
  assert.deepEqual(callbacks, [[false, new Set()]]);
});

test("a complete live entry does not refresh a local approval's object or receivedAt", async () => {
  const before = seedLocal();
  assert.equal(await reconcile({ complete: true, requests: [{ ...request(), receivedAt: 999, remoteOwner: "remote-owner" }] }), true);
  assert.equal(useTaskStore.getState(), before);
  // Matching a remote inventory cannot silently reclassify the local object.
  await reconcile({ complete: true, requests: [], expired: [{ ...request(), turnId: "turn", remoteOwner: "remote-owner" }] });
  assert.equal(useTaskStore.getState(), before);
});

test("complete absence cannot resolve a local request even with an unsolicited expiry claim", async () => {
  const before = seedLocal();
  assert.equal(await reconcile({ complete: true, requests: [], expired: [{ ...request(), turnId: "turn", remoteOwner: "unproven" }] }), true);
  assert.equal(useTaskStore.getState(), before);
});

test("only a recovered remote object with exact authoritative owner and absence proof expires", async () => {
  const local = seedLocal().tasks.local;
  const remote = { ...request("remote"), remoteOwner: "owner-1" };
  await reconcile({ complete: true, requests: [remote] });
  const recovered = useTaskStore.getState().tasks.remote.approvals[0];
  await reconcile({ complete: true, requests: [] });
  assert.equal(useTaskStore.getState().tasks.remote.approvals[0], recovered);
  await reconcile({ complete: true, requests: [], expired: [{ ...remote, turnId: "turn", remoteOwner: "another-owner" }] });
  assert.equal(useTaskStore.getState().tasks.remote.approvals[0], recovered);
  await reconcile({ complete: true, requests: [], expired: [{ ...remote, turnId: "turn" }] });
  const task = useTaskStore.getState().tasks.remote;
  assert.equal(task.approvals.length, 0);
  assert.equal(task.status, "interrupted");
  assert.equal(task.expiredApprovals.length, 1);
  assert.equal(JSON.stringify(task.expiredApprovals).includes("echo waiting"), false);
  assert.equal(useTaskStore.getState().tasks.local, local);
});

test("one omitted or unusable payload does not poison other requests or local approvals", async () => {
  const local = seedLocal().tasks.local, callbacks = [];
  await reconcile({ complete: true, requests: [request("good"), { ...request("bad-body"), params: null }],
    present: [{ threadId: "too-large", id: 42, method: "item/tool/requestUserInput" },
      { threadId: "local", id: 1, method: request().method }] }, (...args) => callbacks.push(args));
  assert.equal(useTaskStore.getState().tasks.local, local);
  assert.equal(useTaskStore.getState().tasks.good.approvals.length, 1);
  assert.equal(useTaskStore.getState().tasks["bad-body"], undefined);
  assert.deepEqual(callbacks, [[true, new Set(["too-large", "bad-body"])]]);
});

test("an explicit live identity wins over an inconsistent expiry claim", async () => {
  resetTaskStore();
  const remote = { ...request("remote"), remoteOwner: "owner" };
  await reconcile({ complete: true, requests: [remote] });
  const before = useTaskStore.getState();
  await reconcile({ complete: true, requests: [], present: [{ threadId: "remote", id: 1, method: remote.method }], expired: [{ ...remote, turnId: "turn" }] });
  assert.equal(useTaskStore.getState(), before);
});

test("a local response during inventory read wins; stale results do not resurrect any request", async () => {
  seedLocal();
  let finish;
  const waiting = reconcilePendingRequests(1, () => true, () => new Promise((resolve) => { finish = resolve; }));
  useTaskStore.getState().resolveApproval("local", 1);
  const after = useTaskStore.getState();
  finish({ complete: true, requests: [request(), request("other")] });
  assert.equal(await waiting, false);
  assert.equal(useTaskStore.getState(), after);
});

test("lease loss during read cannot mutate store or publish recovery state", async () => {
  const before = seedLocal();
  let current = true, finish;
  const waiting = reconcilePendingRequests(1, () => current, () => new Promise((resolve) => { finish = resolve; }), () => assert.fail("stale callback"));
  current = false;
  finish({ complete: true, requests: [request("other")] });
  assert.equal(await waiting, false);
  assert.equal(useTaskStore.getState(), before);
});

test("incomplete recovery does not block unrelated timelines; missing bodies are thread-scoped", () => {
  resetTaskStore();
  useTaskStore.getState().ensureTask("local", "/project");
  useTaskStore.getState().setTaskStatus("local", "completed");
  useTaskStore.getState().ensureTask("missing", "/project");
  useTaskStore.getState().setTaskStatus("missing", "completed");
  const history = new HostHistory({});
  history.requestRecovery(false);
  assert.equal(history.availability("local"), "ready");
  history.requestRecovery(true, new Set(["missing"]));
  assert.equal(history.availability("local"), "ready");
  assert.equal(history.availability("missing"), "recovering");
  history.requestRecovery(false);
  assert.equal(history.availability("missing"), "recovering");
  history.requestRecovery(true);
  assert.equal(history.availability("missing"), "ready");
  history.clear();
});

test("new recovered Cursor question uses the live pure adapter and native target identity", async () => {
  resetTaskStore();
  const raw = { threadId: "cursor", id: "q", method: "cursor/ask_question", turnId: "native-turn", itemId: "native-item", remoteOwner: "owner",
    params: { questions: [{ id: "secret", prompt: "Password?", secret: true, options: [{ label: "Option", description: "Description" }] }] } };
  await reconcile({ complete: true, requests: [raw] });
  const approval = useTaskStore.getState().tasks.cursor.approvals[0];
  assert.equal(approval.params.turnId, "native-turn"); assert.equal(approval.params.itemId, "native-item");
  const { requestQuestions, remoteQuestionResponse } = await import("./questionActions.ts");
  assert.deepEqual(requestQuestions(approval), [{ id: "secret", title: "Password?", secret: true, options: ["Option"], answered: false }]);
  assert.deepEqual(remoteQuestionResponse(approval, { secret: ["transient answer"] }), { answers: { secret: { answers: ["transient answer"] } } });
  assert.equal(raw.params.questions[0].question, undefined); // shared adapter is pure
  await reconcile({ complete: true, requests: [], expired: [{ threadId: "cursor", id: "q", method: raw.method, turnId: "native-turn", itemId: "native-item", remoteOwner: "owner" }] });
  assert.equal(useTaskStore.getState().tasks.cursor.approvals.length, 0);
});

test("Cursor inventory cannot normalize, replace or acquire an existing local question", async () => {
  resetTaskStore();
  const local = { threadId: "cursor", id: "local-q", method: "cursor/ask_question", receivedAt: 123,
    params: { turnId: "local-turn", questions: [{ id: "q", question: "Already normalized" }] } };
  useTaskStore.getState().enqueueApproval(local); const before = useTaskStore.getState();
  await reconcile({ complete: true, requests: [{ ...local, turnId: "different", remoteOwner: "remote", params: { questions: [{ id: "q", prompt: "Different" }] } }] });
  assert.equal(useTaskStore.getState(), before); assert.equal(useTaskStore.getState().tasks.cursor.approvals[0], local);
});
