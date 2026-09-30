import { invoke } from "@tauri-apps/api/core";
import type { ReviewDiff } from "./gitDiff";

export type GitChangeArea = "staged" | "unstaged" | "untracked";

export interface GitChange {
  /** Exact repository-relative filename, never recovered from a diff header. */
  path: string;
  originalPath: string | null;
  area: GitChangeArea;
  status: string;
}

export interface ProjectGitChanges {
  rootPath: string;
  rows: GitChange[];
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  changedFiles: number;
  /** Counts are lower bounds if native status output itself was capped. */
  truncated: boolean;
}

export interface ProjectGitFileDiff {
  path: string;
  area: GitChangeArea;
  text: string;
  binary: boolean;
  truncated: boolean;
}

export interface ProjectGitCommit {
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

export interface ProjectGitHistory {
  entries: ProjectGitCommit[];
  hasMore: boolean;
  nextOffset: number;
  headOid: string | null;
  truncated: boolean;
}

/** Native project inspection works without any AI thread or provider runtime. */
export const getProjectGitDiff = (cwd: string) =>
  invoke<ReviewDiff & { truncated: boolean }>("git_project_diff", { cwd });

export const getProjectGitChanges = (cwd: string, limit = 500) =>
  invoke<ProjectGitChanges>("git_project_changes", { cwd, limit });

export const getProjectGitFileDiff = (cwd: string, path: string, area: GitChangeArea) =>
  invoke<ProjectGitFileDiff>("git_project_file_diff", { cwd, path, area });

/** Pass the first page's headOid to keep later pages on the same history. */
export const getProjectGitHistory = (cwd: string, offset = 0, limit = 30, headOid: string | null = null) =>
  invoke<ProjectGitHistory>("git_project_history", { cwd, offset, limit, headOid });
