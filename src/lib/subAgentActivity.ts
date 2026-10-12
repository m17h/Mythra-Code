import { childAgentModel, childLifecycleForLink, providerDisplayName, type ChildAgentLink } from "./childAgents";
import { nativeDescendantIds, type NativeAgentLink, type NativeAgentReadout } from "./nativeAgentLinks";
import type { TaskStatus } from "./taskStore";
import type { AgentRecord } from "../components/StudioDock";
import type { Activity, Provider } from "../types";
import { decodeHtmlEntities } from "./text";

/**
 * The live sub-agent picture the composer's command center renders.
 *
 * Two independent sources describe the same fleet and neither is complete on
 * its own: cross-provider children are owned by Mythra Code through
 * {@link ChildAgentLink} plus the task store, while a provider that delegates
 * natively only ever surfaces agent records on the root task. Everything here
 * is pure so the merge, the status mapping, and the ordering can be tested
 * without a runtime.
 */

export type SubAgentWorkerStatus = "unknown" | "idle" | "starting" | "working" | "completed" | "cancelled" | "failed";

export type SubAgentWorkerKind = "cross-provider" | "native";

export interface SubAgentWorker extends NativeAgentReadout {
  /** Child thread id for cross-provider work; the runtime agent id otherwise. */
  id: string;
  kind: SubAgentWorkerKind;
  status: SubAgentWorkerStatus;
  /** Short human title, usually the delegated prompt. */
  title: string;
  /** Approved destination this child was started on, when Mythra Code owns it. */
  targetId?: string;
  provider?: Provider;
  model?: string;
  /** One-line "who is doing this" summary, e.g. `Claude · claude-fable-5`. */
  detail: string;
  createdAt: number;
  finishedAt?: number;
  canOpen?: boolean;
  canStop?: boolean;
}

export interface SubAgentCounts {
  total: number;
  /** Holding a concurrency slot right now: starting or working. */
  active: number;
  starting: number;
  working: number;
  completed: number;
  cancelled: number;
  failed: number;
}

const ACTIVE_STATUSES: SubAgentWorkerStatus[] = ["starting", "working", "unknown"];

/** Terminal workers settle to the bottom; live ones stay in view. */
const STATUS_ORDER: Record<SubAgentWorkerStatus, number> = {
  working: 0,
  starting: 1,
  failed: 2,
  cancelled: 3,
  completed: 4,
  idle: 5,
  unknown: 1,
};

export function isSubAgentWorkerActive(status: SubAgentWorkerStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Map an Mythra Code child lifecycle word onto a worker status. The lifecycle
 * vocabulary is what models read over the bridge, so it is translated here
 * rather than widened.
 */
export function workerStatusFromLifecycle(lifecycle: string): SubAgentWorkerStatus {
  if (lifecycle === "running") return "working";
  if (lifecycle === "starting") return "starting";
  if (lifecycle === "unknown" || lifecycle === "completed" || lifecycle === "cancelled" || lifecycle === "failed") return lifecycle;
  return "idle";
}

/**
 * Native agent records carry whatever word their provider chose. Unknown
 * values remain unknown and hold the safety boundary until runtime evidence
 * proves the child settled.
 */
export function workerStatusFromAgentRecord(status: string): SubAgentWorkerStatus {
  const value = status.trim().toLowerCase();
  if (value === "starting" || value === "pending" || value === "queued" || value === "pendinginit") return "starting";
  if (value === "started" || value === "running" || value === "working" || value === "interacted" || value === "inprogress") return "working";
  if (value === "completed" || value === "complete" || value === "done" || value === "success" || value === "succeeded") {
    return "completed";
  }
  if (value === "interrupted" || value === "cancelled" || value === "canceled" || value === "aborted" || value === "stopped" || value === "shutdown") {
    return "cancelled";
  }
  if (value === "failed" || value === "failure" || value === "error" || value === "errored" || value === "notfound") return "failed";
  if (value === "idle") return "idle";
  return "unknown";
}

/**
 * Whether a provider-native agent record still counts as live work.
 *
 * Single source of truth on purpose: the run boundary, the concurrency budget,
 * and Stop all have to agree about which records are running, or a record can
 * survive a Stop that never reached it or hold a slot nothing will release.
 */
export function isActiveAgentRecord(status: string): boolean {
  return isSubAgentWorkerActive(workerStatusFromAgentRecord(status));
}

export function subAgentStatusLabel(status: SubAgentWorkerStatus): string {
  if (status === "unknown") return "Status unknown";
  if (status === "working") return "Working";
  if (status === "starting") return "Starting";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Stopped";
  if (status === "failed") return "Failed";
  return "Idle";
}

function sortWorkers(workers: SubAgentWorker[]): SubAgentWorker[] {
  return [...workers].sort((left, right) => (
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id)
  ));
}

export interface SubAgentWorkerInput {
  rootThreadId: string | null | undefined;
  links: Record<string, ChildAgentLink>;
  statuses: Record<string, TaskStatus>;
  /** Agent records the root task collected, including native delegation. */
  agents: AgentRecord[];
  /** Same-turn command evidence can identify legacy Claude task_* misclassification. */
  rootActivities?: readonly Activity[];
  /** Positive Agent evidence retained by the visible thread's migration index. */
  protectedNativeAgentIds?: ReadonlySet<string>;
  /** Hide durable children from earlier root turns without deleting their
   * ownership records or their separately browsable threads. */
  runStartedAt?: number;
  /** Durable ownership for provider-native children, which carries the task
   * title and spawn time their bare agent records do not. */
  nativeLinks?: Record<string, NativeAgentLink>;
  /** Fallback provider only; a parent's model is never child model evidence. */
  nativeProvider?: Provider;
  nativeModel?: string;
}

/** A filesystem-looking `agent.path`, which is not a provider/model summary. */
function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function claudeCommandWorkerProof(rootThreadId: string, activities: readonly Activity[]) {
  const commandIds = new Set<string>();
  const agentIds = new Set<string>();
  const key = (turnId: string, id: string) => JSON.stringify([turnId, id]);
  for (const activity of activities) {
    if (activity.kind === "agent") {
      for (const id of activity.agent?.threadIds ?? []) agentIds.add(id);
    }
    if (activity.kind === "command" && activity.turnId) commandIds.add(key(activity.turnId, `claude-native:${rootThreadId}:${activity.id}`));
  }
  return (agent: Pick<AgentRecord, "id" | "runtime" | "rootTurnId">): boolean => {
    if (agent.runtime !== "claude" || !agent.rootTurnId) return false;
    const identity = key(agent.rootTurnId, agent.id);
    return commandIds.has(identity) && !agentIds.has(agent.id);
  };
}

/** Recognize only a positively identified legacy shell task.
 * Conflicting Agent evidence wins; this pure check never changes history. */
export function isClaudeCommandWorker(
  rootThreadId: string,
  agent: Pick<AgentRecord, "id" | "runtime" | "rootTurnId">,
  activities: readonly Activity[] = [],
): boolean {
  return claudeCommandWorkerProof(rootThreadId, activities)(agent);
}

type ClaudeCommandWorkerInput = Pick<SubAgentWorkerInput, "rootThreadId" | "agents" | "nativeLinks" | "rootActivities" | "protectedNativeAgentIds">;

function claudeCommandWorkerCandidates(input: ClaudeCommandWorkerInput): AgentRecord[] {
  const rootThreadId = input.rootThreadId;
  if (!rootThreadId || !input.rootActivities?.length) return [];
  const records = new Map(input.agents.map((agent) => [agent.id, agent]));
  for (const link of Object.values(input.nativeLinks ?? {})) {
    if (link.rootThreadId !== rootThreadId || records.has(link.childThreadId)) continue;
    records.set(link.childThreadId, { ...link, id: link.childThreadId, prompt: link.title, status: link.status ?? "unknown" });
  }
  return [...records.values()].filter((agent) => {
    if (input.protectedNativeAgentIds?.has(agent.id)) return false;
    const link = input.nativeLinks?.[agent.id];
    // A reported child execution model is positive agent evidence even if
    // its launch activity is outside the currently loaded history page.
    if (agent.modelSource === "execution" && agent.model?.trim()
      || link?.modelSource === "execution" && link.model?.trim()) return false;
    if (link && (link.rootThreadId !== rootThreadId
      || link.runtime !== undefined && link.runtime !== "claude"
      || agent.rootTurnId && link.rootTurnId && agent.rootTurnId !== link.rootTurnId)) return false;
    return (agent.runtime ?? link?.runtime) === "claude" && Boolean(agent.rootTurnId ?? link?.rootTurnId);
  });
}

/** Exact IDs eligible for removing obsolete synthetic ownership, never history. */
export function knownClaudeCommandWorkerIds(input: ClaudeCommandWorkerInput): string[] {
  const rootThreadId = input.rootThreadId;
  if (!rootThreadId || !input.rootActivities?.length) return [];
  const candidates = claudeCommandWorkerCandidates(input);
  if (!candidates.length) return [];
  const provenCommand = claudeCommandWorkerProof(rootThreadId, input.rootActivities);
  return candidates.filter((agent) => {
    const link = input.nativeLinks?.[agent.id];
    return provenCommand({
      id: agent.id,
      runtime: agent.runtime ?? link?.runtime,
      rootTurnId: agent.rootTurnId ?? link?.rootTurnId,
    });
  }).map((agent) => agent.id);
}

/** Active-view migration cache. History arrays are immutable: compare their
 * row references, then update proof only for changed command/Agent identities.
 * Detail/status revisions never rebuild the history-wide sets. Retain positive
 * Agent evidence for this view even if its page later leaves loaded history. */
export interface ClaudeCommandWorkerReconciler {
  (input: ClaudeCommandWorkerInput): string[];
  readonly protectedAgentIds: ReadonlySet<string>;
  /** Retain intermediate immutable pages until bounded command matching. */
  observeActivities(activities: readonly Activity[]): void;
  /** Observe queued identity proof before an immediate settings decision. */
  flushObservedActivities(): void;
}

export function createClaudeCommandWorkerReconciler(initialRootThreadId?: string | null): ClaudeCommandWorkerReconciler {
  let previous: readonly Activity[] = [];
  let rootId = initialRootThreadId;
  const commands = new Map<string, number>();
  const positiveAgents = new Set<string>();
  const pending: Array<readonly Activity[]> = [];
  const commandKey = (activity: Activity) => JSON.stringify([activity.turnId, activity.id]);
  const indexActivities = (activities: readonly Activity[]) => {
    if (previous !== activities) {
      for (let index = 0; index < Math.max(previous.length, activities.length); index++) {
        const before = previous[index];
        const after = activities[index];
        if (before === after) continue;
        const sameCommand = before?.kind === "command" && after?.kind === "command"
          && before.id === after.id && before.turnId === after.turnId;
        if (!sameCommand) {
          if (before?.kind === "command" && before.turnId) {
            const key = commandKey(before);
            const count = commands.get(key) ?? 0;
            if (count > 1) commands.set(key, count - 1);
            else commands.delete(key);
          }
          if (after?.kind === "command" && after.turnId) {
            const key = commandKey(after);
            commands.set(key, (commands.get(key) ?? 0) + 1);
          }
        }
        if (after?.kind === "agent") {
          for (const id of after.agent?.threadIds ?? []) positiveAgents.add(id);
        }
      }
      previous = activities;
    }
  };
  const flushPending = () => {
    for (const activities of pending) indexActivities(activities);
    pending.length = 0;
  };
  const observeActivities = (activities: readonly Activity[]) => {
    if (activities === previous || activities === pending[pending.length - 1]) return;
    pending.push(activities);
    // Bound retained array snapshots. Overflow only compares immutable row
    // references and updates changed proof; it never deletes worker records.
    if (pending.length >= 16) flushPending();
  };
  const reconcile = (input: ClaudeCommandWorkerInput): string[] => {
    if (!input.rootThreadId) return [];
    if (rootId !== input.rootThreadId) {
      rootId = input.rootThreadId;
      previous = [];
      commands.clear();
      positiveAgents.clear();
      pending.length = 0;
    }
    // An Agent page can arrive before its record, or while an execution model
    // vetoes cleanup. Capture every observed page before checking candidates,
    // including pages replaced before the coalesced subscriber wakes.
    flushPending();
    indexActivities(input.rootActivities ?? []);
    const candidates = claudeCommandWorkerCandidates(input).filter((agent) => !positiveAgents.has(agent.id));
    if (!candidates.length) return [];
    const prefix = `claude-native:${input.rootThreadId}:`;
    return candidates.filter((agent) => {
      if (positiveAgents.has(agent.id) || !agent.id.startsWith(prefix)) return false;
      const turnId = agent.rootTurnId ?? input.nativeLinks?.[agent.id]?.rootTurnId;
      return commands.has(JSON.stringify([turnId, agent.id.slice(prefix.length)]));
    }).map((agent) => agent.id);
  };
  return Object.assign(reconcile, { protectedAgentIds: positiveAgents, observeActivities, flushObservedActivities: flushPending });
}

/**
 * Every sub-agent belonging to one root thread, newest live work first.
 *
 * A cross-provider child is also mirrored onto the root's agent records, so
 * the link view wins for those ids and the remaining records are treated as
 * the provider's own native agents.
 */
export function collectSubAgentWorkers(input: SubAgentWorkerInput): SubAgentWorker[] {
  const rootThreadId = input.rootThreadId;
  if (!rootThreadId) return [];
  const workers: SubAgentWorker[] = [];
  const owned = new Set<string>();
  const commandWorkers = new Set(knownClaudeCommandWorkerIds(input));

  for (const link of Object.values(input.links)) {
    if (link.rootThreadId !== rootThreadId) continue;
    // A reversed or self-referential ownership record must never make the root
    // one of its own workers, where it would occupy a slot in its own budget.
    if (link.childThreadId === rootThreadId) continue;
    // Claim the mirrored agent id even when this durable link belongs to an
    // earlier run; otherwise a late terminal update can masquerade as a new
    // provider-native agent after the run boundary advances.
    owned.add(link.childThreadId);
    const lifecycle = childLifecycleForLink(link, input.statuses[link.childThreadId] ?? "idle");
    if (input.runStartedAt !== undefined && link.createdAt < input.runStartedAt
      && lifecycle !== "running" && lifecycle !== "starting") continue;
    const model = childAgentModel(link);
    workers.push({
      id: link.childThreadId,
      kind: "cross-provider",
      status: workerStatusFromLifecycle(lifecycle),
      title: decodeHtmlEntities(link.title || "Delegated task"),
      targetId: link.targetId,
      provider: link.provider,
      model,
      detail: `${providerDisplayName(link.provider)} · ${model || "provider default"}`,
      createdAt: link.createdAt,
      ...(link.finishedAt ? { finishedAt: link.finishedAt } : {}),
    });
  }

  const nativeIds = nativeDescendantIds(input.nativeLinks ?? {}, rootThreadId);
  const records = new Map(input.agents.map((agent) => [agent.id, agent]));
  for (const id of nativeIds) {
    if (records.has(id)) continue;
    const link = input.nativeLinks![id];
    records.set(id, { ...link, id, prompt: link.title, status: link.status ?? "unknown" });
  }
  for (const agent of records.values()) {
    if (owned.has(agent.id) || agent.id === rootThreadId) continue;
    // A bare native record is only an id and a status word. The durable link
    // Mythra Code wrote when it discovered this child carries the actual task and
    // when it started, so a native row reads as informatively as an owned one.
    const nativeLink = input.nativeLinks?.[agent.id];
    if (commandWorkers.has(agent.id)) continue;
    const provider = agent.provider ?? nativeLink?.provider ?? input.nativeProvider;
    // Empty is an explicit new-activation clear, not missing metadata. Do not
    // resurrect an old execution model from the durable fallback during it.
    const model = agent.model !== undefined ? agent.model.trim() : nativeLink?.model?.trim();
    const providerLabel = provider
      ? `${providerDisplayName(provider)} · ${model || "provider managed"}`
      : "Same provider as this thread";
    // `agent.path` is a worktree location for a native child but a
    // provider/model summary for a mirrored cross-provider one. Only the
    // latter belongs on the identity line; a folder goes after it.
    const detail = agent.path && !isPathLike(agent.path)
      ? agent.path
      : agent.path
        ? `${providerLabel} · ${agent.path}`
        : providerLabel;
    const childStatus = input.statuses[agent.id];
    const status = childStatus && childStatus !== "idle"
      ? workerStatusFromLifecycle(childStatus === "error" ? "failed" : childStatus === "interrupted" ? "cancelled" : childStatus)
      : workerStatusFromAgentRecord(agent.status);
    if (input.runStartedAt !== undefined && nativeLink && nativeLink.createdAt < input.runStartedAt && !isSubAgentWorkerActive(status)) continue;
    const claudeNative = (agent.runtime ?? nativeLink?.runtime) === "claude";
    workers.push({
      id: agent.id,
      kind: "native",
      status,
      title: decodeHtmlEntities(nativeLink?.title || agent.prompt || "Delegated task"),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      task: agent.task ?? nativeLink?.task,
      requestedModel: agent.requestedModel ?? nativeLink?.requestedModel,
      modelSource: agent.model === "" ? undefined : agent.modelSource ?? nativeLink?.modelSource,
      progress: agent.progress ?? nativeLink?.progress,
      result: agent.result ?? nativeLink?.result,
      activationId: agent.activationId ?? nativeLink?.activationId,
      detail,
      // Native records carry no timestamp of their own; the durable link does.
      createdAt: nativeLink?.createdAt ?? agent.createdAt ?? 0,
      ...(nativeLink?.finishedAt ? { finishedAt: nativeLink.finishedAt } : {}),
      canOpen: !claudeNative,
      canStop: !claudeNative,
    });
  }

  return sortWorkers(workers);
}

export function summarizeSubAgentWorkers(workers: SubAgentWorker[]): SubAgentCounts {
  const counts: SubAgentCounts = { total: workers.length, active: 0, starting: 0, working: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const worker of workers) {
    if (worker.status !== "idle" && worker.status !== "unknown") counts[worker.status] += 1;
    if (isSubAgentWorkerActive(worker.status)) counts.active += 1;
  }
  return counts;
}

/** Compact activity line, e.g. `2 working · 1 starting · 3 done`. */
export function describeSubAgentActivity(counts: SubAgentCounts): string {
  if (!counts.total) return "No sub-agents yet";
  const parts: string[] = [];
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.starting) parts.push(`${counts.starting} starting`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.completed) parts.push(`${counts.completed} done`);
  if (!parts.length) return `${counts.total} sub-agent${counts.total === 1 ? "" : "s"}`;
  return parts.join(" · ");
}
