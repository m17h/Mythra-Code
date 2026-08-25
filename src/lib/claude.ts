import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Activity,
  ChatMessage,
  CustomAgentProfile,
  PermissionMode,
  Thread,
} from "../types";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { JsonObject } from "./codex";
import { clampUsedPercent, type ProviderRateLimits } from "./providerUsage";

export interface ClaudeRuntimeStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  warning: string | null;
}

interface ClaudeUsagePayload {
  windows?: Array<{
    label?: unknown;
    usedPercent?: unknown;
    resetLabel?: unknown;
  }>;
}

export function parseClaudeUsageLimits(payload: ClaudeUsagePayload | null | undefined): ProviderRateLimits | null {
  const windows = (payload?.windows ?? []).flatMap((window) => {
    if (typeof window.label !== "string" || window.usedPercent === undefined) return [];
    return [{
      label: window.label,
      usedPercent: clampUsedPercent(window.usedPercent),
      resetsAt: null,
      resetLabel: typeof window.resetLabel === "string" && window.resetLabel.trim() ? window.resetLabel.trim() : null,
    }];
  });
  return windows.length ? { windows } : null;
}

export interface ClaudeEvent {
  threadId: string;
  turnId: string;
  message: JsonObject;
}

export interface ClaudeAttachment {
  path: string;
  kind: "file" | "image";
}

export interface ClaudeTurnOptions {
  threadId: string;
  cwd: string;
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  permission: PermissionMode;
  systemPrompt: string;
  resume: boolean;
  attachments: ClaudeAttachment[];
  subagentMax: number;
  customAgents: CustomAgentProfile[];
  skillsPluginPath?: string;
  /**
   * Path to the cross-provider delegation MCP configuration. Set only for a
   * root thread, so a child Claude process never receives delegation tools.
   */
  childAgentBridgeConfig?: string;
}

export interface ClaudeTranscript {
  thread: Thread;
  messages: ChatMessage[];
  activities: Activity[];
}

export async function getClaudeRuntimeStatus(): Promise<ClaudeRuntimeStatus> {
  return invoke<ClaudeRuntimeStatus>("claude_runtime_status");
}

export async function getClaudeRateLimits(): Promise<ProviderRateLimits | null> {
  return parseClaudeUsageLimits(await invoke<ClaudeUsagePayload>("claude_usage"));
}

export async function startClaudeLogin(): Promise<void> {
  await invoke("claude_login");
}

export async function startClaudeTurn(
  options: ClaudeTurnOptions,
): Promise<{ turnId: string }> {
  return invoke<{ turnId: string }>("claude_turn_start", { options });
}

export async function steerClaudeTurn(
  threadId: string,
  prompt: string,
  attachments: ClaudeAttachment[],
): Promise<void> {
  await invoke("claude_turn_steer", { threadId, prompt, attachments });
}

export async function interruptClaudeTurn(threadId: string): Promise<void> {
  await invoke("claude_turn_interrupt", { threadId });
}

/**
 * Force-stop the Claude process for a thread, releasing its backend slot
 * immediately. The cooperative interrupt already escalates to a kill on its
 * own; this is for recovering a slot the UI no longer tracks.
 */
export async function killClaudeTurn(threadId: string): Promise<void> {
  await invoke("claude_turn_kill", { threadId });
}

export function isClaudeTurnActive(threadId: string): Promise<boolean> {
  return invoke<boolean>("claude_turn_active", { threadId });
}

/** Matches the backend's per-thread busy rejection from claude_turn_start. */
export function isClaudeThreadBusyError(reason: unknown): boolean {
  return String(reason).includes("Claude is already working in this thread");
}

/**
 * Answer a control request Mythra Code does not implement with an error
 * response, so a Claude CLI blocking on the reply cannot stall the turn.
 */
export async function respondClaudeControlError(
  threadId: string,
  requestId: string,
  message: string,
): Promise<void> {
  await invoke("claude_control_error", { threadId, requestId, message });
}

export async function respondToClaudePermission(
  threadId: string,
  requestId: string,
  result: JsonObject,
): Promise<void> {
  await invoke("claude_permission_respond", { threadId, requestId, result });
}

export async function onClaudeEvent(
  handler: (event: ClaudeEvent) => void,
): Promise<UnlistenFn> {
  // The backend emits single messages on "claude-event" and coalesced bursts
  // of stream deltas on "claude-events" as an ordered array. Keep both
  // subscriptions so either backend version works.
  const single = await listen<ClaudeEvent>("claude-event", ({ payload }) => handler(payload));
  try {
    const batched = await listen<ClaudeEvent[]>("claude-events", ({ payload }) => {
      for (const event of payload) handler(event);
    });
    return () => {
      single();
      batched();
    };
  } catch (reason) {
    // If the second subscription fails, do not leave the first listener
    // orphaned and delivering every event twice after a retry.
    single();
    throw reason;
  }
}

function transcriptKey(threadId: string): string {
  return `kiwi.claudeThread.${threadId}`;
}

export async function saveClaudeTranscript(
  transcript: ClaudeTranscript,
): Promise<void> {
  await invoke("state_write", {
    key: transcriptKey(transcript.thread.id),
    value: transcript,
  });
}

export async function loadClaudeTranscript(
  threadId: string,
): Promise<ClaudeTranscript | null> {
  return invoke<ClaudeTranscript | null>("state_read", {
    key: transcriptKey(threadId),
  });
}

export async function deleteClaudeTranscript(threadId: string): Promise<void> {
  await invoke("state_delete", { key: transcriptKey(threadId) });
}
