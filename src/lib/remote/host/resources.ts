import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { childReviewToken } from "../../../hooks/useChildAgents";
import { loadStored } from "../../storage";
import { getChildMailboxes, type ChildMailbox } from "../../childAgentMailbox";
import { refreshModelPricingCatalog, pricingRefreshStatus } from "../../usageLedger";
import { publicCrew } from "./executionPreferences";
import { sanitizeChildAgentLinks, sanitizeChildAgentPresets } from "../../childAgents";
import { sanitizeNativeAgentLinks } from "../../nativeAgentLinks";
import { collectSubAgentWorkers, type SubAgentWorker, type SubAgentWorkerInput } from "../../subAgentActivity";
import { useTaskStore } from "../../taskStore";
import { threadUsageSummary, type ThreadUsageAmounts } from "../../threadUsage";
import { commitMessageScope, useCommitMessageStore } from "../../commitMessages";
import type { ProjectAction, ThreadHandoff } from "../../../types";
import type { WorkflowDefinition, WorkflowRunRecord } from "../../workflows";
import type { HostContextSources } from "./hostContext";
import type { HostRequest } from "../wire";
import { REMOTE_ACTIVITY_BYTES } from "../wire-resources";
import type { HostResourceOperation, WireResourceResult, WireUsageAmounts, WireWorker, WireMailbox } from "../wire-resources";
import { nativeHostTransport, type HostTransport } from "./bridge";
import { HostReadError, currentGrant, idArg, requireThread, threadWorkspace } from "./scope";
const names = new Set<string>(["activity.read", "git.autoPublish.read", "agents.read", "mail.read", "workflows.view", "actions.list", "usage.thread.read", "usage.thread.details", "thread.handoff.lineage", "git.suggestion.read", "terminal.list", "git.context", "usage.prices.refresh", "tools.mcp.list", "agents.presets.read"]);
export const isHostResourceOperation = (op: string): op is HostResourceOperation => names.has(op);
export interface HostResourceSources {
  /** Cached host-only tool inventory for this exact workspace; never the selected project's cache. */
  /** Read-only view of a project's publishing state. Never a retained controller. */
  getAutoPublish?(workspaceId: string): { enabled: boolean; status: string; message: string; repository?: string } | undefined;
  getHostTools?(workspaceId: string): readonly { name: string; status: string; tools: number }[] | undefined;
  refreshHostPricing?(): Promise<{ updatedAt: string } | null>;
  getAgentLifecycle?(): import("./agentActions").HostAgentLifecycle | undefined;
  getSubAgentInput?(threadId: string): SubAgentWorkerInput;
  getProjectActions?(): readonly ProjectAction[];
  getHostWorkflows?(): readonly WorkflowDefinition[];
  getHostWorkflowRuns?(): readonly WorkflowRunRecord[];
  getThreadHandoffs?(): Readonly<Record<string, ThreadHandoff>>;
}
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const number = (value: unknown) => finite(value) ? value : 0;
function amounts(raw: ThreadUsageAmounts): WireUsageAmounts {
  const usage = raw.usage;
  return { usage: usage ? { totalTokens: number(usage.totalTokens), inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens),
    cachedInputTokens: number(usage.cachedInputTokens), reasoningOutputTokens: number(usage.reasoningOutputTokens),
    ...(typeof usage.outputTokensReported === "boolean" ? { outputTokensReported: usage.outputTokensReported } : {}),
    ...(typeof usage.cacheReadReported === "boolean" ? { cacheReadReported: usage.cacheReadReported } : {}), ...(typeof usage.cacheWriteReported === "boolean" ? { cacheWriteReported: usage.cacheWriteReported } : {}),
    ...(finite(usage.cacheReadUnknownTokens) ? { cacheReadUnknownTokens: usage.cacheReadUnknownTokens } : {}), ...(finite(usage.cacheWriteUnknownTokens) ? { cacheWriteUnknownTokens: usage.cacheWriteUnknownTokens } : {}),
    ...(usage.serviceTier ? { serviceTier: text(usage.serviceTier, 64) } : {}), ...(usage.requestedServiceTier ? { requestedServiceTier: text(usage.requestedServiceTier, 64) } : {}),
    ...(["reported", "requested", "unknown"].includes(usage.serviceTierSource ?? "") ? { serviceTierSource: usage.serviceTierSource } : {}),
    ...(finite(usage.cacheWriteInputTokens) ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
    ...(finite(usage.cacheWrite1hInputTokens) ? { cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens } : {}),
    ...(["reported", "partial", "unavailable"].includes(usage.tokenAvailability ?? "") ? { tokenAvailability: usage.tokenAvailability as "reported" | "partial" | "unavailable" } : {}) } : null,
    estimatedCost: finite(raw.estimatedCost) ? raw.estimatedCost : null, pricedTokens: number(raw.pricedTokens), unpricedTokens: number(raw.unpricedTokens) };
}
function sumAmounts(rows: WireUsageAmounts[]): WireUsageAmounts {
  const result: WireUsageAmounts = { usage: null, estimatedCost: null, pricedTokens: 0, unpricedTokens: 0 };
  for (const row of rows) {
    result.pricedTokens += row.pricedTokens; result.unpricedTokens += row.unpricedTokens;
    if (row.estimatedCost !== null) result.estimatedCost = (result.estimatedCost ?? 0) + row.estimatedCost;
    if (!row.usage) continue;
    const previous = result.usage;
    if (!previous) { result.usage = { ...row.usage }; continue; }
    result.usage = { totalTokens: (previous?.totalTokens ?? 0) + row.usage.totalTokens,
      inputTokens: (previous?.inputTokens ?? 0) + row.usage.inputTokens, outputTokens: (previous?.outputTokens ?? 0) + row.usage.outputTokens,
      cachedInputTokens: (previous?.cachedInputTokens ?? 0) + row.usage.cachedInputTokens, reasoningOutputTokens: (previous?.reasoningOutputTokens ?? 0) + row.usage.reasoningOutputTokens,
      ...(previous.outputTokensReported === false || row.usage.outputTokensReported === false ? { outputTokensReported: false } : typeof previous.outputTokensReported === "boolean" && typeof row.usage.outputTokensReported === "boolean" ? { outputTokensReported: previous.outputTokensReported && row.usage.outputTokensReported } : {}),
      cacheReadUnknownTokens: (previous.cacheReadUnknownTokens ?? 0) + (row.usage.cacheReadUnknownTokens ?? 0), cacheWriteUnknownTokens: (previous.cacheWriteUnknownTokens ?? 0) + (row.usage.cacheWriteUnknownTokens ?? 0),
      ...(previous.cacheReadReported === false || row.usage.cacheReadReported === false ? { cacheReadReported: false } : previous.cacheReadReported === true && row.usage.cacheReadReported === true ? { cacheReadReported: true } : {}),
      ...(previous.cacheWriteReported === false || row.usage.cacheWriteReported === false ? { cacheWriteReported: false } : previous.cacheWriteReported === true && row.usage.cacheWriteReported === true ? { cacheWriteReported: true } : {}),
      cacheWriteInputTokens: (previous?.cacheWriteInputTokens ?? 0) + (row.usage.cacheWriteInputTokens ?? 0), cacheWrite1hInputTokens: (previous?.cacheWrite1hInputTokens ?? 0) + (row.usage.cacheWrite1hInputTokens ?? 0),
      ...(row.usage.tokenAvailability === "partial" || row.usage.tokenAvailability === "unavailable" || previous?.tokenAvailability === "partial" || previous?.tokenAvailability === "unavailable" ? { tokenAvailability: "partial" } : {}) };
  }
  if (result.usage?.totalTokens && !result.pricedTokens) result.estimatedCost = null;
  return result;
}
function mailbox(id: string, raw: ChildMailbox, limit: number): WireMailbox {
  return { agentId: id, dropped: number(raw.dropped), truncated: raw.messages.length > limit, messages: raw.messages.slice(-limit).map((row) => ({
    id: row.id, direction: row.direction, kind: row.kind, text: text(row.text, 4000), state: row.state, createdAt: number(row.createdAt),
    ...(finite(row.answeredAt) ? { answeredAt: row.answeredAt } : {}), ...(finite(row.closedAt) ? { closedAt: row.closedAt } : {}),
    ...(finite(row.settledAt) ? { settledAt: row.settledAt } : {}), ...(row.uncertain ? { uncertain: true } : {}),
    ...(row.replyTo ? { replyTo: text(row.replyTo, 128) } : {}), ...(row.via ? { via: row.via } : {}),
  })) };
}
const identity = (worker: SubAgentWorker) => JSON.stringify([worker.id, worker.kind, worker.createdAt, worker.activationId, worker.resultRevision, worker.manualAttemptId, worker.reviewToken, worker.status, worker.review, worker.canStop]);
export class HostResources {
  private handoffs = new Map<string, { device: string; workspaceId: string; expires: number; value: ThreadHandoff }>();
  private targets = new Map<string, { device: string; root: string; key: string; expires: number }>();
  constructor(private sources: HostContextSources, private generation: number, private revision: (context: TurnRunnerContext) => string, private transport: HostTransport = nativeHostTransport) {}
  dispose(): void { this.targets.clear(); this.handoffs.clear(); }
  issueHandoff(context: TurnRunnerContext, device: string, provider: ThreadHandoff["targetProvider"]): string {
    const thread = context.activeThread, workspace = context.activeWorkspace;
    if (!thread || !workspace) throw new HostReadError("thread_unavailable", "This handoff source is not available.");
    for (const [key, row] of this.handoffs) if (row.expires < Date.now()) this.handoffs.delete(key);
    if (this.handoffs.size >= 256) throw new HostReadError("busy", "Too many handoff drafts are open.");
    const handle = crypto.randomUUID();
    this.handoffs.set(handle, { device, workspaceId: workspace.id, expires: Date.now() + 1800_000,
      value: { sourceThreadId: thread.id, sourceTitle: thread.name || thread.preview || "Untitled task", sourceProvider: context.effectiveSettings.provider,
        sourceModel: context.effectiveSettings.model, workspacePath: workspace.path, targetProvider: provider, createdAt: Date.now() } });
    return handle;
  }
  handoff(handle: string, device: string, workspaceId: string): ThreadHandoff {
    const value = this.handoffs.get(handle);
    if (!value || value.expires < Date.now() || value.device !== device || value.workspaceId !== workspaceId) throw new HostReadError("stale_target", "This handoff draft expired. Prepare it again.");
    const grant = this.sources.getGrant(device), source = this.sources.getKnownThreads()[value.value.sourceThreadId];
    if (!grant || requireThread(this.sources, source, grant).workspace.id !== workspaceId) throw new HostReadError("forbidden", "The handoff source is no longer shared.");
    return { ...value.value };
  }
  input(threadId: string): SubAgentWorkerInput {
    if (this.sources.getSubAgentInput) {
      const input = this.sources.getSubAgentInput(threadId);
      if (input.rootThreadId !== threadId) throw new HostReadError("stale_target", "The host returned another conversation's sub-agent context.");
      return input;
    }
    const state = useTaskStore.getState(), links = sanitizeChildAgentLinks(loadStored("kiwi.childAgentLinks", {}));
    return { rootThreadId: threadId, links, nativeLinks: sanitizeNativeAgentLinks(loadStored("kiwi.nativeAgentLinks", {})),
      agents: state.tasks[threadId]?.agents ?? [], rootActivities: state.tasks[threadId]?.activities ?? [], statuses: state.statuses,
      mailboxes: getChildMailboxes(), reviewTokens: Object.fromEntries(Object.entries(links).map(([id, link]) => [id, childReviewToken(link)])) };
  }
  workers(threadId: string): SubAgentWorker[] { return collectSubAgentWorkers(this.input(threadId)); }
  resolveWorker(handle: string, device: string, root: string): SubAgentWorker {
    const target = this.targets.get(handle);
    if (!target || target.device !== device || target.root !== root || target.expires < Date.now()) throw new HostReadError("stale_target", "This sub-agent assignment expired. Refresh its current work.");
    const worker = this.workers(root).find((worker) => identity(worker) === target.key);
    if (!worker) throw new HostReadError("stale_target", "This sub-agent's assignment or result changed.");
    return worker;
  }
  private target(worker: SubAgentWorker, device: string, root: string): string {
    const key = identity(worker);
    for (const [handle, entry] of this.targets) {
      if (entry.expires < Date.now()) this.targets.delete(handle);
      else if (entry.device === device && entry.root === root && entry.key === key) return handle;
    }
    if (this.targets.size >= 1024) throw new HostReadError("busy", "Too many sub-agent details are open. Try again shortly.");
    const handle = crypto.randomUUID(); this.targets.set(handle, { device, root, key, expires: Date.now() + 300_000 }); return handle;
  }
  async read(request: HostRequest, args: Record<string, unknown>, context: TurnRunnerContext, validate: () => void): Promise<WireResourceResult> {
    const keys = ["workspaceId", "threadId", "limit", ...(request.op === "activity.read" ? ["activityId"] : []), ...(request.op === "agents.read" || request.op === "mail.read" ? ["agentId"] : []), ...(request.op === "workflows.view" ? ["workflowId"] : [])];
    if (Object.keys(args).some((key) => !keys.includes(key))) throw new HostReadError("unsupported", "This resource request is not valid.");
    for (const key of ["threadId", "agentId", "workflowId"]) if (args[key] !== undefined) idArg(args[key]);
    const workspace = context.activeWorkspace!, rootId = context.activeThread?.id;
    if (workspace.id !== idArg(args.workspaceId)) throw new HostReadError("stale_target", "This workspace changed.");
    const limit = args.limit === undefined ? 100 : args.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new HostReadError("unsupported", "Request a bounded resource page.");
    const result: WireResourceResult = { revision: this.revision(context), truncated: false };
    validate();
    if (request.op === "activity.read") {
      if (!rootId || typeof args.activityId !== "string" || !args.activityId || args.activityId.length > 512) throw new HostReadError("stale_target", "This step is no longer available.");
      const activity = useTaskStore.getState().tasks[rootId]?.activities.find((row) => row.id === args.activityId);
      // Warnings are the host's own diagnostics, and stay summarized as they are in the timeline.
      if (!activity || activity.kind === "warning") throw new HostReadError("stale_target", "This step is no longer available.");
      const detail = activity.detail ?? "";
      result.activity = { id: activity.id, detail: text(detail, REMOTE_ACTIVITY_BYTES), truncated: detail.length > REMOTE_ACTIVITY_BYTES };
    } else if (request.op === "git.autoPublish.read") {
      const state = this.sources.getAutoPublish?.(workspace.id);
      result.autoPublish = { enabled: state?.enabled === true, status: text(state?.status, 32) || "idle", message: text(state?.message, 1024) || "Automatic publishing is off.",
        ...(state?.repository ? { repository: text(state.repository, 256) } : {}) };
    } else if (request.op === "usage.prices.refresh") {
      const refreshed = await (this.sources.refreshHostPricing?.() ?? refreshModelPricingCatalog()); validate();
      result.pricing = { available: refreshed !== null, checking: pricingRefreshStatus().checking, ...(refreshed ? { updatedAt: text(refreshed.updatedAt, 64) } : {}) };
    } else if (request.op === "tools.mcp.list") {
      const tools = this.sources.getHostTools?.(workspace.id);
      result.toolsAvailability = tools ? "ready" : "unavailable";
      result.tools = (tools ?? []).slice(0, limit).map((row) => ({ name: text(row.name, 128), status: text(row.status, 64), tools: number(row.tools) }));
      result.truncated = (tools?.length ?? 0) > limit;
    } else if (request.op === "agents.presets.read") {
      const presets = sanitizeChildAgentPresets(this.sources.getSettings().childAgentPresets);
      result.presets = presets.slice(0, limit).map((entry) => ({ id: entry.id, name: text(entry.name, 128), subagents: { enabled: entry.policy.enabled, engine: "mythra", maxConcurrent: entry.policy.maxConcurrent, crew: publicCrew(entry.policy.childAgents.targets) } }));
      result.truncated = presets.length > limit;
    } else if (request.op === "git.context") {
      const root = this.sources.executionPathFor(rootId ?? "", workspace.path);
      const raw = await this.transport.invoke<import("../../gitWorkspace").GitWorkspaceSnapshot>("remote_studio_git_snapshot", { root });
      validate(); if (this.sources.executionPathFor(rootId ?? "", workspace.path) !== root) throw new HostReadError("stale_target", "This checkout changed.");
      result.git = { headOid: raw.headOid, branch: raw.branch, branches: raw.branches.slice(0, limit).map((row) => ({ name: text(row.name, 256), current: row.current === true })),
        stagedFiles: number(raw.stagedFiles), unstagedFiles: number(raw.unstagedFiles), changedFiles: number(raw.changedFiles) };
      result.truncated = raw.branches.length > limit;
    } else if (request.op === "terminal.list") {
      const grant = currentGrant(this.sources, request.device, request.grant);
      if (!grant.capabilities.terminal) throw new HostReadError("forbidden", "Terminal access is required to inspect these processes.");
      const root = this.sources.executionPathFor(rootId ?? "", workspace.path);
      const raw = await this.transport.invoke<{ terminals: NonNullable<WireResourceResult["terminals"]>; truncated: boolean }>("remote_terminal_list", { generation: this.generation, device: request.device, grantRevision: grant.revision, workspaceId: workspace.id, root });
      validate(); if (this.sources.executionPathFor(rootId ?? "", workspace.path) !== root) throw new HostReadError("stale_target", "This checkout changed.");
      result.terminals = raw.terminals.slice(0, limit).map((row) => ({ terminalId: idArg(row.terminalId), command: text(row.command, 4000), state: text(row.state, 32), startedAt: number(row.startedAt), owned: row.owned === true,
        ...(row.threadId && this.sources.getKnownThreads()[row.threadId] && threadWorkspace(this.sources, this.sources.getKnownThreads()[row.threadId])?.id === workspace.id ? { threadId: row.threadId } : {}),
        ...(finite(row.columns) ? { columns: row.columns } : {}), ...(finite(row.rows) ? { rows: row.rows } : {}), ...(finite(row.seq) ? { seq: row.seq } : {}) }));
      result.truncated = raw.truncated || raw.terminals.length > limit;
    } else if (request.op === "actions.list") {
      const actions = this.sources.getProjectActions?.() ?? loadStored<ProjectAction[]>("kiwi.projectActions", []);
      result.actions = actions.slice(0, limit).map((entry) => ({ id: idArg(entry.id), name: text(entry.name, 256), command: text(entry.command, 4000), ...(entry.icon ? { icon: text(entry.icon, 64) } : {}) }));
      result.truncated = actions.length > limit;
    } else if (request.op === "workflows.view") {
      const workflows = (this.sources.getHostWorkflows?.() ?? loadStored<WorkflowDefinition[]>("kiwi.workflows", [])).filter((entry) => !entry.projectId || entry.projectId === workspace.id);
      const selected = args.workflowId === undefined ? workflows : workflows.filter((entry) => entry.id === idArg(args.workflowId));
      const runs = this.sources.getHostWorkflowRuns?.() ?? loadStored<WorkflowRunRecord[]>("kiwi.workflowRuns", []);
      let remaining = 96_000;
      const take = (value: unknown, maximum: number) => { const resultText = text(value, Math.min(maximum, remaining)); remaining -= resultText.length; if (typeof value === "string" && resultText.length < value.length) result.truncated = true; return resultText; };
      result.workflows = selected.slice(0, Math.min(limit, 8)).map((entry) => ({ id: entry.id, name: take(entry.name, 256), description: take(entry.description, 2048), enabled: entry.enabled, provider: entry.run.provider, model: take(entry.run.model, 256),
        variables: (entry.variables ?? []).slice(0, 64).map((row) => ({ id: row.id, name: take(row.name, 128), value: take(row.value, 8192), promptOnRun: row.promptOnRun })),
        steps: entry.steps.slice(0, 64).map((step) => ({ id: step.id, name: take(step.name, 256), type: step.type, continueOnError: step.continueOnError,
          ...(step.type === "agent" ? { prompt: take(step.prompt, 65536) } : { command: take(step.command, 4000) }) })),
        runs: runs.filter((run) => run.workflowId === entry.id && run.projectId === workspace.id).slice(-20).map((run) => ({ id: run.id, status: run.status, startedAt: run.startedAt, ...(finite(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
          ...(run.threadId && this.sources.getKnownThreads()[run.threadId] && threadWorkspace(this.sources, this.sources.getKnownThreads()[run.threadId])?.id === workspace.id ? { threadId: run.threadId } : {}) })),
      })); result.truncated ||= selected.length > Math.min(limit, 8);
    } else {
      if (!rootId) throw new HostReadError("thread_unavailable", "Select a conversation for these details.");
      const grant = currentGrant(this.sources, request.device, request.grant);
      const input = this.input(rootId);
      const scoped = (id: string): boolean => {
        const thread = this.sources.getKnownThreads()[id];
        if (thread) { try { return requireThread(this.sources, thread, grant).workspace.id === workspace.id; } catch { return false; } }
        return input.nativeLinks?.[id]?.rootThreadId === rootId && input.nativeLinks[id].runtime === "claude";
      };
      if (request.op === "agents.read" || request.op === "mail.read") {
        const workers = this.workers(rootId).filter((worker) => scoped(worker.id)).filter((worker) => args.agentId === undefined || worker.id === idArg(args.agentId));
        if (args.agentId !== undefined && !workers.length) throw new HostReadError("thread_unavailable", "This sub-agent is not shared in this workspace.");
        if (request.op === "agents.read") result.workers = workers.slice(0, limit).map((worker): WireWorker => ({ id: worker.id, kind: worker.kind, status: worker.status, title: text(worker.title, 4000), detail: text(worker.detail, 1024), createdAt: worker.createdAt,
          target: this.target(worker, request.device, rootId), canOpen: worker.canOpen !== false, canStop: worker.canStop === true, canAccept: Boolean(worker.reviewToken && worker.review !== "accepted"),
          ...(worker.provider ? { provider: worker.provider } : {}), ...(worker.model ? { model: text(worker.model, 256) } : {}), ...(worker.task ? { task: text(worker.task, 12000) } : {}),
          ...(worker.progress ? { progress: text(worker.progress, 8000) } : {}), ...(worker.result ? { result: text(worker.result, 12000) } : {}), ...(worker.review ? { review: worker.review } : {}),
          ...(finite(worker.finishedAt) ? { finishedAt: worker.finishedAt } : {}), ...(worker.targetId ? { targetId: worker.targetId } : {}) }));
        else result.mailboxes = workers.slice(0, limit).flatMap((worker) => { const value = input.mailboxes?.[worker.id]; return value && value.rootThreadId === rootId ? [mailbox(worker.id, value, 50)] : []; });
        result.truncated = workers.length > limit;
      } else if (request.op === "usage.thread.read" || request.op === "usage.thread.details") {
        const summary = threadUsageSummary({ threadId: rootId, nativeLinks: Object.fromEntries(Object.entries(input.nativeLinks ?? {}).filter(([id]) => scoped(id))), managedLinks: Object.fromEntries(Object.entries(input.links).filter(([id]) => scoped(id))) });
        const contextUsage = Object.fromEntries(Object.entries(summary.context).filter(([, value]) => value === null || finite(value)));
        // Native usage can retain descendants no longer shared here. Filter
        // BEFORE summing too, not just before displaying the child IDs.
        const children = summary.descendants.filter((row) => scoped(row.threadId)).map((row) => ({ threadId: row.threadId, amounts: amounts(row.amounts) }));
        const own = amounts(summary.own), subagents = sumAmounts(children.map((row) => row.amounts));
        result.usage = { threadId: rootId, own, subagents, total: sumAmounts([own, subagents]), context: contextUsage,
          descendants: children.slice(0, limit),
          missingThreadIds: summary.missingThreadIds.filter((id) => id === rootId || scoped(id)).slice(0, limit), historyPartialThreadIds: summary.historyPartialThreadIds.filter((id) => id === rootId || scoped(id)).slice(0, limit),
          claudeNativeIncluded: summary.claudeNativeIncluded, detailsAvailable: false }; result.truncated = summary.descendants.length > limit;
      } else if (request.op === "thread.handoff.lineage") {
        const handoff = (this.sources.getThreadHandoffs?.() ?? loadStored<Record<string, ThreadHandoff>>("kiwi.threadHandoffs", {}))[rootId];
        const source = handoff ? this.sources.getKnownThreads()[handoff.sourceThreadId] : undefined;
        result.lineage = { threadId: rootId, ...(source && scoped(source.id) ? { sourceThreadId: source.id, sourceTitle: text(source.name || source.preview, 256), sourceProvider: handoff.sourceProvider, targetProvider: handoff.targetProvider, createdAt: number(handoff.createdAt) } : {}) };
      } else if (request.op === "git.suggestion.read") {
        const root = this.sources.executionPathFor(rootId, workspace.path), entry = useCommitMessageStore.getState().suggestions[commitMessageScope(root)];
        let stale = true;
        if (entry) {
          try {
            const current = await this.transport.invoke<{ token: string }>("remote_studio_commit_context", { root });
            validate(); stale = current.token !== entry.context.token;
          } catch (reason) {
            // Missing safe freshness proof is NOT permission to use the local
            // executable-config Git helper from a View-only read.
            if (!(typeof reason === "string" && /not found|unknown command/i.test(reason))) throw reason;
          }
        }
        result.suggestion = entry ? { id: text(entry.id, 256), message: text(entry.message, 16384), ...(entry.stagedMessage ? { stagedMessage: text(entry.stagedMessage, 16384) } : {}), token: text(entry.context.token, 256), stale } : null;
      }
    }
    validate();
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new HostReadError("busy", "These details are too large. Request fewer rows.");
    return result;
  }
}
