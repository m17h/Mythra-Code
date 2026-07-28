import { invoke } from "@tauri-apps/api/core";

export type ThreadWorktreeStatus = "active" | "applied" | "merged" | "removed" | "missing";

export interface ThreadWorktreeRecord {
  threadId: string;
  projectId: string;
  projectPath: string;
  path: string;
  branch: string;
  baseCommit: string;
  gitDir: string;
  createdAt: number;
  status: ThreadWorktreeStatus;
  lastAppliedAt?: number;
  appliedTree?: string;
  mergedAt?: number;
  removedAt?: number;
  recreatedFromMissing?: boolean;
}

export interface WorkspaceGitInfo {
  isRepo: boolean;
  isRoot: boolean;
  hasCommit: boolean;
  branch?: string | null;
  head?: string | null;
  error?: string | null;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseCommit: string;
  gitDir: string;
}

export interface WorktreeStatus {
  exists: boolean;
  registered: boolean;
  branch?: string | null;
  baseCommit?: string | null;
  changedFiles: number;
  untrackedFiles: number;
  ignoredFiles: string[];
  ahead: number;
  behind: number;
  clean: boolean;
}

export interface WorktreeApplyResult {
  changedFiles: number;
  additions: number;
  deletions: number;
  isolatedTree: string;
}

export interface WorktreeMergeResult {
  sourceCommit: string;
  isolatedTree: string;
}

export function executionPathForThread(
  threadId: string | null | undefined,
  logicalPath: string,
  records: Record<string, ThreadWorktreeRecord>,
): string {
  if (!threadId) return logicalPath;
  const record = records[threadId];
  return record ? record.path : logicalPath;
}

export async function readWorkspaceGitInfo(cwd: string): Promise<WorkspaceGitInfo> {
  return invoke<WorkspaceGitInfo>("workspace_git_info", { cwd });
}

export async function createThreadWorktree(
  projectPath: string,
  label: string,
): Promise<CreatedWorktree> {
  return invoke<CreatedWorktree>("worktree_create", { projectPath, label });
}

export async function recreateThreadWorktree(
  projectPath: string,
  branch: string,
  label: string,
): Promise<CreatedWorktree> {
  return invoke<CreatedWorktree>("worktree_recreate", { projectPath, branch, label });
}

export async function readWorktreeStatus(
  projectPath: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("worktree_status", {
    projectPath,
    worktreePath,
    branch,
    baseCommit,
  });
}

export async function applyWorktreeToSource(
  threadId: string,
  projectPath: string,
  worktreePath: string,
  baseCommit: string,
  safetyId: string,
): Promise<WorktreeApplyResult> {
  return invoke<WorktreeApplyResult>("worktree_apply_to_source", {
    threadId,
    projectPath,
    worktreePath,
    baseCommit,
    safetyId,
  });
}

export async function mergeWorktreeBranch(
  threadId: string,
  projectPath: string,
  worktreePath: string,
  branch: string,
  safetyId: string,
): Promise<WorktreeMergeResult> {
  return invoke<WorktreeMergeResult>("worktree_merge_branch", {
    threadId,
    projectPath,
    worktreePath,
    branch,
    safetyId,
  });
}

export async function removeThreadWorktree(
  threadId: string | undefined,
  projectPath: string,
  worktreePath: string,
  branch: string,
  force: boolean,
  deleteBranch: boolean,
): Promise<void> {
  await invoke("worktree_remove", {
    threadId,
    projectPath,
    worktreePath,
    branch,
    force,
    deleteBranch,
  });
}
