import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { workflowRecipeDigest, workflowRecipeSnapshot } from "./workflowDigest.ts";
import { createHostEngineAdapters } from "./engineAdapters.ts";
import { useRemoteDevices } from "../devices.ts";
import { validateParityArgs } from "./parityActions.ts";

const recipe = () => ({ id: "wf", name: "Reviewed recipe", description: "Display only", projectId: "p", enabled: true,
  skillNames: ["review"], variables: [{ id: "input", name: "INPUT", value: "default", promptOnRun: true }],
  steps: [{ id: "agent", name: "Review", type: "agent", prompt: "Review @review", continueOnError: false },
    { id: "shell", name: "Check", type: "command", command: "echo checked", continueOnError: false }],
  run: { provider: "openai", model: "host-model", permission: "ask", reasoningEffort: "high" }, createdAt: 1, updatedAt: 2 });

test("recipe digest is deterministic SHA-256, independent of object key order and run metadata", async () => {
  const before = recipe(), reordered = Object.fromEntries(Object.entries(before).reverse());
  reordered.run = Object.fromEntries(Object.entries(before.run).reverse());
  reordered.updatedAt = 1000;
  const digest = await workflowRecipeDigest(before);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, createHash("sha256").update(workflowRecipeSnapshot(before)).digest("hex"));
  assert.equal(await workflowRecipeDigest(reordered), digest);
});

test("any reviewed step, input, skill, permission or effort edit changes the digest", async () => {
  const original = recipe(), digest = await workflowRecipeDigest(original);
  for (const edit of [
    (w) => { w.steps[0].prompt += " changed"; }, (w) => { w.steps[1].command = "echo changed"; },
    (w) => { w.steps[1].continueOnError = true; }, (w) => { w.steps.reverse(); },
    (w) => { w.variables[0].value = "changed"; }, (w) => { w.variables[0].promptOnRun = false; },
    (w) => { w.skillNames.push("other"); }, (w) => { w.run.permission = "full"; },
    (w) => { w.run.reasoningEffort = "low"; }, (w) => { w.run.model = "another-model"; },
  ]) { const next = structuredClone(original); edit(next); assert.notEqual(await workflowRecipeDigest(next), digest); }
});

function fixture() {
  let current = recipe();
  const project = { id: "p", path: "/host/project", name: "Host project" }, calls = [];
  const grant = { revision: 1, view: true, work: true, scope: { kind: "all" }, capabilities: { terminal: true, fullAccess: false } };
  const device = "a".repeat(64), oldWindow = globalThis.window, oldSnapshot = useRemoteDevices.getState().snapshot;
  useRemoteDevices.setState({ snapshot: { deviceName: "Fixture host" } });
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command) => {
    calls.push(command);
    if (command === "remote_work_grant") return grant;
    if (command === "remote_work_engine_step") return { state: "preparing", delivery: { device, opId: "step", opSeq: 2, attemptId: "attempt", messageId: "message" } };
    if (command === "remote_work_owner_finish") return { confirmed: true };
    assert.fail(`unexpected command ${command}`);
  } } };
  const sources = { getHostWorkflows: () => [current], getWorkspaces: () => [project], getGrant: () => grant,
    getSettings: () => ({ permission: "ask" }), getProviderCatalog: () => [{ id: "openai", models: [{ id: "host-model" }] }],
    getWorkflowEngine: () => ({ runWorkflow: async (_id, _source, _variables, projectId, invocation) => {
      calls.push("engine-start"); assert.equal(projectId, "p");
      await invocation.remote.begin(current, project, "run");
      await invocation.remote.admitted();
      await invocation.remote.finish();
      return "thread";
    } }),
  };
  const actions = createHostEngineAdapters(sources, { revision: () => "r" }, () => {});
  const operation = { identity: { device, opId: "start", opSeq: 1 }, generation: 1, grantRevision: 1,
    context: { activeWorkspace: project, effectiveSettings: { permission: "ask" } }, assertAllowed() {},
    delivery: { openOwner: async () => { calls.push("owner-open"); return "owner"; }, accepted: async () => { calls.push("accepted"); }, result: () => ({ state: "accepted" }) } };
  return { calls, current: () => current, edit: (change) => { current = change(current); },
    start: (digest) => actions.adapter.execute("workflows.start", { workflowId: "wf", digest }, operation),
    close: () => { actions.dispose(); globalThis.window = oldWindow; useRemoteDevices.setState({ snapshot: oldSnapshot }); } };
}

test("mismatched reviewed recipe refuses before engine, owner, Git or provider effects", async () => {
  const f = fixture();
  try {
    const digest = await workflowRecipeDigest(f.current());
    f.edit((w) => ({ ...w, steps: [...w.steps, { id: "unseen", type: "command", command: "echo unseen" }] }));
    await assert.rejects(f.start(digest), (error) => error.code === "workflow_changed" && error.message === "This workflow changed on Fixture host after you reviewed it. Review it again before running.");
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test("recipe edit while SHA-256 is pending cannot race the final start gate", async () => {
  const f = fixture();
  try {
    const digest = await workflowRecipeDigest(f.current());
    const start = f.start(digest);
    f.edit((w) => ({ ...w, run: { ...w.run, permission: "full" } }));
    await assert.rejects(start, (error) => error.code === "workflow_changed");
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test("matching recipe digest reaches the existing owned workflow engine", async () => {
  const f = fixture();
  try {
    const result = await f.start(await workflowRecipeDigest(f.current()));
    assert.equal(result.state, "accepted"); assert.equal(result.workflowRunId, "run");
    assert.equal(f.calls.filter((call) => call === "engine-start").length, 1);
    assert.ok(f.calls.includes("owner-open"));
  } finally { f.close(); }
});

test("workflow digest accepts exactly lowercase SHA-256 hex and only for start", () => {
  const args = { opId: "op", opSeq: 1, workspaceId: "p", revision: "r", workflowId: "wf", digest: "a".repeat(64) };
  assert.doesNotThrow(() => validateParityArgs("workflows.start", args));
  for (const digest of [null, 42, "", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) assert.throws(() => validateParityArgs("workflows.start", { ...args, digest }));
  assert.throws(() => validateParityArgs("workflows.stop", { ...args, runId: "run" }));
});
