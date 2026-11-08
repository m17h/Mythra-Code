import test from "node:test";
import assert from "node:assert/strict";
import { forkRemoteThread, setRemoteDraftIsolation, reconcileRemoteOutbox, sendRemotePrompt } from "./remoteWork.ts";
import { admitToOutbox, addRemoteEcho, newThreadDraftKey, removeOutboxEntry, setNewThreadTarget, useRemoteEchoes, useRemoteOutbox } from "./outbox.ts";

const DEVICE = "a".repeat(64);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function host(handlers) {
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    assert.equal(command, "remote_request");
    calls.push(args);
    const handler = handlers[args.op];
    return typeof handler === "function" ? handler(args.args) : handler ?? {};
  } } };
  return calls;
}
function reset() {
  useRemoteOutbox.setState({ entries: [], compose: {} });
  useRemoteEchoes.setState({ echoes: [] });
}
const entry = (opId, state) => ({ opId, opSeq: 5, device: DEVICE, op: "prompt.send", threadId: "t1", draftKey: `${DEVICE}/t1`, text: "Hello", state, createdAt: 1 });

test("a late reply leaves a newer draft on screen alone", async () => {
  reset();
  const ack = deferred();
  host({ "host.info": { highestOpSeq: 1 }, "prompt.send": () => ack.promise });
  const first = { workspaceId: "w1", draftId: "one" }, second = { workspaceId: "w1", draftId: "two" };
  setNewThreadTarget(DEVICE, first);
  const sending = sendRemotePrompt({ device: DEVICE, name: "ZEDS-PC", draftKey: newThreadDraftKey(DEVICE, first), text: "First", mode: "send", workspaceId: "w1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  setNewThreadTarget(DEVICE, second);
  ack.resolve({ state: "accepted", threadId: "t9" });
  assert.equal((await sending).status, "accepted");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(useRemoteOutbox.getState().compose[DEVICE], second);
  assert.equal(useRemoteOutbox.getState().entries.length, 0);
});

test("an acknowledgement for the draft still on screen ends that draft", async () => {
  reset();
  host({ "prompt.send": { state: "accepted" } });
  const target = { workspaceId: "w1", draftId: "only" };
  setNewThreadTarget(DEVICE, target);
  await sendRemotePrompt({ device: DEVICE, name: "ZEDS-PC", draftKey: newThreadDraftKey(DEVICE, target), text: "Only", mode: "send", workspaceId: "w1" });
  assert.equal(useRemoteOutbox.getState().compose[DEVICE], undefined);
});

test("a pending answer is asked again, with no connection change to prompt it", async () => {
  reset();
  await admitToOutbox(entry("pending-op", "awaiting"));
  let asked = 0;
  const calls = host({ "op.status": () => (++asked === 1 ? { state: "pending" } : { state: "accepted", threadId: "t1" }) });
  await reconcileRemoteOutbox(DEVICE, "ZEDS-PC");
  assert.equal(useRemoteOutbox.getState().entries.length, 1, "still waiting");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(asked, 2);
  assert.equal(useRemoteOutbox.getState().entries.length, 0, "settled on the second ask");
  assert.equal(calls.filter((call) => call.op === "op.status").length, 2);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(asked, 2, "nothing left to ask about, so it stopped");
});

test("a broken link stops the asking, and the next connection starts it", async () => {
  reset();
  await admitToOutbox(entry("offline-op", "awaiting"));
  let asked = 0;
  host({ "op.status": () => { asked += 1; throw { code: "host_unavailable" }; } });
  await reconcileRemoteOutbox(DEVICE, "ZEDS-PC");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(asked, 1);
  assert.equal(useRemoteOutbox.getState().entries[0].state, "awaiting");
  removeOutboxEntry("offline-op");
});

test("a refused send takes its on-screen copy with it", async () => {
  reset();
  host({ "prompt.send": () => { throw { code: "forbidden" }; } });
  addRemoteEcho({ id: "refused", device: DEVICE, draftKey: `${DEVICE}/t1`, text: "No", queued: false, threadId: "t1", known: 0 });
  const outcome = await sendRemotePrompt({ device: DEVICE, name: "ZEDS-PC", draftKey: `${DEVICE}/t1`, text: "No", mode: "send", threadId: "t1", opId: "refused" });
  assert.equal(outcome.status, "rejected");
  assert.equal(useRemoteEchoes.getState().echoes.length, 0);
});

test("an accepted send keeps its copy until the thread shows it", async () => {
  reset();
  host({ "prompt.send": { state: "accepted", threadId: "t1" } });
  addRemoteEcho({ id: "kept", device: DEVICE, draftKey: `${DEVICE}/t1`, text: "Yes", queued: false, threadId: "t1", known: 0 });
  await sendRemotePrompt({ device: DEVICE, name: "ZEDS-PC", draftKey: `${DEVICE}/t1`, text: "Yes", mode: "send", threadId: "t1", opId: "kept" });
  assert.equal(useRemoteOutbox.getState().entries.length, 0);
  assert.equal(useRemoteEchoes.getState().echoes[0].accepted, true);
  delete globalThis.window;
});

test("isolated draft choice returns only the host token and sends no prompt or local worktree command", async () => {
  const calls = host({ "host.info": {}, "draft.settings.set": (args) => ({ state: "accepted", workspaceId: args.workspaceId,
    draftHandle: "isolated-token", startTarget: "cancel-target", settings: { isolated: args.isolated, model: "host-model" } }) });
  const result = await setRemoteDraftIsolation(DEVICE, "Host", "p", true, "previous-token");
  assert.deepEqual(result, { draftHandle: "isolated-token", startTarget: "cancel-target", settings: { isolated: true, model: "host-model" } });
  const call = calls.find((entry) => entry.op === "draft.settings.set");
  assert.equal(call.args.isolated, true); assert.equal(call.args.draftHandle, "previous-token");
  assert.ok(call.args.opId); assert.ok(call.args.opSeq > 0);
  assert.equal(calls.some((entry) => entry.op === "prompt.send" || entry.op === "worktree.create"), false);
});

test("isolated draft refuses plainly without Terminal and never falls back locally", async () => {
  host({ "draft.settings.set": () => { throw { code: "forbidden" }; } });
  assert.deepEqual(await setRemoteDraftIsolation(DEVICE, "Host", "p", true), {
    failure: "Isolated drafts need Terminal access. Enable it in the host device settings.",
  });
});

test("selected checkpoint fork preserves its selection and returns the fork identity", async () => {
  const calls = host({ "thread.fork": { state: "accepted", threadId: "forked" } });
  assert.deepEqual(await forkRemoteThread(DEVICE, "Host", "source", "selected"), { threadId: "forked" });
  const call = calls.find((entry) => entry.op === "thread.fork");
  assert.equal(call.args.checkpointId, "selected"); assert.equal(call.args.threadId, "source");
  assert.ok(call.args.opId); assert.ok(call.args.opSeq > 0);
  calls.length = 0;
  await forkRemoteThread(DEVICE, "Host", "source");
  assert.equal(Object.hasOwn(calls.find((entry) => entry.op === "thread.fork").args, "checkpointId"), false);
});

test("unconfirmed selected checkpoint fork is not retried as latest", async () => {
  const calls = host({ "thread.fork": () => { throw { code: "host_unavailable" }; } });
  const result = await forkRemoteThread(DEVICE, "Host", "source", "selected");
  assert.match(result.failure, /couldn't confirm/);
  assert.equal(calls.filter((entry) => entry.op === "thread.fork").length, 1);
  assert.equal(calls.find((entry) => entry.op === "thread.fork").args.checkpointId, "selected");
  calls.length = 0;
  assert.ok("failure" in await forkRemoteThread(DEVICE, "Host", "source", ""));
  assert.equal(calls.length, 0);
  delete globalThis.window;
});

test("an old checkpoint with no saved turn has a clear viewer refusal", async () => {
  host({ "thread.fork": { state: "rejected", error: { code: "checkpoint_turn_unavailable" } } });
  const result = await forkRemoteThread(DEVICE, "Host", "source", "legacy-checkpoint");
  assert.match(result.failure, /older checkpoint has no saved conversation turn/);
  assert.match(result.failure, /cannot be forked/);
  delete globalThis.window;
});

test("reviewed workflow helper passes host digest and displays the exact changed-recipe refusal", async () => {
  const { startRemoteWorkflow } = await import("./remoteActions.ts");
  const calls = host({ "workflows.start": { state: "rejected", error: { code: "workflow_changed" } } });
  const result = await startRemoteWorkflow(DEVICE, "Fixture host", { workspaceId: "p", revision: "r", workflowId: "wf", digest: "a".repeat(64), variables: { INPUT: "value" } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "workflow_changed");
  assert.equal(result.message, "This workflow changed on Fixture host after you reviewed it. Review it again before running.");
  assert.equal(calls.find((call) => call.op === "workflows.start").args.digest, "a".repeat(64));
  delete globalThis.window;
});
