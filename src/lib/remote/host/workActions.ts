import { invoke } from "@tauri-apps/api/core";
import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import type { Thread } from "../../../types";
import { flushPendingStateWrites } from "../../storage";
import { isAssistantOutputActive, pinTaskTranscript, storedRemoteQueuedTurns, useTaskStore, type QueuedTurn } from "../../taskStore";
import type { DeviceGrant } from "../types";
import type { HostRequest, RemoteOperationIdentity, RemoteRowOperation, RemoteWorkResult, WireWorkCapabilities, WireWorkApproval } from "../wire";
import { approvalPolicy, isQuestion, remoteApprovalResponse, resolveExactApproval } from "./approvalActions";
import { RemoteDeliveryJournal } from "./deliveryJournal";
import { currentWorkGrant, remotePermission, resolveThreadExecutionContext, type ExecutionTarget } from "./executionContext";
import { hostContext, searchHostFiles, wireEfforts, type HostContextSources } from "./hostContext";
import { remoteQuestionResponse, requestQuestions } from "./questionActions";
import { currentGrant, HostReadError, idArg, objectArgs, requireThread, requireWorkspace, workspaceAllowed } from "./scope";
import { stopThreadAndChildren, type StopActionSources } from "./stopActions";
import { sameStop, WorkTargets, type WorkTarget } from "./targetHandles";
import type { RemoteStopSnapshot, RemoteTurnRunner, RemoteWorkAdapter } from "./workTypes";
import { assertParityAuthority, executeParityMutation, isParityOperation, isParityRead, projectParityRead, validateParityArgs, type HostParityActions } from "./parityActions";

const mutations = new Set(["prompt.send", "prompt.queue", "prompt.steer", "turn.stop", "approval.answer", "question.answer", "thread.settings.set",
  "thread.rename", "thread.archive", "thread.restore", "thread.delete", "thread.pin", "thread.fork", "projects.pin", "projects.remove", "projects.reorder"]);
export function isRemoteWorkOperation(op: string): boolean { return mutations.has(op) || isParityOperation(op) || op === "work.inspect" || op === "host.context" || op === "files.search"; }
const invalid = () => new HostReadError("unsupported", "This work request is not valid.");
const stale = () => new HostReadError("stale_target", "This conversation or request changed. Refresh it before trying again.");
export interface HostMutationContext {
  identity: RemoteOperationIdentity; generation: number; context: TurnRunnerContext;
  /** Call immediately before the durable state commit, not only before an await. */
  assertAllowed(): void;
}
export interface HostRowActions {
  /** Archived metadata is host-only; never trust a viewer to supply a binding. */
  archivedThread(threadId: string): { thread: Thread; workspaceId: string } | null;
  execute(op: RemoteRowOperation, args: Readonly<Record<string, unknown>>, operation: HostMutationContext): Promise<{ state: "accepted"; threadId?: string; workspaceId?: string }>;
}
export interface HostSettingsActions {
  /** Atomic/durable model+effort update; no selected-thread picker callbacks. */
  set(threadId: string, values: { model?: string; effort?: string; provider?: string }, operation: HostMutationContext): Promise<{ state: "accepted" }>;
}
export interface RemoteWorkLease {
  generation: number; isCurrent(): boolean;
  findThread(threadId: string): Thread | undefined;
  ensureHydrated(threadId: string, assertCurrent: () => void): Promise<void>;
}
export interface RemoteWorkOptions extends RemoteWorkLease {
  sources: HostContextSources;
  getRunner(): RemoteTurnRunner;
  stop: StopActionSources;
  rows?: HostRowActions;
  settings?: HostSettingsActions;
  parity?: HostParityActions;
  /** Grant edits/revocation schedule reconciliation; no polling or UI coupling. */
  subscribeAuthority?(changed: () => void): () => void;
}
interface RecoveredDelivery {
  disposition: string; threadId?: string; queuedTurnId?: string; attemptId?: string; messageId?: string;
}
export function createRemoteWork(options: RemoteWorkOptions): RemoteWorkAdapter {
  const targets = new WorkTargets(options.generation, options.isCurrent);
  const nativeGrants = new Map<string, DeviceGrant | null>();
  const inflight = new Map<string, Promise<RemoteWorkResult>>();
  const learned = new Map<string, Thread>();
  const paths = new WeakMap<TurnRunnerContext, string>();
  let disposed = false, active = 0, reconciling: Promise<void> | undefined;
  const releases = new Set<() => void>();
  const current = () => !disposed && options.isCurrent();
  const assertCurrent = () => { if (!current()) throw new HostReadError("host_unavailable", "The host renderer is recovering."); };
  // Source grants can be behind Rust's event snapshot. Both must still permit
  // work; the authoritative native check closes the final dispatch race.
  const sources: HostContextSources = { ...options.sources,
    getKnownThreads: () => ({ ...Object.fromEntries(learned), ...options.sources.getKnownThreads() }),
    getGrant: (device) => {
      const local = options.sources.getGrant(device);
      if (!nativeGrants.has(device)) return local;
      const native = nativeGrants.get(device);
      if (!local || !native) return null;
      const scope = native.scope.kind === "all" ? local.scope : local.scope.kind === "all" ? native.scope
        : { kind: "projects" as const, projectIds: native.scope.projectIds.filter((id) => local.scope.kind === "projects" && local.scope.projectIds.includes(id)) };
      return { revision: local.revision, scope, view: native.view && local.view, work: native.work && local.work,
        capabilities: { fullAccess: native.capabilities.fullAccess && local.capabilities.fullAccess,
          gitWrite: native.capabilities.gitWrite && local.capabilities.gitWrite,
          checkpointRestore: native.capabilities.checkpointRestore && local.capabilities.checkpointRestore,
          terminal: native.capabilities.terminal && local.capabilities.terminal,
          manageProjects: (native.capabilities as { manageProjects?: boolean }).manageProjects === true
            && (local.capabilities as { manageProjects?: boolean }).manageProjects === true } };
    },
  };
  function remember(threadId: string): void {
    const thread = options.findThread(threadId);
    if (thread) { learned.set(threadId, thread); options.sources.rememberThread?.(thread); }
  }
  function context(target: ExecutionTarget, device: string): TurnRunnerContext {
    assertCurrent();
    currentWorkGrant(options.sources, device);
    if ("threadId" in target) remember(target.threadId);
    const resolved = resolveThreadExecutionContext(sources, target, device);
    paths.set(resolved, targetPath(resolved));
    return resolved;
  }
  async function refresh(device: string): Promise<void> {
    assertCurrent();
    const grant = await invoke<DeviceGrant | null>("remote_work_grant", { generation: options.generation, device });
    assertCurrent();
    nativeGrants.set(device, grant);
  }
  function identity(request: HostRequest, args: Record<string, unknown>): RemoteOperationIdentity {
    // Native only emits this top-level identity after its unique durable claim.
    const opId = idArg(args.opId), opSeq = args.opSeq;
    if (typeof opSeq !== "number" || !Number.isSafeInteger(opSeq) || opSeq < 1 || request.opId !== opId || request.opSeq !== opSeq) throw invalid();
    return { device: request.device, opId, opSeq };
  }
  function assertTarget(target: ExecutionTarget, device: string, expected: TurnRunnerContext): void {
    const now = context(target, device);
    if (now.activeWorkspace?.id !== expected.activeWorkspace?.id || now.activeWorkspace?.path !== expected.activeWorkspace?.path
      || now.activeThread?.id !== expected.activeThread?.id || now.effectiveSettings.provider !== expected.effectiveSettings.provider
      || targetPath(now) !== targetPath(expected)) throw stale();
    // Tightening a host policy mid-preparation never sends under an older,
    // stronger permission. No setting picker from the selected thread is used.
    const before = expected.effectiveSettings.permission, after = now.effectiveSettings.permission;
    if (before === "full" && after !== "full" || before === "ask" && after === "read-only") throw new HostReadError("forbidden", "The host permission policy changed before delivery.");
  }
  function targetPath(ctx: TurnRunnerContext): string {
    return paths.get(ctx) ?? (ctx.activeWorkspace ? sources.executionPathFor(ctx.activeThread?.id ?? "", ctx.activeWorkspace.path) : "");
  }
  function journal(id: RemoteOperationIdentity, target: ExecutionTarget, ctx: TurnRunnerContext,
    queue?: QueuedTurn, targetHandle?: string): RemoteDeliveryJournal {
    return new RemoteDeliveryJournal({ generation: options.generation, identity: id, workspaceId: ctx.activeWorkspace!.id,
      threadId: ctx.activeThread?.id, queuedTurnId: queue?.id, attemptId: queue?.remoteDelivery?.attemptId,
      messageId: queue?.remoteDelivery?.messageId, targetHandle, isCurrent: current,
      assertAllowed: () => assertTarget(target, id.device, ctx),
      validateGrant: (grant) => {
        nativeGrants.set(id.device, grant);
        if (!grant?.work || !grant.view || !workspaceAllowed(ctx.activeWorkspace!, grant)
          || remotePermission(ctx.effectiveSettings.permission, grant) !== ctx.effectiveSettings.permission) {
          throw new HostReadError("forbidden", "Remote work is no longer allowed for this instruction.");
        }
        assertTarget(target, id.device, ctx);
      },
    });
  }
  function strictKeys(args: Record<string, unknown>, extra: string[]): void {
    if (Object.keys(args).some((key) => !["opId", "opSeq", ...extra].includes(key))) throw invalid();
  }
  function prompt(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 65536) throw invalid();
    return value;
  }
  async function inspect(request: HostRequest, args: Record<string, unknown>): Promise<WireWorkCapabilities> {
    strictKeys(args, ["threadId"]);
    const threadId = idArg(args.threadId);
    await refresh(request.device);
    const ctx = context({ threadId }, request.device), task = useTaskStore.getState().tasks[threadId];
    const runner = options.getRunner(), stop = runner.getThreadStopTarget(threadId);
    const register = (kind: "turn" | "start" | "parent" | "approval" | "question", extra: { stop?: RemoteStopSnapshot; approval?: NonNullable<typeof task>["approvals"][number] }) =>
      targets.register({ device: request.device, workspaceId: ctx.activeWorkspace!.id, provider: ctx.effectiveSettings.provider, ...extra }, kind);
    const approvals: WireWorkApproval[] = [];
    for (const approval of (task?.approvals ?? []).slice(0, 32)) {
      if (isQuestion(approval)) {
        let questions;
        try { questions = requestQuestions(approval); } catch { continue; }
        const target = await register("question", { approval });
        approvals.push({ target, summary: "The agent needs your input.", canAllowOnce: false, canDeny: true, questions });
      } else {
        const policy = approvalPolicy(approval);
        if (policy && (policy.canAllowOnce || policy.canDeny)) approvals.push({ target: await register("approval", { approval }), ...policy });
      }
      assertTarget({ threadId }, request.device, ctx);
    }
    const liveParent = useTaskStore.getState().parentRuns[threadId];
    const stoppable = task?.status === "running" || task?.status === "starting" || stop.workflowRunId || liveParent;
    const stopTarget = stoppable ? await register(stop.turnId ? "turn" : stop.workflowRunId || liveParent ? "parent" : "start", { stop }) : undefined;
    const canSteer = task?.status === "running" && Boolean(stop.turnId) && !isAssistantOutputActive(task) && !stop.workflowRunId;
    assertTarget({ threadId }, request.device, ctx);
    if (stopTarget && !sameStop(stop, runner.getThreadStopTarget(threadId))) throw stale();
    return { threadId, provider: ctx.effectiveSettings.provider, canSend: !ctx.worktreeBusy, canQueue: true,
      canSteer, ...(stopTarget ? { stop: stopTarget } : {}), ...(canSteer && stopTarget ? { steer: stopTarget } : {}), approvals };
  }
  async function mutate(request: HostRequest, args: Record<string, unknown>, id: RemoteOperationIdentity): Promise<RemoteWorkResult> {
    await refresh(id.device);
    if (isParityOperation(request.op)) {
      validateParityArgs(request.op, args);
      const actions = options.parity;
      if (!actions) throw new HostReadError("unsupported", "This host action is not connected yet.");
      const target = typeof args.threadId === "string" ? { threadId: args.threadId } : { workspaceId: idArg(args.workspaceId) };
      const ctx = context(target, id.device);
      if (ctx.activeWorkspace!.id !== args.workspaceId) throw stale();
      const assertAllowed = () => {
        assertTarget(target, id.device, ctx);
        assertParityAuthority(request.op, currentWorkGrant(sources, id.device));
        if (Array.isArray(args.threadIds)) for (const threadId of args.threadIds) {
          const child = context({ threadId: idArg(threadId) }, id.device);
          if (child.activeWorkspace!.id !== ctx.activeWorkspace!.id) throw stale();
        }
      };
      assertAllowed();
      if (args.provider !== undefined || args.model !== undefined || args.effort !== undefined) {
        const provider = args.provider ?? ctx.effectiveSettings.provider;
        const model = args.model ?? ctx.effectiveSettings.model;
        const entry = sources.getProviderCatalog().find((p) => p.id === provider)?.models.find((m) => m.id === model);
        if (!entry || args.effort !== undefined && !entry.efforts.includes(args.effort as never)) throw invalid();
      }
      const delivery = journal(id, target, ctx);
      return executeParityMutation(request.op, args, actions, ctx, id, options.generation, delivery, assertAllowed);
    }
    if (request.op.startsWith("thread.") || request.op.startsWith("projects.")) return rowMutation(request, args, id);
    const threadId = args.threadId === undefined ? undefined : idArg(args.threadId);
    let target: ExecutionTarget;
    if (request.op === "prompt.send") {
      strictKeys(args, ["threadId", "workspaceId", "text"]);
      if (Boolean(threadId) === (args.workspaceId !== undefined)) throw invalid();
      target = threadId ? { threadId } : { workspaceId: idArg(args.workspaceId) };
    } else {
      if (!threadId) throw invalid();
      target = { threadId };
      strictKeys(args, request.op === "prompt.queue" ? ["threadId", "text"] : request.op === "prompt.steer" ? ["threadId", "text", "target"]
        : request.op === "turn.stop" ? ["threadId", "target"] : request.op === "approval.answer" ? ["threadId", "target", "decision"] : ["threadId", "target", "answers", "cancel"]);
    }
    let ctx = context(target, id.device);
    const release = threadId ? pinTaskTranscript(threadId) : undefined;
    if (release) releases.add(release);
    let delivery: RemoteDeliveryJournal | undefined;
    try {
      if (threadId && (request.op === "prompt.send" || request.op === "prompt.queue")) {
        const before = ctx;
        await options.ensureHydrated(threadId, () => assertTarget(target, id.device, before));
        assertTarget(target, id.device, before);
        ctx = context(target, id.device);
      }
      let owned: WorkTarget | undefined;
      if (args.target !== undefined) {
        owned = targets.resolve(idArg(args.target), id.device, threadId!);
        if (owned.workspaceId !== ctx.activeWorkspace!.id || owned.provider !== ctx.effectiveSettings.provider) throw stale();
      }
      delivery = journal(id, target, ctx, undefined, owned?.wire.handle);
      ctx = { ...ctx, remoteDelivery: delivery };
      if (request.op === "prompt.send") return await options.getRunner().sendPromptTo(ctx, prompt(args.text));
      if (request.op === "prompt.queue") return await options.getRunner().queuePromptTo(ctx, prompt(args.text), delivery.queueRecord());
      if (!owned) throw invalid();
      if (request.op === "prompt.steer") {
        if (!owned.stop?.turnId || !sameStop(owned.stop, options.getRunner().getThreadStopTarget(threadId!))) throw stale();
        const result = await options.getRunner().steerThread(ctx, prompt(args.text), owned.stop);
        targets.consume(owned);
        return result;
      }
      await delivery.beforeCreate();
      if (request.op === "turn.stop") {
        if (!owned.stop) throw stale();
        await targets.claim(owned, id);
        if (!sameStop(owned.stop, options.getRunner().getThreadStopTarget(threadId!))) throw stale();
        await delivery.beforeDispatch({ threadId: threadId!, messageId: delivery.messageId, provider: ctx.effectiveSettings.provider,
          turnId: owned.stop.turnId, startRequestId: owned.stop.startRequestId });
        await stopThreadAndChildren({ ...ctx, remoteStop: async (args) => {
          const cutoff = await delivery!.invokeSteer<{ confirmed: boolean }>("turn_stop", args);
          if (cutoff?.confirmed !== true) throw new HostReadError("uncertain", "The host could not confirm this turn's cutoff.");
        } }, owned.stop, options.getRunner(), options.stop,
          () => delivery!.assertAllowed());
        await delivery.accepted({ threadId: threadId!, turnId: owned.stop.turnId });
      } else {
        const approval = owned.approval;
        if (!approval || !useTaskStore.getState().tasks[threadId!]?.approvals.includes(approval)) throw stale();
        const response = request.op === "approval.answer"
          ? args.decision === "allowOnce" || args.decision === "deny" ? remoteApprovalResponse(approval, args.decision) : (() => { throw invalid(); })()
          : remoteQuestionResponse(approval, args.answers, args.cancel);
        await delivery.beforeDispatch({ threadId: threadId!, messageId: delivery.messageId, provider: ctx.effectiveSettings.provider });
        if (!useTaskStore.getState().tasks[threadId!]?.approvals.includes(approval)) throw stale();
        await delivery.invokeSteer(request.op === "approval.answer" ? "approval_answer" : "question_answer", {
          threadId, requestId: approval.id, method: approval.method, result: response,
          turnId: approval.params.turnId, itemId: approval.params.itemId,
        });
        resolveExactApproval(approval);
        await delivery.accepted({ threadId: threadId! });
      }
      targets.consume(owned);
      return delivery.result();
    } catch (reason) {
      if (!delivery) throw reason;
      await delivery.failure(reason);
      return delivery.result();
    } finally { if (release) { release(); releases.delete(release); } }
  }
  async function rowMutation(request: HostRequest, args: Record<string, unknown>, id: RemoteOperationIdentity): Promise<RemoteWorkResult> {
    const projectOp = request.op.startsWith("projects.");
    const threadId = projectOp ? undefined : idArg(args.threadId);
    let target: ExecutionTarget = projectOp ? { workspaceId: idArg(args.workspaceId) } : { threadId: threadId! };
    let archived: ReturnType<HostRowActions["archivedThread"]> = null;
    if (threadId && sources.getArchivedThreadIds().has(threadId)) {
      if (request.op !== "thread.restore" && request.op !== "thread.delete") throw stale();
      archived = options.rows?.archivedThread(threadId) ?? null;
      if (!archived) throw stale();
      target = { workspaceId: archived.workspaceId };
    } else if (request.op === "thread.restore") throw stale();
    const ctx = context(target, id.device);
    const delivery = journal(id, target, ctx);
    const assertAllowed = () => {
      assertTarget(target, id.device, ctx);
      if (archived && options.rows?.archivedThread(threadId!)?.workspaceId !== archived.workspaceId) throw stale();
      if (request.op === "projects.remove") {
        const grant = currentWorkGrant(sources, id.device);
        if (grant.scope.kind !== "all" || (grant.capabilities as { manageProjects?: boolean }).manageProjects !== true) {
          throw new HostReadError("forbidden", "Removing a project requires Manage projects and an all-project grant.");
        }
      }
    };
    const operation: HostMutationContext = { identity: id, generation: options.generation, context: ctx, assertAllowed };
    try {
      const values: Record<string, unknown> = {};
      if (request.op === "thread.settings.set") {
        strictKeys(args, ["threadId", "model", "effort", "provider"]);
        if (!options.settings || args.model === undefined && args.effort === undefined && args.provider === undefined) throw invalid();
        const provider = args.provider ?? ctx.effectiveSettings.provider;
        // An existing thread's provider owns its transcript/runtime identity.
        // Like the local picker, switching providers requires a NEW thread.
        if (provider !== ctx.effectiveSettings.provider) throw new HostReadError("unsupported", "Start a new thread to use a different provider.");
        const catalog = sources.getProviderCatalog().find((p) => p.id === provider);
        const model = args.model ?? ctx.effectiveSettings.model;
        const entry = catalog?.models.find((m) => m.id === model);
        if (!entry || args.effort !== undefined && (typeof args.effort !== "string" || !wireEfforts.has(args.effort as never) || !entry.efforts.includes(args.effort as never))) throw invalid();
        await delivery.beforeCreate();
        await delivery.beforeDispatch({ threadId: threadId!, messageId: delivery.messageId, provider: ctx.effectiveSettings.provider });
        assertAllowed();
        const saved = await options.settings.set(threadId!, { ...(args.model !== undefined ? { model: entry.id } : {}),
          ...(args.effort !== undefined ? { effort: args.effort as string } : {}), ...(args.provider !== undefined ? { provider: ctx.effectiveSettings.provider } : {}) }, operation);
        if (saved?.state !== "accepted") throw new HostReadError("uncertain", "The host settings write could not be confirmed.");
        await flushPendingStateWrites();
        await delivery.accepted({ threadId });
      } else {
        if (!options.rows) throw new HostReadError("unsupported", "This host has not enabled remote row actions yet.");
        const extra = request.op === "thread.rename" ? ["name"] : request.op.endsWith(".pin") ? ["pinned"] : request.op === "projects.reorder" ? ["relativeTo", "position"] : [];
        strictKeys(args, [projectOp ? "workspaceId" : "threadId", ...extra, ...(request.op === "thread.delete" || request.op === "projects.remove" ? ["confirmed"] : [])]);
        if ((request.op === "thread.delete" || request.op === "projects.remove") && args.confirmed !== true) throw invalid();
        if (request.op === "thread.rename") {
          if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 256 || /[\u0000-\u001f]/.test(args.name)) throw invalid();
          values.name = args.name.trim();
        }
        if (request.op.endsWith(".pin")) { if (typeof args.pinned !== "boolean") throw invalid(); values.pinned = args.pinned; }
        if (request.op === "projects.reorder") {
          const other = requireWorkspace(sources, idArg(args.relativeTo), currentWorkGrant(sources, id.device));
          if (other.id === ctx.activeWorkspace!.id || other.isChat || args.position !== "before" && args.position !== "after") throw invalid();
          values.relativeTo = other.id; values.position = args.position;
        }
        if (projectOp && ctx.activeWorkspace?.isChat) throw invalid();
        await delivery.beforeCreate();
        await delivery.beforeDispatch({ threadId: threadId ?? "", messageId: delivery.messageId, provider: ctx.effectiveSettings.provider });
        assertAllowed();
        const result = await options.rows.execute(request.op as RemoteRowOperation, {
          ...values, ...(threadId ? { threadId } : { workspaceId: ctx.activeWorkspace!.id }),
        }, operation);
        if (result?.state !== "accepted") throw new HostReadError("uncertain", "The host action could not be confirmed.");
        await flushPendingStateWrites();
        await delivery.accepted({ threadId: result?.threadId ?? threadId });
        return { ...delivery.result(), ...(result?.workspaceId ? { workspaceId: result.workspaceId } : {}) };
      }
      return delivery.result();
    } catch (reason) { await delivery.failure(reason); return delivery.result(); }
  }
  async function resolveQueued(entry: QueuedTurn): Promise<TurnRunnerContext> {
    const remote = entry.remoteDelivery;
    if (!remote || remote.disposition !== "queued" || remote.opSeq < 1) throw stale();
    assertCurrent();
    const receipt = await invoke<RecoveredDelivery>("remote_work_recover", { generation: options.generation,
      device: remote.device, opId: remote.opId, opSeq: remote.opSeq });
    assertCurrent();
    if (!receipt || receipt.disposition !== "queued" || receipt.threadId !== entry.threadId || receipt.queuedTurnId !== entry.id
      || receipt.attemptId !== remote.attemptId || receipt.messageId !== remote.messageId) {
      const state = receipt?.disposition === "accepted" ? "accepted" : receipt?.disposition === "rejected" ? "rejected" : "uncertain";
      useTaskStore.getState().setRemoteQueuedDisposition(entry.threadId, entry.id, state);
      await flushPendingStateWrites();
      throw new HostReadError("uncertain", "This queued instruction has no confirmed undelivered receipt.");
    }
    await refresh(remote.device);
    const target = { threadId: entry.threadId };
    let ctx: TurnRunnerContext;
    try {
      ctx = context(target, remote.device);
      if (ctx.activeWorkspace?.id !== remote.workspaceId) throw stale();
    } catch (reason) {
      // A confirmed *undelivered* queue receipt may be safely rejected.
      await invoke("remote_work_receipt", { generation: options.generation, ...remote, threadId: entry.threadId,
        queuedTurnId: entry.id, disposition: "rejected", errorCode: reason instanceof HostReadError ? reason.code : "forbidden" });
      useTaskStore.getState().setRemoteQueuedDisposition(entry.threadId, entry.id, "rejected", "forbidden");
      await flushPendingStateWrites();
      throw reason;
    }
    const before = ctx;
    await options.ensureHydrated(entry.threadId, () => assertTarget(target, remote.device, before));
    assertTarget(target, remote.device, before);
    ctx = context(target, remote.device);
    const latest = storedRemoteQueuedTurns().find((value) => value.id === entry.id && value.threadId === entry.threadId);
    if (!latest || latest.remoteDelivery?.disposition !== "queued") throw stale();
    if (latest.status !== "sending") {
      useTaskStore.getState().setRemoteQueuedDisposition(entry.threadId, entry.id, "queued");
      if (remote.needsRecovery) useTaskStore.getState().setQueuedTurnStatus(entry.threadId, entry.id, "queued");
    }
    const delivery = journal(remote, target, ctx, entry);
    return { ...ctx, remoteDelivery: delivery };
  }
  function reconcileQueues(pump = true): Promise<void> {
    if (reconciling) return reconciling;
    const work = (async () => {
      for (const entry of storedRemoteQueuedTurns()) {
        if (!current()) return;
        // Dispatched/uncertain restores are NEVER promoted to queued. Even a
        // missing native journal row cannot prove they were undelivered.
        const remote = entry.remoteDelivery;
        if (!remote || entry.status === "sending") continue;
        try {
          if (!pump || remote.disposition !== "queued") {
            const receipt = await invoke<RecoveredDelivery>("remote_work_recover", { generation: options.generation,
              device: remote.device, opId: remote.opId, opSeq: remote.opSeq });
            assertCurrent();
            if (receipt?.disposition === "accepted" || receipt?.disposition === "rejected") {
              useTaskStore.getState().setRemoteQueuedDisposition(entry.threadId, entry.id, receipt.disposition);
              useTaskStore.getState().removeQueuedTurn(entry.threadId, entry.id);
            } else if (receipt?.disposition !== "queued" || remote.disposition !== "queued") {
              useTaskStore.getState().setRemoteQueuedDisposition(entry.threadId, entry.id, "uncertain");
            }
            await flushPendingStateWrites();
            continue;
          }
          await resolveQueued(entry);
          if (current()) options.getRunner().pumpRemoteQueue(entry.threadId);
        }
        catch { /* Fixed held/rejected state; do not turn a recovery error into a send. */ }
      }
    })();
    reconciling = work;
    void work.finally(() => { if (reconciling === work) reconciling = undefined; });
    return work;
  }
  const unsubscribe = options.subscribeAuthority?.(() => { if (current()) void reconcileQueues(); });
  return {
    resolveQueued, reconcileQueues,
    async dispatch(request) {
      assertCurrent();
      if (request.generation !== options.generation || !isRemoteWorkOperation(request.op)) throw invalid();
      const args = objectArgs(request.args);
      if (active >= 4) throw new HostReadError("busy", "The host is handling other work. Try again shortly.");
      active += 1;
      try {
        if (request.op === "host.context" || request.op === "files.search") {
          currentGrant(options.sources, request.device, request.grant);
          strictKeys(args, request.op === "host.context" ? ["workspaceId", "threadId"] : ["workspaceId", "query"]);
          if (typeof args.threadId === "string") remember(args.threadId);
          if (request.op === "files.search") return await searchHostFiles(sources, request, args, assertCurrent);
          const result = hostContext(sources, request, args);
          if (options.parity) {
            const target = typeof args.threadId === "string" ? { threadId: args.threadId } : { workspaceId: idArg(args.workspaceId) };
            result.revision = idArg(options.parity.revision(resolveThreadExecutionContext(sources, target)));
          }
          return result;
        }
        if (request.op === "work.inspect") return await inspect(request, args);
        if (isParityOperation(request.op) && isParityRead(request.op)) {
          validateParityArgs(request.op, args);
          if (!options.parity) throw new HostReadError("unsupported", "This host context is not connected yet.");
          const grant = currentGrant(options.sources, request.device, request.grant);
          if (typeof args.threadId === "string") remember(args.threadId);
          const target = typeof args.threadId === "string" ? { threadId: args.threadId } : { workspaceId: idArg(args.workspaceId) };
          const ctx = resolveThreadExecutionContext(sources, target);
          const validate = () => {
            assertCurrent(); currentGrant(options.sources, request.device, request.grant);
            const workspace = requireWorkspace(sources, ctx.activeWorkspace!.id, grant);
            if (workspace.id !== args.workspaceId || workspace.path !== ctx.activeWorkspace!.path) throw stale();
            if (ctx.activeThread) {
              const live = sources.getKnownThreads()[ctx.activeThread.id];
              const resolved = requireThread(sources, live, grant);
              if (resolved.workspace.id !== workspace.id || resolved.workspace.path !== workspace.path) throw stale();
            }
          };
          validate();
          const revision = options.parity.revision(ctx);
          const raw = await options.parity.read(request.op, args, ctx);
          validate();
          if (options.parity.revision(ctx) !== revision || raw.revision !== revision) throw stale();
          return projectParityRead(raw);
        }
        const id = identity(request, args), key = `${id.device}:${id.opId}`;
        const existing = inflight.get(key);
        if (existing) return await existing;
        const work = mutate(request, args, id);
        inflight.set(key, work);
        try { return await work; } finally { inflight.delete(key); }
      } finally { active -= 1; }
    },
    dispose() { disposed = true; targets.dispose(); unsubscribe?.(); nativeGrants.clear(); learned.clear(); for (const release of releases) release(); releases.clear(); },
  };
}
