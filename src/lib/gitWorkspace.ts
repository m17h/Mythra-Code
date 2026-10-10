import { invoke } from "@tauri-apps/api/core";
import type { ProjectGitChanges } from "./gitInspection";

export interface GitWorkspaceBranch {
  name: string;
  current: boolean;
  worktreePath: string | null;
}

export interface GitWorkspaceSnapshot {
  branch: string | null;
  headOid: string | null;
  /** Local tracking state from the same workspace read; absent on older runtimes. */
  upstream?: string | null;
  /** Actual configured remote, including '.' for another local branch. */
  upstreamRemote?: string | null;
  /** Null means no resolvable comparison, rather than zero unpublished commits. */
  ahead?: number | null;
  behind?: number | null;
  branches: GitWorkspaceBranch[];
  stagedFiles: number;
  unstagedFiles: number;
  changedFiles: number;
  stagedPaths: string[];
  rootPath: string;
  /** Native canonical identity check; optional for older runtimes. */
  isRoot?: boolean;
  /** Bounded rows from this snapshot's status scan; absent on older runtimes. */
  changes?: ProjectGitChanges | null;
  /** Changes presentation can fail while identity and summary remain usable. */
  changesError?: string | null;
}

export interface GitWorkflowControls {
  snapshot: GitWorkspaceSnapshot | null;
  /** Advances after every accepted successful read, even an unchanged summary. */
  readRevision?: number;
  busy: boolean;
  error?: string;
  readError?: string;
  notice?: string;
  isolated: boolean;
  branchNotice?: string;
  onBranch: (name: string, create: boolean) => Promise<boolean | void>;
  onRefresh: () => void;
  /** Surface entry shares an already pending owner read instead of queueing another. */
  onRefreshIfIdle?: (observedRevision?: number) => void;
  autoPublish?: {
    enabled: boolean;
    status: string;
    message: string;
    repository?: string;
    onToggle: (enabled: boolean) => void;
    onRetry: () => void;
  };
  lastFetchedAt?: number;
}

export const getGitWorkspace = (cwd: string) =>
  invoke<GitWorkspaceSnapshot>("git_workspace_snapshot", { cwd });

export const changeGitBranch = (
  cwd: string,
  name: string,
  create: boolean,
  expectedHeadOid: string,
  expectedBranch: string,
) => invoke<GitWorkspaceSnapshot>("git_workspace_branch", {
  cwd, name, create, expectedHeadOid, expectedBranch,
});

export const updateLocalGitBase = (
  cwd: string,
  repository: string,
  base: string,
  expectedHeadOid: string,
  expectedBranch: string,
) => invoke<GitWorkspaceSnapshot>("git_workspace_update", {
  cwd, repository, base, expectedHeadOid, expectedBranch,
});

export const fetchGitWorkspace = (cwd: string) =>
  invoke<GitWorkspaceSnapshot>("git_workspace_fetch", { cwd });

export interface GitWorkspaceCommandResult {
  stdout: string;
  stderr: string;
}
export interface GitWorkspaceRevertPreview {
  token: string;
  paths: string[];
  restorePaths: string[];
  preservedPaths: string[];
  headOid: string | null;
  branch: string | null;
}

/** Freeze exact index and working contents before the destructive confirmation. */
export const previewGitWorkspaceRevert = (cwd: string, path: string) =>
  invoke<GitWorkspaceRevertPreview>("git_workspace_revert_preview", { cwd, path });
export const revertGitWorkspace = (cwd: string, path: string, expectedToken: string) =>
  invoke<GitWorkspaceCommandResult>("git_workspace_revert", { cwd, path, expectedToken });
export interface GitWorkspaceRevertAllPreview {
  token: string;
  restorePaths: string[];
  preservedPaths: string[];
  headOid: string;
  branch: string | null;
}
/** Freeze the bulk operation; newly added/untracked contents are preserved. */
export const previewGitWorkspaceRevertAll = (cwd: string) =>
  invoke<GitWorkspaceRevertAllPreview>("git_workspace_revert_all_preview", { cwd });
export const revertGitWorkspaceAll = (cwd: string, expectedToken: string) =>
  invoke<GitWorkspaceCommandResult>("git_workspace_revert_all", { cwd, expectedToken });
export interface GitWorkspaceCommitResult extends GitWorkspaceCommandResult {
  headOid: string;
  branch: string | null;
}

export const commitGitWorkspace = (
  cwd: string,
  message: string,
  stagedOnly: boolean,
  snapshot: GitWorkspaceSnapshot | null,
) => invoke<GitWorkspaceCommitResult>("git_workspace_commit", {
  cwd, message, stagedOnly,
  expectedHeadOid: snapshot?.headOid ?? null,
  expectedBranch: snapshot?.branch ?? null,
});

export const stageGitWorkspace = (
  cwd: string,
  path: string | null,
  unstage: boolean,
  snapshot: GitWorkspaceSnapshot | null,
) => invoke<GitWorkspaceCommandResult>("git_workspace_stage", {
  cwd, path, unstage,
  expectedHeadOid: snapshot?.headOid ?? null,
  expectedBranch: snapshot?.branch ?? null,
});

export const pushGitWorkspace = (
  cwd: string,
  headOid: string,
  branch: string,
  expectedRemoteUrl: string,
  expectedRepository: string,
) => invoke<GitWorkspaceCommandResult>("git_workspace_push", {
  cwd, headOid, branch, expectedRemoteUrl, expectedRepository,
});

/** Fetch and fast-forward under one repository lock, preserving ignored files. */
export const pullGitWorkspace = (
  cwd: string,
  expectedHeadOid: string,
  expectedBranch: string,
  expectedRemoteUrl: string,
  expectedRepository: string,
) => invoke<GitWorkspaceCommandResult>("git_workspace_pull", {
  cwd, expectedHeadOid, expectedBranch, expectedRemoteUrl, expectedRepository,
});
