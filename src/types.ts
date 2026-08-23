import type { ReasoningEffort } from "./components/ModelPowerControl";
import type { JsonObject } from "./lib/codex";

export type Provider = "openai" | "openrouter" | "lmstudio" | "claude" | "cursor";
export type OpenAILogoStyle = "openai" | "codex";
export type ClaudeLogoStyle = "claude" | "anthropic";
export type CursorLogoStyle = "cube" | "app-dark";
export type PermissionMode = "read-only" | "ask" | "full";
export type ThemeName = "kiwi" | "daylight";
export type WorkspaceMode = "chat" | "project";
export type SettingsSection = "general" | "models" | "github" | "usage" | "prompts" | "agents" | "workflows" | "projects" | "skills" | "tools" | "updates";
export type ProjectPromptMode = "replace" | "append";

export interface ProjectOverrides {
  model?: string;
  permission?: PermissionMode;
  systemPrompt?: string;
  /** Existing projects default to replace; append layers app instructions first. */
  systemPromptMode?: ProjectPromptMode;
  /** Complete project-local delegation settings; absent means inherit global. */
  subagents?: ProjectSubagentSettings;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  pinned?: boolean;
  isChat?: boolean;
  worktree?: { source: string; branch: string };
  /** Per-project settings; unset fields inherit the global settings. */
  overrides?: ProjectOverrides;
}

export interface Thread {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  modelProvider: string;
  turns?: Turn[];
  /** Codex app-server metadata for provider-native collaboration children. */
  parentThreadId?: string | null;
  threadSource?: string;
  agentNickname?: string | null;
  agentRole?: string | null;
  agentPath?: string | null;
  canAcceptDirectInput?: boolean;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status?: "completed" | "interrupted" | "failed" | "inProgress";
}

export interface ThreadItem {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string; path?: string; name?: string }> | string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  summary?: string[];
  tool?: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
  prompt?: string | null;
  receiverThreadIds?: string[];
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
}

export interface MessageAttachment {
  path: string;
  name: string;
  kind: "image";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Images submitted with this user turn, retained for the transcript UI. */
  attachments?: MessageAttachment[];
  streaming?: boolean;
  timelineOrder?: number;
  /** Runtime turn identity keeps steering inside the turn it belongs to. */
  turnId?: string;
  turnStatus?: Turn["status"];
  /** Wall-clock duration copied onto completed turn entries for timeline summaries. */
  turnDurationMs?: number;
}

export interface Activity {
  id: string;
  kind: "command" | "file" | "reasoning" | "agent" | "warning";
  title: string;
  detail?: string;
  status?: string;
  /** Structured sub-agent identity for the animated timeline dispatch card.
   * Generic agent-shaped activities such as plans intentionally omit this. */
  agent?: {
    action: "spawn" | "sendInput" | "resume" | "wait" | "close" | "status";
    provider?: Provider;
    model?: string;
    task?: string;
    count?: number;
    /** Runtime thread identities represented by this activity. They let the
     * parent turn settle only children that are no longer genuinely active. */
    threadIds?: string[];
  };
  /** Number of concrete operations represented by a grouped runtime activity. */
  itemCount?: number;
  timelineOrder?: number;
  turnId?: string;
  turnStatus?: Turn["status"];
  /** Wall-clock duration copied onto completed turn entries for timeline summaries. */
  turnDurationMs?: number;
}

export interface Account {
  type?: string;
  email?: string | null;
  planType?: string | null;
}

export interface PendingApproval {
  id: number | string;
  method: string;
  params: JsonObject;
  threadId: string;
  receivedAt: number;
}

export interface PromptProfile {
  id: string;
  name: string;
  prompt: string;
  /** Optional provider layers were added after the original global-only profiles. */
  codexPrompt?: string;
  claudePrompt?: string;
}

export interface ThreadReasoning {
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
}

export interface CustomAgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permission?: PermissionMode;
  enabled: boolean;
}

/**
 * One provider/model destination a root agent is allowed to delegate to.
 * `id` is the only value a model ever writes, so a spawn can never name a
 * provider/model pair the user did not approve.
 */
export interface ChildAgentTarget {
  id: string;
  provider: Provider;
  /** Provider-specific model identity; empty means the provider default. */
  model: string;
  label: string;
  description: string;
  enabled: boolean;
  reasoningMode: "inherit" | "fixed" | "agent";
  reasoningEffort: ReasoningEffort;
  reasoningMaxEffort: ReasoningEffort;
}

export interface ChildAgentSettings {
  enabled: boolean;
  targets: ChildAgentTarget[];
}

export interface ProjectSubagentSettings {
  enabled: boolean;
  maxConcurrent: number;
  childAgents: ChildAgentSettings;
}

export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string;
}

export interface ScheduleRunSettings {
  provider: Provider;
  model: string;
  /** OpenAI-compatible Responses endpoint exposed by LM Studio. */
  lmStudioBaseUrl?: string;
  permission: PermissionMode;
  systemPrompt: string;
  projectInstructionsEnabled: boolean;
  subagentsEnabled: boolean;
  subagentMax: number;
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
  serviceTier: string | null;
}

export interface ScheduleRunRecord {
  id: string;
  scheduleId: string;
  scheduleName: string;
  projectId: string | null;
  threadId?: string;
  at: number;
  status: "started" | "failed";
  error?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastThreadId?: string;
  run?: ScheduleRunSettings;
}

export interface ArchivedThread {
  id: string;
  label: string;
  path: string;
  archivedAt: number;
  /** Persist the provider because archived threads are removed from the live index. */
  provider?: Provider;
}

export interface ThreadHandoff {
  sourceThreadId: string;
  sourceTitle: string;
  sourceProvider: Provider;
  sourceModel: string;
  workspacePath: string;
  targetProvider: Provider;
  createdAt: number;
}

/**
 * How a provider quota is spoken about in the UI. Providers report how much of
 * a window has been consumed; "remaining" flips that for people who think in
 * terms of what they have left.
 */
export type UsageDisplayMode = "remaining" | "consumed";

export interface AppSettings {
  provider: Provider;
  openAiLogo: OpenAILogoStyle;
  claudeLogo: ClaudeLogoStyle;
  cursorLogo: CursorLogoStyle;
  model: string;
  /** OpenAI-compatible Responses endpoint exposed by LM Studio. */
  lmStudioBaseUrl: string;
  permission: PermissionMode;
  /** Global OpenKiwi instructions, applied before any subscription-specific layer. */
  systemPrompt: string;
  /** Additional instructions for ChatGPT/Codex subscription threads. */
  codexSystemPrompt: string;
  /** Additional instructions for Claude Code subscription threads. */
  claudeSystemPrompt: string;
  promptProfileId: string;
  projectInstructionsEnabled: boolean;
  subagentsEnabled: boolean;
  subagentMax: number;
  /** Move settled child conversations to Archived after their parent ends. */
  autoArchiveSubagentThreads: boolean;
  /** Cross-provider delegation. Absent in settings written before 1.5. */
  childAgents: ChildAgentSettings;
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
  serviceTier: string | null;
  theme: ThemeName;
  notificationsEnabled: boolean;
  terminalScrollback: number;
  uiScale: number;
  /** Direction provider quota percentages are shown in. Absent before 1.7.6. */
  usageDisplay: UsageDisplayMode;
}
