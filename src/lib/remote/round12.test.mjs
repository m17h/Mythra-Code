// Thread watching and the host's new write gates.
import test from "node:test";
import assert from "node:assert/strict";
import { threadChanges } from "./remoteStore.ts";
import { assertParityAuthority, validateParityArgs } from "./host/parityActions.ts";
import { HostProjectNavigation, isProjectNavigationOperation } from "./host/projectNavigation.ts";

const row = (id, status, extra = {}) => ({ id, status, workspaceId: "w", provider: "openai", title: id, preview: "", updatedAt: 1, ...extra });

test("a thread that stops working is reported once, and a failure isn't called finished", () => {
  const before = [row("a", "running"), row("b", "starting"), row("c", "running"), row("d", "idle")];
  const after = [row("a", "completed"), row("b", "error"), row("c", "interrupted"), row("d", "idle")];
  assert.deepEqual(threadChanges(before, after).map(({ thread, kind }) => [thread.id, kind]), [["a", "finished"]]);
  assert.deepEqual(threadChanges(after, after), []);
});

test("a thread newly waiting for an answer is reported, and only when it starts waiting", () => {
  const changes = threadChanges([row("a", "running")], [row("a", "running", { waiting: true })]);
  assert.deepEqual(changes.map(({ kind }) => kind), ["waiting"]);
  assert.deepEqual(threadChanges([row("a", "running", { waiting: true })], [row("a", "running", { waiting: true })]), []);
});

test("a thread seen for the first time announces nothing", () => {
  assert.deepEqual(threadChanges([], [row("a", "completed", { waiting: true })]), []);
});

const grant = (capabilities, extra = {}) => ({ view: true, work: true, scope: { kind: "all" }, capabilities, ...extra });
test("automatic publishing can push, so it needs Work, Git changes and Terminal", () => {
  for (const op of ["git.autoPublish.set", "git.autoPublish.retry"]) {
    assert.doesNotThrow(() => assertParityAuthority(op, grant({ gitWrite: true, terminal: true })));
    assert.throws(() => assertParityAuthority(op, grant({ gitWrite: true, terminal: false })), /Terminal/);
    assert.throws(() => assertParityAuthority(op, grant({ gitWrite: false, terminal: true })), /Terminal/);
    assert.throws(() => assertParityAuthority(op, grant({ gitWrite: true, terminal: true }, { work: false })), /Work/);
  }
});

test("the publishing switch must be a real yes or no", () => {
  const args = { workspaceId: "w", opId: "o", opSeq: 1, revision: "r" };
  assert.doesNotThrow(() => validateParityArgs("git.autoPublish.set", { ...args, enabled: true }));
  assert.throws(() => validateParityArgs("git.autoPublish.set", { ...args, enabled: "yes" }));
  assert.throws(() => validateParityArgs("git.autoPublish.set", args));
  assert.throws(() => validateParityArgs("git.autoPublish.retry", { ...args, command: "x" }));
});

function navigation(capabilities = { manageProjects: true }) {
  const device = "a".repeat(64), live = { revision: 1, view: true, work: true, scope: { kind: "all" }, capabilities };
  const calls = [];
  const transport = { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "remote_folders_browse") return { folder: null, parent: null, folders: [{ token: "root", name: "Home", canAdd: true }], truncated: false, next: null };
    if (command === "remote_projects_clone") return { state: "accepted", processHandle: "11111111-1111-4111-8111-111111111111", name: "repo", secret: "/private/path" };
    if (command === "remote_projects_clone_status") return { state: "completed", path: "/private/path" };
    throw new Error(command);
  } };
  const host = new HostProjectNavigation({ getGrant: () => live }, 1, () => true, undefined, transport);
  const request = (op, args) => host.execute({ generation: 1, device, grant: live, op, args });
  return { calls, request };
}

test("clone and its status are project navigation, and their answers carry no host path", async () => {
  assert.ok(isProjectNavigationOperation("projects.clone") && isProjectNavigationOperation("projects.clone.status"));
  const { calls, request } = navigation();
  const [folder] = (await request("folders.browse", {})).folders;
  const started = await request("projects.clone", { folderId: folder.id, url: "https://github.com/a/repo", opId: "op", opSeq: 2 });
  assert.deepEqual(started, { opId: "op", state: "accepted", processHandle: "11111111-1111-4111-8111-111111111111", name: "repo" });
  assert.equal(calls.at(-1)[1].folderToken, "root");
  assert.deepEqual(await request("projects.clone.status", { processHandle: started.processHandle }), { state: "completed" });
});

test("a clone refuses a folder this viewer wasn't given, and anything extra", async () => {
  const { request } = navigation();
  await assert.rejects(request("projects.clone", { folderId: "unknown", url: "x", opId: "op", opSeq: 1 }), /expired/);
  const [folder] = (await request("folders.browse", {})).folders;
  await assert.rejects(request("projects.clone", { folderId: folder.id, url: "x", opId: "op", opSeq: 1, destination: "/etc" }));
  await assert.rejects(request("projects.clone", { folderId: folder.id, opId: "op", opSeq: 1 }));
});

test("cloning needs Manage projects", async () => {
  const { request } = navigation({ manageProjects: false });
  await assert.rejects(request("projects.clone", { folderId: "x", url: "x", opId: "op", opSeq: 1 }), /Manage projects/);
});
