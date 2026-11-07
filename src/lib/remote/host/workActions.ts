import type { ChildAgentTarget } from "../../../types";
import { invoke } from "@tauri-apps/api/core";
import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import type { Thread } from "../../../types";
import { flushPendingStateWrites } from "../../storage";
import { isAssistantOutputActive, pinTaskTranscript, storedRemoteQueuedTurns, useTaskStore, type QueuedTurn } from "../../taskStore";
import type { DeviceGrant } from "../types";
import type { HostRequest, RemoteOperationIdentity, RemoteRowOperation, RemoteWorkResult, WireWorkCapabilities, WireWorkApproval, WireExecutionSettings } from "../wire";
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
import { DraftTokens, type DraftToken } from "./draftTokens";
import { validateExecutionSettings } from "./executionPreferences";
import { createHostSettingsActions } from "./settingsActions";
import type { AttachmentRecord } from "../../../components/StudioDock";
import { createHostEngineAdapters } from "./engineAdapters";
import { executeTerminal, isTerminalMutation } from "./nativeActions";
import { HostDomains, isDomainMutation, isDomainRead } from "./domainActions";
import { clearRemoteEngineOwners } from "./engineOwners";
import { HostProjectNavigation, isProjectNavigationOperation } from "./projectNavigation";
import { executeRowState } from "./rowStateActions";
import { createHostProjectRegistration } from "./projectRegistration";

const mutations = new Set(["draft.settings.set", "prompt.cancel", "prompt.send", "prompt.queue", "prompt.steer", "turn.stop", "approval.answer", "question.answer", "thread.settings.set",
  "thread.rename", "thread.archive", "thread.restore", "thread.delete", "thread.pin", "thread.fork", "projects.pin", "projects.remove", "projects.reorder"]);
export function isRemoteWorkOperation(op: string): boolean { return isProjectNavigationOperation(op) || isDomainMutation(op) || isDomainRead(op) || isTerminalMutation(op) || mutations.has(op) || isParityOperation(op) || op === "work.inspect" || op === "host.context" || op === "files.search"; }
const invalid = () => new HostReadError("unsupported", "This work request is not valid.");
const stale = () => new HostReadError("stale_target", "This conversation or request changed. Refresh it before trying again.");
export interface HostMutationContext {
  identity: RemoteOperationIdentity; generation: number; context: TurnRunnerContext;
  grantRevision: number;
  /** Call immediately before the durable state commit, not only before an await. */
  assertAllowed(): void;
}
export interface HostRowActions {
  /** Archived metadata is host-only; never trust a viewer to supply a binding. */
  /** Only list operations whose actual native/provider commit is grant-fenced. */
  nativeFenced?: readonly RemoteRowOperation[];
  archivedThread(threadId: string): { thread: Thread; workspaceId: string } | null;
  execute(op: RemoteRowOperation, args: Readonly<Record<string, unknown>>, operation: HostMutationContext): Promise<{ state: "accepted"; threadId?: string; workspaceId?: string }>;
}
export interface HostSettingsActions {
  /** Atomic/durable model+effort update; no selected-thread picker callbacks. */
  set(threadId: string, values: WireExecutionSettings, operation: HostMutationContext): Promise<{ state: "accepted" }>;
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
  const drafts = new DraftTokens(() => !disposed && options.isCurrent());
  const nativeGrants = new Map<string, DeviceGrant | null>();
  const inflight = new Map<string, Promise<RemoteWorkResult>>();
  const learned = new Map<string, Thread>();
  const paths = new WeakMap<TurnRunnerContext, string>();
  const choices = new WeakMap<TurnRunnerContext, WireExecutionSettings>();
  let disposed = false, active = 0, reconciling: Promise<void> | undefined;
  const releases = new Set<() => void>();
  const current = () => !disposed && options.isCurrent();
  const assertCurrent = () => { if (!current()) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly."); };
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
  const engines = options.parity ? createHostEngineAdapters(sources, options.parity, (id) => options.getRunner().pumpRemoteQueue(id), current, options.getRunner) : undefined;
  const parity = engines?.adapter;
  const domains = new HostDomains(sources, options.generation, current, parity);
  const navigation = new HostProjectNavigation(sources, options.generation, current, createHostProjectRegistration());
  function remember(threadId: string): void {
    const thread = options.findThread(threadId);
    if (thread) { learned.set(threadId, thread); options.sources.rememberThread?.(thread); }
  }
  function context(target: ExecutionTarget, device: string, choice?: WireExecutionSettings): TurnRunnerContext {
    assertCurrent();
    currentWorkGrant(options.sources, device);
    if ("threadId" in target) remember(target.threadId);
    const resolved = resolveThreadExecutionContext(sources, target, device, choice);
    if (choice) choices.set(resolved, choice);
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
    const now = context(target, device, choices.get(expected));
    if (now.activeWorkspace?.id !== expected.activeWorkspace?.id || now.activeWorkspace?.path !== expected.activeWorkspace?.path
      || now.activeThread?.id !== expected.activeThread?.id || now.effectiveSettings.provider !== expected.effectiveSettings.provider
      || targetPath(now) !== targetPath(expected)) throw stale();
    // Tightening a host policy mid-preparation never sends under an older,
    // stronger permission. No setting picker from the selected thread is used.
    const before = expected.effectiveSettings.permission, after = now.effectiveSettings.permission;
    if (before === "full" && after !== "full" || before === "ask" && after === "read-only") throw new HostReadError("forbidden", "The other device permission policy changed before delivery.");
  }
  function targetPath(ctx: TurnRunnerContext): string {
    return paths.get(ctx) ?? (ctx.activeWorkspace ? sources.executionPathFor(ctx.activeThread?.id ?? "", ctx.activeWorkspace.path) : "");
  }
  function journal(id: RemoteOperationIdentity, target: ExecutionTarget, ctx: TurnRunnerContext,
    queue?: QueuedTurn, targetHandle?: string, draft?: DraftToken): RemoteDeliveryJournal {
    return new RemoteDeliveryJournal({ generation: options.generation, identity: id, workspaceId: ctx.activeWorkspace!.id,
      threadId: ctx.activeThread?.id, queuedTurnId: queue?.id, attemptId: queue?.remoteDelivery?.attemptId ?? draft?.attemptId,
      messageId: queue?.remoteDelivery?.messageId, targetHandle, permission: ctx.effectiveSettings.permission, provider: ctx.effectiveSettings.provider, isCurrent: current,
      assertAllowed: () => {
        if (draft?.cancelled) throw new HostReadError("cancelled", "Stopped before prompt delivery.");
        if (queue) {
          const current = storedRemoteQueuedTurns().find((entry) => entry.threadId === queue.threadId && entry.id === queue.id);
          if (!current || current.editing || current.remoteDelivery?.opId !== id.opId) throw stale();
        }
        assertTarget(target, id.device, ctx);
      },
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
  async function attachments(value: unknown, device: string, workspaceId: string): Promise<{ ids: string[]; records: AttachmentRecord[] }> {
    if (value === undefined) return { ids: [], records: [] };
    if (!Array.isArray(value) || value.length > 20) throw invalid();
    const ids = value.map(idArg);
    if (new Set(ids).size !== ids.length) throw invalid();
    const records = await Promise.all(ids.map(async (attachmentId) => {
      const raw = await invoke<AttachmentRecord>("remote_attachment_resolve", { generation: options.generation, device,
        grantRevision: currentWorkGrant(sources, device).revision, workspaceId, attachmentId });
      assertCurrent();
      if (!raw || typeof raw.path !== "string" || !raw.path || typeof raw.name !== "string" || raw.kind !== "file" && raw.kind !== "image") throw invalid();
      return { path: raw.path, name: raw.name, kind: raw.kind };
    }));
    return { ids, records };
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
    const stopTarget = stoppable ? await register(stop.ownerHandle ? "parent" : stop.turnId ? "turn" : stop.workflowRunId || liveParent ? "parent" : "start", { stop }) : undefined;
    const canSteer = task?.status === "running" && Boolean(stop.turnId) && !isAssistantOutputActive(task) && !stop.workflowRunId;
    const steerTarget = canSteer ? await register("turn", { stop }) : undefined;
    assertTarget({ threadId }, request.device, ctx);
    if (stopTarget && !sameStop(stop, runner.getThreadStopTarget(threadId))) throw stale();
    return { threadId, provider: ctx.effectiveSettings.provider, canSend: !ctx.worktreeBusy, canQueue: true,
      canSteer, ...(stopTarget ? { stop: stopTarget } : {}), ...(steerTarget ? { steer: steerTarget } : {}), approvals };
  }
  async function mutate(request: HostRequest, args: Record<string, unknown>, id: RemoteOperationIdentity): Promise<RemoteWorkResult> {
    await refresh(id.device);
    currentGrant(sources, request.device, request.grant);
    if (isDomainMutation(request.op)) return domains.mutate(request, args, id);
    if (isTerminalMutation(request.op)) return executeTerminal(sources, request, args, id, current);
    if (request.op === "draft.settings.set" || request.op === "prompt.cancel") {
      const workspaceId = idArg(args.workspaceId), target = { workspaceId }, ctx = context(target, id.device);
      const delivery = journal(id, target, ctx);
      try {
        if (request.op === "draft.settings.set") {
          strictKeys(args, ["workspaceId", "draftHandle", "provider", "model", "effort", "permission", "serviceTier", "subagents", "isolated"]);
          const previous = args.draftHandle === undefined ? undefined : idArg(args.draftHandle);
          const patch = Object.fromEntries(Object.entries(args).filter(([key]) => ["provider", "model", "effort", "permission", "serviceTier", "subagents", "isolated"].includes(key)));
          const settings = validateExecutionSettings({ ...(previous ? drafts.get(previous, id.device, workspaceId).settings : {}), ...patch }, sources, ctx.effectiveSettings);
          if (settings.permission && remotePermission(settings.permission, currentWorkGrant(sources, id.device)) !== settings.permission
            || settings.permission === "full" && ctx.effectiveSettings.permission !== "full") throw new HostReadError("forbidden", "Full access isn't allowed for this device. To change it, open Settings → Connections → Devices on the other device.");
          await delivery.beforeCreate();
          const token = drafts.set(id.device, workspaceId, settings, previous);
          await delivery.accepted({});
          return { ...delivery.result(), draftHandle: token.handle, startTarget: token.startTarget, settings: token.settings };
        }
        strictKeys(args, ["workspaceId", "startTarget"]);
        const token = drafts.cancel(idArg(args.startTarget), id.device, workspaceId);
        await delivery.beforeCreate();
        if (token.original) {
          const result = await invoke<{ confirmed: boolean }>("remote_work_cancel_attempt", { generation: options.generation, ...id,
            workspaceId, original: token.original, attemptId: token.attemptId });
          if (!result?.confirmed) throw new HostReadError("uncertain", "The other device couldn't confirm this prompt stopped. Check the conversation.");
        }
        await delivery.accepted({ threadId: token.threadId });
        return delivery.result();
      } catch (reason) { await delivery.failure(reason); return delivery.result(); }
    }
    if (isParityOperation(request.op)) {
      validateParityArgs(request.op, args);
      const actions = parity;
      if (!actions) throw new HostReadError("unsupported", "This action is not connected yet.");
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
      return executeParityMutation(request.op, args, actions, ctx, id, options.generation, delivery, assertAllowed, currentWorkGrant(sources, id.device).revision);
    }
    if (request.op.startsWith("thread.") || request.op.startsWith("projects.")) return rowMutation(request, args, id);
    const threadId = args.threadId === undefined ? undefined : idArg(args.threadId);
    let target: ExecutionTarget;
    if (request.op === "prompt.send") {
      strictKeys(args, ["threadId", "workspaceId", "text", "draftHandle", "attachmentIds"]);
      if (Boolean(threadId) === (args.workspaceId !== undefined)) throw invalid();
      target = threadId ? { threadId } : { workspaceId: idArg(args.workspaceId) };
    } else {
      if (!threadId) throw invalid();
      target = { threadId };
      strictKeys(args, request.op === "prompt.queue" ? ["threadId", "workspaceId", "text", "draftHandle", "attachmentIds"] : request.op === "prompt.steer" ? ["threadId", "text", "target"]
        : request.op === "turn.stop" ? ["threadId", "target"] : request.op === "approval.answer" ? ["threadId", "target", "decision"] : ["threadId", "target", "answers", "cancel"]);
    }
    const initial = context(target, id.device);
    const candidate = args.draftHandle === undefined ? undefined : drafts.get(idArg(args.draftHandle), id.device, initial.activeWorkspace!.id);
    if (candidate?.cancelled) throw stale();
    if (candidate && "threadId" in target && (candidate.settings.provider && candidate.settings.provider !== initial.effectiveSettings.provider
      || candidate.settings.model && candidate.settings.model !== initial.effectiveSettings.model
      || candidate.settings.effort && candidate.settings.effort !== initial.effectiveSettings.reasoningEffort)) throw new HostReadError("stale_target", "Save changes to this thread's settings before sending.");
    const draft = "workspaceId" in target ? candidate : undefined;
    if (draft) drafts.claim(draft, id);
    let ctx = context(target, id.device, draft?.settings);
    const release = threadId ? pinTaskTranscript(threadId) : undefined;
    if (release) releases.add(release);
    let delivery: RemoteDeliveryJournal | undefined;
    try {
      if (args.workspaceId !== undefined && ctx.activeWorkspace!.id !== args.workspaceId) throw stale();
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
      delivery = journal(id, target, ctx, undefined, owned?.wire.handle, draft);
      if (draft) {
        const originalDispatch = delivery.beforeDispatch.bind(delivery), originalAccepted = delivery.accepted.bind(delivery), bind = delivery.bindThread.bind(delivery);
        delivery.beforeDispatch = async (info) => { await originalDispatch(info); draft.phase = "dispatched"; };
        delivery.accepted = async (info) => { draft.phase = "accepted"; await originalAccepted(info); };
        delivery.bindThread = async (threadId) => { draft.threadId = threadId; await bind(threadId); };
      }
      ctx = { ...ctx, remoteDelivery: delivery };
      if (request.op === "prompt.send" || request.op === "prompt.queue") {
        const resolved = await attachments(args.attachmentIds, id.device, ctx.activeWorkspace!.id);
        delivery.assertAllowed();
        ctx = { ...ctx, attachments: resolved.records, remoteAttachmentIds: resolved.ids };
      }
      if (request.op === "prompt.send") return await options.getRunner().sendPromptTo(ctx, prompt(args.text));
      if (request.op === "prompt.queue") return await options.getRunner().queuePromptTo(ctx, prompt(args.text), { ...delivery.queueRecord(), attachmentIds: ctx.remoteAttachmentIds });
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
          if (cutoff?.confirmed !== true) throw new HostReadError("uncertain", "The other device couldn't confirm this turn stopped. Check the conversation.");
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
          throw new HostReadError("forbidden", "Removing a project needs Manage projects and access to all projects.");
        }
      }
    };
    const operation: HostMutationContext = { identity: id, generation: options.generation, grantRevision: currentWorkGrant(sources, id.device).revision, context: ctx, assertAllowed };
    try {
      const values: Record<string, unknown> = {};
      if (request.op === "thread.settings.set") {
        strictKeys(args, ["threadId", "model", "effort", "provider", "permission", "serviceTier", "subagents"]);
        const values = validateExecutionSettings(Object.fromEntries(Object.entries(args).filter(([key]) => ["model", "effort", "provider", "permission", "serviceTier", "subagents"].includes(key))), sources, ctx.effectiveSettings);
        if (!Object.keys(values).length) throw invalid();
        // As on this device: a crew can't change under a run that captured it.
        if (values.subagents?.crew && (ctx.running || ctx.activeThread && useTaskStore.getState().parentRuns[ctx.activeThread.id])) throw new HostReadError("busy", "Finish or stop the parent and every sub-agent before changing this setup.");
        const nextCrew = values.subagents?.crew && values.subagents.engine === "mythra" ? { maxConcurrent: values.subagents.maxConcurrent, targets: values.subagents.crew as ChildAgentTarget[] } : undefined;
        const crewCheck = nextCrew ? sources.stageThreadCrew?.(threadId!, nextCrew, true) : undefined;
        if (crewCheck === "busy") throw new HostReadError("busy", "Finish or stop the parent and every sub-agent before changing this setup.");
        if (crewCheck === "not-ready") throw new HostReadError("unsupported", "Keep one ready sub-agent, or switch Sub-agents off.");
        if (values.permission === "full" && remotePermission(sources.getSettings().permission, currentWorkGrant(sources, id.device)) !== "full") throw new HostReadError("forbidden", "Full access isn't allowed for this device. To change it, open Settings → Connections → Devices on the other device.");
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
        const saved = await createHostSettingsActions().set(threadId!, values, operation);
        if (saved?.state !== "accepted") throw new HostReadError("uncertain", "The other device's settings write couldn't be confirmed.");
        if (nextCrew) sources.stageThreadCrew?.(threadId!, nextCrew, false);
        await flushPendingStateWrites();
        await delivery.accepted({ threadId });
      } else {
        if (!options.rows) throw new HostReadError("unsupported", "The other device has not enabled remote row actions yet.");
        if (!["thread.pin", "projects.pin", "projects.reorder"].includes(request.op) && !options.rows.nativeFenced?.includes(request.op as RemoteRowOperation)) throw new HostReadError("unsupported", "This action's native ownership boundary is not connected yet.");
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
        const rowArgs = { ...values, ...(threadId ? { threadId } : { workspaceId: ctx.activeWorkspace!.id }) };
        const pure = await executeRowState(request.op, rowArgs, operation);
        const result = pure ?? await options.rows.execute(request.op as RemoteRowOperation, rowArgs, operation);
        if (result?.state !== "accepted") throw new HostReadError("uncertain", "The other device's action couldn't be confirmed.");
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
    const resolved = await attachments(remote.attachmentIds, remote.device, remote.workspaceId);
    if (entry.attachments.length && !remote.attachmentIds?.length) throw new HostReadError("stale_target", "This attachment is no longer on the other device. Attach it again.");
    const frozenPath = targetPath(ctx);
    ctx = { ...ctx, attachments: resolved.records, remoteAttachmentIds: resolved.ids };
    paths.set(ctx, frozenPath);
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
    studio: domains.studio, studioReads: domains.studioReads,
    resolveQueued, reconcileQueues,
    async dispatch(request) {
      assertCurrent();
      if (request.generation !== options.generation || !isRemoteWorkOperation(request.op)) throw invalid();
      const args = objectArgs(request.args);
      if (active >= 4) throw new HostReadError("busy", "The other device is handling other work. Try again shortly.");
      active += 1;
      try {
        if (isProjectNavigationOperation(request.op)) {
          if (request.op === "projects.add") { identity(request, args); await refresh(request.device); currentGrant(sources, request.device, request.grant); }
          return await navigation.execute(request);
        }
        if (isDomainRead(request.op)) {
          if (typeof args.threadId === "string") remember(args.threadId);
          return await domains.read(request, args);
        }
        if (request.op === "host.context" || request.op === "files.search") {
          currentGrant(options.sources, request.device, request.grant);
          strictKeys(args, request.op === "host.context" ? ["workspaceId", "threadId"] : ["workspaceId", "threadId", "query"]);
          if (typeof args.threadId === "string") remember(args.threadId);
          if (request.op === "files.search") return await searchHostFiles(sources, request, args, assertCurrent);
          const result = hostContext(sources, request, args);
          if (parity) {
            const target = typeof args.threadId === "string" ? { threadId: args.threadId } : { workspaceId: idArg(args.workspaceId) };
            result.revision = idArg(parity.revision(resolveThreadExecutionContext(sources, target)));
          }
          return result;
        }
        if (request.op === "work.inspect") return await inspect(request, args);
        if (isParityOperation(request.op) && isParityRead(request.op)) {
          validateParityArgs(request.op, args);
          if (!parity) throw new HostReadError("unsupported", "This context is not connected yet.");
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
          const revision = parity.revision(ctx);
          const raw = await parity.read(request.op, args, ctx);
          validate();
          if (parity.revision(ctx) !== revision || raw.revision !== revision) throw stale();
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
    dispose() { disposed = true; clearRemoteEngineOwners(options.generation); navigation.dispose(); domains.dispose(); engines?.dispose(); drafts.clear(); targets.dispose(); unsubscribe?.(); nativeGrants.clear(); learned.clear(); for (const release of releases) release(); releases.clear(); },
  };
}
