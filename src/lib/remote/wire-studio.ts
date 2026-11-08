/** Phase 4 read-only Studio shapes. No native paths, Git arguments or local errors. */
import type { RemoteWireError } from "./wire";

export type StudioOperation = "files.list" | "files.preview" | "git.status" | "git.diff";
/** threadId selects the host-resolved execution checkout, never a viewer cwd. */
export interface StudioTarget { workspaceId: string; threadId?: string }
export interface FilesListArgs extends StudioTarget { parentId?: string; cursor?: string; limit?: number }
export interface FilePreviewArgs extends StudioTarget { fileId: string }
export interface GitStatusArgs extends StudioTarget { limit?: number }
export interface GitDiffArgs extends StudioTarget { changeId: string }
export type StudioFileKind = "file" | "directory";
export interface WireFileEntry {
  id: string; name: string;
  /** Display only; relative to the host-selected checkout. Not accepted as input. */
  path: string; kind: StudioFileKind; size?: number;
}
export interface FilesListResult { entries: WireFileEntry[]; cursor?: string; truncated: boolean }
export interface FilePreviewResult { fileId: string; path: string; text: string; binary: boolean; truncated: boolean }
export type StudioGitArea = "staged" | "unstaged" | "untracked";
export interface WireGitChange { id: string; path: string; originalPath: string | null; area: StudioGitArea; status: string }
export interface GitStatusResult {
  changes: WireGitChange[];
  stagedFiles: number; unstagedFiles: number; untrackedFiles: number; changedFiles: number;
  truncated: boolean;
}
export interface GitDiffResult { changeId: string; path: string; area: StudioGitArea; text: string; binary: boolean; truncated: boolean }
export type StudioResult = FilesListResult | FilePreviewResult | GitStatusResult | GitDiffResult;
/** Merge StudioResult into HostResponse.result when wiring the dispatcher. */
export interface StudioHostResponse {
  generation: number; requestId: string; result?: StudioResult | ProjectNavigationResult; error?: RemoteWireError;
}
export const STUDIO_MAX_ROWS = 200;
export const STUDIO_RESULT_BYTES = 256 * 1024;
export const STUDIO_TEXT_BYTES = 128 * 1024;

// Phase 4 project navigation. This handle namespace cannot select file contents.
export type ProjectNavigationOperation = "folders.browse" | "projects.add" | "projects.clone" | "projects.clone.status";
export interface ProjectCloneResult { opId: string; state: "accepted" | "uncertain"; processHandle?: string; name?: string }
export interface ProjectCloneStatus { state: "running" | "completed" | "failed" | "timedOut" }
export interface FoldersBrowseArgs { folderId?: string; cursor?: string; limit?: number }
export interface ProjectsAddArgs { folderId: string; opId: string; opSeq: number }
export interface WireFolder { id: string; name: string; canAdd: boolean }
export interface FoldersBrowseResult {
  folder: WireFolder | null; parent: WireFolder | null;
  folders: WireFolder[]; cursor?: string; truncated: boolean;
}
export interface ProjectsAddResult {
  opId: string; state: "accepted" | "uncertain";
  workspace?: { id: string; name: string; isChat: false };
}
export type ProjectNavigationResult = FoldersBrowseResult | ProjectsAddResult | ProjectCloneResult | ProjectCloneStatus;

/** Studio reads beyond files and status. Replies never carry a native path
 * except the worktree's own, which is what Copy path copies. */
export type StudioReadOperation = "checkpoint.list" | "checkpoint.diff" | "worktree.status" | "git.log" | "git.revert.preview" | "agents.list" | "attachment.image" | "preview.links";
export interface WireCheckpoint {
  id: string; threadId: string; label: string; createdAt: number; completedAt?: number;
  status?: string; accepted?: boolean; threadLabel?: string; provider?: string; model?: string; branch?: string; head?: string;
  parentId?: string; parentPosition?: "before" | "after"; restoredFromId?: string; overlappingRun?: boolean;
  fileCount?: number; changedFiles?: number; additions?: number; deletions?: number;
  /** Whether each saved side can be restored. The commits themselves stay on the host. */
  restorable: { before: boolean; after: boolean };
}
export interface CheckpointListResult { checkpoints: WireCheckpoint[]; head?: { checkpointId: string; position: "before" | "after" }; truncated: boolean }
export interface CheckpointDiffResult { checkpointId: string; text: string; truncated: boolean }
export interface WireWorktree {
  threadId: string; path: string; branch: string; baseCommit: string; status: string; createdAt: number;
  lastAppliedAt?: number; mergedAt?: number; removedAt?: number; recreatedFromMissing?: boolean;
}
export interface WireWorktreeStatus {
  headOid: string | null; sourceBranch: string | null; exists: boolean; registered: boolean; branch: string | null; baseCommit: string | null;
  changedFiles: number; untrackedFiles: number; ignoredFileCount: number; ahead: number; behind: number; clean: boolean;
}
export interface WorktreeStatusResult { worktree: WireWorktree | null; status: WireWorktreeStatus | null }
export interface WireGitCommit { oid: string; shortOid: string; subject: string; authorName: string; authoredAt: string }
export interface GitLogResult { repository: boolean; entries: WireGitCommit[]; hasMore: boolean; nextOffset: number; headOid: string | null; truncated: boolean }
export interface RevertPreviewResult { previewId: string; restorePaths: string[]; preservedPaths: string[]; truncated: boolean }
export interface WireAgent {
  id: string; prompt: string; status: string; provider?: string; model?: string; runtime?: "codex" | "claude"; createdAt?: number;
  canOpen?: boolean; canStop?: boolean; task?: string; progress?: string; result?: string;
}
export interface AgentsListResult { agents: WireAgent[]; truncated: boolean }
export interface AttachmentImageResult { tooLarge?: boolean; mime?: string; size?: number; data?: string; done?: boolean }
/** Web apps a thread has named on the host. The port is what its links already show. */
export interface WirePreviewLink { endpointId: string; name: string; port: number }
export interface PreviewLinksResult { previews: WirePreviewLink[]; truncated: boolean }

export type WirePullRequest = import("../pullRequests").PullRequest;
export type WirePullRequestSummary = import("../pullRequests").PullRequestSummary;
export type WirePullRequestContext = import("../pullRequests").PullRequestContext;
export interface WirePullRequestComment { id: string; author: string; body: string; url: string; createdAt: string; updatedAt: string }
export interface WireGitHubAccess {
  authenticated: boolean; repository: string | null; isolated: boolean; context: WirePullRequestContext | null;
  /** The checkout's branch and its tracked branch. */
  branch: string | null; upstream: string | null; ahead: number; behind: number;
  /** Whether the host can archive a thread for this device yet. */
  canArchive: boolean;
  /** The pull request saved with this thread on the host. */
  savedLink: { repository: string; number: number } | null;
}
export interface WireCiStatus { checks: WirePullRequest["checks"]; headOid: string; mergeStateStatus: string }

/** Host paths here are display/copy metadata only, NEVER inputs to file reads. */
export interface WireExecutionHeader {
  projectName: string; projectPath: string; executionPath: string; branch: string | null;
  checkout: "main" | "worktree"; worktreeStatus: string | null; exists: boolean;
}
export interface WireAttachmentMetadata { index: number; name: string; kind: "image" | "file"; originalHostPath?: string }
export interface WireHostQuota {
  provider: import("./wire").WireProvider; label: string; summary: string; planLabel?: string; updatedAt?: number;
  /** All windows, with stable display labels; selection stays on the viewer. */
  windows: { label: string; usedPercent: number; resetsAt: number | null; resetLabel: string }[];
}
export interface WireHostProcessPolicy {
  readOnly: boolean; readOnlyReason: string | null;
  terminalBusy: boolean; checksBusy: boolean; repositoryBusy: boolean;
  runBlockedReason: string | null; checksBlockedReason: string | null; processPolicyReason: string | null;
  /** null means no deadline. These describe remote dispatch, not viewer settings. */
  terminalTimeoutMs: number | null; runTimeoutMs: number | null; checksTimeoutMs: number;
  configuredTerminalTimeoutMinutes: number;
}
export type RepositoryWriteAction = { action: "attachRemote"; url: string } | { action: "createRepository"; name: string; visibility: "private" | "public" };
export interface RepositoryWriteResult {
  opId: string; state: "accepted" | "rejected"; workspaceId?: string; threadId?: string;
  repository?: { url: string; remoteUrl?: string; repository: string | null; attached?: boolean; message?: string };
  error?: { code: string; message: string };
}
/** Additive same-app public fields, without changing the base wire contract. */
declare module "./wire" {
  interface HostContextResult { header?: WireExecutionHeader; quotas?: WireHostQuota[]; processPolicy?: WireHostProcessPolicy }
  interface WireMessage { attachmentMetadata?: WireAttachmentMetadata[] }
  interface RemoteWorkResult { originalHostPath?: string }
}
