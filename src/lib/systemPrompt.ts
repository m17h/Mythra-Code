import type { ProjectPromptMode } from "../types";

export function resolveSystemPrompt(
  appPrompt: string,
  projectPrompt?: string,
  mode: ProjectPromptMode = "replace",
): string {
  const app = appPrompt.trim();
  const project = projectPrompt?.trim() ?? "";
  if (!project) return app;
  if (mode === "append" && app) return `${app}\n\n${project}`;
  return project;
}
