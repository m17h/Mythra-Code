import { DEFAULT_USAGE_DISPLAY } from "./providerUsage";
import type { AppSettings, ChildAgentSettings, EffortSliderStyle, PromptProfile, ThemeName } from "../types";

/** Cross-provider delegation is off by default; every enabled destination is user-approved. */
export const DEFAULT_CHILD_AGENT_SETTINGS: ChildAgentSettings = { enabled: false, targets: [] };

/** Missing or malformed saved values adopt the safer cleanup default. */
export function sanitizeAutoArchiveSubagentThreads(value: unknown): boolean {
  return value === false ? false : true;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const RELEASE_NOTES_URL = "https://github.com/m17h/Mythra-Code/releases/latest";

export const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  { id: "mythra", name: "Mythra", description: "Deep graphite with luminous cyan", swatches: ["#1e2024", "#292d32", "#64ddf2"] },
  { id: "light-mythra", name: "Light Mythra", description: "Paper white with a deep cyan accent", swatches: ["#f3f6f7", "#ffffff", "#087f9b"] },
  { id: "kiwi", name: "Kiwi", description: "Deep graphite with electric green", swatches: ["#1e2024", "#292d32", "#a7e26f"] },
  { id: "daylight", name: "Light Kiwi", description: "Paper white with a deep leaf green", swatches: ["#f4f5f2", "#ffffff", "#3e8e22"] },
  { id: "midnight", name: "Midnight", description: "Deep ocean blue with arctic ice", swatches: ["#14181f", "#1d232d", "#7fc4ff"] },
  { id: "synthwave", name: "Synthwave", description: "Neon violet with hot magenta", swatches: ["#17131f", "#221b2e", "#ff6ac1"] },
];

/** Stored theme ids may outlive a palette. Retired and malformed values fall
 * back to Mythra instead of leaving the shell with an unstyled data attribute. */
export function sanitizeTheme(value: unknown): ThemeName {
  return THEMES.some((theme) => theme.id === value) ? value as ThemeName : "mythra";
}

export function themeColorScheme(theme: ThemeName): "light" | "dark" {
  return theme === "light-mythra" || theme === "daylight" ? "light" : "dark";
}

export const EFFORT_SLIDER_STYLES: Array<{ id: EffortSliderStyle; name: string; description: string }> = [
  { id: "aurora", name: "Aurora", description: "A slow drift of northern-light pastels" },
  { id: "spectrum", name: "Spectrum", description: "Heat colors per level, sparks, and a burning Max" },
  { id: "classic", name: "Classic", description: "The original quiet accent-colored rail" },
  { id: "neon", name: "Neon", description: "Your model's accent, glowing hotter with effort" },
  { id: "pixel", name: "Pixel", description: "A chunky retro VU meter with a square thumb" },
  { id: "ink", name: "Ink", description: "A bare monochrome line for zero distraction" },
];

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "openai",
  openAiLogo: "openai",
  claudeLogo: "claude",
  cursorLogo: "cube",
  model: DEFAULT_OPENAI_MODEL,
  lmStudioBaseUrl: DEFAULT_LM_STUDIO_BASE_URL,
  permission: "ask",
  systemPrompt: "",
  codexSystemPrompt: "",
  claudeSystemPrompt: "",
  promptProfileId: "",
  projectInstructionsEnabled: false,
  subagentsEnabled: false,
  subagentMax: 3,
  autoArchiveSubagentThreads: true,
  childAgents: DEFAULT_CHILD_AGENT_SETTINGS,
  childAgentPresets: [],
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "mythra",
  effortSlider: "aurora",
  notificationsEnabled: true,
  terminalScrollback: 100_000,
  uiScale: 100,
  usageDisplay: DEFAULT_USAGE_DISPLAY,
};

/** Mythra Code ships no opinions as profiles; every saved profile belongs to the user. */
export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [];
