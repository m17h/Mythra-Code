import type { GitChangeArea, ProjectGitChanges, ProjectGitFileDiff, ProjectGitHistory } from "./gitInspection";
import type {
  CreatePullRequestInput,
  CreatePullRequestResult,
  PullRequest,
  PullRequestContext,
  PullRequestListQuery,
  PullRequestMergeMethod,
  PullRequestSummary,
} from "./pullRequests";

/**
 * Contracts the Git workspace receives from its owner. Only types live here,
 * so the panel and its tests never load the native bridge themselves.
 */

export type GitView = "changes" | "pulls" | "history";

/** Where a shortcut or the command palette asks the Git workspace to go. It
 *  only moves focus; nothing here ever runs a Git or GitHub write. */
export type GitFocusTarget = "commit" | "branch" | "fetch" | "pull" | "push" | "conversationPullRequest" | "pullRequestSearch";
export interface GitRoute {
  view: GitView;
  focus?: GitFocusTarget;
  /** Increments for every request, so repeating one still moves focus. */
  nonce: number;
}

/** Bounded native reads that need no AI thread or provider runtime. */
export interface ProjectGitInspection {
  /** The checkout these reads describe. Results are stored under it. */
  cwd: string;
  getChanges: (cwd: string) => Promise<ProjectGitChanges>;
  getFileDiff: (cwd: string, path: string, area: GitChangeArea) => Promise<ProjectGitFileDiff>;
  getHistory: (cwd: string, offset: number, limit: number, headOid: string | null) => Promise<ProjectGitHistory>;
}

/**
 * Project-owned pull request access: browse and inspect without a thread, and
 * create or merge through the same validated native commands and operation
 * leases the conversation workflow uses. Never attaches, never archives.
 */
export interface ProjectPullRequestAccess {
  /** Checkout the create/branch operations act in. */
  cwd: string;
  /** Project root used for reads and GitHub-side operations. */
  projectPath: string;
  /** The origin repository the project is connected to, when known. */
  repository: string | null;
  authenticated: boolean;
  /** True while an AI thread is selected; creating then belongs to it. */
  threadActive: boolean;
  isolated: boolean;
  mutationBlockedReason: string | null;
  checkMutationAllowed: (cwd: string) => string | null;
  list: (cwd: string, repository: string, query: PullRequestListQuery) => Promise<PullRequestSummary[]>;
  view: (cwd: string, repository: string, number: number) => Promise<PullRequest>;
  context: (cwd: string) => Promise<PullRequestContext>;
  find: (cwd: string, repository: string, branch: string) => Promise<PullRequest | null>;
  create: (cwd: string, repository: string, input: CreatePullRequestInput) => Promise<CreatePullRequestResult>;
  merge: (cwd: string, repository: string, number: number, method: PullRequestMergeMethod, expectedHeadOid: string, auto: boolean) => Promise<PullRequest>;
  ready: (cwd: string, repository: string, number: number, expectedHeadOid: string) => Promise<PullRequest>;
  createBranch: (cwd: string, name: string, expectedHeadOid: string) => Promise<void>;
  /** Attach to the selected conversation — thread metadata only. */
  attachToThread?: (url: string) => Promise<void>;
  /** The conversation's attached pull request, if any. */
  threadLink?: { repository: string; number: number } | null;
  onUpdateLocal?: (repository: string, base: string) => Promise<void>;
  onChanged?: (cwd: string) => void;
}
