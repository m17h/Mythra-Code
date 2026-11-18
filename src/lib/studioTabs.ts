/**
 * The Tools dock's surfaces. Kept out of the dock component so the app
 * shell can persist and validate the selected tab without eagerly loading the
 * lazily split dock bundle.
 */
export type StudioTab =
  | "changes"
  | "git"
  | "checkpoints"
  | "worktrees"
  | "files"
  | "terminal"
  | "actions"
  | "agents"
  | "usage"
  | "skills";

/** The rail's three groups, in rail order. */
export type StudioTabGroup = "changes" | "project" | "run";

export const STUDIO_TAB_GROUPS: Array<{ id: StudioTabGroup; label: string; tabs: StudioTab[] }> = [
  { id: "changes", label: "Changes", tabs: ["changes", "git", "checkpoints", "worktrees"] },
  { id: "project", label: "Project", tabs: ["files", "terminal", "actions"] },
  { id: "run", label: "Run", tabs: ["agents", "usage", "skills"] },
];

export const STUDIO_TAB_IDS: StudioTab[] = STUDIO_TAB_GROUPS.flatMap((group) => group.tabs);

/**
 * Ids saved by earlier versions, and where each now lives. "review" became
 * the Changes tab; "tools" split into Actions (workflows and quick actions)
 * and Skills & MCP, and lands on Actions; "context" was the old Files tab.
 */
const LEGACY_STUDIO_TABS: Record<string, StudioTab> = {
  review: "changes",
  tools: "actions",
  context: "files",
};

export function isStudioTab(value: unknown): value is StudioTab {
  return typeof value === "string" && (STUDIO_TAB_IDS as string[]).includes(value);
}

/** A current tab id for any saved or requested value, or null when unknown. */
export function migrateStudioTab(value: unknown): StudioTab | null {
  if (isStudioTab(value)) return value;
  return typeof value === "string" ? LEGACY_STUDIO_TABS[value] ?? null : null;
}

/**
 * Which dock tab shows a Git route. Changes hosts the file list and the
 * commit box; Git hosts the checkout (branch, fetch, pull, push), pull
 * requests and history.
 */
export function studioTabForGitRoute(route: { view: string; focus?: string }): StudioTab {
  return route.view === "changes" && (!route.focus || route.focus === "commit") ? "changes" : "git";
}
