import test from "node:test";
import assert from "node:assert/strict";
import { HostGitHub, isGitHubRead, isGitHubWrite, wirePullRequest } from "./githubActions.ts";
import { isDomainMutation, isDomainRead } from "./domainActions.ts";

const HEAD = "a".repeat(40), LATER = "b".repeat(40), OP = "op-1";
const pullRequest = { repository: "me/app", number: 7, url: "https://github.com/me/app/pull/7", title: "Fix", body: "Body", state: "OPEN", isDraft: false, headRefName: "fix", baseRefName: "main", headOid: HEAD,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", checks: [{ name: "ci", state: "SUCCESS", url: "https://github.com/me/app/runs/1", secretLog: "token" }], updatedAt: "now", canMerge: true, mergeMethods: ["squash", "rocket"], author: { email: "a@b.c" } };
const grant = { revision: 3 };
const request = (op, device = "d1", revision = 3) => ({ op, device, generation: 1, requestId: "r", grant: { ...grant, revision } });
const target = { workspaceId: "w", threadId: "t", root: "/host/project", isolated: false };
const stamp = { workspaceId: "w", threadId: "t" };
const identity = { opId: OP, opSeq: 1 };
function host(replies = {}) {
  const calls = [];
  const transport = { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "github_repo_status") return replies.repo === undefined ? { repository: "me/app" } : replies.repo;
    if (command === "github_status") return { authenticated: true, login: "me", email: "secret@example.com" };
    if (command === "remote_github_read") {
      if (args.action === "github.pr.context") return { repository: "me/app", branch: "fix", defaultBranch: "main", headOid: HEAD, dirty: false, ahead: 1, behind: 0, pushRemote: "https://token@github.com/me/app", permission: "WRITE", mergeMethods: ["merge"], remoteUrl: "x" };
      if (args.action === "github.comments.list") return { comments: [{ id: 1, author: "me", body: "Hi", url: "file:///etc/passwd", createdAt: "now", updatedAt: "now", extra: 1 }], hasMore: false };
      if (args.action === "github.ci.status") return { checks: pullRequest.checks, headOid: HEAD, mergeStateStatus: "CLEAN", extra: 1 };
      if (args.action === "github.pr.list") return [{ ...pullRequest, authorLogin: "me" }];
      return { ...pullRequest, headOid: replies.head ?? HEAD };
    }
    if (command === "remote_github_execute") return replies.execute ?? { result: { opId: OP, state: "accepted" }, payload: { number: 7, creationOutcome: "created", body: "not for the viewer" } };
    throw new Error(`unexpected ${command}`);
  } };
  return { github: new HostGitHub(1, transport), calls };
}
const fine = () => undefined;

test("GitHub operations are routed through the domain adapter by their exact names", () => {
  for (const op of ["github.comments.list", "github.ci.status", "github.pr.view", "github.pr.list", "github.pr.find", "github.pr.context"]) assert.ok(isGitHubRead(op) && isDomainRead(op) && !isDomainMutation(op), op);
  for (const op of ["github.pr.create", "github.pr.merge", "github.pr.ready", "github.pr.comment"]) assert.ok(isGitHubWrite(op) && isDomainMutation(op) && !isDomainRead(op), op);
  assert.ok(!isGitHubRead("github.raw") && !isGitHubWrite("github.raw"));
});

test("a pull request crosses as an allowlist, and only GitHub links survive", () => {
  const wire = wirePullRequest({ ...pullRequest, url: "file:///etc/passwd" });
  assert.equal(wire.url, "");
  assert.deepEqual(wire.mergeMethods, ["squash"]);
  assert.deepEqual(wire.checks, [{ name: "ci", state: "SUCCESS", url: "https://github.com/me/app/runs/1" }]);
  assert.ok(!JSON.stringify(wire).includes("a@b.c"));
  assert.throws(() => wirePullRequest({ ...pullRequest, state: "HACKED" }));
});

test("reads use the host's repository, never one a viewer supplied", async () => {
  const { github, calls } = host();
  await github.read(request("github.pr.view"), { number: 7, repository: "them/other", root: "/etc" }, target, fine);
  const call = calls.find((entry) => entry.command === "remote_github_read");
  assert.deepEqual(call.args.args, { repository: "me/app", number: 7 });
  assert.equal(call.args.root, "/host/project");
  assert.equal(call.args.grantRevision, 3);
});

test("the context hides account details and credential-bearing remotes", async () => {
  const { github } = host();
  const access = await github.read(request("github.pr.context"), {}, target, fine);
  assert.equal(access.authenticated, true);
  assert.equal(access.repository, "me/app");
  assert.equal(access.context.pushRemote, "");
  assert.ok(!JSON.stringify(access).includes("secret@example.com") && !JSON.stringify(access).includes("token"));
});

test("a project with no GitHub repository says so instead of guessing", async () => {
  const { github, calls } = host({ repo: { repository: null } });
  const access = await github.read(request("github.pr.context"), {}, target, fine);
  assert.equal(access.repository, null);
  assert.equal(calls.some((entry) => entry.command === "remote_github_read"), false);
  await assert.rejects(github.read(request("github.pr.view"), { number: 7 }, target, fine), { code: "unsupported" });
});

test("comments and checks stay inside their shapes", async () => {
  const { github } = host();
  const { comments } = await github.read(request("github.comments.list"), { number: 7 }, target, fine);
  assert.deepEqual(comments, [{ id: "1", author: "me", body: "Hi", url: "", createdAt: "now", updatedAt: "now" }]);
  const status = await github.read(request("github.ci.status"), { number: 7 }, target, fine);
  assert.deepEqual(Object.keys(status).sort(), ["checks", "headOid", "mergeStateStatus"]);
});

test("a write answers the head this device was last shown, and refuses without one", async () => {
  const { github, calls } = host();
  await assert.rejects(github.write(request("github.pr.merge"), { number: 7, method: "squash" }, identity, stamp, target.root, fine), { code: "stale_target" });
  assert.equal(calls.some((entry) => entry.command === "remote_github_execute"), false);
  await github.read(request("github.pr.view"), { number: 7 }, target, fine);
  const result = await github.write(request("github.pr.merge"), { number: 7, method: "squash", auto: false, expectedHeadOid: LATER, repository: "them/other" }, identity, stamp, target.root, fine);
  const call = calls.find((entry) => entry.command === "remote_github_execute");
  assert.deepEqual(call.args.args, { repository: "me/app", number: 7, method: "squash", auto: false, expectedHeadOid: HEAD });
  assert.equal(result.state, "accepted");
  assert.equal(JSON.stringify(result).includes("not for the viewer"), false);
});

test("what one device saw never authorizes another, or a changed grant", async () => {
  const { github } = host();
  await github.read(request("github.pr.view", "d1"), { number: 7 }, target, fine);
  await assert.rejects(github.write(request("github.pr.ready", "d2"), { number: 7 }, identity, stamp, target.root, fine), { code: "stale_target" });
  await assert.rejects(github.write(request("github.pr.ready", "d1", 4), { number: 7 }, identity, stamp, target.root, fine), { code: "stale_target" });
});

test("create measures against the checkout the context read showed", async () => {
  const { github, calls } = host();
  const args = { head: "fix", base: "main", title: "Fix", body: "", draft: false, commitAll: false };
  await assert.rejects(github.write(request("github.pr.create"), args, identity, stamp, target.root, fine), { code: "stale_target" });
  await github.read(request("github.pr.context"), {}, target, fine);
  const result = await github.write(request("github.pr.create"), args, identity, stamp, target.root, fine);
  assert.equal(calls.find((entry) => entry.command === "remote_github_execute").args.args.expectedHeadOid, HEAD);
  assert.equal(result.number, 7);
  assert.equal(result.creationOutcome, "created");
});

test("access is rechecked at the last moment, and a refused write never reaches GitHub", async () => {
  const { github, calls } = host();
  await github.read(request("github.pr.view"), { number: 7 }, target, fine);
  await assert.rejects(github.write(request("github.pr.comment"), { number: 7, body: "Hi" }, identity, stamp, target.root, () => { throw Object.assign(new Error("no"), { code: "forbidden" }); }), { code: "forbidden" });
  assert.equal(calls.some((entry) => entry.command === "remote_github_execute"), false);
});

test("an unconfirmed reply is never reported as a failure that is safe to repeat", async () => {
  const { github } = host({ execute: { result: { opId: "someone-else", state: "accepted" } } });
  await github.read(request("github.pr.view"), { number: 7 }, target, fine);
  await assert.rejects(github.write(request("github.pr.comment"), { number: 7, body: "Hi" }, identity, stamp, target.root, fine), { code: "uncertain" });
});

test("a retired adapter refuses and forgets", async () => {
  const { github } = host();
  await github.read(request("github.pr.view"), { number: 7 }, target, fine);
  github.dispose();
  await assert.rejects(github.read(request("github.pr.view"), { number: 7 }, target, fine), { code: "host_unavailable" });
  await assert.rejects(github.write(request("github.pr.ready"), { number: 7 }, identity, stamp, target.root, fine), { code: "host_unavailable" });
});
