import { childAgentModel, childLifecycleForLink, providerDisplayName, type ChildAgentLink } from "./childAgents";
import type { TaskStatus } from "./taskStore";
import type { AgentRecord } from "../components/StudioDock";
import type { Provider } from "../types";
import { decodeHtmlEntities } from "./text";

/**
 * The live sub-agent picture the composer's command center renders.
 *
 * Two independent sources describe the same fleet and neither is complete on
 * its own: cross-provider children are owned by OpenKiwi through
 * {@link ChildAgentLink} plus the task store, while a provider that delegates
 * natively only ever surfaces agent records on the root task. Everything here
 * is pure so the merge, the status mapping, and the ordering can be tested
 * without a runtime.
 */

export type SubAgentWorkerStatus = "idle" | "starting" | "working" | "completed" | "cancelled" | "failed";

export type SubAgentWorkerKind = "cross-provider" | "native";

export interface SubAgentWorker {
  /** Child thread id for cross-provider work; the runtime agent id otherwise. */
  id: string;
  kind: SubAgentWorkerKind;
  status: SubAgentWorkerStatus;
  /** Short human title, usually the delegated prompt. */
  title: string;
  /** Approved destination this child was started on, when OpenKiwi owns it. */
  targetId?: string;
  provider?: Provider;
  model?: string;
  /** One-line "who is doing this" summary, e.g. `Claude · claude-fable-5`. */
  detail: string;
  createdAt: number;
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

const ACTIVE_STATUSES: SubAgentWorkerStatus[] = ["starting", "working"];

/** Terminal workers settle to the bottom; live ones stay in view. */
const STATUS_ORDER: Record<SubAgentWorkerStatus, number> = {
  working: 0,
  starting: 1,
  failed: 2,
  cancelled: 3,
  completed: 4,
  idle: 5,
};

export function isSubAgentWorkerActive(status: SubAgentWorkerStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Map an OpenKiwi child lifecycle word onto a worker status. The lifecycle
 * vocabulary is what models read over the bridge, so it is translated here
 * rather than widened.
 */
export function workerStatusFromLifecycle(lifecycle: string): SubAgentWorkerStatus {
  if (lifecycle === "running") return "working";
  if (lifecycle === "starting") return "starting";
  if (lifecycle === "completed" || lifecycle === "cancelled" || lifecycle === "failed") return lifecycle;
  return "idle";
}

/**
 * Native agent records carry whatever word their provider chose. Unknown
 * values settle to idle instead of being guessed into an active state, so a
 * renamed provider status can never inflate the live count.
 */
export function workerStatusFromAgentRecord(status: string): SubAgentWorkerStatus {
  const value = status.trim().toLowerCase();
  if (value === "starting" || value === "pending" || value === "queued") return "starting";
  if (value === "started" || value === "running" || value === "working" || value === "interacted" || value === "inprogress") return "working";
  if (value === "completed" || value === "complete" || value === "done" || value === "success" || value === "succeeded") {
    return "completed";
  }
  if (value === "interrupted" || value === "cancelled" || value === "canceled" || value === "aborted" || value === "stopped") {
    return "cancelled";
  }
  if (value === "failed" || value === "failure" || value === "error") return "failed";
  return "idle";
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
  if (status === "working") return "Working";
  if (status === "starting") return "Starting";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
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
  /** Hide durable children from earlier root turns without deleting their
   * ownership records or their separately browsable threads. */
  runStartedAt?: number;
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

  for (const link of Object.values(input.links)) {
    if (link.rootThreadId !== rootThreadId) continue;
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
    });
  }

  for (const agent of input.agents) {
    if (owned.has(agent.id)) continue;
    workers.push({
      id: agent.id,
      kind: "native",
      status: workerStatusFromAgentRecord(agent.status),
      title: decodeHtmlEntities(agent.prompt || "Delegated task"),
      detail: agent.path || "Same provider as this thread",
      // Native records carry no timestamp; ordering falls back to their id.
      createdAt: 0,
    });
  }

  return sortWorkers(workers);
}

export function summarizeSubAgentWorkers(workers: SubAgentWorker[]): SubAgentCounts {
  const counts: SubAgentCounts = { total: workers.length, active: 0, starting: 0, working: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const worker of workers) {
    if (worker.status !== "idle") counts[worker.status] += 1;
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
