// The real viewer store over a fake link. Time is real, so these prove the backoff
// that a person would actually wait through, without any native code.
import test from "node:test";
import assert from "node:assert/strict";
import { mountRemoteDevice, refreshRemoteDevice, selectRemoteThread, useRemoteStore } from "./remoteStore.ts";

const device = "a".repeat(64), thread = "t";
const message = (id, text) => ({ id, order: Number(id.slice(1)), role: "assistant", text, turnId: null, streaming: false, turnStatus: "completed" });
const state = { status: "idle", availability: "ready", activeTurnId: null, workingStartedAt: null, error: null };
function link() {
  const callbacks = new Map(), listeners = new Map();
  const host = { up: true, code: "host_unavailable", epoch: "e1", messages: [message("m1", "First")], seq: 1, subscribes: [], requests: [], withhold: false };
  const snapshot = () => ({ ...state, messages: host.messages, activities: [], approvals: [], queuedTurns: [], history: { hasMore: false } });
  const emit = (event, payload) => { const id = listeners.get(event); if (id) callbacks.get(id)?.({ event, payload }); };
  let callbackId = 0;
  globalThis.window = {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event) => listeners.delete(event) },
    __TAURI_INTERNALS__: {
      transformCallback: (fn) => { callbacks.set(++callbackId, fn); return callbackId; },
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return args.handler; }
        if (command === "plugin:event|unlisten") { listeners.delete(args.event); return; }
        if (command !== "remote_request") return;
        host.requests.push({ op: args.op, at: Date.now() });
        if (!host.up) throw { code: host.code };
        if (args.op === "workspaces.list") return { workspaces: [{ id: "p", name: "Project", isChat: false }] };
        if (args.op === "threads.list") return { threads: [{ id: thread, workspaceId: "p", provider: "openai", title: "Thread", preview: "", updatedAt: 1, status: "idle" }] };
        if (args.op === "timeline.unsubscribe") return;
        if (args.op === "timeline.subscribe") {
          host.subscribes.push(args.args);
          const replayable = args.args.epoch === host.epoch;
          const after = args.args.afterSeq ?? 0;
          return replayable
            ? { epoch: host.epoch, seq: host.seq, frames: host.messages.slice(after).map((row, index) => ({ seq: after + index + 1, frame: { ...state, upsertMessages: [row] } })) }
            : { epoch: host.epoch, seq: host.seq, snapshot: snapshot() };
        }
        throw new Error(`Unexpected ${args.op}`);
      },
    },
  };
  return { host, emit,
    stream(id, text) { host.messages.push(message(id, text)); host.seq += 1; emit("remote-viewer-frame", { device, threadId: thread, epoch: host.epoch, seq: host.seq, frame: { ...state, upsertMessages: [host.messages.at(-1)] } }); },
    fall(state) { host.up = false; emit("remote-viewer-state", { device, threadId: thread, state }); },
    // Unsubscribing finishes after release returns, so the fake link outlives it.
    async close() { await new Promise((resolve) => setTimeout(resolve, 30)); delete globalThis.window; } };
}
const timeline = () => useRemoteStore.getState().devices[device]?.timelines.get(thread);
async function until(predicate, within = 6000) {
  const end = Date.now() + within;
  while (!predicate()) { if (Date.now() > end) assert.fail("the store did not settle in time"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function opened(l) {
  useRemoteStore.setState({ devices: {} });
  const release = mountRemoteDevice(device);
  try {
    await until(() => useRemoteStore.getState().devices[device]?.lists.get("p")?.threads.length);
    selectRemoteThread(device, thread);
    await until(() => timeline()?.state === "live");
    return release;
  } catch (reason) { release(); await l.close(); throw reason; }
}

test("a dropped link keeps the text, says stale, and replays what was missed exactly once", async () => {
  const l = link(), release = await opened(l);
  try {
    l.stream("m2", "Second");
    assert.deepEqual(timeline().messages.map((row) => row.id), ["m1", "m2"]);
    l.fall("stale");
    assert.equal(timeline().state, "stale");
    assert.deepEqual(timeline().messages.map((row) => row.id), ["m1", "m2"], "the conversation stays on screen");
    // The host kept working while this device was away.
    l.host.messages.push(message("m3", "Third")); l.host.seq += 1;
    l.host.up = true;
    refreshRemoteDevice(device);
    await until(() => timeline()?.state === "live");
    assert.deepEqual(timeline().messages.map((row) => row.id), ["m1", "m2", "m3"]);
    const resumed = l.host.subscribes.at(-1);
    assert.equal(resumed.epoch, "e1");
    assert.equal(resumed.afterSeq, 2, "it asks only for what it missed");
  } finally { release(); await l.close(); }
});

test("while the link stays down it backs off, and recovers without anyone doing anything", async () => {
  const l = link(), release = await opened(l);
  try {
    const before = l.host.requests.length;
    l.fall("stale");
    await until(() => l.host.requests.length >= before + 2, 4500);
    const tries = l.host.requests.slice(before).map((entry) => entry.at);
    const gap = tries[1] - tries[0];
    assert.ok(gap >= 1500, `the second retry waits longer than the first (${gap} ms)`);
    assert.equal(timeline().state, "stale");
    l.host.up = true;
    await until(() => timeline()?.state === "live", 8000);
  } finally { release(); await l.close(); }
});

test("a restarted host has a new epoch, so the view takes a fresh snapshot instead of guessing", async () => {
  const l = link(), release = await opened(l);
  try {
    l.fall("recovering");
    assert.equal(timeline().state, "recovering");
    l.host.epoch = "e2"; l.host.messages = [message("m1", "First"), message("m9", "After restart")]; l.host.seq = 1;
    l.host.up = true;
    refreshRemoteDevice(device);
    await until(() => timeline()?.state === "live" && timeline().epoch === "e2");
    assert.deepEqual(timeline().messages.map((row) => row.id), ["m1", "m9"]);
  } finally { release(); await l.close(); }
});

test("a sequence gap on a live link recovers by itself", async () => {
  const l = link(), release = await opened(l);
  try {
    const before = l.host.subscribes.length;
    l.host.messages.push(message("m2", "Dropped")); l.host.seq += 1;
    l.stream("m3", "Arrived");
    assert.equal(timeline().replayable, false, "the gap is noticed at once");
    await until(() => l.host.subscribes.length > before && timeline()?.state === "live");
    assert.deepEqual(timeline().messages.map((row) => row.id), ["m1", "m2", "m3"]);
  } finally { release(); await l.close(); }
});

test("access removed ends the view and never retries", async () => {
  const l = link(), release = await opened(l);
  try {
    const before = l.host.requests.length;
    l.host.code = "forbidden"; l.host.up = false;
    l.emit("remote-viewer-state", { device, threadId: thread, state: "removed" });
    assert.equal(timeline().state, "removed");
    assert.equal(timeline().messages.length, 0, "nothing from that device stays on screen");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(l.host.requests.length, before);
  } finally { release(); await l.close(); }
});

test("closing the view stops the retries", async () => {
  const l = link(), release = await opened(l);
  l.fall("stale");
  release();
  const before = l.host.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(l.host.requests.length <= before + 1);
  await l.close();
});
