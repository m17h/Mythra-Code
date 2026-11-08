// Thread watching and the host's new write gates.
import test from "node:test";
import assert from "node:assert/strict";
import { threadChanges } from "./remoteStore.ts";
import { remoteGuide } from "./firstRun.ts";
import { deviceHelp, deviceHelpOffersRetry } from "./devices.ts";
import { isParityOperation } from "./host/parityActions.ts";
import { clearRemoteEngineOwners, hasRemoteWork, noteLocalWork, noteRemoteWork, rememberRemoteEngineOwner } from "./host/engineOwners.ts";
import { checkpointUnlessRemote } from "./host/remoteCheckpoint.ts";
import { useTaskStore } from "../taskStore.ts";
import { createWorkerReads, workerRuntime } from "./workerReads.ts";
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

test("automatic publishing can't be changed from another device", () => {
  assert.equal(isParityOperation("git.autoPublish.set"), false);
  assert.equal(isParityOperation("git.autoPublish.retry"), false);
});

function navigation(capabilities = { manageProjects: true, terminal: true }) {
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
  const { request } = navigation({ manageProjects: false, terminal: true });
  await assert.rejects(request("projects.clone", { folderId: "x", url: "x", opId: "op", opSeq: 1 }), /Manage projects/);
});

test("cloning needs Terminal too, and browsing doesn't", async () => {
  const { request } = navigation({ manageProjects: true, terminal: false });
  const [folder] = (await request("folders.browse", {})).folders;
  await assert.rejects(request("projects.clone", { folderId: folder.id, url: "https://github.com/a/repo", opId: "op", opSeq: 1 }), /Terminal/);
});

const guide = (over = {}) => remoteGuide({ name: "ZEDS-PC", loading: false, workspaces: [{ isChat: true }, { isChat: false }], chosenWorkspace: true, providers: [{ ready: true }], canWork: true, canAddProjects: false, ...over });
test("a ready machine shows no guide at all", () => { assert.equal(guide(), null); });
test("before the host answers, it says it's opening rather than showing nothing", () => {
  assert.equal(guide({ workspaces: null }).kind, "opening");
  assert.equal(guide({ workspaces: [], loading: true }).kind, "opening");
});
test("no access says exactly where to share from", () => {
  const shown = guide({ workspaces: [] });
  assert.equal(shown.kind, "nothingShared");
  assert.match(shown.body, /Settings → Connections → Devices/);
  assert.deepEqual(shown.actions, ["checkAgain"]);
});
test("no projects offers adding one only to a device allowed to", () => {
  const empty = { workspaces: [{ isChat: true }], chosenWorkspace: false };
  assert.deepEqual(guide({ ...empty, canAddProjects: true }).actions, ["addProject", "openChats"]);
  const refused = guide(empty);
  assert.equal(refused.kind, "noProjects");
  assert.deepEqual(refused.actions, ["openChats", "checkAgain"]);
  assert.match(refused.body, /Manage projects/);
});
test("no ready provider names where to sign in, and an unanswered list isn't called empty", () => {
  const shown = guide({ providers: [{ ready: false }] });
  assert.equal(shown.kind, "noProviders");
  assert.match(shown.body, /Accounts & connections/);
  assert.equal(guide({ providers: [] }).kind, "noProviders");
  assert.equal(guide({ providers: null }), null);
});
test("a view-only device is told how to get Work", () => {
  assert.equal(guide({ canWork: false }).kind, "viewOnly");
});
test("a project list with nothing picked asks for a pick", () => {
  assert.equal(guide({ chosenWorkspace: false }).kind, "chooseProject");
});

const unreachable = (platform) => ({ name: "Studio", platform, state: "unreachable", updateOn: null });
test("an unreachable Mac gets the firewall step as a possibility, with Try again beside it", () => {
  const help = deviceHelp(unreachable("macos"), {});
  assert.match(help, /may be asleep/);
  assert.match(help, /firewall may also be blocking/);
  assert.match(help, /On that Mac, open System Settings → Network → Firewall → Options and allow incoming connections for Mythra Code\. Then choose Try again\./);
  assert.equal(deviceHelpOffersRetry(unreachable("macos")), true);
});
test("other platforms keep their wording and don't ask for a button they don't have", () => {
  assert.match(deviceHelp(unreachable("windows"), {}), /^Windows may be blocking/);
  assert.doesNotMatch(deviceHelp(unreachable("other"), {}), /Try again/);
  assert.equal(deviceHelpOffersRetry(unreachable("windows")), false);
  assert.equal(deviceHelpOffersRetry({ ...unreachable("macos"), state: "offline" }), false);
});

test("work from another device stays marked after its lease ends, until someone here takes over", () => {
  rememberRemoteEngineOwner({ generation: 7, threadId: "marked", runId: "r", kind: "parent", ownerHandle: "marked-owner" });
  assert.equal(hasRemoteWork("marked"), true);
  clearRemoteEngineOwners(7);
  assert.equal(hasRemoteWork("marked"), true);
  noteLocalWork("marked");
  assert.equal(hasRemoteWork("marked"), false);
});
test("local owners and placeholder ids never mark a thread", () => {
  rememberRemoteEngineOwner({ generation: 0, local: true, threadId: "local-thread", runId: "r", kind: "parent", ownerHandle: "local-owner" });
  rememberRemoteEngineOwner({ generation: 7, threadId: "command:1", runId: "r", kind: "start", ownerHandle: "command-owner" });
  rememberRemoteEngineOwner({ generation: 7, threadId: "preparing:1", runId: "r", kind: "workflow", ownerHandle: "preparing-owner" });
  for (const id of ["local-thread", "command:1", "preparing:1"]) assert.equal(hasRemoteWork(id), false);
  clearRemoteEngineOwners(7);
});
test("the remote-work list can't grow without limit", () => {
  noteRemoteWork("oldest");
  for (let index = 0; index < 4_096; index += 1) noteRemoteWork(`filler-${index}`);
  assert.equal(hasRemoteWork("oldest"), false);
  assert.equal(hasRemoteWork("filler-4095"), true);
  for (let index = 0; index < 4_096; index += 1) noteLocalWork(`filler-${index}`);
});
test("local checkpoints run exactly as before", async () => {
  let calls = 0;
  assert.equal(await checkpointUnlessRemote(["root", "child"], "root", async () => { calls += 1; return "checkpoint"; }), "checkpoint");
  assert.equal(calls, 1);
  assert.equal(useTaskStore.getState().tasks.root?.activities?.length ?? 0, 0);
});
test("a child under remote work runs no Git and says the checkpoint wasn't made", async () => {
  noteRemoteWork("remote-root");
  let calls = 0;
  const begin = async () => { calls += 1; return "checkpoint"; };
  assert.equal(await checkpointUnlessRemote(["remote-root", "child"], "remote-root", begin), undefined);
  assert.equal(calls, 0);
  assert.equal(useTaskStore.getState().tasks["remote-root"].activities.some((activity) => activity.kind === "warning" && activity.title === "Automatic checkpoint not created"), true);
  assert.equal(await checkpointUnlessRemote(["child", "remote-root"], null, begin), undefined);
  assert.equal(calls, 0);
  noteLocalWork("remote-root");
});

test("a slow worker list can't land in the draft you switched to", () => {
  const reads = createWorkerReads(), thread = { device: "d", workspaceId: "w", threadId: "t" }, draft = { device: "d", workspaceId: "w" };
  reads.enter(thread);
  const slow = reads.begin(thread);
  assert.equal(reads.accepts(slow, thread), true);
  reads.enter(draft);
  assert.equal(reads.accepts(slow, thread), false);
  assert.equal(reads.begin(draft), null);
  assert.equal(reads.begin(thread), null);
});
test("an older answer loses to a newer one, and leaving drops everything", () => {
  const reads = createWorkerReads(), thread = { device: "d", workspaceId: "w", threadId: "t" };
  reads.enter(thread);
  const first = reads.begin(thread), second = reads.begin(thread);
  assert.equal(reads.accepts(first, thread), false);
  assert.equal(reads.accepts(second, thread), true);
  reads.leave();
  assert.equal(reads.accepts(second, thread), false);
  assert.equal(reads.begin(thread), null);
});
test("a stale refresh from the old scope can't cancel the current read", () => {
  const reads = createWorkerReads(), one = { device: "d", workspaceId: "w", threadId: "1" }, two = { device: "d", workspaceId: "w", threadId: "2" };
  reads.enter(two);
  const live = reads.begin(two);
  assert.equal(reads.begin(one), null);
  assert.equal(reads.accepts(live, two), true);
});
test("Codex children keep their own runtime on the other device", () => {
  assert.equal(workerRuntime({ nativeRuntime: "codex", provider: "openai" }), "codex");
  assert.equal(workerRuntime({ nativeRuntime: "claude" }), "claude");
  assert.equal(workerRuntime({ provider: "claude" }), "claude");
  assert.equal(workerRuntime({ provider: "openai" }), "codex");
  assert.equal(workerRuntime({}), "codex");
});
