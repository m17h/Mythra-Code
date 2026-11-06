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
export type ProjectNavigationOperation = "folders.browse" | "projects.add";
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
export type ProjectNavigationResult = FoldersBrowseResult | ProjectsAddResult;
