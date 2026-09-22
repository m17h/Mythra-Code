import { invoke } from "@tauri-apps/api/core";

export interface GitPublishBinding {
  repository: string;
  remote: string;
  remoteUrl: string;
  commonDir: string;
}

export interface GitPublishBranch {
  name: string;
  headOid: string;
  remoteBranch: string;
  checkedOut: boolean;
}

export interface GitPublishSnapshot {
  binding: GitPublishBinding;
  branches: GitPublishBranch[];
}

export interface GitAutoPublishBranch {
  observedOid: string;
  publishedOid?: string;
  remoteBranch: string;
  pendingOid?: string;
  paused?: string;
}

export interface GitAutoPublishProject {
  enabled: boolean;
  binding: GitPublishBinding;
  branches: Record<string, GitAutoPublishBranch>;
  status: "idle" | "publishing" | "waiting" | "paused";
  message: string;
  updatedAt: number;
  retryAt?: number;
}

export function getGitPublishSnapshot(cwd: string): Promise<GitPublishSnapshot> {
  return invoke<GitPublishSnapshot>("git_publish_snapshot", { cwd });
}

export function publishGitCommit(
  cwd: string,
  binding: GitPublishBinding,
  branch: string,
  headOid: string,
  remoteBranch: string,
  lastPublishedOid?: string,
  expectedRemoteOid?: string,
): Promise<{ publishedOid: string }> {
  return invoke("git_publish_commit", {
    cwd,
    binding,
    branch,
    headOid,
    remoteBranch,
    lastPublishedOid,
    expectedRemoteOid,
  });
}
