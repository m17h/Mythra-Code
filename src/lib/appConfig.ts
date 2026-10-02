import { DEFAULT_USAGE_DISPLAY } from "./providerUsage";
import type { AppSettings, ChatFont, ChildAgentSettings, EffortSliderStyle, PromptProfile, ThemeName } from "../types";

/** Cross-provider delegation is off by default; every enabled destination is user-approved. */
export const DEFAULT_CHILD_AGENT_SETTINGS: ChildAgentSettings = { enabled: false, targets: [] };

/** Keep finished conversations visible unless automatic archiving was explicitly enabled. */
export function sanitizeAutoArchiveSubagentThreads(value: unknown): boolean {
  return value === true;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const RELEASE_NOTES_URL = "https://github.com/m17h/Mythra-Code/releases/latest";

export const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  // Swatches are display-only previews ([canvas, island panel, accent]) and
  // track the Lumen palettes in src/styles/lumen/tokens.css.
  { id: "mythra", name: "Mythra", description: "Deep graphite with luminous cyan", swatches: ["#16181b", "#292d32", "#64ddf2"] },
  { id: "light-mythra", name: "Light Mythra", description: "Paper white with clear sky-cyan accents", swatches: ["#e3e7ea", "#ffffff", "#0068b5"] },
  { id: "kiwi", name: "Kiwi", description: "Deep graphite with electric green", swatches: ["#16181b", "#292d32", "#a6df72"] },
  { id: "daylight", name: "Light Kiwi", description: "Paper white with a deep leaf green", swatches: ["#e4e6e0", "#ffffff", "#3a861d"] },
  { id: "synthwave", name: "Synthwave", description: "Deep graphite with hot neon pink", swatches: ["#16181b", "#292d32", "#ff6ac1"] },
  { id: "atari", name: "Atari", description: "Warm tan with deep brick-red accents", swatches: ["#ddd0b6", "#f7efdf", "#8e3b32"] },
];

/** Stored theme ids may outlive a palette. Retired (Ember, Terminal, Midnight,
 * Monochrome) and malformed values fall back to Mythra instead of leaving the
 * shell with an unstyled data attribute. */
export function sanitizeTheme(value: unknown): ThemeName {
  return THEMES.some((theme) => theme.id === value) ? value as ThemeName : "mythra";
}

export function themeColorScheme(theme: ThemeName): "light" | "dark" {
  return theme === "light-mythra" || theme === "daylight" || theme === "atari" ? "light" : "dark";
}

export const EFFORT_SLIDER_STYLES: Array<{ id: EffortSliderStyle; name: string; description: string }> = [
  { id: "aurora", name: "Aurora", description: "A slow drift of northern-light pastels" },
  { id: "astra", name: "Astra", description: "A living nebula with gentle starlight" },
  { id: "spectrum", name: "Spectrum", description: "Heat colors per level, sparks, and a burning Max" },
  { id: "classic", name: "Classic", description: "The original quiet accent-colored rail" },
  { id: "neon", name: "Neon", description: "Your model's accent, glowing hotter with effort" },
  { id: "pixel", name: "Pixel", description: "A chunky retro VU meter with a square thumb" },
  { id: "ink", name: "Ink", description: "A bare monochrome line for zero distraction" },
  { id: "reactor", name: "Reactor", description: "Pulsing energy cells and a glowing reactor core" },
  { id: "comet", name: "Comet", description: "A soft ice-blue trail that streams toward the thumb" },
  { id: "coil", name: "Coil", description: "A twisted cord that winds tighter the harder it works" },
];

/** Settings written before the font selector have no value at all; anything
 * unrecognised falls back to the interface default rather than an unstyled
 * shell attribute. */
export function sanitizeChatFont(value: unknown): ChatFont {
  return value === "humanist" || value === "serif" || value === "mono" ? value : "system";
}

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
  autoArchiveSubagentThreads: false,
  childAgents: DEFAULT_CHILD_AGENT_SETTINGS,
  childAgentPresets: [],
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "mythra",
  effortSlider: "aurora",
  chatFont: "system",
  notificationsEnabled: true,
  automaticThreadTitles: false,
  threadTitleProvider: "openai",
  threadTitleModel: "",
  terminalScrollback: 100_000,
  uiScale: 100,
  usageDisplay: DEFAULT_USAGE_DISPLAY,
};

/** Retired slider ids migrate to their direct replacement; malformed values
 * still fall back to the default instead of leaving the shell unstyled. */
export function sanitizeEffortSlider(value: unknown): EffortSliderStyle {
  if (value === "shard" || value === "tide") return "reactor";
  if (value === "dart" || value === "filament") return "comet";
  return EFFORT_SLIDER_STYLES.some((style) => style.id === value)
    ? value as EffortSliderStyle
    : DEFAULT_SETTINGS.effortSlider;
}

/** Mythra Code ships no opinions as profiles; every saved profile belongs to the user. */
export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [];
