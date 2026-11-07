import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { loadStored, deferUntilRemoteStateAdopted } from "../../storage.ts";
import { createRemoteWork } from "./workActions.ts";
import { executeThreadBatch, executeThreadRow, threadRowKeys } from "./threadRows.ts";
import { createThreadRowLifecycle, threadRowBlockedReason } from "./threadLifecycle.ts";
import { reconcileRemoteStateCommits } from "./stateCommit.ts";
import { createHostEngineAdapters } from "./engineAdapters.ts";

const device = "d".repeat(64), workspace = { id: "p", name: "Host", path: "/host/project" };
const grant = { view: true, work: true, revision: 1, scope: { kind: "all" }, capabilities: { terminal: false, gitWrite: false, fullAccess: false } };
function fixture(op = "thread.rename", provider = "openai", options = {}) {
  resetTaskStore();
  const previousWindow = globalThis.window, calls = [], events = [], id = options.id ?? "t", model = provider === "openrouter" ? "org/host-model" : "host-model";
  const thread = { id, name: "Before", preview: "preview", cwd: workspace.path, updatedAt: 1, modelProvider: provider };
  let permission = true, archived = op === "thread.restore", removed = false, reserved = false, executes = 0;
  let known = archived ? {} : { [id]: thread }, state = {
    "kiwi.knownThreads": known, "kiwi.threadProjects": { [id]: workspace.path },
    "kiwi.archivedThreads": archived ? [{ id, label: "Before", provider, path: workspace.path, archivedAt: 1 }] : [],
    "kiwi.threadWorktrees": {}, "kiwi.threadModels": { [id]: model }, "kiwi.threadReasoning": { [id]: { reasoningEffort: "high", ultra: false } },
    "kiwi.threadSubagentSettings": {}, "kiwi.threadExecutionPreferences": {}, "kiwi.pinnedThreads": [id, "other"],
    "kiwi.queuedTurns": { [id]: [{ id: "queue", threadId: id, text: "old", attachments: [], createdAt: 1, status: "queued" }], other: [] },
    "kiwi.parentRuns": {}, "kiwi.checkpoints": [], "kiwi.checkpointHeads": {}, "kiwi.turnDurations": {}, "kiwi.threadPullRequests": {},
    "kiwi.childAgentPolicies": {}, "kiwi.childAgentLinks": {}, "kiwi.nativeAgentLinks": {}, "kiwi.childAgentMailbox": {},
    "kiwi.threadHandoffs": {}, "kiwi.pendingHandoff": null, "kiwi.agentQuestions": {}, "kiwi.turnContextReceipts": {},
  };
  const evidence = () => ({ deleted: removed, archived, childLinks: {}, nativeLinks: {}, childStartInFlight: false, ...options.evidence?.() });
  const lifecycle = createThreadRowLifecycle({ evidence, reserve(_op, target) { assert.equal(target, id); assert.equal(reserved, false); reserved = true; events.push("reserve"); return {
    assertOwned() { assert.equal(reserved, true); }, release() { reserved = false; events.push("release"); },
  }; },
    cancelTitle: async () => { events.push("title"); if (options.revokeDuringTitle) permission = false; options.afterTitle?.(); },
    joinRenames: async () => { events.push("renames"); }, waitPreparation: async () => { events.push("preparation"); },
    flushTranscript: async () => { events.push("flush-transcript"); }, cancelTranscriptSave: () => { events.push("cancel-save"); },
    committed(change) {
      events.push("committed");
      for (const row of change.rows) state[row.key] = row.value;
      known = state["kiwi.knownThreads"];
      archived = state["kiwi.archivedThreads"].some((entry) => entry.id === id);
      if (op === "thread.delete") removed = true;
      if (change.thread) assert.equal("turns" in change.thread, false);
      options.committed?.(change);
    },
  });
  const rows = () => threadRowKeys(op).map((key) => ({ key, value: structuredClone(state[key] ?? {}), revision: 1 }));
  const sources = {
    getWorkspaces: () => [workspace], getKnownThreads: () => known, getBindings: () => state["kiwi.threadProjects"],
    getArchivedThreadIds: () => new Set(archived ? [id] : []), getOwnershipLinks: () => ({}), getUnavailableThreadIds: () => new Set(removed ? [id] : []),
    getRuntime: () => ({ available: true }), getGrant: () => permission ? grant : { ...grant, view: false, work: false }, executionPathFor: (_id, root) => root,
    getSettings: () => ({ ...DEFAULT_SETTINGS, provider, model, subagentsEnabled: false, permission: "ask" }),
    getThreadModels: () => state["kiwi.threadModels"], getThreadReasoning: () => state["kiwi.threadReasoning"], getThreadSubagents: () => ({}), getRuntimeModels: () => [],
    getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false, onRemoteCodexRuntimeOwned() {},
    getBaseContext: () => ({ customAgents: [], openRouterModels: [], lmStudioModels: [], ensureSkillRoots: async () => { events.push("skills"); } }),
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "remote_work_grant") return sources.getGrant();
    if (command === "remote_work_receipt") return null;
    if (command === "runtime_thread_state") return { instance: "runtime", loaded: true };
    if (command === "remote_thread_snapshot") {
      events.push("snapshot"); if (options.missing) throw "Command remote_thread_snapshot not found";
      return { version: 1, rows: options.badRows ? rows().slice(1) : rows() };
    }
    if (command === "remote_thread_execute") {
      events.push("execute"); executes++;
      if (options.uncertain && executes === 1) { options.duringUncertain?.(); throw "MYTHRA_REMOTE_REJECTED:stale_target"; }
      const after = structuredClone(state), target = op === "thread.fork" ? "fork" : id;
      if (op === "thread.rename") after["kiwi.knownThreads"][id].name = args.args.name;
      if (op === "thread.archive") after["kiwi.archivedThreads"] = [{ id, label: "Before", path: workspace.path, provider, archivedAt: 2 }];
      if (op === "thread.restore") { after["kiwi.archivedThreads"] = []; after["kiwi.knownThreads"][id] = thread; }
      if (op === "thread.delete") { delete after["kiwi.knownThreads"][id]; delete after["kiwi.queuedTurns"][id]; after["kiwi.pinnedThreads"] = ["other"]; }
      if (op === "thread.fork") { after["kiwi.knownThreads"].fork = { ...thread, id: "fork", turns: [] }; after["kiwi.threadProjects"].fork = workspace.path; }
      return { result: { opId: args.stamp.opId, state: "accepted", threadId: target, workspaceId: workspace.id },
        rows: threadRowKeys(op).map((key) => ({ key, value: after[key], revision: 2 })), replayed: Boolean(options.uncertain), thread: op === "thread.fork" ? after["kiwi.knownThreads"].fork : op === "thread.rollback" ? { ...thread, turns: [] } : null, ...(options.replyThread ? { thread: options.replyThread } : {}) };
    }
    if (command === "remote_work_recover") return { disposition: "dispatched" };
    if (command === "runtime_thread_state") return { instance: "runtime" };
    if (command === "state_write" || command === "state_delete") return null;
    assert.fail(`Unexpected native call: ${command}`);
  } } };
  const work = createRemoteWork({ sources, generation: 7, isCurrent: () => true, findThread: (target) => known[target], ensureHydrated: async () => {},
    getRunner: () => ({}), stop: {}, parity: { revision: () => "r", read: async () => ({ revision: "r", rows: [] }), execute: async () => assert.fail("History cannot reach raw App fallback") }, rows: { threadLifecycle: lifecycle,
      archivedThread: () => {
        events.push("archive-read"); const target = archived ? { thread, workspaceId: workspace.id } : null;
        return options.readArchived ? options.readArchived(target) : target;
      },
      execute: async () => assert.fail("Stamped effect must not repeat the raw App sidebar mutation"),
    } });
  return { work, lifecycle, calls, events, state: () => state, reserved: () => reserved, sources, thread, evidence, setArchived: (value) => { archived = value; },
    async run() { return work.dispatch({ requestId: "request", generation: 7, device, grant, op, opId: `op-${op}`, opSeq: 1,
      args: { opId: `op-${op}`, opSeq: 1, threadId: id, ...(op === "thread.rename" ? { name: "After" } : {}), ...(op === "thread.delete" ? { confirmed: true } : {}), ...(op === "thread.compact" || op === "thread.rollback" ? { workspaceId: "p", revision: "r", ...(op === "thread.rollback" ? { confirmed: true } : {}) } : {}), ...(options.args ?? {}) } }); },
    close() { work.dispose(); globalThis.window = previousWindow; },
  };
}

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) for (const op of ["thread.rename", "thread.archive", "thread.restore", "thread.delete"]) {
  test(`${provider} ${op}: real work router uses shared lifecycle, exact native stamp and no blind saves`, async () => {
    const f = fixture(op, provider);
    try {
      const result = await f.run();
      assert.equal(result.state, "accepted", JSON.stringify(result)); assert.equal(result.threadId, "t");
      const native = f.calls.find((call) => call.command === "remote_thread_execute");
      assert.equal(native.args.stamp.threadId, "t"); assert.equal(native.args.stamp.workspaceId, "p"); assert.equal(native.args.provider, provider);
      assert.equal(native.args.root, workspace.path); assert.equal(native.args.bookkeeping.version, 1);
      assert.deepEqual(native.args.bookkeeping.rows.map((row) => row.key), threadRowKeys(op));
      assert.equal(f.events.at(-1), "release"); assert.ok(f.events.indexOf("renames") < f.events.indexOf("execute"));
      assert.ok(f.events.indexOf("snapshot") < f.events.indexOf("execute"));
      assert.equal(f.calls.some((call) => call.command === "state_write" || call.command === "codex_rpc"), false);
      assert.equal(f.calls.some((call) => call.command === "remote_work_receipt" && call.args.disposition === "dispatched"), false);
      if (op === "thread.rename") assert.equal(loadStored("kiwi.knownThreads", {}).t.name, "After");
      if (op === "thread.delete") assert.deepEqual(loadStored("kiwi.pinnedThreads", []), ["other"]);
      assert.equal(JSON.stringify(result).includes("/host/"), false);
    } finally { f.close(); }
  });
}
for (const provider of ["openai", "openrouter", "lmstudio"]) test(`${provider} fork uses host settings with delegation disabled and does not navigate`, async () => {
  const f = fixture("thread.fork", provider);
  try {
    const result = await f.run(); assert.equal(result.state, "accepted", JSON.stringify(result)); assert.equal(result.threadId, "fork");
    const args = f.calls.find((call) => call.command === "remote_thread_execute").args.args;
    assert.equal(args.model, provider === "openrouter" ? "org/host-model" : "host-model"); assert.equal(args.baseInstructions, "");
    assert.equal(args.config.features.multi_agent, false);
    assert.ok(f.events.includes("skills")); assert.ok(f.events.includes("preparation"));
    assert.equal(useTaskStore.getState().activeThreadId, null);
  } finally { f.close(); }
});
for (const provider of ["claude", "cursor"]) test(`${provider} fork preserves the same unsupported-provider guard as the local sidebar`, async () => {
  const f = fixture("thread.fork", provider);
  try { assert.equal((await f.run()).error.code, "unsupported"); assert.equal(f.calls.some((call) => call.command === "remote_thread_execute"), false); }
  finally { f.close(); }
});

test("grant removal during title cancellation aborts before native snapshot/provider effect", async () => {
  const f = fixture("thread.archive", "openai", { revokeDuringTitle: true });
  try { assert.equal((await f.run()).state, "rejected"); assert.equal(f.reserved(), false); assert.equal(f.calls.some((call) => call.command.startsWith("remote_thread_")), false); }
  finally { f.close(); }
});
test("missing native thread support and incomplete snapshot bookkeeping refuse before provider effects", async () => {
  for (const options of [{ missing: true }, { badRows: true }]) {
    const f = fixture("thread.rename", "openai", options);
    try { assert.notEqual((await f.run()).state, "accepted"); assert.equal(f.reserved(), false); assert.equal(f.calls.some((call) => call.command === "remote_thread_execute"), false); }
    finally { f.close(); }
  }
});
test("latched execute refusal is uncertain; same-op replay adopts refs before releasing deferred local intents", async () => {
  let deferredSaw, f;
  const options = { uncertain: true, duringUncertain() {
    assert.equal(deferUntilRemoteStateAdopted("kiwi.knownThreads", () => { deferredSaw = f.state()["kiwi.knownThreads"].t.name; }), true);
  } };
  f = fixture("thread.rename", "openai", options);
  try {
    const result = await f.run(); assert.equal(result.state, "uncertain"); assert.equal(f.reserved(), true);
    await reconcileRemoteStateCommits(); assert.equal(f.reserved(), false); assert.equal(deferredSaw, "After");
    assert.equal(f.calls.filter((call) => call.command === "remote_thread_execute").length, 2);
    assert.deepEqual(f.calls.filter((call) => call.command === "remote_thread_execute").map((call) => call.args.stamp.opId), ["op-thread.rename", "op-thread.rename"]);
  } finally { f.close(); }
});
test("deleting a resident task adopts queue cleanup without removeTask's blind persistence", async () => {
  const f = fixture("thread.delete", "openai", { committed() { assert.ok(useTaskStore.getState().tasks.t, "resource cleanup still has its resident agent records"); } });
  try {
    useTaskStore.getState().ensureTask("t", workspace.path);
    useTaskStore.getState().startAssistantMessage("t", { id: "assistant", role: "assistant", text: "a", turnId: "old", streaming: true });
    useTaskStore.getState().queueAssistantDelta("t", "assistant", "pending", "old");
    assert.equal((await f.run()).state, "accepted");
    assert.equal(useTaskStore.getState().tasks.t, undefined);
    assert.equal(f.calls.some((call) => call.command === "state_write"), false);
  } finally { f.close(); }
});

test("a child starting during title cancellation blocks archive before any provider mutation", async () => {
  let childStarting = false;
  const f = fixture("thread.archive", "openai", { afterTitle() { childStarting = true; }, evidence: () => ({ childStartInFlight: childStarting }) });
  try { assert.equal((await f.run()).error.code, "busy"); assert.equal(f.reserved(), false); assert.equal(f.calls.some((call) => call.command.startsWith("remote_thread_")), false); }
  finally { f.close(); }
});
for (const provider of ["claude", "cursor"]) test(`${provider} dirty transcript is flushed before native rename, not written again after adoption`, async () => {
  const f = fixture("thread.rename", provider);
  try {
    useTaskStore.getState().ensureTask("t", workspace.path);
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, transcriptDirty: true } } }));
    assert.equal((await f.run()).state, "accepted");
    assert.ok(f.events.indexOf("flush-transcript") < f.events.indexOf("execute"));
    assert.equal(f.calls.some((call) => call.command === "state_write" || call.command.endsWith("transcript_write")), false);
  } finally { f.close(); }
});
test("shared sidebar policy refuses native unknown activity and isolated deletion", () => {
  resetTaskStore();
  const thread = { id: "root", modelProvider: "openai" };
  const source = { evidence: () => ({ deleted: false, archived: false, childLinks: {}, childStartInFlight: false,
    nativeLinks: { child: { childThreadId: "child", rootThreadId: "root", title: "Child", createdAt: 1, status: "unknown" } } }) };
  assert.ok(threadRowBlockedReason("thread.archive", thread, source));
  assert.equal(threadRowBlockedReason("thread.rename", thread, source), null, "rename still permits an active thread like the local sidebar");
  source.evidence = () => ({ deleted: false, archived: false, nativeLinks: {}, childLinks: {}, childStartInFlight: false, worktree: { status: "active" } });
  assert.ok(threadRowBlockedReason("thread.delete", thread, source));
});

test("legacy provider lookup may be asynchronous and is not repeated by synchronous action guards", async () => {
  const f = fixture("thread.restore", "claude", { readArchived: async (target) => { await Promise.resolve(); return target; } });
  try {
    assert.equal((await f.run()).state, "accepted");
    assert.equal(f.events.filter((event) => event === "archive-read").length, 1);
    assert.equal(f.calls.find((call) => call.command === "remote_thread_execute").args.provider, "claude");
  } finally { f.close(); }
});
test("archive membership changing during asynchronous legacy lookup refuses before a provider effect", async () => {
  let f;
  f = fixture("thread.restore", "cursor", { readArchived: async (target) => { await Promise.resolve(); f.setArchived(false); return target; } });
  try {
    assert.equal((await f.run()).state, "rejected");
    assert.equal(f.calls.some((call) => call.command.startsWith("remote_thread_")), false);
  } finally { f.close(); }
});

test("bulk rows never fall back to the old App parity callback loop", async () => {
  let fellBack = false;
  const engines = createHostEngineAdapters({}, { revision: () => "r", execute: async () => { fellBack = true; return { state: "accepted" }; } }, () => {});
  try {
    for (const op of ["thread.archiveMany", "thread.deleteMany"]) await assert.rejects(engines.adapter.execute(op, { threadIds: ["t"] }, {}), (reason) => reason.code === "unsupported");
    assert.equal(fellBack, false);
  } finally { engines.dispose(); }
});

function batch(op, reply, options = {}) {
  const single = op === "thread.archiveMany" ? "thread.archive" : "thread.delete", f = fixture(single, "openai", options);
  const threads = [f.thread, { ...f.thread, id: "t2" }], calls = [];
  const rows = () => threadRowKeys(single).map((key) => ({ key, value: {}, revision: 1 }));
  const transport = { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "remote_thread_batch_snapshot") return { version: 1, rows: rows() };
    return reply(args, rows());
  } };
  const operation = { context: { activeThread: undefined, activeWorkspace: workspace, effectiveSettings: { provider: "openai" } }, generation: 7, grantRevision: 1, identity: { device, opId: "batch", opSeq: 1 }, assertAllowed() {} };
  const taken = [];
  const lifecycle = { begin: (_op, thread) => ({ prepare: async () => { taken.push(`prepare:${thread.id}`); }, assertAllowed() {}, committed: (change) => { taken.push(`committed:${change.threadId}`); }, release: () => { taken.push(`release:${thread.id}`); } }) };
  return { f, threads, calls, taken, run: () => executeThreadBatch(op, threads, operation, f.sources, lifecycle, transport) };
}
for (const op of ["thread.archiveMany", "thread.deleteMany"]) {
  test(`${op} sends one root, gives each thread its own lease and finishes all of them`, async () => {
    const b = batch(op, (_args, rows) => ({ result: { opId: "batch", state: "accepted", workspaceId: workspace.id, completedThreadIds: ["t", "t2"], remainingThreadIds: [] }, rows }));
    try {
      assert.equal((await b.run()).state, "accepted");
      const native = b.calls.find((call) => call.command === "remote_thread_batch_execute").args;
      assert.deepEqual(native.targets.map((target) => [target.threadId, target.provider, target.root]), [["t", "openai", workspace.path], ["t2", "openai", workspace.path]]);
      assert.deepEqual(native.args, op === "thread.deleteMany" ? { confirmed: true } : {});
      for (const id of ["t", "t2"]) for (const step of ["prepare", "committed", "release"]) assert.ok(b.taken.includes(`${step}:${id}`), `${step}:${id}`);
    } finally { b.f.close(); }
  });
}
test("a partial batch finishes what finished and reports the rest as unknown", async () => {
  const b = batch("thread.archiveMany", (_args, rows) => ({ result: { opId: "batch", state: "uncertain", workspaceId: workspace.id, completedThreadIds: ["t"], remainingThreadIds: ["t2"] }, rows }));
  try {
    await assert.rejects(b.run(), (reason) => reason.code === "uncertain" && /1 of these/.test(reason.message));
    assert.ok(b.taken.includes("committed:t"));
    assert.equal(b.taken.includes("committed:t2"), false);
    assert.ok(b.taken.includes("release:t2"));
  } finally { b.f.close(); }
});
test("a batch over the native limit is refused before anything happens", async () => {
  const b = batch("thread.archiveMany", () => assert.fail("must not reach native"));
  b.threads.push(...Array.from({ length: 100 }, (_, index) => ({ ...b.f.thread, id: `extra-${index}` })));
  try { await assert.rejects(b.run(), { code: "unsupported" }); assert.equal(b.calls.length, 0); } finally { b.f.close(); }
});

const history = (f, op, provider) => executeThreadRow(op, { threadId: "t", ...(op === "thread.rollback" ? { confirmed: true } : {}) }, { context: { activeThread: f.thread, activeWorkspace: workspace, effectiveSettings: { provider } },
  generation: 7, grantRevision: 1, identity: { device, opId: `op-${op}`, opSeq: 1 }, assertAllowed() {} }, f.sources, f.lifecycle);
for (const provider of ["openai", "openrouter", "lmstudio"]) {
  test(`${provider} compact goes through the stamped effect with nothing to repeat`, async () => {
    const f = fixture("thread.compact", provider);
    try {
      const result = await history(f, "thread.compact", provider);
      assert.equal(result.state, "accepted");
      const native = f.calls.find((call) => call.command === "remote_thread_execute").args;
      assert.deepEqual(native.args, {});
      assert.deepEqual(native.bookkeeping.rows.map((row) => row.key), threadRowKeys("thread.compact"));
      assert.ok(f.events.includes("preparation"));
      assert.equal(f.events.at(-1), "release");
      assert.equal(f.calls.some((call) => call.command === "codex_rpc" || call.command === "state_write"), false);
    } finally { f.close(); }
  });
  test(`${provider} rollback removes one turn and hands back the provider's history`, async () => {
    let change;
    const turns = [{ id: "turn", items: [] }];
    const f = fixture("thread.rollback", provider, { replyThread: { id: "t", name: "Before", preview: "", cwd: workspace.path, updatedAt: 2, modelProvider: provider, turns }, committed: (value) => { change = value; } });
    try {
      await history(f, "thread.rollback", provider);
      assert.deepEqual(f.calls.find((call) => call.command === "remote_thread_execute").args.args, { confirmed: true, numTurns: 1 });
      assert.deepEqual(change.history.turns, turns);
    } finally { f.close(); }
  });
}
for (const provider of ["claude", "cursor"]) for (const op of ["thread.compact", "thread.rollback"]) test(`${provider} ${op} is refused as it is locally`, async () => {
  const f = fixture(op, provider);
  try {
    await assert.rejects(history(f, op, provider), { code: "unsupported" });
    assert.equal(f.calls.some((call) => call.command === "remote_thread_snapshot"), false);
  } finally { f.close(); }
});
test("history can't change under a thread that's still working", async () => {
  const f = fixture("thread.rollback", "openai");
  try {
    useTaskStore.getState().ensureTask("t", workspace.path);
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, status: "running" } } }));
    await assert.rejects(history(f, "thread.rollback", "openai"), { code: "busy" });
    assert.equal(f.calls.some((call) => call.command === "remote_thread_execute"), false);
  } finally { f.close(); }
});
test("delete names the same rows native returns", () => {
  const keys = threadRowKeys("thread.delete");
  for (const key of ["kiwi.childAgentPolicies", "kiwi.childAgentLinks", "kiwi.nativeAgentLinks", "kiwi.childAgentMailbox", "kiwi.threadHandoffs", "kiwi.pendingHandoff", "kiwi.agentQuestions", "kiwi.turnContextReceipts"]) assert.ok(keys.includes(key), key);
  assert.equal(new Set(keys).size, keys.length);
});

for (const provider of ["openai", "openrouter", "lmstudio"]) for (const op of ["thread.compact", "thread.rollback"]) {
  test(`${provider} ${op}: real parity adapter uses exact native history effect and shared preparation`, async () => {
    const f = fixture(op, provider);
    try {
      const store = useTaskStore.getState(); store.ensureTask("t", workspace.path);
      useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, unread: true,
        messages: [{ id: "removed-question", role: "assistant", text: "old", questions: [{ id: "q", title: "Deleted?", options: [] }] }] } } }));
      const result = await f.run(); assert.equal(result.state, "accepted", JSON.stringify(result));
      const call = f.calls.find((call) => call.command === "remote_thread_execute");
      assert.deepEqual(call.args.args, op === "thread.rollback" ? { confirmed: true, numTurns: 1 } : {});
      assert.ok(f.events.includes("preparation")); assert.equal(useTaskStore.getState().activeThreadId, null);
      assert.equal(useTaskStore.getState().tasks.t.unread, true);
      if (op === "thread.rollback") assert.deepEqual(useTaskStore.getState().tasks.t.messages, []);
    } finally { f.close(); }
  });
}
for (const provider of ["claude", "cursor"]) for (const op of ["thread.compact", "thread.rollback"]) {
  test(`${provider} ${op}: same provider history restriction as local`, async () => {
    const f = fixture(op, provider);
    try { assert.equal((await f.run()).error.code, "unsupported"); assert.equal(f.calls.some((call) => call.command.startsWith("remote_thread_")), false); }
    finally { f.close(); }
  });
}
test("delete exact bookkeeping includes all eight child/question/handoff cleanup keys", () => {
  for (const key of ["childAgentPolicies", "childAgentLinks", "nativeAgentLinks", "childAgentMailbox", "threadHandoffs", "pendingHandoff", "agentQuestions", "turnContextReceipts"])
    assert.ok(threadRowKeys("thread.delete").includes(`kiwi.${key}`));
});

for (const provider of ["openai", "openrouter", "lmstudio"]) test(`${provider} selected checkpoint goes through stamped fork, not latest or raw RPC`, async () => {
  const f = fixture("thread.fork", provider, { args: { checkpointId: "selected" } });
  f.state()["kiwi.checkpoints"] = [{ id: "selected", threadId: "t", workspacePath: workspace.path, turnId: "earlier-turn" }];
  try {
    const result = await f.run(); assert.equal(result.state, "accepted", JSON.stringify(result));
    const call = f.calls.find((entry) => entry.command === "remote_thread_execute");
    assert.equal(call.args.args.checkpointId, "selected");
    assert.ok(call.args.bookkeeping.rows.some((row) => row.key === "kiwi.checkpoints"));
    assert.equal(Object.hasOwn(call.args.args, "lastTurnId"), false, "native resolves the host checkpoint boundary");
    assert.equal(f.calls.some((entry) => entry.command === "codex_rpc"), false);
  } finally { f.close(); }
});

test("old checkpoint without turn and another conversation's checkpoint cannot fork latest", async () => {
  for (const record of [{ id: "selected", threadId: "t", workspacePath: workspace.path }, { id: "selected", threadId: "other", turnId: "foreign" }]) {
    const f = fixture("thread.fork", "openai", { args: { checkpointId: "selected" } });
    f.state()["kiwi.checkpoints"] = [record];
    try {
      const result = await f.run(); assert.equal(result.state, "rejected");
      assert.equal(result.error.code, record.threadId === "t" ? "checkpoint_turn_unavailable" : "stale_target");
      assert.equal(f.calls.some((entry) => entry.command === "remote_thread_execute"), false);
      assert.equal(f.reserved(), false);
    } finally { f.close(); }
  }
});
