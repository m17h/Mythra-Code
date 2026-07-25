import type { ReasoningEffort } from "./components/ModelPowerControl";
import type { JsonObject } from "./lib/codex";

export type Provider = "openai" | "openrouter" | "claude";
export type PermissionMode = "read-only" | "ask" | "full";
export type ThemeName = "kiwi" | "midnight" | "ember" | "violet" | "daylight";
export type WorkspaceMode = "chat" | "project";
export type SettingsSection = "general" | "models" | "prompts" | "agents" | "workflows" | "projects" | "skills" | "tools" | "updates";
export type ProjectPromptMode = "replace" | "append";

export interface ProjectOverrides {
  model?: string;
  permission?: PermissionMode;
  systemPrompt?: string;
  /** Existing projects default to replace; append layers app instructions first. */
  systemPromptMode?: ProjectPromptMode;
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
  content?: Array<{ type: string; text?: string }> | string[];
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  timelineOrder?: number;
}

export interface Activity {
  id: string;
  kind: "command" | "file" | "reasoning" | "agent" | "warning";
  title: string;
  detail?: string;
  status?: string;
  timelineOrder?: number;
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
  builtIn?: boolean;
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

export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string;
}

export interface ScheduleRunSettings {
  provider: Provider;
  model: string;
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
}

export interface AppSettings {
  provider: Provider;
  model: string;
  permission: PermissionMode;
  systemPrompt: string;
  promptProfileId: string;
  projectInstructionsEnabled: boolean;
  subagentsEnabled: boolean;
  subagentMax: number;
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
  serviceTier: string | null;
  theme: ThemeName;
  notificationsEnabled: boolean;
  terminalScrollback: number;
  uiScale: number;
}
