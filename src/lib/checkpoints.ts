import { invoke } from "@tauri-apps/api/core";

export type CheckpointStatus =
  | "running"
  | "ready"
  | "restored-before"
  | "restored-after"
  | "safety"
  | "interrupted"
  | "recovered"
  | "failed"
  | "legacy";

export interface CheckpointRecord {
  id: string;
  threadId: string;
  turnId?: string;
  workspacePath?: string;
  repoRoot?: string;
  threadLabel?: string;
  provider?: string;
  model?: string;
  branch?: string;
  head?: string;
  label: string;
  createdAt: number;
  completedAt?: number;
  status?: CheckpointStatus;
  accepted?: boolean;
  parentId?: string;
  parentPosition?: CheckpointRestoreTarget;
  restoredFromId?: string;
  /** Safety checkpoints around Apply remember the matching worktree baseline
   * so restoring the files also restores what the next Apply should diff from. */
  worktreeThreadId?: string;
  worktreeBaseline?: string;
  overlappingRun?: boolean;
  beforeCommit?: string;
  afterCommit?: string;
  fileCount?: number;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  error?: string;
}

export interface CheckpointSnapshot {
  commit: string;
  repoRoot: string;
  fileCount: number;
  branch?: string | null;
  head?: string | null;
}

export interface CompletedCheckpointSnapshot {
  snapshot: CheckpointSnapshot;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export type CheckpointRestoreTarget = "before" | "after";

export interface CheckpointHead {
  checkpointId: string;
  position: CheckpointRestoreTarget;
}

export function checkpointIsRestorable(
  checkpoint: CheckpointRecord,
  target: CheckpointRestoreTarget,
): boolean {
  return Boolean(
    checkpoint.workspacePath
      && checkpoint.beforeCommit
      && (target === "before" || checkpoint.afterCommit),
  );
}

export function checkpointStatusLabel(checkpoint: CheckpointRecord): string {
  if (!checkpoint.workspacePath || !checkpoint.beforeCommit) return "Conversation marker";
  if (checkpoint.accepted) return "Accepted";
  switch (checkpoint.status) {
    case "running":
      return "Run in progress";
    case "restored-before":
      return "Restored before run";
    case "restored-after":
      return "Completed state restored";
    case "safety":
      return "Safety copy";
    case "interrupted":
      return "Run interrupted";
    case "recovered":
      return "Recovered after restart";
    case "failed":
      return "Snapshot failed";
    case "legacy":
      return "Conversation marker";
    default:
      return "Ready";
  }
}

export const CHECKPOINT_RETENTION_PER_PROJECT = 150;
export const CHECKPOINT_RETENTION_MIN_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Splits checkpoint records into the retained list and the overflow to prune,
 * capping each project at `limit` records. Pruning is conservative: it never
 * touches records that are still running, safety copies, worktree
 * baseline/apply anchors, explicitly protected ids (current heads, active
 * runs), or anything newer than seven days.
 */
export function partitionCheckpointsForRetention(
  records: CheckpointRecord[],
  protectedIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
  limit = CHECKPOINT_RETENTION_PER_PROJECT,
): { kept: CheckpointRecord[]; pruned: CheckpointRecord[] } {
  if (records.length <= limit) return { kept: records, pruned: [] };
  const perProjectCounts = new Map<string, number>();
  const prunedIds = new Set<string>();
  const newestFirst = [...records].sort((left, right) => right.createdAt - left.createdAt);
  for (const record of newestFirst) {
    const key = record.workspacePath ?? "";
    const count = (perProjectCounts.get(key) ?? 0) + 1;
    perProjectCounts.set(key, count);
    if (count <= limit) continue;
    if (protectedIds.has(record.id)) continue;
    if (record.status === "running" || record.status === "safety") continue;
    if (record.worktreeThreadId || record.worktreeBaseline) continue;
    if (now - record.createdAt < CHECKPOINT_RETENTION_MIN_AGE_MS) continue;
    prunedIds.add(record.id);
  }
  if (!prunedIds.size) return { kept: records, pruned: [] };
  return {
    kept: records.filter((record) => !prunedIds.has(record.id)),
    pruned: records.filter((record) => prunedIds.has(record.id)),
  };
}

export async function createCheckpointSnapshot(
  id: string,
  cwd: string,
  label: string,
): Promise<CheckpointSnapshot> {
  return invoke<CheckpointSnapshot>("checkpoint_create", { id, cwd, label });
}

export async function completeCheckpointSnapshot(
  id: string,
  cwd: string,
  label: string,
): Promise<CompletedCheckpointSnapshot> {
  return invoke<CompletedCheckpointSnapshot>("checkpoint_complete", { id, cwd, label });
}

export async function readCheckpointDiff(
  id: string,
  cwd: string,
): Promise<string> {
  return invoke<string>("checkpoint_diff", { id, cwd });
}

export async function restoreCheckpointSnapshot(
  id: string,
  cwd: string,
  target: CheckpointRestoreTarget,
  safetyId: string,
): Promise<CheckpointSnapshot> {
  return invoke<CheckpointSnapshot>("checkpoint_restore", { id, cwd, target, safetyId });
}

export async function deleteCheckpointSnapshot(
  id: string,
  cwd: string,
): Promise<void> {
  await invoke("checkpoint_delete", { id, cwd });
}
