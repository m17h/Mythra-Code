/**
 * The Workspace dock's surfaces. Kept out of the dock component so the app
 * shell can persist and validate the selected tab without eagerly loading the
 * lazily split dock bundle.
 */
export type StudioTab =
  | "files"
  | "review"
  | "agents"
  | "terminal"
  | "checkpoints"
  | "worktrees"
  | "context"
  | "usage"
  | "tools"
  | "git";

export const STUDIO_TAB_IDS: StudioTab[] = [
  "files",
  "review",
  "agents",
  "terminal",
  "checkpoints",
  "worktrees",
  "context",
  "usage",
  "tools",
  "git",
];

export function isStudioTab(value: unknown): value is StudioTab {
  return typeof value === "string" && (STUDIO_TAB_IDS as string[]).includes(value);
}
