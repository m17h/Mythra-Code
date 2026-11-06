import type { Project, ProjectDefaults, Provider } from "../types";
import { parseEffortSlider, sanitizeChatFont, sanitizeTheme, THEMES } from "./appConfig";
import { modelForProvider } from "./threadProvider";
import { sanitizeProjectPromptProfileOverrides } from "./projectPromptProfiles";

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
  const theme: unknown = raw.theme;
  // A retired palette keeps the project's appearance override on Mythra, its
  // replacement, rather than silently following a different global theme.
  if (theme === "midnight" || theme === "monochrome" || THEMES.some((entry) => entry.id === theme)) {
    defaults.theme = sanitizeTheme(theme);
  }
  const effortSlider = parseEffortSlider(raw.effortSlider);
  if (effortSlider) defaults.effortSlider = effortSlider;
  const chatFont = sanitizeChatFont(raw.chatFont);
  if (raw.chatFont === chatFont) defaults.chatFont = chatFont;
  return defaults;
}

/**
 * Retire the old top-level model/permission overrides while preserving
 * prompts and sub-agent policy, which are configured in their own surfaces.
 */
export function sanitizeProjectDefaultOverrides(projects: Project[]): Project[] {
  return projects.map((project) => {
    if (!project.overrides) return project;
    const overrides = sanitizeProjectPromptProfileOverrides(project.overrides) as Record<string, unknown>;
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
