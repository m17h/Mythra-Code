import type { AppSettings, PromptProfile, ThemeName } from "../types";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const RELEASE_NOTES_URL = "https://github.com/m17h/OpenKiwi/releases/latest";

export const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  { id: "kiwi", name: "OpenKiwi", description: "Deep graphite with electric green", swatches: ["#1e2024", "#292d32", "#a7e26f"] },
  { id: "daylight", name: "Daylight", description: "Paper white with a deep leaf green", swatches: ["#f4f5f2", "#ffffff", "#3e8e22"] },
];

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "openai",
  openAiLogo: "openai",
  claudeLogo: "claude",
  model: DEFAULT_OPENAI_MODEL,
  permission: "ask",
  systemPrompt: "",
  promptProfileId: "empty",
  projectInstructionsEnabled: false,
  subagentsEnabled: false,
  subagentMax: 3,
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "kiwi",
  notificationsEnabled: true,
  terminalScrollback: 100_000,
  uiScale: 100,
};

export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [
  { id: "empty", name: "Empty", prompt: "", builtIn: true },
  { id: "concise", name: "Concise builder", prompt: "Be concise, make progress autonomously, verify important changes, and clearly report results.", builtIn: true },
  { id: "reviewer", name: "Careful reviewer", prompt: "Prioritize correctness, security, and maintainability. Inspect evidence before conclusions and flag uncertainty explicitly.", builtIn: true },
];
