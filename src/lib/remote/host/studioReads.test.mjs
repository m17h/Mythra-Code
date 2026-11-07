// Over an in-memory transport: a request goes in the way the bridge delivers it
// and the reply is read back from what would have crossed the wire.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { HostDispatcher } from "./dispatcher.ts";
import { HostBridge } from "./bridge.ts";
import { hostContext } from "./hostContext.ts";
import { projectMessage } from "./projection.ts";
import { validateExecutionSettings, applyHostExecutionPreferences, publicCrew } from "./executionPreferences.ts";
import { assertParityAuthority, isParityOperation, validateParityArgs } from "./parityActions.ts";
import { createHostParity } from "../hostParity.ts";
import { hostLocalPort, isPublicWebLink } from "../links.ts";
import { sequenced } from "../remoteWork.ts";

const grant = { revision: 1, scope: { kind: "all" }, view: true, work: false, capabilities: { fullAccess: false, terminal: false, gitWrite: false, checkpointRestore: false, manageProjects: false } };
const DEVICE = "a".repeat(64);
const project = { id: "p", name: "Host project", path: "/host/project" };
const other = { id: "q", name: "Other", path: "/host/other" };
const thread = { id: "t", cwd: project.path, modelProvider: "openai", preview: "", updatedAt: 0 };
const checkpoint = { id: "c1", threadId: "t", workspacePath: "/host/project", repoRoot: "/host/project", label: "Saved", createdAt: 5, status: "completed",
  beforeCommit: "b".repeat(40), afterCommit: "c".repeat(40), error: "failed at /host/project/secret", changedFiles: 2 };
const worktree = { threadId: "t", projectId: "p", projectPath: "/host/project", path: "/host/wt", branch: "side", baseCommit: "d".repeat(40), gitDir: "/host/project/.git/worktrees/x", createdAt: 1, status: "ready" };

function harness({ grantFor = () => grant, execution = (_id, path) => path, native = {} } = {}) {
  const sent = [], calls = [];
  const transport = {
    invoke: async (command, args) => {
      if (command === "remote_host_respond") { sent.push(args); return undefined; }
      if (command === "noop") return undefined;
      calls.push({ command, args });
      const reply = native[command];
      if (!reply) throw new Error("/host/project/secret failed with stderr");
      return typeof reply === "function" ? reply(args) : reply;
    },
    listen: async () => () => undefined,
  };
  const sources = {
    getWorkspaces: () => [project, other], getKnownThreads: () => ({ t: thread }), getBindings: () => ({ t: project.path }), getOwnershipLinks: () => ({}),
    getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(), getRuntime: () => ({ available: true }), getGrant: grantFor,
    executionPathFor: execution,
    getStudioReads: () => ({ getCheckpoints: () => [checkpoint, { ...checkpoint, id: "elsewhere", threadId: "z", workspacePath: "/host/other" }],
      getCheckpointHead: () => ({ checkpointId: "c1", position: "after" }), getThreadWorktree: () => worktree }),
  };
  const catalog = { thread: (id) => id === "t" ? thread : undefined, eligible: () => true, ownership: () => ({}) };
  const bridge = new HostBridge(1, transport, () => true, () => assert.fail("lost"));
  const dispatcher = new HostDispatcher(sources, catalog, {}, {}, {}, bridge, () => true, undefined, transport);
  const call = async (op, args, requestGrant = grant) => {
    let n = sent.length;
    await dispatcher.dispatch({ generation: 1, requestId: `r${n}`, device: DEVICE, grant: requestGrant, op, args });
    await bridge.command("noop").catch(() => undefined);
    return sent[n];
  };
  return { call, calls, sources };
}
const wire = (reply) => JSON.stringify(reply);

test("files and Git status now reach the host's Studio instead of being refused", async () => {
  const { call } = harness({ native: { remote_studio_files_list: { entries: [{ name: "a.txt", kind: "file" }], truncated: false, next: null },
    remote_studio_git_status: { rows: [{ path: "a.txt", originalPath: null, area: "unstaged", status: " M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false } } });
  const files = await call("files.list", { workspaceId: "p" });
  assert.equal(files.error, undefined); assert.equal(files.result.entries[0].name, "a.txt");
  const status = await call("git.status", { workspaceId: "p", threadId: "t" });
  assert.equal(status.result.changes[0].path, "a.txt");
});

test("checkpoint.list shows this project's saves and no folder, commit or error text", async () => {
  const { call } = harness();
  const { result } = await call("checkpoint.list", { workspaceId: "p", threadId: "t" });
  assert.deepEqual(result.checkpoints.map((entry) => entry.id), ["c1"]);
  assert.deepEqual(result.checkpoints[0].restorable, { before: true, after: true });
  assert.deepEqual(result.head, { checkpointId: "c1", position: "after" });
  for (const secret of ["/host", "bbbbbbbb", "cccccccc", "secret"]) assert.ok(!wire(result).includes(secret), secret);
});

test("checkpoint.diff is limited to checkpoints this target can see, and native errors stay home", async () => {
  const { call, calls } = harness({ native: { remote_studio_checkpoint_diff: { text: "+two", truncated: false } } });
  assert.equal((await call("checkpoint.diff", { workspaceId: "p", threadId: "t", checkpointId: "c1" })).result.text, "+two");
  assert.equal(calls[0].args.root, "/host/project");
  assert.equal((await call("checkpoint.diff", { workspaceId: "p", threadId: "t", checkpointId: "elsewhere" })).error.code, "stale_target");
  const failing = harness();
  const reply = await failing.call("checkpoint.diff", { workspaceId: "p", threadId: "t", checkpointId: "c1" });
  assert.equal(reply.error.code, "host_unavailable"); assert.ok(!wire(reply).includes("/host/project"));
});

test("unknown fields are refused before anything native runs", async () => {
  const { call, calls } = harness();
  assert.equal((await call("git.log", { workspaceId: "p", path: "/etc" })).error.code, "unsupported");
  assert.equal((await call("git.log", { workspaceId: "p", limit: 1000 })).error.code, "unsupported");
  assert.equal((await call("git.log", { workspaceId: "p", headOid: "--output=/tmp/x" })).error.code, "unsupported");
  assert.equal(calls.length, 0);
});

test("a thread from another workspace is refused", async () => {
  const { call } = harness();
  assert.equal((await call("checkpoint.list", { workspaceId: "q", threadId: "t" })).error.code, "forbidden");
});

test("git.log resolves its own root, and a hostile reply is not passed on", async () => {
  const oid = "e".repeat(40);
  const { call, calls } = harness({ execution: () => "/host/wt", native: { remote_studio_git_log: (args) => ({ repository: true, hasMore: false, nextOffset: args.offset + 1, headOid: oid,
    truncated: false, entries: [{ oid, shortOid: "eee", subject: "Hello", authorName: "A", authoredAt: "2026-01-01T00:00:00Z" }] }) } });
  const { result } = await call("git.log", { workspaceId: "p", threadId: "t", limit: 1 });
  assert.equal(calls[0].args.root, "/host/wt"); assert.equal(result.entries[0].subject, "Hello");
  const bad = harness({ native: { remote_studio_git_log: { repository: true, hasMore: false, nextOffset: 0, headOid: "../../etc/passwd", truncated: false, entries: [] } } });
  assert.equal((await bad.call("git.log", { workspaceId: "p" })).error.code, "host_unavailable");
});

test("worktree.status shares the path Copy path needs and no other folder", async () => {
  const native = { headOid: null, sourceBranch: "main", exists: true, registered: true, branch: "side", baseCommit: "d", changedFiles: 1, untrackedFiles: 0, ignoredFileCount: 0, ahead: 1, behind: 0, clean: false };
  const { call } = harness({ native: { remote_studio_worktree_status: native } });
  const { result } = await call("worktree.status", { workspaceId: "p", threadId: "t" });
  assert.equal(result.worktree.path, "/host/wt"); assert.equal(result.status.ahead, 1);
  assert.ok(!wire(result).includes("/host/project"), "the project path and git folder stay on the host");
});

test("a revert preview keeps its token on the host and works once", async () => {
  const { call } = harness({ native: { remote_studio_git_status: { rows: [{ path: "a.txt", originalPath: null, area: "unstaged", status: " M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false },
    remote_studio_revert_preview: { token: "t0k3n", paths: ["a.txt"], restorePaths: ["a.txt"], preservedPaths: [] } } });
  const changeId = (await call("git.status", { workspaceId: "p" })).result.changes[0].id;
  assert.equal((await call("git.revert.preview", { workspaceId: "p", changeId })).error.code, "forbidden", "View alone can't run Git over the checkout");
  const writer = { ...grant, work: true, capabilities: { ...grant.capabilities, terminal: true, gitWrite: true } };
  const { result } = await call("git.revert.preview", { workspaceId: "p", changeId }, writer);
  assert.deepEqual(result.restorePaths, ["a.txt"]);
  assert.ok(!wire(result).includes("t0k3n"));
  const bad = await call("git.revert.preview", { workspaceId: "p", changeId: "made-up" }, writer);
  assert.equal(bad.error.code, "stale_target");
});

test("agents.list sends the readout without a native path", async () => {
  resetTaskStore();
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, agents: [{ id: "child", prompt: "Look", status: "running", path: "/host/project/secret" }] } } }));
  const { call } = harness();
  const { result } = await call("agents.list", { workspaceId: "p", threadId: "t" });
  assert.equal(result.agents[0].id, "child"); assert.ok(!wire(result).includes("/host"));
});

test("images resolve from a message reference, never a path", async () => {
  resetTaskStore();
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.getState().appendUserMessage("t", { id: "m", role: "user", text: "see", attachments: [{ path: "/host/project/shot.png", name: "shot.png", kind: "image" }, { path: "/host/project/notes.txt", name: "notes.txt", kind: "file" }] });
  const { call, calls } = harness({ native: { remote_studio_attachment_image: { mime: "image/png", size: 3, data: "AAAA", done: true } } });
  assert.deepEqual(projectMessage("t", useTaskStore.getState().tasks.t.messages[0], 1).attachmentImages, [0]);
  const { result } = await call("attachment.image", { workspaceId: "p", threadId: "t", messageId: "m", index: 0 });
  assert.equal(result.mime, "image/png"); assert.equal(calls[0].args.path, "/host/project/shot.png"); assert.ok(!wire(result).includes("/host"));
  assert.equal((await call("attachment.image", { workspaceId: "p", threadId: "t", messageId: "m", index: 1 })).error.code, "stale_target");
  assert.equal((await call("attachment.image", { workspaceId: "p", threadId: "t", messageId: "m", index: 9 })).error.code, "unsupported");
  assert.equal((await call("attachment.image", { workspaceId: "p", threadId: "t", messageId: "m", path: "/etc/passwd", index: 0 })).error.code, "unsupported");
  const svg = harness({ native: { remote_studio_attachment_image: { mime: "image/svg+xml", size: 3, data: "AAAA", done: true } } });
  assert.equal((await svg.call("attachment.image", { workspaceId: "p", threadId: "t", messageId: "m", index: 0 })).error.code, "host_unavailable");
});

test("a crew round-trips, reaches the settings, and refuses what the host doesn't offer", () => {
  const target = { id: "reviewer", provider: "claude", model: "opus", label: "Reviewer", description: "Reads", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" };
  const catalog = { getProviderCatalog: () => [{ id: "openai", name: "OpenAI", ready: true, models: [{ id: "gpt", name: "GPT", efforts: [] }] }, { id: "claude", name: "Claude", ready: true, models: [{ id: "opus", name: "Opus", efforts: [] }] }] };
  const base = { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt" };
  const subagents = { enabled: true, engine: "mythra", maxConcurrent: 2, crew: [target] };
  const saved = validateExecutionSettings({ subagents }, catalog, base);
  assert.deepEqual(saved.subagents.crew, publicCrew([target]));
  assert.deepEqual(applyHostExecutionPreferences(base, saved).childAgents.targets.map((entry) => entry.id), ["reviewer"]);
  assert.deepEqual(applyHostExecutionPreferences(base, { crew: saved.subagents.crew }).childAgents.targets.map((entry) => entry.id), ["reviewer"]);
  assert.throws(() => validateExecutionSettings({ subagents: { ...subagents, crew: [{ ...target, model: "not-offered" }] } }, catalog, base));
  assert.throws(() => validateExecutionSettings({ subagents: { ...subagents, crew: [{ ...target, provider: "nonsense" }] } }, catalog, base));
  assert.throws(() => validateExecutionSettings({ subagents: { ...subagents, crew: Array.from({ length: 25 }, (_, n) => ({ ...target, id: `r${n}` })) } }, catalog, base));
});

test("isolated reports whether the thread runs away from the shared project", () => {
  const sources = { getWorkspaces: () => [project], getKnownThreads: () => ({ t: thread }), getBindings: () => ({ t: project.path }), getOwnershipLinks: () => ({}),
    getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(), getRuntime: () => ({ available: true }), getGrant: () => grant,
    getSettings: () => DEFAULT_SETTINGS, getThreadModels: () => ({}), getThreadReasoning: () => ({}), getThreadSubagents: () => ({}), getRuntimeModels: () => [],
    getBaseContext: () => ({}), getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false, onRemoteCodexRuntimeOwned: () => {},
    getProviderCatalog: () => [], getPublicSkills: () => [], getPublicWorkflows: () => [] };
  const request = { device: DEVICE, grant };
  assert.equal(hostContext({ ...sources, executionPathFor: (_id, path) => path }, request, { workspaceId: "p", threadId: "t" }).execution.isolated, false);
  assert.equal(hostContext({ ...sources, executionPathFor: () => "/host/wt" }, request, { workspaceId: "p", threadId: "t" }).execution.isolated, true);
});

test("accepting a checkpoint and stopping an agent need Work, and only act on what is really there", async () => {
  assert.ok(isParityOperation("checkpoint.accept") && isParityOperation("agents.stop"));
  assert.throws(() => assertParityAuthority("agents.stop", grant));
  assertParityAuthority("agents.stop", { ...grant, work: true });
  assert.throws(() => validateParityArgs("agents.stop", { workspaceId: "p", revision: "r", agentId: "a", extra: 1 }));
  resetTaskStore();
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, agents: [{ id: "child", prompt: "", status: "running" }, { id: "fixed", prompt: "", status: "running", canStop: false }] } } }));
  const stopped = [];
  const parity = createHostParity({ stopAgent: async (parent, id) => { stopped.push([parent, id]); }, acceptCheckpoint: (_context, id) => id === "c1" });
  const operation = { context: { activeThread: { id: "t" } }, assertAllowed: () => undefined };
  await parity.execute("agents.stop", { agentId: "child" }, operation);
  assert.deepEqual(stopped, [["t", "child"]]);
  await assert.rejects(parity.execute("agents.stop", { agentId: "ghost" }, operation));
  await assert.rejects(parity.execute("agents.stop", { agentId: "fixed" }, operation));
  assert.equal((await parity.execute("checkpoint.accept", { checkpointId: "c1" }, operation)).state, "accepted");
  await assert.rejects(parity.execute("checkpoint.accept", { checkpointId: "nope" }, operation));
});

test("web previews come from what the agent wrote, for Work only, and never from the viewer", async () => {
  resetTaskStore();
  useTaskStore.getState().ensureTask("t", project.path);
  useTaskStore.getState().appendUserMessage("t", { id: "u", role: "user", text: "open http://localhost:22 please" });
  useTaskStore.setState((state) => ({ tasks: { ...state.tasks, t: { ...state.tasks.t, messages: [...state.tasks.t.messages,
    { id: "a", role: "assistant", text: "Running at http://localhost:3000/app and http://127.0.0.1:3000 and http://[::1]:5173 and https://example.com:8080", streaming: false }] } } }));
  const registered = [];
  const { call } = harness({ grantFor: () => ({ ...grant, work: true }), native: { remote_preview_register: (args) => { registered.push(args); return { endpointId: `e${registered.length}` }; } } });
  const work = { ...grant, work: true };
  const reply = await call("preview.links", { workspaceId: "p", threadId: "t" }, work);
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result.previews.map((entry) => entry.port).sort(), [3000, 5173]);
  assert.deepEqual(registered.map((entry) => entry.address).sort(), ["127.0.0.1:3000", "[::1]:5173"]);
  assert.equal(registered[0].workspaceId, "p"); assert.equal(registered[0].generation, 1);
  await call("preview.links", { workspaceId: "p", threadId: "t" }, work);
  assert.equal(registered.length, 2, "an endpoint is registered once");
  assert.equal((await call("preview.links", { workspaceId: "p", threadId: "t", address: "127.0.0.1:22" }, work)).error.code, "unsupported");
  const viewOnly = harness();
  assert.equal((await viewOnly.call("preview.links", { workspaceId: "p", threadId: "t" })).error.code, "forbidden");
});

test("links that mean the other machine stay off this device's browser", () => {
  for (const link of ["http://home.arpa/", "https://printer.home.arpa", "http://nas.HOME.ARPA:8080/", "http://localhost:3000", "http://router.lan", "http://10.0.0.1"]) assert.equal(isPublicWebLink(link), false, link);
  assert.equal(isPublicWebLink("https://example.com"), true);
  assert.equal(isPublicWebLink("https://home.arpa.example.com"), true);
  assert.equal(hostLocalPort("http://localhost:3000/x"), 3000);
  assert.equal(hostLocalPort("http://[::1]:5173"), 5173);
  assert.equal(hostLocalPort("http://localhost"), null);
  assert.equal(hostLocalPort("http://192.168.1.5:3000"), null);
});

test("a later action can't overtake an earlier one on the same device", async () => {
  const device = "c".repeat(64), order = [];
  globalThis.window ??= {};
  window.__TAURI_INTERNALS__ = { invoke: async () => ({ highestOpSeq: 40 }) };
  let saved;
  const slowSave = new Promise((resolve) => { saved = resolve; });
  const first = sequenced(device, async (opSeq) => { order.push(["save", opSeq]); await slowSave; }, async (opSeq) => { order.push(["send", opSeq]); return "one"; });
  const second = sequenced(device, () => undefined, async (opSeq) => { order.push(["send", opSeq]); return "two"; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, [["save", 41]], "the second waits for the first frame");
  saved();
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
  assert.deepEqual(order, [["save", 41], ["send", 41], ["send", 42]]);
  // Waiting for a reply would stall everything behind one slow operation.
  let finish;
  const slowReply = sequenced(device, () => undefined, () => new Promise((resolve) => { finish = resolve; }));
  assert.equal(await sequenced(device, () => undefined, async () => "next"), "next");
  finish("late"); assert.equal(await slowReply, "late");
  // A failed step must not block the queue.
  await assert.rejects(sequenced(device, () => { throw new Error("no disk"); }, async () => "never"));
  assert.equal(await sequenced(device, () => undefined, async () => "after"), "after");
  delete window.__TAURI_INTERNALS__;
});

test("a started thread shows the crew it captured, including one waiting for the next message", () => {
  const target = { id: "reviewer", provider: "claude", model: "", label: "Reviewer", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" };
  const sources = { getWorkspaces: () => [project], getKnownThreads: () => ({ t: thread }), getBindings: () => ({ t: project.path }), getOwnershipLinks: () => ({}),
    getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(), getRuntime: () => ({ available: true }), getGrant: () => grant,
    getSettings: () => DEFAULT_SETTINGS, getThreadModels: () => ({}), getThreadReasoning: () => ({}), getThreadSubagents: () => ({}), getRuntimeModels: () => [],
    getBaseContext: () => ({}), getWorkspaceGitInfo: () => null, isWorktreeBusy: () => false, onRemoteCodexRuntimeOwned: () => {},
    getProviderCatalog: () => [], getPublicSkills: () => [], getPublicWorkflows: () => [], executionPathFor: (_id, path) => path,
    getThreadCrew: () => ({ maxConcurrent: 3, targets: [target] }) };
  const context = hostContext(sources, { device: DEVICE, grant }, { workspaceId: "p", threadId: "t" });
  assert.deepEqual(context.execution.subagents.crew.map((entry) => entry.id), ["reviewer"]);
  assert.equal(context.execution.subagents.maxConcurrent, 3);
});

test("uppercase Windows workspace badges use the schedule producer's exact path key", async () => {
  const { countScheduledPrompts } = await import("../../scheduledPromptCounts.ts");
  const { call, sources } = harness();
  const path = "C:\\Users\\Morgan\\Project\\";
  const counts = countScheduledPrompts([], { [path]: [{ id: "new", status: "scheduled" }] }, { bindings: {}, knownThreads: {}, worktrees: {}, tasks: {} });
  sources.getWorkspaces = () => [{ ...project, path }];
  sources.getScheduledCounts = () => counts;
  const { result } = await call("workspaces.list", {});
  assert.deepEqual(result.workspaces[0].scheduled, { newConversations: 1, threadPrompts: 0 });
  assert.equal(Object.keys(counts.workspaces)[0], "C:/Users/Morgan/Project");
});

test("new isolated draft availability requires Work, Terminal, a repository root and a commit", () => {
  const ready = { isRepo: true, isRoot: true, hasCommit: true };
  let current = { ...grant, work: true, capabilities: { ...grant.capabilities, terminal: true } }, git = ready;
  const sources = { getWorkspaces: () => [project], getKnownThreads: () => ({ t: thread }), getBindings: () => ({ t: project.path }), getOwnershipLinks: () => ({}),
    getArchivedThreadIds: () => new Set(), getUnavailableThreadIds: () => new Set(), getRuntime: () => ({ available: true }), getGrant: () => current,
    getSettings: () => DEFAULT_SETTINGS, getThreadModels: () => ({}), getThreadReasoning: () => ({}), getThreadSubagents: () => ({}), getRuntimeModels: () => [],
    getBaseContext: () => ({}), getWorkspaceGitInfo: () => git, isWorktreeBusy: () => false, onRemoteCodexRuntimeOwned() {}, executionPathFor: (_id, root) => root,
    getProviderCatalog: () => [], getPublicSkills: () => [], getPublicWorkflows: () => [] };
  const read = () => hostContext(sources, { device: DEVICE, grant: current }, { workspaceId: "p" }).execution;
  assert.equal(read().canCreateIsolated, true); assert.equal(read().isolationBlocked, undefined);
  current = { ...current, capabilities: { ...current.capabilities, terminal: false } };
  assert.equal(read().canCreateIsolated, false); assert.equal(read().isolationBlocked, "terminal");
  current = { ...current, capabilities: { ...current.capabilities, terminal: true } };
  for (const [field, reason] of [["isRepo", "repository"], ["isRoot", "root"], ["hasCommit", "commit"]]) {
    git = { ...ready, [field]: false }; assert.equal(read().canCreateIsolated, false); assert.equal(read().isolationBlocked, reason);
  }
  git = null; assert.equal(read().canCreateIsolated, false);
  git = ready; current = { ...current, work: false }; assert.equal(read().canCreateIsolated, false);
});
