import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Activity, ChatMessage, PermissionMode, Thread } from "../types";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { JsonObject } from "./codex";

export interface CursorRuntimeStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  warning: string | null;
}

export interface CursorModel {
  id: string;
  name: string;
  configOptions: JsonObject[];
}

export interface CursorEvent {
  threadId: string;
  turnId: string;
  message: JsonObject;
}

export interface CursorTurnOptions {
  threadId: string;
  cwd: string;
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  permission: PermissionMode;
  systemPrompt: string;
  resumeSessionId?: string;
  attachments: Array<{ path: string; kind: "file" | "image" }>;
  /**
   * Cross-provider delegation bridge, announced to ACP when the session is
   * created. Set only for a root thread.
   */
  childAgentBridge?: { name: string; command: string; args: string[] };
}

export interface CursorTranscript {
  thread: Thread;
  cursorSessionId: string;
  messages: ChatMessage[];
  activities: Activity[];
}

export function getCursorRuntimeStatus(): Promise<CursorRuntimeStatus> {
  return invoke<CursorRuntimeStatus>("cursor_runtime_status");
}

export async function startCursorLogin(): Promise<void> {
  await invoke("cursor_login");
}

export function listCursorModels(): Promise<CursorModel[]> {
  return invoke<CursorModel[]>("cursor_models");
}

export function startCursorTurn(options: CursorTurnOptions): Promise<{ turnId: string; cursorSessionId: string }> {
  return invoke("cursor_turn_start", { options });
}

export async function steerCursorTurn(threadId: string, prompt: string, attachments: CursorTurnOptions["attachments"] = []): Promise<void> {
  await invoke("cursor_turn_steer", { threadId, prompt, attachments });
}

export async function interruptCursorTurn(threadId: string): Promise<void> {
  await invoke("cursor_turn_interrupt", { threadId });
}

export async function killCursorTurn(threadId: string): Promise<void> {
  await invoke("cursor_turn_kill", { threadId });
}

export function isCursorTurnActive(threadId: string): Promise<boolean> {
  return invoke<boolean>("cursor_turn_active", { threadId });
}

export async function respondToCursorPermission(threadId: string, requestId: string | number, result: JsonObject): Promise<void> {
  await invoke("cursor_permission_respond", { threadId, requestId, result });
}

export async function onCursorEvent(handler: (event: CursorEvent) => void): Promise<UnlistenFn> {
  // The backend emits single messages on "cursor-event" and coalesced bursts
  // of session/update notifications on "cursor-events" as an ordered array.
  // Keep both subscriptions so either backend version works.
  const single = await listen<CursorEvent>("cursor-event", ({ payload }) => handler(payload));
  try {
    const batched = await listen<CursorEvent[]>("cursor-events", ({ payload }) => {
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
  return `kiwi.cursorThread.${threadId}`;
}

export function saveCursorTranscript(transcript: CursorTranscript): Promise<void> {
  return invoke("local_transcript_snapshot_write", { provider: "cursor", value: transcript });
}

export function loadCursorTranscript(threadId: string): Promise<CursorTranscript | null> {
  return invoke("local_transcript_full_read", { provider: "cursor", threadId });
}

export async function deleteCursorTranscript(threadId: string): Promise<void> {
  await invoke("state_delete", { key: transcriptKey(threadId) });
}
