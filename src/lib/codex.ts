import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { annotateThreadUsage, usageForThread } from "./usageLedger";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";

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
  /** Executable currently serving app-server RPCs, if one is running. */
  runningPath?: string | null;
  /** Isolated rollout/config store used by the active app-server process. */
  dataHome?: string | null;
  version: string | null;
  /** Version loaded by the running app-server process, if any. */
  runningVersion?: string | null;
  /** Active command/exec RPCs would be terminated by an app-server restart. */
  runningCommands?: number;
  /** The resolved executable differs from the binary loaded by app-server. */
  runtimeChanged?: boolean;
  compatible: boolean;
  warning: string | null;
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  return invoke<CodexRuntimeStatus>("codex_runtime_status");
}

/** Re-probes the installed executable and reports the version serving app-server. */
export async function refreshCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  return invoke<CodexRuntimeStatus>("codex_runtime_status_refresh");
}

export async function getNormalChatWorkspace(): Promise<string> {
  return invoke<string>("normal_chat_workspace");
}

export async function rpc<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
  if (method === "turn/start" && typeof params.threadId === "string" && typeof params.model === "string") {
    const record = usageForThread(params.threadId);
    if (record?.provider) annotateThreadUsage(params.threadId, { provider: record.provider, model: params.model, projectPath: record.projectPath });
  }
  const result = await invoke<T>("codex_rpc", { method, params });
  if (method === "thread/start" || method === "thread/resume") {
    const thread = (result as { thread?: { id?: string; modelProvider?: string } } | null)?.thread;
    const id = thread?.id ?? params.threadId;
    const providerId = params.modelProvider ?? thread?.modelProvider;
    const provider = providerId === "openrouter" ? "openrouter" : providerId === LM_STUDIO_RUNTIME_PROVIDER_ID ? "lmstudio" : providerId === "openai" ? "openai" : undefined;
    if (typeof id === "string" && provider && typeof params.model === "string") {
      annotateThreadUsage(id, { provider, model: params.model, projectPath: typeof params.cwd === "string" ? params.cwd : undefined });
    }
  }
  return result;
}

export interface CodexServerRequestIdentity { method: string; threadId?: string; turnId?: string; itemId?: string }

export async function respond(id: number | string, result: JsonObject, expected?: CodexServerRequestIdentity): Promise<void> {
  await invoke("codex_respond", { id, result, ...(expected ? { expected } : {}) });
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

export interface OpenRouterCreditBalance {
  remaining: number;
  used: number | null;
  /** Account credits are authoritative; keyLimit is a regular key's cap. */
  source: "account" | "keyLimit";
}

export async function getOpenRouterCredits(): Promise<OpenRouterCreditBalance> {
  return invoke<OpenRouterCreditBalance>("openrouter_credits");
}

/** Reads the complete account-filtered OpenRouter tool-capable catalog. */
export async function listOpenRouterModels<T>(): Promise<T> {
  return invoke<T>("list_openrouter_models");
}

/** Resolves a single `author/slug` that is absent from the catalog response. */
export async function fetchOpenRouterModel<T>(slug: string): Promise<T> {
  return invoke<T>("openrouter_model", { slug });
}

export async function saveLmStudioKey(apiKey: string): Promise<void> {
  await invoke("save_lmstudio_key", { apiKey });
}

export async function hasLmStudioKey(): Promise<boolean> {
  return invoke<boolean>("has_lmstudio_key");
}

export async function listLmStudioModels<T>(baseUrl: string): Promise<T> {
  return invoke<T>("list_lmstudio_models", { baseUrl });
}

export async function restartRuntime(): Promise<void> {
  await invoke("restart_runtime");
}

/** Reserve an idle app-server for the explicit model-catalog refresh. */
export async function reserveRuntimeRestart(): Promise<string> {
  return invoke<string>("reserve_runtime_restart");
}

/** Release a reservation if the renderer's final safety checks abort. */
export async function releaseRuntimeRestart(token: string): Promise<void> {
  await invoke("release_runtime_restart", { token });
}

/** Replace the server only while holding the matching idle-refresh reservation. */
export async function restartRuntimeReserved(token: string): Promise<void> {
  await invoke("restart_runtime_reserved", { token });
}

/**
 * Identity of the app-server process that will serve the next RPC, starting
 * it if necessary. A different value than last time means every thread that
 * process had loaded is gone, so a plain `thread/resume` will honour
 * startup-only config again instead of ignoring it.
 */
export async function runtimeInstanceId(): Promise<string> {
  return invoke<string>("runtime_instance");
}

export interface RuntimeThreadState {
  instance: string;
  /** True only when the current app-server process has loaded this thread. */
  loaded: boolean;
}

export async function runtimeThreadState(threadId: string): Promise<RuntimeThreadState> {
  return invoke<RuntimeThreadState>("runtime_thread_state", { threadId });
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
