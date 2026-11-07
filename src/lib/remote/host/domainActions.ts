import type { CheckpointRecord } from "../../checkpoints";
import type { GitWorkspaceSnapshot } from "../../gitWorkspace";
import type { GitHubRepoStatus } from "../../github";
import type { ThreadWorktreeRecord } from "../../worktrees";
import { recoverRemoteStateRows, withRemoteStateCommit } from "../../storage";
import { useTaskStore } from "../../taskStore";
import type { HostRequest, RemoteOperationIdentity, RemoteWorkResult } from "../wire";
import type { StudioResult } from "../wire-studio";
import { HostStudio } from "./studio";
import { HostStudioReads } from "./studioReads";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostContextSources } from "./hostContext";
import { currentGrant, HostReadError, idArg, requireThread, requireWorkspace } from "./scope";
import { resolveThreadExecutionContext } from "./executionContext";
import { nativeRefusal, nativeTarget, strictNativeKeys } from "./nativeActions";
import type { HostParityActions } from "./parityActions";
import { registerRemoteStateRecovery, type StampedRow } from "./stateCommit";
import { HostGitHub, isGitHubRead, isGitHubWrite } from "./githubActions";

const writes = new Set(["git.write", "checkpoint.create", "checkpoint.complete", "checkpoint.delete", "checkpoint.restore", "worktree.create", "worktree.recreate", "worktree.baseline", "worktree.apply", "worktree.merge", "worktree.remove", "worktree.continueShared", "worktree.returnShared"]);
export const isDomainMutation = (op: string): boolean => writes.has(op) || isGitHubWrite(op);
export const isDomainRead = (op: string): boolean => op === "git.status" || isGitHubRead(op);
interface GitBaseline {
  root: string; revision: string; expires: number; grantRevision: number;
  snapshot: GitWorkspaceSnapshot; remote?: GitHubRepoStatus;
}
const stale = () => new HostReadError("stale_target", "This resource on the other device changed. Refresh before applying the action.");
const invalid = () => new HostReadError("unsupported", "This action is not valid.");
function key(request: HostRequest, args: Record<string, unknown>): string { return JSON.stringify([request.device, args.workspaceId, args.threadId ?? null]); }
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.includes("\0") || new TextEncoder().encode(value).length > maximum) throw invalid();
  return value;
}
/** Filesystem helpers are invoked only with host-derived arguments. Native owns
 * dispatch idempotence; neither an ambiguous reply nor replay re-runs a write. */
export class HostDomains {
  private git = new Map<string, GitBaseline>();
  private disposed = false;
  readonly studio: HostStudio;
  readonly studioReads: HostStudioReads;
  private readonly github: HostGitHub;
  constructor(private readonly sources: HostContextSources, generation: number, private readonly isCurrent: () => boolean,
    private readonly parity?: Pick<HostParityActions, "revision">, private readonly transport: HostTransport = nativeHostTransport) {
    const catalog = { thread: (id: string) => sources.getKnownThreads()[id], ownership: () => sources.getOwnershipLinks() };
    this.studio = new HostStudio(sources, catalog, generation, isCurrent, transport);
    this.studioReads = new HostStudioReads(sources, catalog, this.studio, generation, isCurrent, sources.getStudioReads?.(), transport);
    this.github = new HostGitHub(generation, transport, () => sources.canArchiveThreads?.() === true);
  }
  dispose(): void { this.disposed = true; this.studio.dispose(); this.studioReads.dispose(); this.github.dispose(); this.git.clear(); }
  private check(request: HostRequest): void {
    if (this.disposed || !this.isCurrent()) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly.");
    currentGrant(this.sources, request.device, request.grant);
  }
  private target(request: HostRequest, args: Record<string, unknown>) {
    this.check(request);
    const grant = currentGrant(this.sources, request.device, request.grant);
    const workspace = args.workspaceId === undefined
      ? requireThread(this.sources, this.sources.getKnownThreads()[idArg(args.threadId)], grant).workspace
      : requireWorkspace(this.sources, idArg(args.workspaceId), grant);
    if (workspace.isChat) throw invalid();
    if (args.threadId !== undefined && requireThread(this.sources, this.sources.getKnownThreads()[idArg(args.threadId)], grant).workspace.id !== workspace.id) throw stale();
    const context = resolveThreadExecutionContext(this.sources, args.threadId === undefined ? { workspaceId: workspace.id } : { threadId: idArg(args.threadId) });
    return { workspace, context, root: this.sources.executionPathFor(context.activeThread?.id ?? "", workspace.path) };
  }
  /** Host-only baseline through native anchored safe_git, never local helpers. */
  private async guardedSnapshot(request: HostRequest, root: string): Promise<GitWorkspaceSnapshot> {
    this.check(request);
    try {
      const result = await this.transport.invoke<GitWorkspaceSnapshot>("remote_studio_git_snapshot", { root });
      this.check(request);
      return result;
    } catch (reason) {
      if (typeof reason === "string" && /not found|unknown command/i.test(reason)) throw new HostReadError("unsupported", "This device has not installed guarded Git baseline reads yet.");
      throw reason;
    }
  }
  async read(request: HostRequest, args: Record<string, unknown>): Promise<StudioResult> {
    const before = this.target(request, args);
    const validate = () => { const now = this.target(request, args); if (now.root !== before.root || now.workspace.path !== before.workspace.path) throw stale(); };
    if (isGitHubRead(request.op)) {
      const threadId = before.context.activeThread?.id;
      return await this.github.read(request, args, { workspaceId: before.workspace.id, ...(threadId ? { threadId } : {}), root: before.root, isolated: before.root !== before.workspace.path }, validate) as StudioResult;
    }
    if (request.op === "git.status") {
      const snapshot = await this.guardedSnapshot(request, before.root);
      validate();
      const result = await this.studio.execute(request);
      const after = await this.guardedSnapshot(request, before.root);
      validate();
      if (snapshot.headOid !== after.headOid || snapshot.branch !== after.branch || !after.isRoot) throw stale();
      let remote: GitHubRepoStatus | undefined;
      try { remote = await this.transport.invoke<GitHubRepoStatus>("remote_studio_git_metadata", { root: before.root }); } catch { /* Safe local actions do not require a configured remote. No fallback. */ }
      validate();
      const revision = this.parity?.revision(before.context);
      if (!revision || this.parity?.revision(this.target(request, args).context) !== revision) throw stale();
      while (this.git.size >= 256) this.git.delete(this.git.keys().next().value!);
      this.git.set(key(request, args), { root: before.root, snapshot: after, remote, revision, expires: Date.now() + 300_000, grantRevision: request.grant.revision });
      return result;
    }
    throw invalid();
  }
  async mutate(request: HostRequest, args: Record<string, unknown>, identity: RemoteOperationIdentity): Promise<RemoteWorkResult> {
    this.check(request);
    const target = nativeTarget(this.sources, request, args, identity, () => !this.disposed && this.isCurrent());
    const assertAllowed = () => {
      const grant = target.assertAllowed();
      if ((request.op === "git.write" || isGitHubWrite(request.op)) && !grant.capabilities.gitWrite || request.op === "checkpoint.restore" && !grant.capabilities.checkpointRestore) throw new HostReadError("forbidden", "This device doesn't have that access anymore.");
      if (!this.parity || this.parity.revision(target.context) !== args.revision) throw stale();
      if (target.context.activeThread) {
        const id = target.context.activeThread.id, store = useTaskStore.getState(), task = store.tasks[id];
        if (this.sources.isWorktreeBusy(id) || task?.status === "starting" || task?.status === "running" || store.workflowOwners[id]
          || store.parentRuns[id]) throw new HostReadError("busy", "Stop this thread's active work before changing its checkout.");
      }
    };
    assertAllowed();
    if (request.op === "git.write") return this.gitWrite(request, args, identity, target, assertAllowed);
    if (isGitHubWrite(request.op)) return this.github.write(request, args, identity, target.stamp, target.root, assertAllowed);
    const checkpoint = request.op.startsWith("checkpoint.");
    strictNativeKeys(args, ["workspaceId", "threadId", "revision", ...(checkpoint ? ["checkpointId", "label", "target", "confirmed"]
      : request.op === "worktree.create" || request.op === "worktree.recreate" ? ["label"] : request.op === "worktree.baseline" ? [] : request.op === "worktree.remove" || request.op === "worktree.returnShared" ? ["confirmed", "force"] : ["confirmed"])]);
    if ((request.op === "checkpoint.restore" || request.op === "checkpoint.delete" || request.op === "worktree.apply" || request.op === "worktree.merge" || (request.op === "worktree.remove" || request.op === "worktree.returnShared" || request.op === "worktree.continueShared")) && args.confirmed !== true) throw invalid();
    if (!target.context.activeThread) throw invalid();
    const keys = request.op === "checkpoint.restore" ? ["kiwi.checkpoints", "kiwi.checkpointHeads", "kiwi.threadWorktrees"]
      : request.op === "worktree.apply" || request.op === "worktree.merge" || request.op === "worktree.remove" || request.op === "worktree.returnShared" ? ["kiwi.threadWorktrees", "kiwi.checkpoints", "kiwi.checkpointHeads"]
        : checkpoint ? ["kiwi.checkpoints", "kiwi.checkpointHeads"] : ["kiwi.threadWorktrees"];
    // Missing versioned native bookkeeping support refuses BEFORE any helper runs.
    return withRemoteStateCommit(keys, async (adopt) => {
      let snapshot: { version: number; rows: StampedRow[] };
      try { snapshot = await this.transport.invoke("remote_domain_snapshot", { stamp: target.stamp }); } catch (reason) {
        if (typeof reason === "string" && /(?:not found|unknown command)/i.test(reason)) throw new HostReadError("unsupported", "The other device cannot durably record that checkout action yet.");
        throw nativeRefusal(reason);
      }
      if (snapshot.version !== 1 || snapshot.rows.length !== keys.length || keys.some((key) => !snapshot.rows.some((row) => row.key === key))) throw new HostReadError("unsupported", "The other device cannot durably record that checkout action yet.");
      assertAllowed();
      let root = target.root;
      let nativeArgs: Record<string, unknown>;
      if (checkpoint) {
        const id = idArg(args.checkpointId);
        const records = snapshot.rows.find((row) => row.key === "kiwi.checkpoints")!.value as CheckpointRecord[] | null;
        const record = records?.find((record) => record.id === id);
        if (request.op === "checkpoint.create") {
          if (record) throw stale();
          nativeArgs = { checkpointId: id, label: bounded(args.label, 1024), threadId: target.context.activeThread!.id, createdAt: Date.now(), provider: target.context.effectiveSettings.provider, model: target.context.effectiveSettings.model };
        } else {
          if (!record || record.threadId !== target.context.activeThread!.id || record.workspacePath !== root || record.status === "running") throw stale();
          nativeArgs = { checkpointId: id, label: record.label, ...(request.op === "checkpoint.restore" ? { target: args.target, confirmed: true } : {}) };
          if (request.op === "checkpoint.restore" && (args.target !== "before" && args.target !== "after" || !record.beforeCommit || args.target === "after" && !record.afterCommit)) throw stale();
        }
      } else {
        const records = snapshot.rows.find((row) => row.key === "kiwi.threadWorktrees")!.value as Record<string, ThreadWorktreeRecord> | null;
        const record = records?.[target.context.activeThread!.id];
        root = target.context.activeWorkspace!.path;
        if (request.op === "worktree.create") {
          if (record) throw stale();
          nativeArgs = { label: bounded(args.label, 256) };
        } else {
          if (!record || record.projectId !== target.stamp.workspaceId || record.projectPath !== root) throw stale();
          if (request.op === "worktree.recreate") {
            if (record.status !== "missing" && record.status !== "removed") throw stale();
            nativeArgs = { branch: record.branch, label: args.label === undefined ? record.branch.slice(0, 256) : bounded(args.label, 256) };
          } else if (request.op === "worktree.continueShared") {
            if (record.status === "missing") throw stale();
            nativeArgs = { confirmed: true };
          } else if (request.op === "worktree.baseline") nativeArgs = { baseline: record.baseCommit };
          else {
            if (record.status === "missing" || record.status === "removed") throw stale();
            nativeArgs = { worktreePath: record.path, baseCommit: record.baseCommit, branch: record.branch, confirmed: true };
            if (request.op === "worktree.remove" || request.op === "worktree.returnShared") Object.assign(nativeArgs, { force: args.force === true, deleteBranch: true, expectedRetainedBranchOid: record.retainedBranchOid ?? null });
            if (request.op === "worktree.merge") {
              const source = await this.guardedSnapshot(request, root);
              Object.assign(nativeArgs, { expectedSourceBranch: source.branch, expectedSourceHeadOid: source.headOid });
            }
          }
        }
      }
      assertAllowed();
      const dispatchArgs = { stamp: target.stamp, root, action: request.op, args: nativeArgs, bookkeeping: { version: 1, rows: snapshot.rows } };
      type Result = { result: RemoteWorkResult; rows?: StampedRow[]; replayed: boolean };
      try {
        const raw = await this.transport.invoke<Result>("remote_domain_execute", dispatchArgs);
        if (raw.result?.opId !== identity.opId || raw.result.state !== "accepted" || !raw.rows || keys.some((key) => !raw.rows!.some((row) => row.key === key))) throw new Error("Domain rows unconfirmed");
        for (const row of raw.rows) { if (!keys.includes(row.key)) throw new Error("Unexpected domain rows"); adopt(row.key, row.value); }
        return { opId: identity.opId, state: "accepted", threadId: target.stamp.threadId, workspaceId: target.stamp.workspaceId };
      } catch (reason) {
        const error = nativeRefusal(reason);
        if (error.code === "uncertain") {
          registerRemoteStateRecovery(`${identity.device}:${identity.opId}`, async () => {
            const replay = await this.transport.invoke<Result>("remote_domain_execute", dispatchArgs);
            if (!replay.replayed || replay.result?.state !== "accepted" || !replay.rows || keys.some((key) => !replay.rows!.some((row) => row.key === key))) throw new Error("Domain commit still unconfirmed");
            recoverRemoteStateRows(replay.rows);
          });
          Object.assign(error, { holdRemoteState: true });
        }
        throw error;
      }
    });
  }
  /** A folder with no repository has no Git baseline to compare against yet. */
  private async gitInit(args: Record<string, unknown>, identity: RemoteOperationIdentity, target: ReturnType<typeof nativeTarget>, assertAllowed: () => void): Promise<RemoteWorkResult> {
    if (args.resourceId !== undefined) throw invalid();
    assertAllowed();
    try {
      const raw = await this.transport.invoke<{ result: RemoteWorkResult }>("remote_domain_execute", { stamp: target.stamp, root: target.root, action: "git.init", args: {} });
      if (raw.result?.opId !== identity.opId || raw.result.state !== "accepted") throw new Error("Unconfirmed domain receipt");
      return { opId: identity.opId, state: "accepted", workspaceId: target.stamp.workspaceId };
    } catch (reason) { throw nativeRefusal(reason); }
  }
  /** The shared project's branch, as local Update does, even from an isolated thread. */
  private async gitUpdate(request: HostRequest, args: Record<string, unknown>, identity: RemoteOperationIdentity,
    target: ReturnType<typeof nativeTarget>, assertAllowed: () => void): Promise<RemoteWorkResult> {
    if (args.confirmed !== true) throw invalid();
    const root = target.context.activeWorkspace!.path;
    const base = this.github.verifiedBase(request, target.stamp.workspaceId, args.base);
    const repository = await this.github.repositoryFor(root);
    if (!repository) throw new HostReadError("unsupported", "Refresh this project's configured Git remote on the other device first.");
    const before = await this.transport.invoke<GitWorkspaceSnapshot>("remote_studio_git_snapshot", { root });
    if (!before.headOid || !before.branch) throw new HostReadError("stale_target", "The shared project needs a named branch before it can update.");
    assertAllowed();
    try {
      const raw = await this.transport.invoke<{ result: RemoteWorkResult }>("remote_domain_execute", { stamp: target.stamp, root, action: "git.update",
        args: { expectedRepository: repository, base, expectedHeadOid: before.headOid, expectedBranch: before.branch } });
      if (raw.result?.opId !== identity.opId || raw.result.state !== "accepted") throw new Error("Unconfirmed domain receipt");
      this.git.delete(key(request, args));
      return { opId: identity.opId, state: "accepted", workspaceId: target.stamp.workspaceId };
    } catch (reason) { throw nativeRefusal(reason); }
  }
  private async gitWrite(request: HostRequest, args: Record<string, unknown>, identity: RemoteOperationIdentity,
    target: ReturnType<typeof nativeTarget>, assertAllowed: () => void): Promise<RemoteWorkResult> {
    strictNativeKeys(args, ["workspaceId", "threadId", "revision", "action", "resourceId", "message", "name", "create", "stagedOnly", "confirmed", "base"]);
    const action = bounded(args.action, 32);
    if (action === "init") return this.gitInit(args, identity, target, assertAllowed);
    if (action === "update") return this.gitUpdate(request, args, identity, target, assertAllowed);
    if (!["stage", "unstage", "commit", "branch", "push", "pull", "fetch", "update", "revert", "revertAll"].includes(action)) throw invalid();
    const baseline = this.git.get(key(request, args));
    if (!baseline || baseline.root !== target.root || baseline.revision !== args.revision || baseline.expires < Date.now() || baseline.grantRevision !== request.grant.revision) throw stale();
    const nativeArgs: Record<string, unknown> = { expectedHeadOid: baseline.snapshot.headOid, expectedBranch: baseline.snapshot.branch };
    const reverting = action === "revert" || action === "revertAll";
    const change = args.resourceId === undefined || reverting ? undefined : this.studio.resolveGitChange(request, args, args.resourceId);
    if (change && !["stage", "unstage", "revert"].includes(action)) throw invalid();
    if (change) {
      if (action === "stage" && change.area === "staged" || action === "unstage" && change.area !== "staged") throw stale();
      nativeArgs.path = change.path;
    }
    if (action === "commit") { nativeArgs.message = bounded(args.message, 16384); if (typeof args.stagedOnly !== "boolean") throw invalid(); nativeArgs.stagedOnly = args.stagedOnly; }
    if (action === "branch") { nativeArgs.name = bounded(args.name, 256); if (typeof args.create !== "boolean") throw invalid(); nativeArgs.create = args.create; }
    if (action === "push" || action === "pull") {
      if (!baseline.remote?.repository || !baseline.remote.remoteUrl) throw new HostReadError("unsupported", "Refresh this project's configured Git remote on the other device first.");
      Object.assign(nativeArgs, { expectedRemoteUrl: baseline.remote.remoteUrl, expectedRepository: baseline.remote.repository });
    }
    if (action === "revert" || action === "revertAll") {
      if (args.confirmed !== true) throw invalid();
      const preview = this.studioReads.takeRevert(request, args, idArg(args.resourceId));
      if (action === "revertAll" ? preview.path !== null : preview.path === null) throw stale();
      if (preview.path !== null) nativeArgs.path = preview.path;
      nativeArgs.confirmationToken = preview.token;
    }
    assertAllowed();
    try {
      const raw = await this.transport.invoke<{ result: RemoteWorkResult; payload?: { headOid?: string; branch?: string | null } }>("remote_domain_execute", { stamp: target.stamp, root: target.root, action: `git.${action}`, args: nativeArgs });
      if (raw.result?.opId !== identity.opId || raw.result.state !== "accepted") throw new Error("Unconfirmed domain receipt");
      // No stdout/stderr/native payload is serialized: it may include paths,
      // credential-bearing remotes, signed commit data or hook output.
      if (raw.payload?.headOid) baseline.snapshot = { ...baseline.snapshot, headOid: raw.payload.headOid, branch: raw.payload.branch ?? baseline.snapshot.branch };
      if (action === "branch" || action === "pull" || !raw.payload && action === "commit") this.git.delete(key(request, args));
      return { opId: identity.opId, state: "accepted", workspaceId: target.stamp.workspaceId };
    } catch (reason) { throw nativeRefusal(reason); }
  }
}
