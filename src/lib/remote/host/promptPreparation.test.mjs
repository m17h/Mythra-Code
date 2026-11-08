// Real renderer journal/storage/owner/preparation modules; named native ABI
// mocked here. Native Git/SQLite/anchor behavior has separate Rust regressions.
import test from "node:test";
import assert from "node:assert/strict";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { loadStored, storeValue, flushPendingStateWrites, subscribeRemoteStateAdoption } from "../../storage.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { remotePromptPreparation, configureRemotePreparationRoots, configureRemoteCheckpointSettlement, completeRemotePreparedCheckpoint, forgetRemoteOwnerPreparations } from "./promptPreparation.ts";
import { rememberRemoteEngineOwner, finishRemoteEngineOwner, remoteEngineStopped } from "./engineOwners.ts";
import { reconcileRemoteStateCommits } from "./stateCommit.ts";
const keys = ["kiwi.threadWorktrees", "kiwi.threadProjects", "kiwi.checkpoints", "kiwi.checkpointHeads"];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let next = 0;
function fixture({ draft = false, terminal = true } = {}) {
  resetTaskStore(); const id = `instruction-${++next}`, owner = `owner-${next}`, oldWindow = globalThis.window, calls = [], settled = [];
  const grant = { revision: 7, view: true, work: true, scope: { kind: "all" }, capabilities: { terminal } };
  const worktree = { path: "/host/isolated", branch: "remote", baseCommit: "head", gitDir: "/host/project/.git/worktrees/remote" };
  const db = { "kiwi.threadWorktrees": null, "kiwi.threadProjects": null, "kiwi.checkpoints": null, "kiwi.checkpointHeads": null };
  const replies = new Map(), effects = new Map(); let interceptor;
  const rows = () => keys.map((key) => ({ key, value: structuredClone(db[key]), revision: db[key] === null ? null : 1 }));
  const native = async (command, args) => {
    calls.push({ command, args }); const overridden = await interceptor?.(command, args);
    if (overridden?.handled) return overridden.value;
    if (command === "remote_work_grant") return grant;
    if (command === "remote_studio_git_identity") return { isRoot: true, headOid: "head", branch: "main" };
    if (command === "remote_work_receipt" || command === "state_write") return;
    if (command === "remote_work_owner_finish") return { confirmed: true };
    if (command === "remote_prompt_prepare" || command === "remote_prompt_preparation_discard") {
      const kind = args.kind ?? "isolatedDiscard";
      if (!replies.has(kind)) {
        effects.set(kind, (effects.get(kind) ?? 0) + 1);
        if (kind === "checkpointBefore" && args.threadId) db["kiwi.checkpoints"] = [{ id: `cp-${id}`, threadId: args.threadId, remotePrepared: true, status: "running" }];
        if (kind === "checkpointAfter") db["kiwi.checkpoints"] = [{ id: `cp-${id}`, threadId: args.threadId, remotePrepared: true, status: "ready" }];
        replies.set(kind, { preparationId: `prep-${kind}`, kind, opId: id, checkpointId: kind.startsWith("checkpoint") ? `cp-${id}` : null,
          worktree: kind === "isolatedCreate" ? worktree : null });
      }
      return { ...replies.get(kind), rows: rows(), replayed: effects.get(kind) > 1 };
    }
    if (command === "remote_prompt_preparation_bind") {
      db["kiwi.threadWorktrees"] = { [args.threadId]: { ...worktree, threadId: args.threadId, projectId: "p", projectPath: "/host/project", status: "active" } };
      db["kiwi.threadProjects"] = { [args.threadId]: "/host/project" };
      if (replies.has("checkpointBefore")) db["kiwi.checkpoints"] = [{ id: `cp-${id}`, threadId: args.threadId, status: "running", remotePrepared: true }];
      return { bound: true, rows: rows() };
    }
    assert.fail(`Unexpected IPC ${command}`);
  };
  globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: native } };
  const delivery = new RemoteDeliveryJournal({ generation: 15, identity: { device: "device", opId: id, opSeq: next }, workspaceId: "p", threadId: draft ? undefined : "thread", permission: "ask", provider: "openai",
    owner: { handle: owner, runId: id, kind: "start", threadId: draft ? undefined : "thread" }, isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
  const preparation = remotePromptPreparation(delivery, "p", draft ? undefined : "thread");
  const releaseRoots = configureRemotePreparationRoots(() => "/host/project");
  const releaseSettlement = configureRemoteCheckpointSettlement((id, error) => settled.push({ id, error }));
  return { id, owner, preparation, delivery, grant, calls, effects, worktree, db, settled,
    intercept(fn) { interceptor = fn; }, rows,
    async close() { preparation.settle(); preparation.release(); remoteEngineStopped(owner); forgetRemoteOwnerPreparations(owner); releaseRoots(); releaseSettlement(); await flushPendingStateWrites(); globalThis.window = oldWindow; resetTaskStore(); } };
}

test("optional checkpoint skips without Terminal; isolated creation refuses before any native write", async () => {
  const f = fixture({ terminal: false }); try {
    assert.equal(await f.preparation.checkpointBefore("thread", "Run"), undefined);
    await assert.rejects(f.preparation.isolatedCreate("New"), (reason) => reason.code === "forbidden");
    assert.equal(f.calls.some(({ command }) => command === "remote_prompt_prepare" || command === "remote_studio_git_identity"), false);
    assert.equal(f.calls.some(({ command }) => /^(worktree_|checkpoint_|workspace_git_)/.test(command)), false);
  } finally { await f.close(); }
});

test("non-Git checkpoint preflight uses guarded read and never enters a mutation latch", async () => {
  const f = fixture(); try {
    f.intercept((command) => { if (command === "remote_studio_git_identity") throw new Error("not a repository"); });
    assert.equal(await f.preparation.checkpointBefore("thread", "Run"), undefined);
    assert.equal(f.calls.some(({ command }) => command === "remote_prompt_prepare"), false);
  } finally { await f.close(); }
});

test("isolated draft prepares, binds native proof and completes under one original instruction; all rows adopted", async () => {
  const f = fixture({ draft: true }), adopted = [];
  const unsub = keys.map((key) => subscribeRemoteStateAdoption(key, (value) => adopted.push({ key, value })));
  try {
    assert.deepEqual(await f.preparation.isolatedCreate("新".repeat(200)), f.worktree);
    const cp = await f.preparation.checkpointBefore(undefined, "Run");
    assert.equal(f.delivery.result().state, "rejected", "preparation does not accept/pay prompt");
    await f.preparation.bind("native-thread");
    await f.delivery.accepted({ threadId: "native-thread", turnId: "turn" });
    assert.equal(await completeRemotePreparedCheckpoint(cp, "turn"), true);
    assert.equal(loadStored("kiwi.threadProjects", {}).length, undefined);
    assert.equal(loadStored("kiwi.threadProjects", {})["native-thread"], "/host/project");
    assert.equal(loadStored("kiwi.checkpoints", [])[0].status, "ready");
    assert.equal(new Set(adopted.map((row) => row.key)).size, 4);
    for (const { command, args } of f.calls.filter((entry) => entry.command.startsWith("remote_prompt_"))) {
      assert.equal(args.ownerHandle, f.owner); assert.equal(args.stamp.opId, f.id); assert.equal(args.stamp.grantRevision, 7);
      assert.equal(args.stamp.threadId, undefined); assert.equal(args.cwd, undefined); assert.equal(args.provider, undefined);
      if (args.label) assert.ok(new TextEncoder().encode(args.label).byteLength <= 256);
      assert.ok(command === "remote_prompt_prepare" || command === "remote_prompt_preparation_bind");
    }
  } finally { for (const stop of unsub) stop(); await f.close(); }
});

test("flush before native, then adopt supersedes a blind save scheduled while commit is in flight", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    storeValue("kiwi.threadWorktrees", { old: true });
    f.intercept(async (command, args) => { if (command === "remote_prompt_prepare" && args.kind === "checkpointBefore") { entered.resolve(); await release.promise; } });
    const preparing = f.preparation.checkpointBefore("thread", "Run"); await entered.promise;
    storeValue("kiwi.threadWorktrees", { stale: true }); release.resolve(); await preparing;
    await flushPendingStateWrites();
    const write = f.calls.findIndex(({ command, args }) => command === "state_write" && args.key === "kiwi.threadWorktrees");
    const commit = f.calls.findIndex(({ command }) => command === "remote_prompt_prepare");
    assert.ok(write >= 0 && write < commit); assert.equal(loadStored("kiwi.threadWorktrees", {}), null);
    assert.equal(f.calls.slice(commit + 1).some(({ command, args }) => command === "state_write" && args.key === "kiwi.threadWorktrees"), false);
  } finally { release.resolve(); await f.close(); }
});

test("fast completion cannot retire native owner until start acknowledgement bind and checkpointAfter finish", async () => {
  const f = fixture({ draft: true }), bindEntered = deferred(), bindRelease = deferred();
  try {
    f.preparation.hold(); await f.preparation.isolatedCreate("New"); await f.preparation.checkpointBefore(undefined, "Run");
    rememberRemoteEngineOwner({ generation: 15, threadId: "native-thread", runId: f.id, kind: "start", ownerHandle: f.owner });
    await f.delivery.accepted({ threadId: "native-thread", turnId: "turn" });
    const finishing = finishRemoteEngineOwner(f.owner);
    f.intercept(async (command) => { if (command === "remote_prompt_preparation_bind") { bindEntered.resolve(); await bindRelease.promise; } });
    const binding = f.preparation.bind("native-thread"); await bindEntered.promise;
    assert.equal(f.calls.some(({ command }) => command === "remote_work_owner_finish"), false);
    assert.equal(f.calls.some(({ command, args }) => command === "remote_prompt_prepare" && args.kind === "checkpointAfter"), false);
    bindRelease.resolve(); await binding; f.preparation.release();
    assert.equal(await finishing, true);
    const after = f.calls.findIndex(({ command, args }) => command === "remote_prompt_prepare" && args.kind === "checkpointAfter");
    assert.ok(after >= 0 && after < f.calls.findIndex(({ command }) => command === "remote_work_owner_finish"));
  } finally { bindRelease.resolve(); await f.close(); }
});

test("lost bind reply fences state and owner until the SAME native binding is reconciled", async () => {
  const f = fixture({ draft: true }); let dropped = false;
  try {
    await f.preparation.isolatedCreate("New"); await f.preparation.checkpointBefore(undefined, "Run");
    f.intercept((command) => { if (command === "remote_prompt_preparation_bind" && !dropped) { dropped = true; throw new Error("lost reply"); } });
    await assert.rejects(f.preparation.bind("native-thread"), (reason) => reason.code === "uncertain");
    await f.delivery.accepted({ threadId: "native-thread", turnId: "turn" });
    rememberRemoteEngineOwner({ generation: 15, threadId: "native-thread", runId: f.id, kind: "start", ownerHandle: f.owner });
    assert.equal(await finishRemoteEngineOwner(f.owner), false);
    assert.equal(f.calls.some(({ command }) => command === "remote_work_owner_finish"), false);
    await reconcileRemoteStateCommits();
    assert.equal(await finishRemoteEngineOwner(f.owner), true);
    assert.equal(f.effects.get("isolatedCreate"), 1); assert.equal(f.effects.get("checkpointBefore"), 1);
    const binds = f.calls.filter(({ command }) => command === "remote_prompt_preparation_bind");
    assert.equal(binds.length, 2); assert.deepEqual(binds[0].args, binds[1].args);
  } finally { await f.close(); }
});

test("revoked Terminal skips completion, settles native row locally and never falls back to local Git", async () => {
  const f = fixture(); try {
    const cp = await f.preparation.checkpointBefore("thread", "Run");
    await f.delivery.accepted({ threadId: "thread", turnId: "turn" }); f.grant.capabilities.terminal = false;
    assert.equal(await completeRemotePreparedCheckpoint(cp, "turn"), false);
    assert.equal(f.settled[0].id, cp);
    assert.equal(f.calls.some(({ command, args }) => command === "remote_prompt_prepare" && args.kind === "checkpointAfter"), false);
    assert.equal(f.calls.some(({ command }) => command === "checkpoint_complete" || command === "checkpoint_delete"), false);
  } finally { await f.close(); }
});

test("late predecessor completion cannot finish a new instruction checkpoint", async () => {
  const f = fixture(); try {
    useTaskStore.getState().ensureTask("thread", "/host/project");
    useTaskStore.getState().setActiveTurn("thread", "previous"); useTaskStore.getState().completeTurn("thread", "previous", "completed");
    const cp = await f.preparation.checkpointBefore("thread", "Run");
    assert.equal(await completeRemotePreparedCheckpoint(cp, "previous"), true);
    assert.equal(f.calls.some(({ command, args }) => command === "remote_prompt_prepare" && args.kind === "checkpointAfter"), false);
    await f.delivery.accepted({ threadId: "thread", turnId: "new" });
    assert.equal(await completeRemotePreparedCheckpoint(cp, "another"), true);
    assert.equal(f.calls.some(({ command, args }) => command === "remote_prompt_prepare" && args.kind === "checkpointAfter"), false);
    assert.equal(await completeRemotePreparedCheckpoint(cp, "new"), true);
  } finally { await f.close(); }
});

test("unused isolated draft discard precedes root rejection; native refusal never becomes force cleanup", async () => {
  const f = fixture({ draft: true }); try {
    await f.preparation.isolatedCreate("New"); await f.preparation.checkpointBefore(undefined, "Run");
    await f.preparation.discard(); await f.delivery.rejected("cancelled");
    const discard = f.calls.findIndex(({ command }) => command === "remote_prompt_preparation_discard");
    const rejected = f.calls.findIndex(({ command, args }) => command === "remote_work_receipt" && args.disposition === "rejected");
    assert.ok(discard >= 0 && rejected > discard);
    assert.equal(f.calls.some(({ command }) => command === "worktree_remove" || command === "checkpoint_delete"), false);
  } finally { await f.close(); }
});

test("a rejected anonymous draft releases its own native start owner, not a shared engine owner", async () => {
  const f = fixture({ draft: true }); try {
    // Root start owners use the admitted attempt ID; child engine receipts don't.
    Object.defineProperty(f.delivery, "ownerRunId", { configurable: true, get: () => f.delivery.attemptId });
    await f.preparation.isolatedCreate("New"); await f.preparation.discard(); await f.delivery.rejected("cancelled");
    await f.preparation.finishRejectedDraft();
    assert.equal(f.calls.filter(({ command }) => command === "remote_work_owner_finish").length, 1);
    Object.defineProperty(f.delivery, "ownerRunId", { configurable: true, get: () => "shared-workflow-run" });
    await f.preparation.finishRejectedDraft();
    assert.equal(f.calls.filter(({ command }) => command === "remote_work_owner_finish").length, 1);
  } finally { await f.close(); }
});
