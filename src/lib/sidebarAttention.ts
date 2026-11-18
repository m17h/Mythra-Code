/**
 * M05: which threads need the person, and how many per project. A thread
 * needs attention while it has an unanswered approval. Pure, so the sidebar's
 * project counts and the "Needs you" filter agree exactly.
 */
export type AttentionTask = { approvals?: readonly unknown[] } | undefined;

/** Stable key (sorted ids) so a store selector only changes when the set does. */
export function attentionThreadKey(tasks: Record<string, AttentionTask>): string {
  return Object.entries(tasks)
    .filter(([, task]) => (task?.approvals?.length ?? 0) > 0)
    .map(([id]) => id)
    .sort()
    .join("|");
}

export function attentionIdsFromKey(key: string): Set<string> {
  return new Set(key ? key.split("|") : []);
}

const normalized = (path: string) => (path.replace(/\\/g, "/").replace(/\/+$/, "") || "/");

/** Count attention threads per normalized project path. */
export function countAttentionByWorkspace(
  ids: ReadonlySet<string>,
  index: Record<string, { cwd?: string } | undefined>,
  bindings: Record<string, string>,
  normalize: (path: string) => string = normalized,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const path = bindings[id] || index[id]?.cwd;
    if (!path) continue;
    const key = normalize(path);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Elapsed run time as the sidebar writes it: "12s", "4m", "1h 5m". */
export function formatWorkingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** I5 (round 6): the first seconds of a run say only "Working"; a count
 * appears from 10s, once how long it has run starts to matter. */
export const WORKING_DURATION_MIN_MS = 10_000;
export function visibleWorkingDuration(elapsedMs: number): string | null {
  return Number.isFinite(elapsedMs) && elapsedMs >= WORKING_DURATION_MIN_MS ? formatWorkingDuration(elapsedMs) : null;
}

/** I5/M02 (round 6): row states whose status gets its own line under the
 * title (running, waiting on you, failed, unavailable). Idle and "Done" rows
 * stay one line. */
const STATUS_BELOW = new Set(["live", "attention", "waiting", "faulted", "unavailable"]);
export function statusOnOwnLine(lifecycle: string): boolean {
  return STATUS_BELOW.has(lifecycle);
}

/** I8 (round 6): a project row shows one indicator, by priority: threads
 * waiting on you, else threads working. The other count stays in the
 * tooltip and the row's accessible name. */
export type ProjectIndicator =
  | { kind: "attention"; count: number; title: string }
  | { kind: "working"; count: number; title: string }
  | null;
export function projectIndicator(attention: number, working: number): ProjectIndicator {
  const needs = `${attention} thread${attention === 1 ? " needs" : "s need"} approval`;
  const busy = `${working} thread${working === 1 ? "" : "s"} working`;
  if (attention > 0) return { kind: "attention", count: attention, title: working > 0 ? `${needs} · ${busy}` : needs };
  if (working > 0) return { kind: "working", count: working, title: busy };
  return null;
}
