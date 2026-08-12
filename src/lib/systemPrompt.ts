import type { ProjectPromptMode, Provider } from "../types";

function joinPromptLayers(...layers: Array<string | undefined>): string {
  return layers.map((layer) => layer?.trim() ?? "").filter(Boolean).join("\n\n");
}

/** Global instructions always precede the selected subscription's own layer. */
export function resolveProviderSystemPrompt(
  globalPrompt: string,
  provider: Provider,
  codexPrompt = "",
  claudePrompt = "",
): string {
  const providerPrompt = provider === "openai"
    ? codexPrompt
    : provider === "claude"
      ? claudePrompt
      : "";
  return joinPromptLayers(globalPrompt, providerPrompt);
}

export function resolveSystemPrompt(
  appPrompt: string,
  projectPrompt?: string,
  mode: ProjectPromptMode = "replace",
): string {
  const app = appPrompt.trim();
  const project = projectPrompt?.trim() ?? "";
  if (!project) return app;
  if (mode === "append" && app) return joinPromptLayers(app, project);
  return project;
}
