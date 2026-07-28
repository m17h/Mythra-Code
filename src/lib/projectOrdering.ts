import type { Project } from "../types";

export type ProjectDropPosition = "before" | "after";

export function reorderProjects(
  projects: Project[],
  sourceId: string,
  targetId: string,
  position: ProjectDropPosition,
): Project[] {
  if (sourceId === targetId) return projects;
  const source = projects.find((project) => project.id === sourceId);
  if (!source || !projects.some((project) => project.id === targetId)) return projects;

  const remaining = projects.filter((project) => project.id !== sourceId);
  const targetIndex = remaining.findIndex((project) => project.id === targetId);
  const insertionIndex = targetIndex + (position === "after" ? 1 : 0);
  return [
    ...remaining.slice(0, insertionIndex),
    source,
    ...remaining.slice(insertionIndex),
  ];
}
