// A checkpoint made natively for another device must never meet ordinary local Git.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { useCheckpoints } from "../../../hooks/useCheckpoints.ts";
import { loadStored, storeValue } from "../../storage.ts";
import { partitionCheckpointsForRetention, runCheckpointLabel } from "../../checkpoints.ts";

const project = "/work/project";
const prepared = (id, threadId = "thread", extra = {}) => ({ id, threadId, workspacePath: project, label: "Run: remote", createdAt: 1, status: "running", remotePrepared: true, beforeCommit: "abc", ...extra });
const plain = (id, extra = {}) => ({ id, threadId: "local", workspacePath: project, label: "Run: local", createdAt: 1, status: "ready", beforeCommit: "abc", ...extra });

function harness(records) {
  const calls = [], oldWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "checkpoint_complete") return { snapshot: { commit: "def", repoRoot: project, fileCount: 1 }, changedFiles: 1, additions: 1, deletions: 0 };
    return null;
  } } };
  storeValue("kiwi.checkpoints", records);
  let hook;
  function Fixture() {
    hook = useCheckpoints({ chatWorkspacePath: "/chat", activeThread: null, activeProject: null, activeThreadId: null, activeExecutionPath: project, defaultProvider: "openai", threadModels: {},
      knownThreadsRef: { current: {} }, threadProjectBindingsRef: { current: {} }, threadWorktreesRef: { current: {} }, setError() {}, setTransientStatus() {} });
    return React.createElement("span");
  }
  renderToString(React.createElement(Fixture));
  const records_ = () => loadStored("kiwi.checkpoints", []);
  return { calls, git: () => calls.filter((call) => call.command.startsWith("checkpoint_")), hook: () => hook, records: records_, close() { globalThis.window = oldWindow; } };
}
const settle = () => new Promise((done) => setTimeout(done, 10));

test("a turn ending can't complete a prepared checkpoint with local Git", async () => {
  const f = harness([prepared("native")]);
  try {
    await f.hook().finalizeRunCheckpoint("thread", "turn");
    await settle();
    assert.deepEqual(f.git(), []);
    const row = f.records()[0];
    assert.equal(row.status, "interrupted");
    assert.match(row.error, /only its starting point/);
  } finally { f.close(); }
});
test("discarding a run can't delete a prepared checkpoint's snapshot", async () => {
  const f = harness([prepared("native")]);
  try {
    f.hook().discardRunCheckpoint("thread");
    await settle();
    assert.deepEqual(f.git(), []);
    assert.equal(f.records()[0].status, "interrupted");
  } finally { f.close(); }
});
test("a discard for a different checkpoint leaves the prepared one running", async () => {
  const f = harness([prepared("native")]);
  try {
    f.hook().discardRunCheckpoint("thread", "other");
    await settle();
    assert.equal(f.records()[0].status, "running");
  } finally { f.close(); }
});
test("deleting a thread drops prepared rows without local Git, and still cleans local ones", async () => {
  const f = harness([prepared("native", "thread", { status: "ready" }), plain("mine", { threadId: "thread" })]);
  try {
    f.hook().forgetThreadCheckpoints("thread");
    await settle();
    assert.deepEqual(f.git().map((call) => [call.command, call.args.id]), [["checkpoint_delete", "mine"]]);
    assert.deepEqual(f.records(), []);
  } finally { f.close(); }
});
test("retention prunes as before and skips Git only for prepared rows", async () => {
  const old = Array.from({ length: 2000 }, (_, index) => plain(`old-${index}`, { createdAt: 1 + index }));
  const f = harness([prepared("native-old", "thread", { status: "ready", createdAt: 0 }), ...old]);
  try {
    f.hook().persistCheckpoints((current) => [...current]);
    await settle();
    const deleted = f.git().filter((call) => call.command === "checkpoint_delete").map((call) => call.args.id);
    assert.ok(deleted.length > 0);
    assert.equal(deleted.includes("native-old"), false);
    assert.equal(f.records().some((row) => row.id === "native-old"), false);
  } finally { f.close(); }
});
test("a finished prepared checkpoint is left alone by a later turn end", async () => {
  const f = harness([prepared("native", "thread", { status: "ready", afterCommit: "def" })]);
  try {
    await f.hook().finalizeRunCheckpoint("thread");
    await settle();
    assert.deepEqual(f.git(), []);
    assert.equal(f.records()[0].status, "ready");
  } finally { f.close(); }
});
test("a thread with nothing prepared finishes silently, as it always did", async () => {
  const f = harness([plain("mine", { threadId: "thread" })]);
  try {
    await f.hook().finalizeRunCheckpoint("thread");
    await settle();
    assert.deepEqual(f.git(), []);
    assert.equal(f.records()[0].status, "ready");
  } finally { f.close(); }
});
test("explicit local runs still use local Git from start to finish", async () => {
  const f = harness([]);
  const originalInvoke = globalThis.window.__TAURI_INTERNALS__.invoke;
  globalThis.window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const reply = await originalInvoke(command, args);
    return command === "checkpoint_create" ? { commit: "abc", repoRoot: project, fileCount: 1 } : reply;
  };
  try {
    const id = await f.hook().beginRunCheckpoint("thread", project, "fix it", "openai", "model");
    assert.ok(id);
    await f.hook().finalizeRunCheckpoint("thread", "turn");
    await settle();
    assert.deepEqual(f.git().map((call) => call.command), ["checkpoint_create", "checkpoint_complete"]);
    assert.equal(f.records()[0].status, "ready");
    assert.equal(f.records()[0].label, "Run: fix it");
  } finally { f.close(); }
});
test("the shared label stays what local runs always wrote", () => {
  assert.equal(runCheckpointLabel("  fix   it "), "Run: fix it");
  assert.equal(runCheckpointLabel(""), "Model run");
  assert.ok(partitionCheckpointsForRetention);
});
