import { invoke } from "@tauri-apps/api/core";

export interface GitWorkspaceBranch {
  name: string;
  current: boolean;
  worktreePath: string | null;
}

export interface GitWorkspaceSnapshot {
  branch: string | null;
  headOid: string | null;
  branches: GitWorkspaceBranch[];
  stagedFiles: number;
  unstagedFiles: number;
  changedFiles: number;
  stagedPaths: string[];
  rootPath: string;
}

export interface GitWorkflowControls {
  snapshot: GitWorkspaceSnapshot | null;
  busy: boolean;
  error?: string;
  notice?: string;
  isolated: boolean;
  branchNotice?: string;
  onBranch: (name: string, create: boolean) => Promise<boolean | void>;
  onRefresh: () => void;
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
