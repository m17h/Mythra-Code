import { DEFAULT_USAGE_DISPLAY } from "./providerUsage";
import type { AppSettings, ChatFont, ChildAgentSettings, EffortSliderStyle, PromptProfile, ThemeName } from "../types";

/** Cross-provider delegation is off by default; every enabled destination is user-approved. */
export const DEFAULT_CHILD_AGENT_SETTINGS: ChildAgentSettings = { enabled: false, targets: [] };

export const DEFAULT_TERMINAL_TIMEOUT_MINUTES = 5;
/** Keep conversion to protocol milliseconds exact. */
export const MAX_TERMINAL_TIMEOUT_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

/** Only an explicit zero/null disables the deadline; malformed old settings retain the default. */
export function sanitizeTerminalTimeoutMinutes(value: unknown): number {
  if (value === null || value === 0) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_TIMEOUT_MINUTES
    ? value : DEFAULT_TERMINAL_TIMEOUT_MINUTES;
}

/** Automatic parent follow-ups per authorization. Existing settings keep the original eight. */
export const DEFAULT_PARENT_FOLLOW_UP_LIMIT = 8;
export const MAX_PARENT_FOLLOW_UP_LIMIT = 1_000;

/**
 * A whole number of automatic parent follow-ups, or null for no count limit.
 * Only an explicit null is unlimited; missing or malformed values keep the default.
 */
export function sanitizeParentFollowUpLimit(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PARENT_FOLLOW_UP_LIMIT
    ? value : DEFAULT_PARENT_FOLLOW_UP_LIMIT;
}

/** Keep finished conversations visible unless automatic archiving was explicitly enabled. */
export function sanitizeAutoArchiveSubagentThreads(value: unknown): boolean {
  return value === true;
}

/** Escape cannot stop work unless the saved setting explicitly enables it. */
export function sanitizeEscapeStopsRun(value: unknown): boolean {
  return value === true;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const RELEASE_NOTES_URL = "https://github.com/m17h/Mythra-Code/releases/latest";

export const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  // Swatches are display-only previews ([window, surface, accent]) and track
  // the Pro palettes in src/styles/lumen/tokens.css.
  { id: "mythra", name: "Mythra", description: "Deep graphite with luminous cyan", swatches: ["#212226", "#313237", "#64ddf2"] },
  { id: "light-mythra", name: "Light Mythra", description: "Paper white with clear sky-cyan accents", swatches: ["#e7e8eb", "#ffffff", "#0a95d4"] },
  { id: "kiwi", name: "Kiwi", description: "Deep graphite with electric green", swatches: ["#212226", "#313237", "#a6df72"] },
  { id: "daylight", name: "Light Kiwi", description: "Paper white with a deep leaf green", swatches: ["#e5e9e1", "#ffffff", "#3a861d"] },
  { id: "synthwave", name: "Synthwave", description: "Deep graphite with hot neon pink", swatches: ["#212226", "#313237", "#ff6ac1"] },
  { id: "atari", name: "Atari", description: "Warm tan with deep brick-red accents", swatches: ["#e2d3b7", "#fbf5e9", "#8e3b32"] },
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
  { id: "studio", name: "Studio", description: "Simple dots in the active provider's color" },
  { id: "aurora", name: "Aurora", description: "A slow drift of northern-light pastels" },
  { id: "astra", name: "Astra", description: "A living nebula with gentle starlight" },
  { id: "pixel", name: "Pixel", description: "A chunky retro VU meter with a square thumb" },
  { id: "ink", name: "Ink", description: "A bare monochrome line for zero distraction" },
  { id: "reactor", name: "Reactor", description: "Pulsing energy cells and a glowing reactor core" },
  { id: "comet", name: "Comet", description: "A soft ice-blue trail that streams toward the thumb" },
  { id: "coil", name: "Coil", description: "A twisted cord that winds tighter the harder it works" },
  { id: "poet", name: "Poet", description: "Pixel art in honor of Claude Code" },
];

/** Settings written before the font selector have no value at all; anything
 * unrecognised falls back to the interface default rather than an unstyled
 * shell attribute. */
export function sanitizeChatFont(value: unknown): ChatFont {
  if (value === "humanist" || value === "serif" || value === "mono" || value === "pixelify" || value === "vt323") return value;
  // Custom fonts resolve against the per-device library at render time; a
  // missing one falls back to the interface font (customFonts.ts).
  if (typeof value === "string" && /^custom:[a-z0-9-]{1,64}$/.test(value)) return value as ChatFont;
  return "system";
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
  projectClaudeInstructionsEnabled: false,
  subagentsEnabled: false,
  subagentMax: 3,
  managedSubagentV2: false,
  autoArchiveSubagentThreads: false,
  parentFollowUpLimit: DEFAULT_PARENT_FOLLOW_UP_LIMIT,
  childAgents: DEFAULT_CHILD_AGENT_SETTINGS,
  childAgentPresets: [],
  subagentModelGuidance: [],
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "mythra",
  effortSlider: "studio",
  chatFont: "system",
  escapeStopsRun: false,
  warnOnMaxReasoning: true,
  notificationsEnabled: true,
  automaticGitInitialization: false,
  automaticThreadTitles: false,
  threadTitleProvider: "openai",
  threadTitleModel: "",
  terminalScrollback: 100_000,
  terminalTimeoutMinutes: DEFAULT_TERMINAL_TIMEOUT_MINUTES,
  uiScale: 100,
  usageDisplay: DEFAULT_USAGE_DISPLAY,
};

/** Resolve slider ids accepted by both global settings and project overrides. */
export function parseEffortSlider(value: unknown): EffortSliderStyle | undefined {
  if (value === "spectrum" || value === "classic" || value === "neon") return "studio";
  if (value === "dart" || value === "filament") return "comet";
  return EFFORT_SLIDER_STYLES.find((style) => style.id === value)?.id;
}

/** Global settings need a slider even when the stored value is unknown. */
export function sanitizeEffortSlider(value: unknown): EffortSliderStyle {
  if (value === "shard" || value === "tide") return "reactor";
  return parseEffortSlider(value) ?? DEFAULT_SETTINGS.effortSlider;
}

/** Mythra Code ships no opinions as profiles; every saved profile belongs to the user. */
export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [];
