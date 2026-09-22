import { invoke } from "@tauri-apps/api/core";

export type PullRequestMergeMethod = "squash" | "merge" | "rebase";
export interface PullRequestContext {
  repository: string;
  branch: string;
  defaultBranch: string;
  headOid: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  pushRemote: string;
  permission: string;
  mergeMethods: PullRequestMergeMethod[];
  changedFiles?: string[];
  changedFileCount?: number;
  commits?: string[];
}
export interface PullRequest {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headOid: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  checks: { name: string; state: string; url: string }[];
  updatedAt: string;
  canMerge: boolean;
  viewerCanMerge?: boolean;
  autoMergeAllowed?: boolean;
  mergeMethods: PullRequestMergeMethod[];
}
export type CreatePullRequestResult = PullRequest & { creationOutcome: "created" | "existing" | "updated" };

export interface ThreadPullRequestLink {
  repository: string;
  number: number;
  url: string;
  attachedAt: number;
  snapshot: PullRequest;
}
export interface CreatePullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  commitAll: boolean;
  commitMessage?: string;
  expectedHeadOid: string;
}
export interface PullRequestPanelProps {
  threadId: string | null;
  context: PullRequestContext | null;
  pullRequest: PullRequest | null;
  linked: boolean;
  isolated: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  mutationBlockedReason: string | null;
  onRefresh: () => void;
  onAttach: (reference: string) => Promise<void>;
  onDetach: () => void;
  onCreate: (input: CreatePullRequestInput) => Promise<void>;
  onMerge: (method: PullRequestMergeMethod, auto: boolean) => Promise<void>;
  onReady?: () => Promise<void>;
  onUpdateLocal?: () => Promise<void>;
  updateLocalBusy?: boolean;
  updateLocalNotice?: string;
  onCreateBranch: (name: string) => Promise<void>;
  onOpenWorktrees: () => void;
  onOpenGitHubSettings: () => void;
}

export function parsePullRequestReference(input: string, repository?: string): { repository: string; number: number } | null {
  const value = input.trim();
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/.exec(value);
  const numeric = /^#?([1-9]\d*)$/.exec(value);
  const repo = match?.[1] ?? (numeric ? repository : undefined);
  const number = Number(match?.[2] ?? numeric?.[1]);
  const validRepository = repo && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)
    && ![".", ".."].includes(repo.split("/")[1]);
  return validRepository && Number.isSafeInteger(number) ? { repository: repo, number } : null;
}

export const getPullRequestContext = (cwd: string) => invoke<PullRequestContext>("github_pr_context", { cwd });
export const getPullRequest = (cwd: string, repository: string, number: number) => invoke<PullRequest>("github_pr_view", { cwd, repository, number });
export const findPullRequest = (cwd: string, repository: string, branch: string) => invoke<PullRequest | null>("github_pr_find", { cwd, repository, branch });
export const createPullRequest = (cwd: string, repository: string, input: CreatePullRequestInput) => invoke<CreatePullRequestResult>("github_pr_create", { cwd, repository, ...input });
export const mergePullRequest = (cwd: string, repository: string, number: number, method: PullRequestMergeMethod, expectedHeadOid: string, auto: boolean) => invoke<PullRequest>("github_pr_merge", { cwd, repository, number, method, expectedHeadOid, auto });
export const createPullRequestBranch = (cwd: string, name: string, expectedHeadOid: string) => invoke<void>("github_pr_branch", { cwd, name, expectedHeadOid });
export const markPullRequestReady = (cwd: string, repository: string, number: number, expectedHeadOid: string) => invoke<PullRequest>("github_pr_ready", { cwd, repository, number, expectedHeadOid });
