import type { Project } from "../types";

export type ProjectDropPosition = "before" | "after";

function sameOrder(a: Project[], b: Project[]): boolean {
  return a.length === b.length && a.every((project, index) => project === b[index]);
}

/**
 * The one invariant the sidebar order has to hold: every pinned project sits
 * above every unpinned one.
 *
 * Pinning is only worth anything if it survives the next drag, so the rule
 * lives here rather than in the drop handler — a hand-edited store, a list
 * saved before this rule existed, or a project pinned from anywhere in the app
 * all come back sorted. The partition is stable, so the order the user chose
 * inside each group is left exactly as it was, and pinning or unpinning moves
 * a project only as far as the boundary between the two groups.
 */
export function sortProjectsByPin(projects: Project[]): Project[] {
  const sorted = [
    ...projects.filter((project) => project.pinned),
    ...projects.filter((project) => !project.pinned),
  ];
  return sameOrder(sorted, projects) ? projects : sorted;
}

/**
 * Moves one project next to another, clamped to the group it belongs to.
 *
 * Dropping an unpinned project into the pinned block lands it at the top of
 * the unpinned block instead — the nearest position the drag can legally
 * reach. Pin state is a deliberate choice made from the row menu, so a drag
 * never changes it by accident, and the drop is never silently discarded
 * either.
 */
export function reorderProjects(
  projects: Project[],
  sourceId: string,
  targetId: string,
  position: ProjectDropPosition,
): Project[] {
  if (sourceId === targetId) return projects;
  const ordered = sortProjectsByPin(projects);
  const source = ordered.find((project) => project.id === sourceId);
  if (!source || !ordered.some((project) => project.id === targetId)) return projects;

  const remaining = ordered.filter((project) => project.id !== sourceId);
  const targetIndex = remaining.findIndex((project) => project.id === targetId);
  const pinnedCount = remaining.filter((project) => project.pinned).length;
  const requested = targetIndex + (position === "after" ? 1 : 0);
  const insertionIndex = source.pinned
    ? Math.min(requested, pinnedCount)
    : Math.max(requested, pinnedCount);

  const next = [
    ...remaining.slice(0, insertionIndex),
    source,
    ...remaining.slice(insertionIndex),
  ];
  return sameOrder(next, projects) ? projects : next;
}

/** Flips one project's pin, keeping the pinned-first order intact. */
export function toggleProjectPinned(projects: Project[], projectId: string): Project[] {
  if (!projects.some((project) => project.id === projectId)) return projects;
  return sortProjectsByPin(projects.map((project) => (
    project.id === projectId ? { ...project, pinned: !project.pinned } : project
  )));
}
