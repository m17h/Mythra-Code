import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type JsonObject = Record<string, unknown>;

export interface CodexEvent {
  method?: string;
  id?: number | string;
  params?: JsonObject;
  stream?: "stderr";
  line?: string;
}

export interface CodexRuntimeStatus {
  available: boolean;
  source: "Codex CLI" | "ChatGPT app" | "Custom path" | null;
  path: string | null;
  version: string | null;
  compatible: boolean;
  warning: string | null;
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  return invoke<CodexRuntimeStatus>("codex_runtime_status");
}

export async function getNormalChatWorkspace(): Promise<string> {
  return invoke<string>("normal_chat_workspace");
}

export async function rpc<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
  return invoke<T>("codex_rpc", { method, params });
}

export async function respond(id: number | string, result: JsonObject): Promise<void> {
  await invoke("codex_respond", { id, result });
}

export async function onCodexEvent(handler: (event: CodexEvent) => void): Promise<UnlistenFn> {
  // The backend emits single messages on "codex-event" and coalesced bursts of
  // delta notifications on "codex-events" as an ordered array.
  const single = await listen<CodexEvent>("codex-event", ({ payload }) => handler(payload));
  try {
    const batched = await listen<CodexEvent[]>("codex-events", ({ payload }) => {
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

export async function saveOpenRouterKey(apiKey: string): Promise<void> {
  await invoke("save_openrouter_key", { apiKey });
}

export async function hasOpenRouterKey(): Promise<boolean> {
  return invoke<boolean>("has_openrouter_key");
}

export async function listOpenRouterModels<T>(): Promise<T> {
  return invoke<T>("list_openrouter_models");
}

export async function restartRuntime(): Promise<void> {
  await invoke("restart_runtime");
}

export async function auditEvent(
  kind: string,
  payload: JsonObject = {},
  threadId?: string,
): Promise<void> {
  await invoke("audit_append", { kind, threadId: threadId ?? null, payload });
}

export async function readDiagnostics<T = JsonObject>(): Promise<T> {
  return invoke<T>("diagnostics_read");
}

export interface AuditRow {
  id: number;
  kind: string;
  threadId: string | null;
  payload: unknown;
  createdAt: number;
}

export async function recentAuditRows(limit = 50, kindPrefix?: string): Promise<AuditRow[]> {
  return invoke<AuditRow[]>("audit_recent", { limit, kindPrefix: kindPrefix ?? null });
}

export async function exportTextFile(path: string, contents: string): Promise<void> {
  await invoke("export_text_file", { path, contents });
}

export async function exportDiagnostics(path: string): Promise<void> {
  await invoke("diagnostics_export", { path });
}
