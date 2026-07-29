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
