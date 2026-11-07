import test from "node:test";
import assert from "node:assert/strict";
import { remoteTerminal, useRemoteTerminals, endRemoteTerminals, listRemoteTerminalSessions, readRemoteTerminalStatus, readRemoteTerminalOutput } from "./remoteTerminal.ts";
import { listRemoteSteers, deliverRemoteSteerNow } from "./remoteWork.ts";
const DEVICE = "d".repeat(64);
const enc = (value) => Buffer.from(value).toString("base64");
const listeners = new Map();
let nextCallback = 1;
const callbacks = new Map();
let handler = () => ({});
const calls = [];
globalThis.window = { __TAURI_INTERNALS__: {
  transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  async invoke(command, args) {
    if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return nextCallback++; }
    if (command === "plugin:event|unlisten") return;
    assert.equal(command, "remote_request");
    calls.push(args);
    if (args.op === "host.info") return { highestOpSeq: 100 };
    return handler(args.op, args.args);
  },
} };
const snapshot = (id, text, seq = 1, owned = true, running = true) => ({ terminalId: id, command: "echo hello", startedAt: 1,
  state: running ? "running" : "exited", running, owned, attachable: true, seq, elapsedMs: 200,
  exitCode: running ? null : 7, deltaBase64: enc(text), cursor: text.length, truncated: false, hasMore: false });
function emit(id, seq, text) {
  callbacks.get(listeners.get("remote-terminal-output"))?.({ payload: { device: DEVICE, terminalId: id, seq, data: { deltaBase64: enc(text) } } });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
test("native inventory/status/read pass opaque ids and bounded numeric byte cursors only", async () => {
  calls.length = 0;
  handler = (op, args) => op === "terminal.list" ? { terminals: [snapshot("host-session", "")], truncated: false } : snapshot(args.terminalId, "tail");
  const list = await listRemoteTerminalSessions(DEVICE, "p");
  assert.equal(list.terminals[0].terminalId, "host-session");
  await readRemoteTerminalStatus(DEVICE, "p", "host-session");
  await readRemoteTerminalOutput(DEVICE, "p", "host-session", 1234, 1024);
  assert.deepEqual(calls.at(-1).args, { workspaceId: "p", terminalId: "host-session", cursor: 1234, limit: 1024 });
  await assert.rejects(readRemoteTerminalOutput(DEVICE, "p", "id", -1));
  await assert.rejects(readRemoteTerminalOutput(DEVICE, "p", "id", 0, 65537));
  assert.equal(calls.some((c) => c.op === "terminal.open"), false);
});
test("reattach after link loss replaces snapshot and deduplicates early frames at the atomic baseline", async () => {
  const session = remoteTerminal(DEVICE, "reattach");
  handler = (_op, args) => snapshot(args.terminalId, "before", 4);
  await session.attach("stable-host-id");
  emit("stable-host-id", 5, "-live");
  assert.equal(session.store.read(0).text, "before-live");
  endRemoteTerminals(DEVICE);
  assert.equal(useRemoteTerminals.getState().views[DEVICE + "/reattach"].running, false);
  let reply;
  handler = (op, args) => op === "terminal.attach" ? new Promise((resolve) => { reply = resolve; }) : { ok: true };
  const attaching = session.attach("stable-host-id");
  await tick();
  emit("stable-host-id", 7, "-included");
  emit("other-session", 200, "-unrelated");
  emit("stable-host-id", 8, "-after");
  reply(snapshot("stable-host-id", "tail-included", 7));
  await attaching;
  assert.equal(session.store.read(0).text, "tail-included-after");
  assert.equal(calls.some((c) => c.op === "terminal.open"), false, "reattach never launches a replacement process");
  endRemoteTerminals(DEVICE);
});
test("host-local sessions stream read-only; status preserves exit code and command", async () => {
  const session = remoteTerminal(DEVICE, "local");
  handler = (_op, args) => snapshot(args.terminalId, "local", 1, false);
  await session.attach("local-id");
  calls.length = 0;
  session.write("Host", "exit\r");
  session.stop("Host");
  session.resize("Host", 100, 20);
  await tick();
  assert.equal(calls.some((c) => ["terminal.write", "terminal.close", "terminal.resize"].includes(c.op)), false);
  emit("local-id", 2, "-stream");
  assert.equal(session.store.read(0).text, "local-stream");
  endRemoteTerminals(DEVICE);
  handler = (_op, args) => snapshot(args.terminalId, "complete", 3, false, false);
  await session.attach("local-id");
  const view = useRemoteTerminals.getState().views[DEVICE + "/local"];
  assert.equal(view.running, false);
  assert.equal(view.exitCode, 7);
  assert.equal(view.command, "echo hello");
});
test("lost attachment reply cannot overwrite a newer session", async () => {
  const session = remoteTerminal(DEVICE, "late");
  let resolve;
  handler = () => new Promise((r) => { resolve = r; });
  const old = session.attach("old");
  await tick();
  endRemoteTerminals(DEVICE);
  handler = (_op, args) => snapshot(args.terminalId, "new", 9);
  await session.attach("new");
  resolve(snapshot("old", "old", 1));
  await old;
  assert.equal(session.store.read(0).text, "new");
  endRemoteTerminals(DEVICE);
});
test("steer list uses explicit thread; duplicate Deliver-now retains opId/opSeq and does not claim read", async () => {
  calls.length = 0;
  handler = (op, args) => op === "steer.list" ? { threadId: args.threadId, steers: [{ messageId: "m", turnId: "turn", runtimeId: "runtime", status: "queued", deliveryRequested: true, canDeliver: false }], truncated: false }
    : { opId: args.opId, state: "accepted", deliveryRequested: true };
  assert.equal((await listRemoteSteers(DEVICE, "p", "t")).steers[0].status, "queued");
  assert.equal(await deliverRemoteSteerNow(DEVICE, "Host", "p", "t", "turn", "runtime"), null);
  assert.equal(await deliverRemoteSteerNow(DEVICE, "Host", "p", "t", "turn", "runtime"), null);
  const delivered = calls.filter((c) => c.op === "steer.deliver");
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].args.opId, delivered[1].args.opId);
  assert.equal(delivered[0].args.opSeq, delivered[1].args.opSeq);
  assert.deepEqual(Object.keys(delivered[0].args).sort(), ["opId", "opSeq", "workspaceId", "threadId", "turnId", "runtimeId"].sort());
});
test("unconfirmed Deliver-now remains unconfirmed and explicit permission refusals are reported", async () => {
  handler = () => { throw { code: "host_unavailable" }; };
  assert.match(await deliverRemoteSteerNow(DEVICE, "Host", "p", "t", "turn", "uncertain"), /couldn't confirm/);
  handler = () => { throw { code: "forbidden" }; };
  assert.match(await deliverRemoteSteerNow(DEVICE, "Host", "p", "t", "turn", "refused"), /doesn't allow/);
  endRemoteTerminals(DEVICE);
});
