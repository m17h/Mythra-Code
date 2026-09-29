import type { GitChange, GitChangeArea, ProjectGitChanges } from "./gitInspection";
import type { GitWorkspaceSnapshot } from "./gitWorkspace";

/**
 * Pure helpers for the project's Changes view. They read native Git status
 * rows as they are — one row per path per area — and never infer a filename
 * from diff text.
 */

export const CHANGE_AREAS: GitChangeArea[] = ["staged", "unstaged", "untracked"];

export const CHANGE_AREA_LABELS: Record<GitChangeArea, string> = {
  staged: "Staged",
  unstaged: "Not staged",
  untracked: "New files",
};

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflict",
  "?": "New file",
};

export function changeKey(row: Pick<GitChange, "path" | "area">): string {
  return `${row.area}\0${row.path}`;
}

export function changeStatusLabel(row: Pick<GitChange, "status">): string {
  return STATUS_LABELS[row.status] ?? "Changed";
}

export function splitChangePath(path: string): { name: string; directory: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, directory: "" } : { name: path.slice(index + 1), directory: path.slice(0, index) };
}

export function groupChanges(rows: GitChange[]): Record<GitChangeArea, GitChange[]> {
  const groups: Record<GitChangeArea, GitChange[]> = { staged: [], unstaged: [], untracked: [] };
  for (const row of rows) groups[row.area]?.push(row);
  return groups;
}

/** Paths with a staged version and newer, unstaged edits on top of it. */
export function partiallyStagedPaths(rows: GitChange[]): Set<string> {
  const staged = new Set(rows.filter((row) => row.area === "staged").map((row) => row.path));
  return new Set(rows.filter((row) => row.area === "unstaged" && staged.has(row.path)).map((row) => row.path));
}

export interface CommitPlan {
  /** Files the staged commit would record. */
  staged: number;
  /** Staged files whose newer, unstaged edits stay out of a staged commit. */
  heldBack: number;
  /** Distinct files "Commit all" stages and records. */
  all: number;
  unstaged: number;
  untracked: number;
  /** Staged and all paths, when the native rows were read completely. */
  stagedPaths: string[];
  allPaths: string[];
  /** False when counts come from the summary snapshot or a capped list. */
  exact: boolean;
}

/**
 * Exactly what each commit button includes. "Commit all" runs `git add --all`
 * first, so it takes every staged, unstaged and new file; "Commit staged"
 * takes only the index, leaving newer edits of a partly staged file behind.
 */
export function commitPlan(changes: ProjectGitChanges | null, snapshot: GitWorkspaceSnapshot | null): CommitPlan {
  if (!changes) {
    const staged = snapshot?.stagedFiles ?? 0;
    return {
      staged,
      heldBack: 0,
      all: snapshot?.changedFiles ?? 0,
      unstaged: snapshot?.unstagedFiles ?? 0,
      untracked: 0,
      stagedPaths: snapshot?.stagedPaths ?? [],
      allPaths: [],
      exact: false,
    };
  }
  const groups = groupChanges(changes.rows);
  const allPaths = [...new Set(changes.rows.map((row) => row.path))];
  return {
    staged: changes.stagedFiles,
    heldBack: partiallyStagedPaths(changes.rows).size,
    all: changes.changedFiles,
    unstaged: changes.unstagedFiles,
    untracked: changes.untrackedFiles,
    stagedPaths: groups.staged.map((row) => row.path),
    allPaths,
    exact: !changes.truncated,
  };
}

/**
 * Why a row gets no Discard button. The native revert restores the committed
 * version of a path; for anything that has no committed version that would
 * delete the file, so it is never offered.
 */
export function discardBlockedReason(row: GitChange, rows: GitChange[]): string | null {
  if (row.area === "untracked") return "New files are never deleted here. Remove the file yourself if you no longer want it.";
  if (row.status === "U") return "Resolve this conflict before discarding changes.";
  const added = rows.some((other) => other.path === row.path && other.area === "staged" && (other.status === "A" || other.status === "C"));
  if (added) return "This file has no committed version, so discarding would delete it. Unstage it instead and remove the file yourself if you no longer want it.";
  return null;
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago" — never a bare timestamp. */
export function relativeAge(at: number | string | undefined | null, now = Date.now()): string | null {
  if (at === undefined || at === null || at === "") return null;
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Anchored read time remains truthful while a pane is idle; no timer or IPC. */
export function readTime(at: number | undefined | null): string | null {
  if (at === undefined || at === null || !Number.isFinite(at)) return null;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  return `at ${date.toLocaleString()}`;
}

export function fileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}
