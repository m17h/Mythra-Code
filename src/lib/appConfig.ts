import { DEFAULT_USAGE_DISPLAY } from "./providerUsage";
import type { AppSettings, ChildAgentSettings, PromptProfile, ThemeName } from "../types";

/** Cross-provider delegation is off by default; every enabled destination is user-approved. */
export const DEFAULT_CHILD_AGENT_SETTINGS: ChildAgentSettings = { enabled: false, targets: [] };

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const RELEASE_NOTES_URL = "https://github.com/m17h/OpenKiwi/releases/latest";

export const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  { id: "kiwi", name: "OpenKiwi", description: "Deep graphite with electric green", swatches: ["#1e2024", "#292d32", "#a7e26f"] },
  { id: "daylight", name: "Daylight", description: "Paper white with a deep leaf green", swatches: ["#f4f5f2", "#ffffff", "#3e8e22"] },
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
  autoArchiveSubagentThreads: false,
  childAgents: DEFAULT_CHILD_AGENT_SETTINGS,
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "kiwi",
  notificationsEnabled: true,
  terminalScrollback: 100_000,
  uiScale: 100,
  usageDisplay: DEFAULT_USAGE_DISPLAY,
};

/** OpenKiwi ships no opinions as profiles; every saved profile belongs to the user. */
export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [];
