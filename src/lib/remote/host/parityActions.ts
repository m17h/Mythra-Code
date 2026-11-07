import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { useTaskStore } from "../../taskStore";
import { flushPendingStateWrites } from "../../storage";
import type { DeviceGrant } from "../types";
import type { HostParityOperation, RemoteOperationIdentity, RemoteWorkResult, WireParityReadResult, WireParityRow } from "../wire";
import type { HostMutationContext } from "./workActions";
import type { RemoteTurnDelivery } from "./workTypes";
import { HostReadError, idArg } from "./scope";

const reads = new Set<string>(["queue.read", "schedules.read", "workflows.list", "workflows.read", "projects.settings.read", "projects.instructions.read",
  "models.list", "models.refresh", "models.search", "skills.list", "skills.read", "skills.analyze", "usage.account.read", "usage.account.refresh",
  "threads.search", "threads.archived", "parent.read", "thread.handoff.read", "run.status", "checks.read", "checks.status", "discovery.run.status", "discovery.check.status"]);
const writes: Record<string, readonly string[]> = {
  "queue.edit.begin": ["queueId"], "queue.edit.finish": ["queueId", "editHandle", "text", "cancel"],
  "queue.retry": ["queueId"], "queue.steer": ["queueId", "target"], "queue.remove": ["queueId"],
  "prompt.schedule": ["text", "deliverAt"], "prompt.scheduleNew": ["text", "deliverAt", "draftHandle"],
  "schedules.edit": ["scheduleId", "text"], "schedules.reschedule": ["scheduleId", "deliverAt"], "schedules.release": ["scheduleId"], "schedules.remove": ["scheduleId"],
  "thread.compact": [], "thread.rollback": ["confirmed"], "thread.pullRequest.set": ["reference"],
  "thread.handoff.prepare": ["provider"], "thread.handoff.send": ["handoffId", "text"],
  "parent.continue": ["parentRunId"], "parent.dismiss": ["parentRunId"],
  "thread.archiveMany": ["threadIds"], "thread.deleteMany": ["threadIds", "confirmed"],
  "workflows.start": ["workflowId", "variables", "userPrompt"], "workflows.stop": ["workflowId", "runId"],
  "checkpoint.accept": ["checkpointId"], "agents.stop": ["agentId", "target"], "agents.accept": ["agentId", "target"], "agents.replace": ["agentId", "target", "targetId"],
  "actions.run": ["actionId"], "review.start": [], "git.suggestCommit": [],
  "git.autoPublish.set": ["enabled"], "git.autoPublish.retry": [],
  "projects.settings.set": ["name", "provider", "model", "effort"], "projects.instructions.set": ["prompt", "mode"],
  "projects.profiles.save": ["profileId", "name", "prompt", "mode"], "projects.profiles.delete": ["profileId"], "projects.profiles.select": ["profileId"],
  "projects.run.set": ["command", "setupCommand", "label"], "projects.check.set": ["command"],
  "run.start": [], "run.stop": ["processHandle"], "checks.start": [], "checks.stop": ["processHandle"],
  "discovery.run.start": [], "discovery.run.stop": ["runId"], "discovery.check.start": [], "discovery.check.stop": ["runId"],
  "discovery.settings.set": ["provider", "model", "effort"],
};
export const isParityOperation = (op: string): op is HostParityOperation => reads.has(op) || Object.hasOwn(writes, op);
export const isParityRead = (op: string): boolean => reads.has(op);
const providers = new Set(["openai", "openrouter", "lmstudio", "claude", "cursor"]);
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
const invalid = () => new HostReadError("unsupported", "This action is not valid.");
export interface HostParityActions {
  /** One resource revision for this workspace/thread; changes with its state. */
  revision(context: TurnRunnerContext): string;
  read(op: HostParityOperation, args: Readonly<Record<string, unknown>>, context: TurnRunnerContext): Promise<WireParityReadResult>;
  /**
   * Explicit App extraction point, NOT a native invoke/rpc proxy. Must preserve
   * local safety/lifecycle checks and use delivery receipts for every new start.
   * Queue edits need device/generation-bound expiring holds; cancelled/replaced
   * remote queue admissions must be durably rejected before their row is freed.
   */
  execute(op: HostParityOperation, args: Readonly<Record<string, unknown>>, operation: HostMutationContext & {
    delivery: RemoteTurnDelivery;
  }): Promise<{ state: "accepted" | "queued"; threadId?: string; queuedTurnId?: string; workflowRunId?: string; editHandle?: string; processHandle?: string }>;
}
export function assertParityAuthority(op: string, grant: DeviceGrant): void {
  if (!grant.view || !isParityRead(op) && !grant.work) throw new HostReadError("forbidden", "This action requires Work access.");
  const managing = op === "projects.settings.set" || op === "projects.instructions.set" || op.startsWith("projects.profiles.") || op === "projects.run.set" || op === "projects.check.set";
  if (managing && (grant.scope.kind !== "all" || (grant.capabilities as { manageProjects?: boolean }).manageProjects !== true)) {
    throw new HostReadError("forbidden", "This needs Manage projects and access to all projects.");
  }
  const shell = (op.startsWith("run.") || op.startsWith("checks.")) && !isParityRead(op)
    || (op.startsWith("discovery.") || op === "actions.run") && !isParityRead(op) || op === "projects.run.set" || op === "projects.check.set";
  if (shell && !grant.capabilities.terminal) throw new HostReadError("forbidden", "This action requires Terminal access.");
  if (op.startsWith("git.autoPublish.") && !isParityRead(op) && !(grant.capabilities.gitWrite && grant.capabilities.terminal)) throw new HostReadError("forbidden", "This action requires Git changes and Terminal access.");
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximum) throw invalid();
  return value;
}
export function validateParityArgs(op: string, args: Record<string, unknown>): void {
  const common = ["workspaceId", "threadId"];
  const allowed = reads.has(op) ? [...common, ...(op === "thread.handoff.read" ? ["provider"] : []), "query", "cursor", "limit", "workflowId", "skillId"]
    : [...common, "opId", "opSeq", "revision", ...(writes[op] ?? [])];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw invalid();
  idArg(args.workspaceId);
  if (args.threadId !== undefined) idArg(args.threadId);
  if (!reads.has(op)) idArg(args.revision);
  for (const key of ["checkpointId", "agentId", "queueId", "editHandle", "draftHandle", "scheduleId", "workflowId", "runId", "parentRunId", "messageId", "handoffId", "processHandle", "profileId", "target", "targetId", "actionId", "skillId", "cursor"]) {
    if (args[key] !== undefined) idArg(args[key]);
  }
  for (const key of ["text", "prompt", "userPrompt"]) if (args[key] !== undefined) string(args[key], 65536);
  for (const key of ["command", "setupCommand"]) if (args[key] !== undefined) string(args[key], 4000);
  for (const key of ["name", "label", "query", "model"]) if (args[key] !== undefined) string(args[key], 256);
  if (args.provider !== undefined && !providers.has(String(args.provider))) throw invalid();
  if (args.effort !== undefined && !efforts.has(String(args.effort))) throw invalid();
  if (args.mode !== undefined && args.mode !== "append" && args.mode !== "replace") throw invalid();
  if (args.cancel !== undefined && args.cancel !== true || args.confirmed !== undefined && args.confirmed !== true) throw invalid();
  if (args.deliverAt !== undefined && (typeof args.deliverAt !== "number" || !Number.isSafeInteger(args.deliverAt)
    || args.deliverAt <= Date.now() || args.deliverAt > Date.now() + 366 * 86400_000)) throw invalid();
  if (args.threadIds !== undefined && (!Array.isArray(args.threadIds) || !args.threadIds.length || args.threadIds.length > 100)) throw invalid();
  if (Array.isArray(args.threadIds)) { args.threadIds.forEach(idArg); if (new Set(args.threadIds).size !== args.threadIds.length) throw invalid(); }
  if (args.variables !== undefined) {
    if (!args.variables || typeof args.variables !== "object" || Array.isArray(args.variables) || Object.keys(args.variables).length > 64) throw invalid();
    for (const [key, value] of Object.entries(args.variables)) { idArg(key); string(value, 8192); }
  }
  if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw invalid();
  const threadOp = op.startsWith("queue.") || op.startsWith("parent.") || op === "thread.compact" || op === "thread.rollback" || op === "thread.pullRequest.set"
    || op.startsWith("thread.handoff.") || op === "prompt.schedule" || op.startsWith("agents.") || op === "review.start" || op === "git.suggestCommit";
  if (threadOp && args.threadId === undefined) throw invalid();
  if (op === "thread.rollback" || op === "thread.deleteMany") { if (args.confirmed !== true) throw invalid(); }
  if (op === "thread.pullRequest.set" && args.reference !== null && (typeof args.reference !== "string" || !args.reference.trim() || args.reference.length > 2048)) throw invalid();
  if (op.startsWith("queue.") && op !== "queue.read") idArg(args.queueId);
  if (op === "queue.steer") idArg(args.target);
  if (op === "queue.edit.finish") {
    idArg(args.editHandle);
    if (args.cancel === true ? args.text !== undefined : typeof args.text !== "string" || !args.text.trim()) throw invalid();
  }
  if (op.startsWith("schedules.") && op !== "schedules.read") idArg(args.scheduleId);
  if (op === "schedules.reschedule" && args.deliverAt === undefined) throw invalid();
  if (op === "schedules.edit" && (typeof args.text !== "string" || !args.text.trim())) throw invalid();
  if ((op === "thread.handoff.prepare" || op === "thread.handoff.read") && args.provider === undefined) throw invalid();
  if (op === "thread.handoff.send") idArg(args.handoffId);
  if (op === "run.stop" || op === "checks.stop") idArg(args.processHandle);
  if (op === "prompt.schedule" || op === "prompt.scheduleNew") { if (typeof args.text !== "string" || !args.text.trim() || args.deliverAt === undefined) throw invalid(); }
  if (op.startsWith("parent.") && op !== "parent.read") idArg(args.parentRunId);
  if (op.startsWith("workflows.") && op !== "workflows.list") idArg(args.workflowId);
  if (op === "workflows.stop") idArg(args.runId);
  if (op.startsWith("agents.")) { idArg(args.agentId); idArg(args.target); }
  if (op === "agents.replace") idArg(args.targetId);
  if (op === "git.autoPublish.set" && typeof args.enabled !== "boolean") throw invalid();
  if (op === "actions.run") idArg(args.actionId);
  if (op === "projects.instructions.set" && (typeof args.prompt !== "string" || args.mode === undefined)) throw invalid();
}
/** Rebuild every public field, including nested workflow fields. No spreads of host records. */
export function projectParityRead(raw: WireParityReadResult): WireParityReadResult {
  const rows: WireParityRow[] = [];
  for (const row of raw.rows.slice(0, 200)) {
    const next: WireParityRow = { id: idArg(row.id) };
    for (const key of ["name", "description", "text", "status", "model", "threadId", "parentThreadId", "runId", "queueId", "command", "setupCommand", "prompt", "mode", "handoffHandle"] as const) {
      if (typeof row[key] === "string") next[key] = row[key]!.slice(0, key === "text" || key === "prompt" ? 65536 : key === "command" || key === "setupCommand" ? 4000 : 2048);
    }
    for (const key of ["enabled", "pinned", "archived", "editing"] as const) if (typeof row[key] === "boolean") next[key] = row[key];
    for (const key of ["createdAt", "updatedAt", "deliverAt", "value", "limit"] as const) if (typeof row[key] === "number" && Number.isFinite(row[key])) next[key] = row[key];
    if (row.provider && providers.has(row.provider)) next.provider = row.provider;
    if (row.effort && efforts.has(row.effort)) next.effort = row.effort;
    if (row.variables) next.variables = row.variables.slice(0, 64).map((v) => ({ id: idArg(v.id), label: string(v.label, 256), required: v.required === true,
      ...(typeof v.default === "string" ? { default: string(v.default, 8192) } : {}) }));
    if (row.steps) next.steps = row.steps.slice(0, 64).filter((s) => s.type === "agent" || s.type === "command" || s.type === "wait").map((s) => ({
      id: idArg(s.id), type: s.type, name: string(s.name, 256), ...(typeof s.prompt === "string" ? { prompt: string(s.prompt, 65536) } : {}),
      ...(typeof s.command === "string" ? { command: string(s.command, 4000) } : {}), ...(s.provider && providers.has(s.provider) ? { provider: s.provider } : {}),
      ...(typeof s.model === "string" ? { model: string(s.model, 256) } : {}),
    }));
    rows.push(next);
  }
  const result = { revision: idArg(raw.revision), rows, truncated: raw.truncated === true || raw.rows.length > 200,
    ...(raw.cursor ? { cursor: idArg(raw.cursor) } : {}), ...(raw.timezone ? { timezone: string(raw.timezone, 128) } : {}) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new HostReadError("busy", "This page is too large. Request fewer rows.");
  return result;
}
export async function executeParityMutation(op: HostParityOperation, args: Record<string, unknown>, actions: HostParityActions,
  context: TurnRunnerContext, identity: RemoteOperationIdentity, generation: number, delivery: RemoteTurnDelivery,
  assertAllowed: () => void, grantRevision = 0): Promise<RemoteWorkResult> {
  const assertRevision = () => {
    assertAllowed();
    if (actions.revision(context) !== args.revision) throw new HostReadError("stale_target", "This state on the other device changed. Refresh before applying the action.");
  };
  try {
    assertRevision();
    const threadId = context.activeThread?.id, task = threadId ? useTaskStore.getState().tasks[threadId] : undefined;
    if ((op === "thread.compact" || op === "thread.rollback") && (task?.status === "starting" || task?.status === "running"
      || threadId && useTaskStore.getState().workflowOwners[threadId])) throw new HostReadError("busy", "Stop the active work before changing its history.");
    if (op.startsWith("parent.") && threadId && useTaskStore.getState().parentRuns[threadId]?.id !== args.parentRunId) throw new HostReadError("stale_target", "This parent run has ended.");
    await delivery.beforeCreate();
    assertRevision();
    // A workflow must establish native ownership before ANY preparation latch.
    // Its remote engine owns admission/child dispatch, not the generic state adapter.
    if (!["workflows.start", "parent.continue", "run.start", "checks.start", "discovery.run.start", "discovery.check.start", "thread.compact", "thread.rollback", "queue.steer", "prompt.scheduleNew", "thread.handoff.prepare", "thread.handoff.send", "thread.archiveMany", "thread.deleteMany", "agents.stop", "agents.accept", "agents.replace", "checkpoint.accept", "actions.run", "review.start", "git.suggestCommit"].includes(op)) await delivery.beforeDispatch({ threadId: threadId ?? "", messageId: delivery.messageId, provider: context.effectiveSettings.provider });
    assertRevision();
    const result = await actions.execute(op, args, { context, identity, generation, grantRevision, delivery, assertAllowed: assertRevision });
    if (result?.state === "queued" && result.threadId && result.queuedTurnId) {
      if (delivery.result().state !== "queued") await delivery.queued(result.threadId, result.queuedTurnId);
      return delivery.result();
    }
    if (result?.state !== "accepted") throw new HostReadError("uncertain", "The other device's action couldn't be confirmed.");
    await flushPendingStateWrites();
    await delivery.accepted({ threadId: result?.threadId ?? threadId });
    return { ...delivery.result(), ...(result?.workflowRunId ? { workflowRunId: idArg(result.workflowRunId) } : {}), ...(result?.editHandle ? { editHandle: idArg(result.editHandle) } : {}), ...(result?.processHandle ? { processHandle: idArg(result.processHandle) } : {}) };
  } catch (reason) { await delivery.failure(reason); return delivery.result(); }
}
