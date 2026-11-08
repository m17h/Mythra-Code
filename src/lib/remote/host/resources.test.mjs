import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { storeValue, loadStored } from "../../storage.ts";
import { resetUsageLedgerCache } from "../../usageLedger.ts";
import { HostResources } from "./resources.ts";
import { acceptedMailbox } from "./agentActions.ts";
import { acceptCheckpoint, executeHostRecipe } from "./recipeActions.ts";
import { createRemoteWork } from "./workActions.ts";
const device = "e".repeat(64), project = { id: "p", name: "Host", path: "/host/project" }, other = { id: "other", name: "Private", path: "/private/project" };
const grant = { revision: 1, view: true, work: true, scope: { kind: "projects", projectIds: ["p"] }, capabilities: { terminal: true, gitWrite: false, fullAccess: false } };
const root = { id: "root", cwd: project.path, modelProvider: "openai", updatedAt: 1, preview: "Root" }, child = { ...root, id: "child" }, hidden = { ...root, id: "hidden", cwd: other.path };
const box = { rootThreadId: "root", nextSeq: 4, dropped: 2, nativeToken: "DO-NOT-SEND", messages: [
  { id: "m1", direction: "toParent", kind: "question", text: "Question", state: "unread", createdAt: 1 },
  { id: "m2", direction: "toChild", kind: "guidance", text: "Advice", state: "queued", createdAt: 2 },
  { id: "m3", direction: "toChild", kind: "guidance", text: "Failure", state: "failed", uncertain: true, createdAt: 3, reason: "/private/credentials" },
] };
function fixture() {
  resetTaskStore(); resetUsageLedgerCache();
  const old = globalThis.window, calls = [], db = {};
  let available = true, work = true;
  const links = { child: { childThreadId: "child", rootThreadId: "root", createdAt: 1, provider: "openai", model: "model", title: "Child", terminalStatus: "completed", finishedAt: 2, signoff: "required", activationTurnId: "turn" },
    hidden: { childThreadId: "hidden", rootThreadId: "root", createdAt: 1, provider: "openai", model: "model", title: "PRIVATE", terminalStatus: "completed", finishedAt: 2 } };
  const context = { activeThread: root, activeWorkspace: project, activeProject: project, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "model", permission: "ask" }, attachments: [{ path: "/private/attachment" }] };
  const input = { rootThreadId: "root", links, nativeLinks: {}, statuses: { root: "idle", child: "completed", hidden: "completed" }, agents: [], mailboxes: { child: structuredClone(box) }, reviewTokens: { child: "review-token" } };
  const sources = { getWorkspaces: () => [project, other], getKnownThreads: () => ({ root, child, hidden }), getBindings: () => ({ root: project.path, child: project.path, hidden: other.path }),
    getGrant: () => ({ ...grant, view: available, work }), getRuntime: () => ({ available: true }), getOwnershipLinks: () => links, getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(),
    getSettings: () => context.effectiveSettings, getThreadModels: () => ({}), getThreadReasoning: () => ({}), getThreadSubagents: () => ({}), getBaseContext: () => context, getRuntimeModels: () => [],
    getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false, executionPathFor: (_id, path) => path, onRemoteCodexRuntimeOwned() {}, getSubAgentInput: () => input,
    getProjectActions: () => [{ id: "action", name: "Lint", command: "echo host", path: "/private/action", credential: "DO-NOT-SEND" }],
    getHostWorkflows: () => [{ id: "wf", projectId: "p", name: "Workflow", description: "Host", enabled: true, run: { provider: "openai", model: "host-model", systemPrompt: "DO-NOT-SEND" }, variables: [{ id: "v", name: "input", value: "default", promptOnRun: true }], steps: [{ id: "s", name: "Agent", type: "agent", prompt: "Read", continueOnError: false }] }],
    getHostWorkflowRuns: () => [{ id: "run", projectId: "p", workflowId: "wf", status: "completed", startedAt: 1, threadId: "root", error: "DO-NOT-SEND" }, { id: "private-run", projectId: "other", workflowId: "wf", status: "failed", startedAt: 1, threadId: "hidden" }],
    getThreadHandoffs: () => ({ root: { sourceThreadId: "hidden", sourceTitle: "PRIVATE", sourceProvider: "claude", targetProvider: "openai", sourceModel: "x", workspacePath: other.path, createdAt: 1 } }),
  };
  const validate = () => { if (!available) throw new Error("Revoked"); };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "remote_state_snapshot") return { rows: args.keys.map((key) => ({ key, value: structuredClone(db[key]), revision: 1 })) };
    if (command === "remote_state_commit") { for (const row of args.writes) db[row.key] = row.value; return { result: { state: "accepted" }, rows: args.writes.map((row) => ({ key: row.key, value: row.value, revision: 2 })) }; }
    if (command === "state_write" || command === "remote_work_receipt") return null;
    if (command === "remote_work_grant") return sources.getGrant();
    assert.fail(`Unexpected call ${command}`);
  } } };
  const resources = new HostResources(sources, 1, () => "revision", { invoke: async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "remote_terminal_list");
    return { terminals: [{ terminalId: "owned", command: "echo host", state: "running", startedAt: 1, owned: true, pid: 123, cwd: "/private/process", token: "DO-NOT-SEND" }], truncated: false };
  } });
  return { resources, sources, context, input, calls, db, validate, revoke() { available = false; }, viewOnly() { work = false; },
    read(op, args = {}) { return resources.read({ generation: 1, device, grant, op }, { workspaceId: "p", threadId: "root", ...args }, context, validate); },
    close() { resources.dispose(); globalThis.window = old; } };
}
test("agents.read scopes workers and exposes an opaque device-bound assignment instead of review/native tokens", async () => {
  const f = fixture(); try {
    const result = await f.read("agents.read"); assert.deepEqual(result.workers.map((row) => row.id), ["child"]);
    assert.equal(JSON.stringify(result).includes("review-token"), false); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    const target = result.workers[0].target; assert.equal(f.resources.resolveWorker(target, device, "root").id, "child");
    assert.throws(() => f.resources.resolveWorker(target, "another-device", "root"));
    f.input.reviewTokens.child = "new-review"; assert.throws(() => f.resources.resolveWorker(target, device, "root"), /changed/);
  } finally { f.close(); }
});
test("mail.read is non-consuming, bounded and never spreads mailbox credentials or raw diagnostics", async () => {
  const f = fixture(); try {
    const result = await f.read("mail.read", { agentId: "child" });
    assert.equal(result.mailboxes[0].messages[0].state, "unread"); assert.equal(f.input.mailboxes.child.messages[0].state, "unread");
    assert.equal(JSON.stringify(result).includes("DO-NOT-SEND"), false); assert.equal(JSON.stringify(result).includes("/private/"), false);
    await assert.rejects(f.read("mail.read", { agentId: "hidden" }), /not shared/);
  } finally { f.close(); }
});
test("workflow view projects definitions and scoped run status, not execution credentials or other projects", async () => {
  const f = fixture(); try { const result = await f.read("workflows.view"); assert.equal(result.workflows[0].runs.length, 1); assert.equal(result.workflows[0].steps[0].prompt, "Read"); assert.equal(JSON.stringify(result).includes("DO-NOT-SEND"), false); }
  finally { f.close(); }
});
test("saved actions are host-derived allowlisted metadata", async () => {
  const f = fixture(); try { const result = await f.read("actions.list"); assert.equal(result.actions[0].command, "echo host"); assert.equal(JSON.stringify(result).includes("DO-NOT-SEND"), false); assert.equal(JSON.stringify(result).includes("/private"), false); } finally { f.close(); }
});
test("terminal listing sends host-derived root, requires Terminal and removes PID/path/token fields", async () => {
  const f = fixture(); try {
    const result = await f.read("terminal.list"); assert.equal(f.calls.at(-1).args.root, project.path); assert.equal(JSON.stringify(result).includes("DO-NOT-SEND"), false); assert.equal(JSON.stringify(result).includes("/private"), false);
    const noTerminal = { ...grant, capabilities: { terminal: false } }; f.sources.getGrant = () => noTerminal;
    await assert.rejects(f.resources.read({ generation: 1, device, grant: noTerminal, op: "terminal.list" }, { workspaceId: "p" }, f.context, f.validate), /Terminal/);
  } finally { f.close(); }
});
test("handoff lineage does not disclose an unshared source", async () => {
  const f = fixture(); try { assert.deepEqual((await f.read("thread.handoff.lineage")).lineage, { threadId: "root" }); } finally { f.close(); }
});
test("handoff draft source handle is scoped to device/workspace and retains host-only path", () => {
  const f = fixture(); try {
    const handle = f.resources.issueHandoff(f.context, device, "claude");
    assert.equal(f.resources.handoff(handle, device, "p").workspacePath, project.path);
    assert.throws(() => f.resources.handoff(handle, "wrong", "p")); assert.throws(() => f.resources.handoff(handle, device, "other"));
  } finally { f.close(); }
});
test("usage totals exclude unshared retained native child records before summing, and never invent request detail", async () => {
  const f = fixture(); try {
    const usage = (n) => ({ totalTokens: n, inputTokens: n, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 });
    storeValue("kiwi.usageLedger", [{ threadId: "root", provider: "openai", usage: usage(10), eventIds: ["root"], estimatedCost: 1, pricedTokens: 10 }, { threadId: "hidden", nativeParentThreadId: "root", provider: "claude", usage: usage(9000), eventIds: ["hidden"], estimatedCost: 900, pricedTokens: 9000 }]);
    const result = await f.read("usage.thread.details"); assert.equal(result.usage.total.usage.totalTokens, 10); assert.equal(result.usage.descendants.some((row) => row.threadId === "hidden"), false); assert.equal(result.usage.detailsAvailable, false);
  } finally { f.close(); }
});
test("resource schema rejects viewer paths and unbounded pages", async () => {
  const f = fixture(); try { await assert.rejects(f.read("agents.read", { cwd: "/private" })); await assert.rejects(f.read("agents.read", { limit: 201 })); } finally { f.close(); }
});
test("pure accepted mailbox closes questions, cancels queued guidance and resolves known failures without pretending delivery", () => {
  const result = acceptedMailbox(structuredClone(box), 100);
  assert.equal(result.messages[0].closedAt, 100); assert.equal(result.messages[0].answeredAt, undefined); assert.equal(result.messages[0].state, "unread");
  assert.equal(result.messages[1].state, "cancelled"); assert.equal(result.messages[2].uncertain, true); assert.equal(result.resolvedThroughSeq, 3);
});
test("checkpoint acceptance uses exact stamped CAS and preserves unrelated checkpoints", async () => {
  const f = fixture(); f.db["kiwi.checkpoints"] = [{ id: "c", threadId: "root", workspacePath: project.path, accepted: false }, { id: "private", threadId: "hidden", workspacePath: other.path, accepted: false }];
  try {
    const operation = { context: f.context, identity: { device, opId: "accept", opSeq: 1 }, generation: 1, grantRevision: 1, assertAllowed: f.validate };
    await acceptCheckpoint({ checkpointId: "c" }, operation); assert.equal(f.db["kiwi.checkpoints"][0].accepted, true); assert.equal(f.db["kiwi.checkpoints"][1].accepted, false);
    await assert.rejects(acceptCheckpoint({ checkpointId: "private" }, operation)); assert.equal(f.calls.filter((call) => call.command === "remote_state_commit").length, 1);
  } finally { f.close(); }
});
for (const op of ["review.start", "git.suggestCommit"]) test(`${op} builds a host recipe, not viewer instructions/attachments/skill mentions`, async () => {
  const f = fixture(); try {
    useTaskStore.getState().ensureTask("root", project.path); useTaskStore.getState().setDiff("root", { text: "HOST DIFF\nfatal: private diagnostic", successfulText: "HOST DIFF", source: "turn", baseline: "run", untrackedPaths: [], untrackedTruncated: false });
    const operation = { context: f.context, identity: { device, opId: "recipe", opSeq: 1 }, generation: 1, grantRevision: 1, assertAllowed: f.validate, delivery: {} };
    let seen;
    await executeHostRecipe(op, f.sources, operation, { sendPromptTo: async (context, text) => { seen = { context, text }; return { state: "queued", threadId: "root", queuedTurnId: "q" }; } });
    assert.deepEqual(seen.context.attachments, []); assert.equal(seen.context.resolveSkillMentions, false); assert.equal(seen.context.activeThread.id, "root");
    assert.ok(seen.text.includes(op === "review.start" ? "HOST DIFF" : "get_commit_message_context"));
    assert.equal(seen.text.includes("private diagnostic"), false);
  } finally { f.close(); }
});
test("a failed diff refresh never puts Git's diagnostics into the review prompt", async () => {
  const f = fixture(); try {
    useTaskStore.getState().ensureTask("root", project.path); useTaskStore.getState().setDiff("root", { text: "fatal: private diagnostic", source: "repository", baseline: "HEAD", untrackedPaths: [] });
    const operation = { context: f.context, identity: { device, opId: "recipe", opSeq: 1 }, generation: 1, grantRevision: 1, assertAllowed: f.validate, delivery: {} };
    // With no successful diff it goes back to the guarded read, which this fixture refuses.
    await assert.rejects(executeHostRecipe("review.start", f.sources, operation, { sendPromptTo: async () => assert.fail("the diagnostic reached a prompt") }), /remote_studio_git_status/);
  } finally { f.close(); }
});
test("agents.read says which runtime a native child uses", async () => {
  const f = fixture(); try {
    f.input.agents = [{ id: "child", provider: "openai", model: "model", status: "running" }];
    delete f.input.links.child;
    f.input.nativeLinks.child = { childThreadId: "child", rootThreadId: "root", provider: "openai", model: "model", createdAt: 1, runtime: "codex" };
    assert.equal((await f.read("agents.read")).workers.find((worker) => worker.id === "child")?.nativeRuntime, "codex");
  } finally { f.close(); }
});
test("real work router serves resource reads for View-only callers without touching selection", async () => {
  const f = fixture(); f.viewOnly();
  const work = createRemoteWork({ sources: f.sources, generation: 1, isCurrent: () => true, findThread: (id) => f.sources.getKnownThreads()[id], ensureHydrated: async () => {}, getRunner: () => ({}), stop: {} });
  try {
    const result = await work.dispatch({ generation: 1, requestId: "r", device, grant: f.sources.getGrant(), op: "actions.list", args: { workspaceId: "p" } });
    assert.equal(result.actions[0].id, "action"); assert.equal(useTaskStore.getState().activeThreadId, null);
  } finally { work.dispose(); f.close(); }
});
for (const changed of [false, true]) test(`agent sign-off ${changed ? "refuses changed review after shared preparation" : "holds shared admission until stamped sign-off and raw-ref adoption"}`, async () => {
  const f = fixture(); let reserved = false, committed = false;
  try {
    const { childReviewToken } = await import("../../../hooks/useChildAgents.ts");
    const { acceptHostAgent } = await import("./agentActions.ts");
    f.input.reviewTokens.child = childReviewToken(f.input.links.child);
    f.db["kiwi.childAgentLinks"] = structuredClone(f.input.links); f.db["kiwi.childAgentMailbox"] = structuredClone(f.input.mailboxes);
    f.sources.getAgentLifecycle = () => ({ beginAcceptance(root, worker) { assert.equal(root, "root"); assert.equal(worker.id, "child"); assert.equal(reserved, false); reserved = true; return {
      async prepare() { assert.equal(reserved, true); if (changed) f.input.reviewTokens.child = "new-review"; }, assertAllowed() { assert.equal(reserved, true); },
      committed() { assert.equal(reserved, true); committed = true; f.input.links = f.db["kiwi.childAgentLinks"]; }, release() { reserved = false; },
    }; } });
    const worker = (await f.read("agents.read")).workers[0];
    const operation = { context: f.context, identity: { device, opId: "accept-agent", opSeq: 1 }, generation: 1, grantRevision: 1, assertAllowed: f.validate, delivery: {} };
    const result = acceptHostAgent({ agentId: "child", target: worker.target }, operation, f.sources, f.resources);
    if (changed) { await assert.rejects(result, /changed/); assert.equal(committed, false); assert.equal(f.calls.some((call) => call.command === "remote_state_commit"), false); }
    else { assert.equal((await result).state, "accepted"); assert.equal(committed, true); assert.equal(f.db["kiwi.childAgentLinks"].child.acceptedBy, "user"); assert.equal(f.db["kiwi.childAgentMailbox"].child.messages[0].answeredAt, undefined); }
    assert.equal(reserved, false);
  } finally { f.close(); }
});
test("agent sign-off refuses without the shared hidden-pending/follow-up lifecycle", async () => {
  const f = fixture(); try {
    const { acceptHostAgent } = await import("./agentActions.ts"), worker = (await f.read("agents.read")).workers[0];
    await assert.rejects(acceptHostAgent({ agentId: "child", target: worker.target }, { context: f.context, identity: { device }, assertAllowed() {} }, f.sources, f.resources), /not attached/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test("wrong-root live getter is refused rather than reading selected-thread worker state", async () => {
  const f = fixture(); f.input.rootThreadId = "wrong";
  try { await assert.rejects(f.read("agents.read"), /another conversation/); } finally { f.close(); }
});

test("activity.read returns one step's whole output, and never the host's own warnings", async () => {
  const f = fixture(); try {
    useTaskStore.getState().ensureTask("root", project.path);
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, root: { ...state.tasks.root, activities: [
      { id: "long", kind: "command", title: "npm test", detail: "x".repeat(40_000) },
      { id: "huge", kind: "command", title: "cat", detail: "y".repeat(300 * 1024) },
      { id: "warn", kind: "warning", title: "Failed", detail: "/private/secret" },
    ] } } }));
    const long = await f.read("activity.read", { activityId: "long" });
    assert.equal(long.activity.detail.length, 40_000); assert.equal(long.activity.truncated, false);
    const huge = await f.read("activity.read", { activityId: "huge" });
    assert.equal(huge.activity.detail.length, 256 * 1024); assert.equal(huge.activity.truncated, true);
    await assert.rejects(f.read("activity.read", { activityId: "warn" }), /no longer available/);
    await assert.rejects(f.read("activity.read", { activityId: "missing" }), /no longer available/);
    await assert.rejects(f.read("activity.read", {}), /no longer available/);
  } finally { f.close(); }
});

test("git.autoPublish.read shows only the allowlisted state of this project", async () => {
  const f = fixture(); try {
    assert.deepEqual((await f.read("git.autoPublish.read")).autoPublish, { enabled: false, status: "idle", message: "Automatic publishing is off." });
    let asked; f.sources.getAutoPublish = (id) => { asked = id; return { enabled: true, status: "waiting", message: "Waiting", repository: "a/b", binding: "DO-NOT-SEND" }; };
    const result = await f.read("git.autoPublish.read");
    assert.equal(asked, "p"); assert.deepEqual(result.autoPublish, { enabled: true, status: "waiting", message: "Automatic publishing is waiting on the other device.", repository: "a/b" });
  } finally { f.close(); }
});


test("publishing status never sends native error text or an unknown status", async () => {
  const f = fixture(); try {
    const secret = "fatal: /private/project/credentials https://user:token@example.invalid";
    for (const status of ["idle", "publishing", "waiting", "paused", secret]) {
      const config = { enabled: true, status, message: secret, repository: "a/b" };
      f.sources.getAutoPublish = () => config;
      const wire = (await f.read("git.autoPublish.read")).autoPublish;
      assert.equal(wire.status, status === secret ? "paused" : status);
      assert.equal(JSON.stringify(wire).includes(secret), false);
      assert.equal(config.message, secret, "host-local diagnostics remain intact");
    }
    f.sources.getAutoPublish = () => ({ enabled: false, status: "publishing", message: secret });
    assert.deepEqual((await f.read("git.autoPublish.read")).autoPublish,
      { enabled: false, status: "idle", message: "Automatic publishing is off." });
  } finally { f.close(); }
});

test("worker identity detail is built only from provider and model, never its host checkout", async () => {
  const f = fixture(); try {
    const secret = "C:\\Users\\private\\checkout";
    f.input.agents = [{ id: "child", provider: "claude", model: "claude-model", status: "running", path: secret }];
    delete f.input.links.child;
    f.input.nativeLinks.child = { childThreadId: "child", rootThreadId: "root", provider: "claude", model: "claude-model", createdAt: 1, runtime: "claude" };
    const result = await f.read("agents.read");
    assert.equal(result.workers[0].detail, "Claude · claude-model");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(f.input.agents[0].path, secret, "local identity detail keeps its checkout");
    delete f.input.agents[0].provider; delete f.input.agents[0].model;
    delete f.input.nativeLinks.child.provider; delete f.input.nativeLinks.child.model;
    assert.equal((await f.read("agents.read")).workers[0].detail, "Same provider as this thread");
  } finally { f.close(); }
});

test("review diff exports known-success stdout only; old caches and failures use a fixed notice", async () => {
  const f = fixture(); try {
    useTaskStore.getState().ensureTask("root", project.path);
    const diagnostic = "fatal: C:\\Users\\private\\checkout https://user:token@example.invalid";
    const diff = { text: diagnostic, source: "repository", baseline: diagnostic, untrackedPaths: [diagnostic] };
    useTaskStore.getState().setDiff("root", diff);
    const unavailable = (await f.read("review.diff")).reviewDiff;
    assert.equal(unavailable.text, "Review changes are unavailable. Refresh them on the host.");
    assert.equal(unavailable.baseline, "HEAD"); assert.deepEqual(unavailable.untrackedPaths, []);
    assert.equal(JSON.stringify(unavailable).includes(diagnostic), false);
    const stdout = "diff --git a/file b/file\n+safe";
    useTaskStore.getState().setDiff("root", { ...diff, successfulText: stdout, baseline: "HEAD", untrackedPaths: ["new-file"] });
    const successful = (await f.read("review.diff")).reviewDiff;
    assert.equal(successful.text, stdout); assert.deepEqual(successful.untrackedPaths, ["new-file"]);
    assert.equal(useTaskStore.getState().tasks.root.diff.text, diagnostic, "local diagnostics are untouched");
    useTaskStore.getState().setDiff("root", { ...diff, successfulText: "", baseline: "HEAD", untrackedPaths: [] });
    assert.equal((await f.read("review.diff")).reviewDiff.text, "", "empty successful stdout is not a failed read");
  } finally { f.close(); }
});

test("workflow view carries the host's full canonical recipe digest", async () => {
  const { workflowRecipeDigest } = await import("./workflowDigest.ts");
  const f = fixture();
  try {
    const result = await f.read("workflows.view", { workflowId: "wf" });
    assert.equal(result.workflows[0].digest, await workflowRecipeDigest(f.sources.getHostWorkflows()[0]));
  } finally { f.close(); }
});
