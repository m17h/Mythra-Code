import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { useTurnRunner } from "../../../hooks/useTurnRunner.ts";
import { DEFAULT_SETTINGS } from "../../appConfig.ts";
import { flushPendingStateWrites } from "../../storage.ts";
import { PendingTurnStarts } from "../../pendingTurnStarts.ts";
import { resetTaskStore, useTaskStore } from "../../taskStore.ts";
import { RemoteDeliveryJournal } from "./deliveryJournal.ts";
import { remoteStartOwner, remoteEngineStopped, clearRemoteEngineOwners } from "./engineOwners.ts";
import { sameStop, sameStopLifetime } from "./targetHandles.ts";
import { HostHistory } from "./history.ts";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const device = "a".repeat(64), grant = { revision: 1, view: true, work: true, scope: { kind: "all" }, capabilities: { fullAccess: false } };
const project = { id: "p", path: "/host/project", name: "Project" };

for (const mode of ["stop", "send", "project", "isolated"]) for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) test(`${provider}: real runner ${mode === "stop" ? "exposes owner and cancels preparation before input" : mode === "isolated" ? "refuses unstamped isolated draft creation" : `reaches registered native start (${mode})`}`, async () => {
  resetTaskStore(); clearRemoteEngineOwners(13);
  const old = globalThis.window, calls = [], errors = [], ownerAdmission = deferred(), skills = deferred(), skillEntered = deferred();
  globalThis.window = { setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_receipt") return;
    if (command === "remote_work_owner_open") { await ownerAdmission.promise; return { ownerHandle: `owner-${provider}` }; }
    if (command === "remote_work_owner_finish") return { confirmed: true };
    if (mode !== "stop") {
      if (command === "child_agent_session_start") return { registrationId: `registration-${provider}`, name: "project-tools", command: "host-bridge", args: [], configPath: "/private/project-tools.json", toolNames: ["propose_agent_settings"] };
      if (command === "child_agent_session_end" || command === "child_agent_revoke_root_registration") return;
      if (command === "preference_learning_list") return [];
      if (command === "runtime_thread_state") return { instance: "runtime", loaded: false };
      if (command === "cursor_turn_state" || command === "local_transcript_full_read") return null;
      if (command === "local_transcript_write_state_read") return null;
      if (command === "local_transcript_snapshot_write" || command === "local_transcript_tail_write" || command === "local_transcript_metadata_write") return { generation: 1, headSeq: 0, tailSeq: 0 };
      if (command === "state_write") return;
      if (command === "codex_rpc" && args.method === "thread/resume") return { thread: { id: provider }, model: "provider-model", runtimeInstance: "runtime" };
      if (command === "codex_rpc" && args.method === "turn/start") return { turn: { id: `turn-${provider}`, status: "inProgress", items: [] } };
      if (command === "claude_turn_start" || command === "cursor_turn_start") return { turnId: `turn-${provider}`, cursorSessionId: "session" };
    }
    assert.fail(`Unexpected native call before ${mode}: ${command}${args?.method ? `:${args.method}` : ""}`);
  } } };
  const thread = { id: provider, modelProvider: provider, cwd: project.path, updatedAt: 1, preview: "Existing thread" };
  useTaskStore.getState().ensureTask(thread.id, project.path);
  const settings = { ...DEFAULT_SETTINGS, provider, model: "provider-model", subagentsEnabled: false, autoCompactTokens: undefined, projectInstructionsEnabled: false, projectClaudeInstructionsEnabled: false };
  const journal = new RemoteDeliveryJournal({ generation: 13, identity: { device, opId: `send-${provider}`, opSeq: 1 }, threadId: thread.id, workspaceId: "p", permission: "ask", provider,
    isCurrent: () => true, assertAllowed() {}, validateGrant() {} });
  const noop = () => {};
  const context = { activeThread: thread, activeWorkspace: project, activeProject: project, effectiveSettings: settings,
    deferredDelivery: true, remoteDelivery: journal, attachments: [], running: false, childAgentLinks: {}, childAgentPolicies: {},
    subscriptionSystemPrompts: { openai: "", claude: "" }, customAgents: [], openRouterModels: [], lmStudioModels: [],
    runtimeStatus: { available: true, compatible: true }, account: { type: "chatgpt" }, openRouterReady: true, lmStudioReady: true,
    claudeStatus: { available: true, loggedIn: true }, cursorStatus: { available: true, loggedIn: true },
    workspaceGitInfo: null, draftThreadIsolated: false, worktreeBusy: false, skillsFolder: "",
    threadWorktreesRef: { current: {} }, threadProjectBindingsRef: { current: { [thread.id]: project.path } },
    activeWorkspacePathRef: { current: project.path }, pendingTurnStartsRef: { current: new PendingTurnStarts() },
    skillRuntimeRootRef: { current: "" }, cursorSessionIdsRef: { current: {} },
    executionPathFor: () => project.path, resolveSkillPrompt: async (text) => text,
    resolveSkillPrompts: async (prompt, systemPrompt) => { skillEntered.resolve(); await skills.promise; return { prompt, systemPrompt, skillReferences: [] }; },
    setError: (value) => { if (value) errors.push(value); }, setStatus: noop, setTransientStatus: noop, setThreads: noop,
    setActiveThread: noop, setAttachments: noop, setDraftThreadIsolated: noop, setStartingDraftTurn: noop,
    setRuntimeSetupOpen: noop, setAuthRequiredOpen: noop, openSettings: noop,
    childAgentReadiness: {}, ensureSkillRoots: async () => {}, waitForThreadPreparation: async () => {},
    beginRunCheckpoint: async () => { assert.fail("remote prompt executed an unstamped local checkpoint"); }, prepareNewThreadGit: async () => { assert.fail("remote prompt executed unstamped Git init"); }, discardRunCheckpoint: noop, rememberThread: noop, persistChildAgentPolicies: noop,
    scheduleClaudeThreadSave: noop, scheduleCursorThreadSave: noop,
  };
  if (mode === "isolated") { context.activeThread = null; context.draftThreadIsolated = true; }
  if (mode === "send") { context.activeProject = null; context.activeWorkspace = { ...project, isChat: true }; }
  let runner;
  function Fixture() { runner = useTurnRunner(context); return React.createElement("span"); }
  try {
    renderToString(React.createElement(Fixture));
    const sending = runner.sendPromptTo(context, "Hello from another machine");
    if (mode === "isolated") {
      const outcome = await sending;
      assert.equal(outcome.state, "rejected"); assert.equal(outcome.error?.code, "unsupported");
      assert.equal(calls.some(([name]) => name === "worktree_create" || name === "codex_rpc" || name === "claude_turn_start" || name === "cursor_turn_start"), false);
      return;
    }
    assert.equal(useTaskStore.getState().tasks[thread.id].status, "starting", errors.join("; "));
    let joined = false;
    const waiting = runner.waitForThreadStopTarget(thread.id).then(() => { joined = true; });
    await Promise.resolve(); assert.equal(joined, false);
    ownerAdmission.resolve(); await waiting; await skillEntered.promise;
    const target = runner.getThreadStopTarget(thread.id);
    assert.equal(target.ownerHandle, `owner-${provider}`); assert.equal(target.turnId, undefined);
    assert.equal(remoteStartOwner(thread.id).ownerHandle, target.ownerHandle);
    if (mode === "send" || mode === "project") {
      skills.resolve(); const outcome = await sending;
      assert.equal(outcome.state, "accepted", errors.join("; "));
      const command = provider === "claude" ? "claude_turn_start" : provider === "cursor" ? "cursor_turn_start" : "codex_rpc";
      const input = calls.find(([name, args]) => name === command && (name !== "codex_rpc" || args.method === "turn/start"));
      assert.ok(input); const params = input[1].options ?? input[1].params;
      assert.equal(params.remoteDelivery.ownerHandle, `owner-${provider}`);
      assert.equal(params.remoteDelivery.opId, `send-${provider}`);
      assert.equal(params.threadId, thread.id);
      assert.equal(runner.getThreadStopTarget(thread.id).turnId, `turn-${provider}`);
      useTaskStore.getState().completeTurn(thread.id, `turn-${provider}`, "completed");
      await flushPendingStateWrites();
      return;
    }
    let stopped = 0;
    await runner.stopThreadTurn({ ...context, running: true, remoteStop: async () => { stopped++; } }, target);
    assert.equal(stopped, 1); assert.equal(useTaskStore.getState().tasks[thread.id].status, "interrupted");
    skills.resolve(); const outcome = await sending;
    assert.notEqual(outcome.state, "accepted");
    assert.equal(calls.some(([name]) => name === "codex_rpc" || name === "claude_turn_start" || name === "cursor_turn_start"), false);
  } finally { skills.resolve(); ownerAdmission.resolve(); remoteEngineStopped(`owner-${provider}`); clearRemoteEngineOwners(13); globalThis.window = old; resetTaskStore(); }
});

test("whole-owner startup Stop survives its turn-ID acknowledgement, but not a successor; Steer stays exact", () => {
  const starting = { threadId: "t", ownerHandle: "owner", ownerRunId: "run", agentRunId: "a", runStartedAt: 1 };
  const running = { ...starting, turnId: "newly-acknowledged", startRequestId: "start" };
  assert.equal(sameStopLifetime(starting, running), true); assert.equal(sameStop(starting, running), false);
  assert.equal(sameStopLifetime(starting, { ...running, agentRunId: "successor" }), false);
  assert.equal(sameStopLifetime(starting, { ...running, ownerHandle: "successor" }), false);
});

test("core first-run native commands are actually registered, not only mocked by renderer tests", () => {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");
  const registered = new Set([...source.matchAll(/generate_handler!\[([\s\S]*?)\]/g)].flatMap((match) => [...match[1].matchAll(/(?:[a-zA-Z_][a-zA-Z0-9_]*::)*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g)].map((entry) => entry[1])));
  for (const command of ["remote_request", "remote_host_attach", "remote_host_ready", "remote_host_renew", "remote_host_publish", "remote_host_respond", "remote_host_tick_ack", "remote_host_thread_retired",
    "remote_work_grant", "remote_work_receipt", "remote_work_recover", "remote_work_owner_open", "remote_work_owner_bind", "remote_work_owner_retire", "remote_work_owner_finish", "remote_work_target_register", "remote_work_target_claim", "remote_work_dispatch",
    "runtime_instance", "runtime_thread_state", "codex_rpc", "claude_turn_start", "cursor_turn_start", "cursor_turn_state", "local_transcript_page_read"]) assert.ok(registered.has(command), `${command} missing from lib.rs handler`);
});

for (const provider of ["openai", "openrouter", "lmstudio", "claude", "cursor"]) for (const witness of ["tracked live turn", "new terminal receipt"]) test(`${provider}: hydration uncertainty clears only after ${witness}, not old completed history`, async () => {
  resetTaskStore();
  const old = globalThis.window, id = `history-${provider}`, nativeTurn = `native-${provider}`;
  const thread = { id, cwd: project.path, modelProvider: provider, updatedAt: 1, preview: "" };
  useTaskStore.getState().ensureTask(id, project.path);
  useTaskStore.getState().setActiveTurn(id, "previous-turn");
  useTaskStore.getState().completeTurn(id, "previous-turn", "completed");
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "local_transcript_page_read") return { thread, cursorSessionId: "session", messages: [], activities: [], nextCursor: null, headSeq: 0, tailSeq: 0, generation: 1, byteLen: 0 };
    if (command === "claude_turn_active") return true;
    if (command === "cursor_turn_state") return { turnId: nativeTurn, startRequestId: "start", phase: "completed", cursorSessionId: "session" };
    if (command === "codex_rpc" && args.method === "thread/turns/list") return { data: [{ id: nativeTurn, status: "inProgress", items: [] }], nextCursor: null };
    assert.fail(`Unexpected history IPC ${command}`);
  } } };
  const sources = { getRuntime: () => ({ available: true }), getWorkspaces: () => [project], getBindings: () => ({ [id]: project.path }),
    getOwnershipLinks: () => ({}), getKnownThreads: () => ({ [id]: thread }), executionPathFor: (_id, path) => path, onCursorSession() {} };
  const history = new HostHistory(sources);
  try {
    await history.ensure({ thread, workspacePath: project.path, assertCurrent() {} });
    assert.equal(history.availability(id), "recovering"); // old completion proves nothing
    useTaskStore.getState().setTaskStatus(id, "idle");
    assert.equal(history.availability(id), "recovering"); // idle proves nothing
    useTaskStore.getState().setActiveTurn(id, nativeTurn);
    useTaskStore.getState().setTaskStatus(id, "running");
    if (witness === "tracked live turn") assert.equal(history.availability(id), "ready");
    useTaskStore.getState().completeTurn(id, nativeTurn, "completed");
    assert.equal(history.availability(id), "ready");
  } finally { history.clear(); globalThis.window = old; resetTaskStore(); }
});
