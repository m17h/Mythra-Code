// Real renderer store/client; native persistence/network/TLS are not mocked into
// an assertion of a completed pairing. The native layer has its own tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { remoteAccessRequest, remoteAccessRespond, remoteAccessCancel, listenRemoteChanged } from "./client.ts";
import { useRemoteDevices, acceptRemoteSnapshot, incomingRequests, declinedRequests, outgoingRequests, pendingRequestCount, isPendingAccessRequest, networkHelp,
  FULL_CONTROL_GRANT, VIEW_ONLY_GRANT, accessGrantPreset, createRemoteDevicesSync } from "./devices.ts";

const fingerprint = "a".repeat(64);
const incoming = (requestId = "incoming", extra = {}) => ({ requestId, fingerprint, name: "Host", platform: "windows", createdAt: 1, expiresAt: 604800001, reciprocal: true, code: "482193", ...extra });
const outgoing = (requestId = "outgoing", state = "waiting", extra = {}) => ({ requestId, fingerprint, name: "Host", platform: "windows", createdAt: 1, expiresAt: 604800001,
  reciprocal: true, code: "482193", state, error: null, reverseConnecting: false, ...extra });
const snapshot = (generation, extra = {}) => ({ generation, ready: true, platform: "macos", deviceName: "Mac", fingerprint: "b".repeat(64), hosting: false, listening: false, port: null,
  shareName: true, browsing: false, searching: false, networkAccess: "ok", discoveryError: null, hostError: null, publicNetwork: null, refusedAdapters: 0, unsavedChanges: false,
  accessRequests: [], outgoingRequests: [], devices: [], nearby: [], ...extra });
const reset = () => useRemoteDevices.setState({ snapshot: null, initialization: "idle", initializationError: null }, true);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function syncFixture({ read, subscribe } = {}) {
  reset(); let receive, subscriptions = 0, reads = 0; const status = [];
  const controller = createRemoteDevicesSync({
    subscribe: async (callback) => { subscriptions++; receive = callback; return subscribe ? subscribe(callback) : () => {}; },
    read: async () => { reads++; return read ? read(reads) : snapshot(reads); },
    accept: acceptRemoteSnapshot,
    status: (value) => { status.push(value); useRemoteDevices.setState(value); },
  });
  return { controller, status, emit: (value) => receive(value), get reads() { return reads; }, get subscriptions() { return subscriptions; } };
}

test("access clients use the native request identity and decision names; reciprocal is checked by default", async () => {
  reset(); const old = globalThis.window, calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push({ command, args }); return snapshot(calls.length); } } };
  try {
    const before = useRemoteDevices.getState();
    await remoteAccessRequest("nearby-instance"); await remoteAccessRequest("nearby-instance", false);
    for (const decision of ["allow", "viewOnly", "decline"]) await remoteAccessRespond(fingerprint, "request-id", decision);
    await remoteAccessCancel("request-id");
    assert.deepEqual(calls, [
      { command: "remote_access_request", args: { instance: "nearby-instance", reciprocal: true } },
      { command: "remote_access_request", args: { instance: "nearby-instance", reciprocal: false } },
      ...["allow", "viewOnly", "decline"].map((decision) => ({ command: "remote_access_respond", args: { fingerprint, requestId: "request-id", decision } })),
      { command: "remote_access_cancel", args: { requestId: "request-id" } },
    ]);
    assert.equal(useRemoteDevices.getState(), before, "commands do not optimistically grant access or invent requests");
    await assert.rejects(remoteAccessRespond(fingerprint, "request-id", "view"));
    await assert.rejects(remoteAccessRespond("", "request-id", "allow"));
    await assert.rejects(remoteAccessRespond(fingerprint, "", "allow"));
    assert.equal(calls.length, 6);
  } finally { globalThis.window = old; }
});

test("Full control and View only are isolated immutable presets, not a partial Work grant", () => {
  assert.equal(FULL_CONTROL_GRANT.view, true); assert.equal(FULL_CONTROL_GRANT.work, true);
  assert.equal(FULL_CONTROL_GRANT.scope.kind, "all"); assert.equal(Object.values(FULL_CONTROL_GRANT.capabilities).every(Boolean), true);
  assert.equal(FULL_CONTROL_GRANT.capabilities.manageProjects, true);
  assert.equal(VIEW_ONLY_GRANT.view, true); assert.equal(VIEW_ONLY_GRANT.work, false);
  assert.equal(Object.values(VIEW_ONLY_GRANT.capabilities).some(Boolean), false);
  const editable = accessGrantPreset("allow"), again = accessGrantPreset("allow");
  editable.capabilities.terminal = false; editable.scope.kind = "projects";
  assert.equal(again.capabilities.terminal, true); assert.equal(again.scope.kind, "all");
  assert.equal(FULL_CONTROL_GRANT.capabilities.terminal, true); assert.equal(FULL_CONTROL_GRANT.scope.kind, "all");
  assert.notEqual(accessGrantPreset("viewOnly").capabilities, VIEW_ONLY_GRANT.capabilities);
  assert.throws(() => accessGrantPreset("decline")); assert.throws(() => accessGrantPreset("view"));
});

test("old native snapshots have empty request arrays and no retained pairing window or modal flow", () => {
  reset(); const old = snapshot(1, { accessRequests: undefined, outgoingRequests: undefined, pairing: { invitation: "old" }, flow: { stage: "comparing" } });
  assert.equal(acceptRemoteSnapshot(old), true);
  const stored = useRemoteDevices.getState().snapshot;
  assert.deepEqual(incomingRequests(stored), []); assert.deepEqual(outgoingRequests(stored), []);
  assert.equal(Object.hasOwn(stored, "pairing"), false); assert.equal(Object.hasOwn(stored, "flow"), false);
  assert.equal(pendingRequestCount(null), 0); assert.equal(isPendingAccessRequest(outgoing()), true);
});

test("authoritative incoming/outgoing arrays survive reload hydration and offline/hosting-off snapshots", () => {
  reset(); const accessRequests = [incoming()], outgoingRequests_ = [outgoing()];
  const devices = [{ fingerprint, canView: false, grant: null, state: "offline" }];
  acceptRemoteSnapshot(snapshot(5, { accessRequests, outgoingRequests: outgoingRequests_, devices, hosting: false, listening: false }));
  const state = useRemoteDevices.getState().snapshot;
  assert.equal(incomingRequests(state), accessRequests); assert.equal(outgoingRequests(state), outgoingRequests_);
  assert.equal(state.devices, devices, "host/viewing relationship data remains untouched");
  assert.equal(pendingRequestCount(state), 1);
  // Even an old timestamp does not let a client clock expire native authority.
  assert.equal(incomingRequests(state)[0].createdAt, 1); assert.equal(outgoingRequests(state)[0].state, "waiting");
  reset(); acceptRemoteSnapshot(snapshot(1, { accessRequests, outgoingRequests: outgoingRequests_, devices }));
  assert.equal(outgoingRequests(useRemoteDevices.getState().snapshot)[0].requestId, "outgoing");
});

test("delayed response cannot resurrect an answered request or a removed grant", () => {
  reset(); const pending = snapshot(2, { accessRequests: [incoming()], devices: [{ fingerprint, grant: FULL_CONTROL_GRANT }] });
  acceptRemoteSnapshot(pending);
  acceptRemoteSnapshot(snapshot(4, { devices: [{ fingerprint, grant: null }] }));
  const current = useRemoteDevices.getState();
  assert.equal(acceptRemoteSnapshot(pending), false);
  assert.equal(acceptRemoteSnapshot(snapshot(4, { accessRequests: [incoming()] })), false);
  assert.equal(useRemoteDevices.getState(), current);
  assert.equal(incomingRequests(current.snapshot).length, 0); assert.equal(current.snapshot.devices[0].grant, null);
});

test("duplicate snapshot events do not churn subscriptions or notification inputs", () => {
  reset(); let changes = 0; const stop = useRemoteDevices.subscribe(() => { changes++; });
  try {
    const state = snapshot(5, { accessRequests: [incoming()] });
    acceptRemoteSnapshot(state); for (let i = 0; i < 100; i++) acceptRemoteSnapshot(structuredClone(state));
    assert.equal(changes, 1); assert.equal(incomingRequests(useRemoteDevices.getState().snapshot)[0].requestId, "incoming");
  } finally { stop(); }
});

test("terminal answers remain native results, never optimistic grants or pending badges", () => {
  reset(); const states = ["connecting", "waiting", "allowed", "viewOnly", "declined", "cancelled", "expired", "failed"];
  const rows = states.map((state, index) => outgoing(`r-${index}`, state));
  acceptRemoteSnapshot(snapshot(5, { outgoingRequests: rows, devices: [] }));
  assert.deepEqual(outgoingRequests(useRemoteDevices.getState().snapshot).map((row) => row.state), states);
  assert.deepEqual(rows.filter(isPendingAccessRequest).map((row) => row.state), ["connecting", "waiting"]);
  assert.equal(pendingRequestCount(useRemoteDevices.getState().snapshot), 0);
  assert.deepEqual(useRemoteDevices.getState().snapshot.devices, []);
});

test("new request identity after decline cannot be overwritten by a stale old answer", () => {
  reset(); acceptRemoteSnapshot(snapshot(3, { outgoingRequests: [outgoing("old", "declined")] }));
  acceptRemoteSnapshot(snapshot(5, { outgoingRequests: [outgoing("new", "connecting", { reverseConnecting: true })] }));
  acceptRemoteSnapshot(snapshot(4, { outgoingRequests: [outgoing("old", "allowed")] }));
  const row = outgoingRequests(useRemoteDevices.getState().snapshot)[0];
  assert.equal(row.requestId, "new"); assert.equal(row.state, "connecting"); assert.equal(row.reverseConnecting, true);
});

test("startup subscribes before reading, and concurrent callers share one listener/read", async () => {
  const order = [], waiting = deferred();
  const f = syncFixture({ subscribe: () => { order.push("subscribe"); return () => {}; }, read: () => { order.push("read"); return waiting.promise; } });
  const a = f.controller.start(), b = f.controller.start(); assert.equal(a, b);
  await Promise.resolve(); await Promise.resolve(); waiting.resolve(snapshot(1)); await a;
  assert.deepEqual(order, ["subscribe", "read"]); assert.equal(f.subscriptions, 1); assert.equal(f.reads, 1);
  await f.controller.start(); assert.equal(f.reads, 1);
});

test("startup read cannot overwrite a newer event received while it was pending", async () => {
  const waiting = deferred(), f = syncFixture({ read: () => waiting.promise });
  const started = f.controller.start(); await Promise.resolve(); await Promise.resolve();
  f.emit(snapshot(3, { accessRequests: [incoming("fresh")] }));
  waiting.resolve(snapshot(2, { accessRequests: [incoming("old")] })); await started;
  assert.equal(useRemoteDevices.getState().snapshot.generation, 3);
  assert.equal(incomingRequests(useRemoteDevices.getState().snapshot)[0].requestId, "fresh");
  assert.equal(useRemoteDevices.getState().initialization, "ready");
});

test("valid live event wins even when the initial read fails; no contradictory failed state", async () => {
  const waiting = deferred(), f = syncFixture({ read: () => waiting.promise });
  const started = f.controller.start(); await Promise.resolve(); await Promise.resolve();
  f.emit(snapshot(3, { accessRequests: [incoming()] })); waiting.reject(new Error("initial read failed")); await started;
  assert.equal(useRemoteDevices.getState().initialization, "ready"); assert.equal(useRemoteDevices.getState().initializationError, null);
  await f.controller.start(); assert.equal(f.reads, 1); assert.equal(f.subscriptions, 1);
});

test("failed startup remains retryable without duplicating a successful subscription", async () => {
  const f = syncFixture({ read: (attempt) => { if (attempt === 1) throw new Error("transient"); return snapshot(3); } });
  await f.controller.start(); assert.equal(useRemoteDevices.getState().initialization, "failed");
  await f.controller.start(); assert.equal(useRemoteDevices.getState().initialization, "ready");
  assert.equal(f.reads, 2); assert.equal(f.subscriptions, 1);
});

test("a later event recovers failed initial hydration without another read or listener", async () => {
  const f = syncFixture({ read: () => { throw new Error("transient"); } });
  await f.controller.start(); f.emit(snapshot(3, { outgoingRequests: [outgoing()] }));
  assert.equal(useRemoteDevices.getState().initialization, "ready"); await f.controller.start();
  assert.equal(f.reads, 1); assert.equal(f.subscriptions, 1);
});

test("a failed listener is retried before any read", async () => {
  let attempts = 0; const f = syncFixture({ subscribe: () => { if (++attempts === 1) throw new Error("listen failed"); return () => {}; } });
  await f.controller.start(); assert.equal(f.reads, 0); assert.equal(useRemoteDevices.getState().initialization, "failed");
  await f.controller.start(); assert.equal(f.subscriptions, 2); assert.equal(f.reads, 1); assert.equal(useRemoteDevices.getState().initialization, "ready");
});

test("malformed generation cannot replace authoritative pending requests", () => {
  reset(); acceptRemoteSnapshot(snapshot(3, { accessRequests: [incoming()] })); const before = useRemoteDevices.getState();
  for (const generation of [NaN, Infinity, -1, undefined, "5"]) assert.equal(acceptRemoteSnapshot(snapshot(generation)), false);
  assert.equal(useRemoteDevices.getState(), before);
});

test("client event name matches the real native constant, not the prose typo", () => {
  const native = readFileSync("src-tauri/src/remote/mod.rs", "utf8"), client = readFileSync("src/lib/remote/client.ts", "utf8");
  assert.match(native, /CHANGED_EVENT:\s*&str\s*=\s*"remote-changed"/);
  assert.match(client, /listen<RemoteSnapshot>\("remote-changed"/);
  assert.equal(typeof listenRemoteChanged, "function");
  assert.equal(/remote_pair(?:ing)?_/.test(client), false, "old pairing commands no longer reach the renderer UI");
});


test("native declined history is not an inbox badge; Undo only reopens its exact request identity", () => {
  reset(); const declined = incoming("declined", { status: "declined" }), pending = incoming("pending", { status: "pending" });
  acceptRemoteSnapshot(snapshot(3, { accessRequests: [pending, declined] })); const stored = useRemoteDevices.getState().snapshot;
  assert.deepEqual(incomingRequests(stored), [pending]); assert.deepEqual(declinedRequests(stored), [declined]);
  assert.equal(pendingRequestCount(stored), 1);
  assert.equal(incomingRequests(stored), incomingRequests(stored), "derived selectors stay stable for useSyncExternalStore");
  assert.equal(declinedRequests(stored), declinedRequests(stored));
  const reopened = new Set(["declined"]);
  assert.deepEqual(incomingRequests(stored, reopened), [pending, declined]); assert.deepEqual(declinedRequests(stored, reopened), []);
  assert.equal(pendingRequestCount(stored, reopened), 2); assert.equal(declined.status, "declined");
  assert.deepEqual(stored.devices, [], "a local Undo cannot grant access");
});

test("working reverse fallback suppresses permission help, but stale terminal history does not", () => {
  const blocked = snapshot(3, { networkAccess: "blocked" });
  assert.equal(networkHelp({ ...blocked, outgoingRequests: [outgoing("reverse", "connecting", { reverseConnecting: true })] }), null);
  assert.equal(networkHelp({ ...blocked, outgoingRequests: [outgoing("old", "allowed", { reverseConnecting: true })] }).localNetwork, true);
  assert.equal(networkHelp(blocked).localNetwork, true);
});

test("all three new access commands are actually registered in lib.rs", () => {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");
  const handlers = [...source.matchAll(/generate_handler!\[([\s\S]*?)\]/g)].map((match) => match[1]).join("\n");
  for (const command of ["remote_access_request", "remote_access_respond", "remote_access_cancel"]) assert.ok(handlers.includes(command + ","), command);
});
