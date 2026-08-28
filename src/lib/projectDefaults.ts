import type { Project, ProjectDefaults, Provider } from "../types";
import { EFFORT_SLIDER_STYLES, THEMES } from "./appConfig";
import { modelForProvider } from "./threadProvider";

const PROJECT_DEFAULT_PROVIDERS: Provider[] = ["openai", "claude", "cursor", "openrouter", "lmstudio"];

/**
 * Project defaults are persisted user input. Validate them before they can
 * influence provider routing or shell data attributes.
 */
export function sanitizeProjectDefaults(value: unknown): ProjectDefaults | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<ProjectDefaults>;
  if (!PROJECT_DEFAULT_PROVIDERS.includes(raw.provider as Provider)) return null;
  const provider = raw.provider as Provider;
  const model = modelForProvider(provider, typeof raw.model === "string" ? raw.model : "");
  if (!model) return null;

  const defaults: ProjectDefaults = { provider, model };
  if (THEMES.some((theme) => theme.id === raw.theme)) defaults.theme = raw.theme;
  if (EFFORT_SLIDER_STYLES.some((style) => style.id === raw.effortSlider)) defaults.effortSlider = raw.effortSlider;
  return defaults;
}

/**
 * Retire the old top-level model/permission overrides while preserving
 * prompts and sub-agent policy, which are configured in their own surfaces.
 */
export function sanitizeProjectDefaultOverrides(projects: Project[]): Project[] {
  return projects.map((project) => {
    if (!project.overrides) return project;
    const overrides = { ...project.overrides } as Record<string, unknown>;
    delete overrides.model;
    delete overrides.permission;
    const defaults = sanitizeProjectDefaults(overrides.defaults);
    if (defaults) overrides.defaults = defaults;
    else delete overrides.defaults;
    return {
      ...project,
      overrides: Object.keys(overrides).length ? overrides as Project["overrides"] : undefined,
    };
  });
}
