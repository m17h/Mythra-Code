import { createContext } from "react";

/**
 * The folder the open thread runs in (its worktree when it has one), so the
 * transcript can show changed files project-relative, like the Tools panel dock.
 * Empty for Chats and when unknown: paths are then shown as they came.
 */
export const TimelineProjectRoot = createContext("");

/** `path` relative to `root` when it lies inside it; otherwise unchanged. */
export function projectRelativePath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  if (!base) return path;
  const normalized = path.replace(/\\/g, "/");
  const normalizedBase = base.replace(/\\/g, "/");
  if (normalized === normalizedBase) return path;
  return normalized.startsWith(`${normalizedBase}/`) ? normalized.slice(normalizedBase.length + 1) : path;
}
