import type { AppSettings, CustomAgentProfile, PermissionMode, ProjectCheckCommand, ProjectRunCommand, ScheduleRunSettings } from "../types";
import type { ChildAgentBridgeLaunch } from "./agentBridge";
import type { JsonObject } from "./codex";
import { MYTHRA_CODE_NATIVE_DELEGATION_POLICY, mythraCodeDeveloperInstructions, type CheckButtonPromptContext, type RunButtonPromptContext } from "./completionPrompt";
import { RUN_COMMAND_TOOL } from "./projectRun";
import { CHECK_COMMAND_TOOL } from "./projectChecks";
import { resolveProviderSystemPrompt } from "./systemPrompt";
import { DEFAULT_LM_STUDIO_BASE_URL } from "./appConfig";
import { LM_STUDIO_RUNTIME_PROVIDER_ID, runtimeModelProviderId } from "./providerIds";
import { nativeSubagentOptionsError, nativeSubagentVersionAtLeast, parentAutoCompactionUnavailableReason, sanitizeNativeSubagentMax, sanitizeNativeSubagentOptions } from "./threadSubagentSettings";

/** First runtime whose V2 config and spawn model overrides we have verified. */
export const NATIVE_CODEX_MINIMUM_VERSION = "0.161.0";

export function nativeCodexSubagentUnavailableReason(version: string | null | undefined): string | null {
  if (nativeSubagentVersionAtLeast(version, [0, 161, 0])) return null;
  return `Native Codex sub-agents need Codex ${NATIVE_CODEX_MINIMUM_VERSION} or newer. Update Codex before using this mode.`;
}

export function normalizeNativeSubagentMax(value: number | undefined): number {
  return sanitizeNativeSubagentMax(value);
}

function nativeCodexDelegation(run: ScheduleRunSettings): boolean {
  return run.provider === "openai" && run.subagentsEnabled && run.subagentEngine === "native";
}

export function normalizeLmStudioBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "") || DEFAULT_LM_STUDIO_BASE_URL;
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function lmStudioProviderConfig(run: ScheduleRunSettings): JsonObject {
  if (run.provider !== "lmstudio") return {};
  return {
    model_providers: {
      // Never key this on the app's `lmstudio` id — Codex reserves it.
      [LM_STUDIO_RUNTIME_PROVIDER_ID]: {
        name: "LM Studio",
        base_url: normalizeLmStudioBaseUrl(run.lmStudioBaseUrl),
        env_key: "LMSTUDIO_API_KEY",
        env_key_instructions: "Configure the optional LM Studio API token in Mythra Code Settings.",
        wire_api: "responses",
      },
    },
  };
}

export function commandSandbox(permission: PermissionMode, cwd: string, additionalWritableRoots: string[] = []): JsonObject {
  if (permission === "full") return { type: "dangerFullAccess" };
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [cwd, ...additionalWritableRoots], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function sandboxMode(permission: PermissionMode): string {
  if (permission === "read-only") return "read-only";
  if (permission === "full") return "danger-full-access";
  return "workspace-write";
}

export function customAgentConfig(agents: CustomAgentProfile[]): Record<string, JsonObject> {
  return Object.fromEntries(agents.filter((agent) => agent.enabled).map((agent) => [
    agent.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || agent.id,
    {
      description: agent.description,
      instructions: agent.instructions,
      model: agent.model,
      model_reasoning_effort: agent.reasoningEffort,
    },
  ]));
}

export interface ThreadStartOptions {
  serviceName?: string;
  customAgents?: CustomAgentProfile[];
  modelContextWindow?: number;
  /** Non-interactive threads (scheduled runs) never issue approval requests,
   *  because nobody is guaranteed to be present to answer them. */
  interactive: boolean;
  /** Managed turns send their current app prompt separately, without a sticky duplicate. */
  perTurnSystemPrompt?: boolean;
  additionalWorkspaceRoots?: string[];
  /**
   * Cross-provider delegation bridge. Attached only to a root thread, which is
   * what keeps sub-agent depth at one: a child's runtime is started without it
   * and therefore has no delegation tools at all.
   */
  childAgentBridge?: ChildAgentBridgeLaunch;
  /** The project's Run button command, so the model can describe and update it. */
  projectRunCommand?: ProjectRunCommand | null;
  projectCheckCommand?: ProjectCheckCommand | null;
}

function runButtonContext(options: Pick<ThreadStartOptions, "childAgentBridge" | "projectRunCommand">): RunButtonPromptContext {
  return {
    toolAvailable: Boolean(options.childAgentBridge?.toolNames.includes(RUN_COMMAND_TOOL)),
    run: options.projectRunCommand ?? null,
  };
}

function checkButtonContext(options: Pick<ThreadStartOptions, "childAgentBridge" | "projectCheckCommand">): CheckButtonPromptContext {
  return {
    toolAvailable: Boolean(options.childAgentBridge?.toolNames.includes(CHECK_COMMAND_TOOL)),
    check: options.projectCheckCommand ?? null,
  };
}

/** Registers the Mythra Code delegation bridge as a per-thread MCP server. */
export function childAgentMcpConfig(bridge: ChildAgentBridgeLaunch | undefined): JsonObject {
  if (!bridge) return {};
  return {
    mcp_servers: {
      // Collection returns within 45 seconds, while a cold provider spawn may
      // legitimately take several minutes. Codex otherwise gives every MCP
      // tool the same 60-second default timeout.
      [bridge.name]: {
        command: bridge.command,
        args: bridge.args,
        startup_timeout_sec: 30,
        tool_timeout_sec: 310,
      },
    },
  };
}

/**
 * Third-party providers should only receive the local coding surface that
 * Codex owns (shell, files, approvals, agents, and user-configured MCP).
 * ChatGPT connected-app tools are fetched independently by the runtime and
 * can contain provider-specific schemas that OpenRouter destinations reject.
 */
export function threadRuntimeConfig(run: ScheduleRunSettings, options: Partial<Pick<ThreadStartOptions, "interactive" | "customAgents" | "modelContextWindow" | "childAgentBridge" | "projectRunCommand" | "projectCheckCommand">> = {}): JsonObject {
  const compactError = parentAutoCompactionUnavailableReason(run.provider, run.autoCompactTokens);
  if (compactError) throw new Error(compactError);
  const contextWindow = Number(options.modelContextWindow);
  const nativeDelegation = nativeCodexDelegation(run);
  const nativeMax = normalizeNativeSubagentMax(run.nativeSubagentMax);
  const nativeOptionsError = nativeDelegation ? nativeSubagentOptionsError(run.provider, run.nativeSubagentOptions) : null;
  if (nativeOptionsError) throw new Error(nativeOptionsError);
  const nativeOptions = nativeDelegation ? sanitizeNativeSubagentOptions(run.nativeSubagentOptions)?.codex : undefined;
  if (nativeOptions?.autoCompactTokens !== undefined) throw new Error("Codex currently shares the parent compaction setting with native workers. Reset child compaction to inherited, or use Mythra Code for independent worker windows.");
  const mythraDelegation = Boolean(options.childAgentBridge?.toolNames.includes("spawn_mythra_agent"));
  const mythraSettings = Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings"));
  if (nativeDelegation && mythraDelegation) {
    throw new Error("Native sub-agents cannot share a thread with the Mythra Code spawning bridge. Refresh this thread's sub-agent setup before sending.");
  }
  return {
    ...childAgentMcpConfig(options.childAgentBridge),
    ...lmStudioProviderConfig(run),
    ...(nativeDelegation ? { model_provider: "openai" } : {}),
    project_doc_max_bytes: run.projectInstructionsEnabled ? 32_768 : 0,
    project_doc_fallback_filenames: [],
    // Older runtimes use this mode hint. Current V2 ignores it, but replacing
    // the app baseline also avoids retaining its native-disabled custom text.
    multi_agent_mode: nativeDelegation ? "explicitRequestOnly" : { custom: MYTHRA_CODE_NATIVE_DELEGATION_POLICY },
    developer_instructions: mythraCodeDeveloperInstructions(mythraDelegation, mythraSettings, runButtonContext(options), checkButtonContext(options), nativeDelegation),
    model_reasoning_effort: run.ultra ? "ultra" : run.reasoningEffort,
    ...(run.autoCompactTokens !== undefined ? {
      // Own context only. Native Codex workers inherit this runtime policy;
      // separate Mythra workers supply their own approved target preference.
      model_auto_compact_token_limit: run.autoCompactTokens,
      model_auto_compact_token_limit_scope: "total",
    } : {}),
    ...((run.provider === "openrouter" || run.provider === "lmstudio") && Number.isFinite(contextWindow) && contextWindow > 0
      ? { model_context_window: Math.floor(contextWindow) }
      : {}),
    agents: {
      enabled: nativeDelegation,
      // Native and Mythra budgets are independent settings and never active
      // together. Override the old alias as well as the canonical V2 limit.
      max_threads: nativeDelegation ? nativeMax : 1,
      max_concurrent_threads_per_session: nativeDelegation ? nativeMax : 1,
      // V1 compatibility only; V2 owns its descendants and ignores this cap.
      max_depth: 1,
      ...(nativeOptions?.model ? { default_subagent_model: nativeOptions.model } : {}),
      ...(nativeOptions?.reasoningEffort ? { default_subagent_reasoning_effort: nativeOptions.reasoningEffort } : {}),
      ...(!nativeDelegation ? customAgentConfig(options.customAgents ?? []) : {}),
    },
    features: {
      ...(run.provider === "openai" ? { default_mode_request_user_input: options.interactive !== false } : {}),
      multi_agent: nativeDelegation,
      multi_agent_v2: nativeDelegation ? {
        enabled: true,
        expose_spawn_agent_model_overrides: true,
        // Codex 0.161 V2 counts the root, unlike agents' child-only limit.
        max_concurrent_threads_per_session: nativeMax + 1,
      } : false,
      ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: false, remote_plugin: false } : {}),
    },
    ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: { _default: { enabled: false } } } : {}),
  };
}

export function threadStartParams(run: ScheduleRunSettings, cwd: string, options: ThreadStartOptions): JsonObject {
  const developerInstructions = mythraCodeDeveloperInstructions(
    Boolean(options.childAgentBridge?.toolNames.includes("spawn_mythra_agent")),
    Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings")),
    runButtonContext(options),
    checkButtonContext(options),
    nativeCodexDelegation(run),
  );
  const params: JsonObject = {
    cwd,
    runtimeWorkspaceRoots: [cwd, ...(options.additionalWorkspaceRoots ?? [])],
    sandbox: sandboxMode(run.permission),
    approvalPolicy: options.interactive && run.permission === "ask" ? "on-request" : "never",
    // Explicit empty preserves the app's historical no-prompt behavior rather
    // than restoring Codex's default base. The current snapshot is sent by turn/start.
    baseInstructions: options.perTurnSystemPrompt ? "" : run.systemPrompt,
    developerInstructions,
    config: threadRuntimeConfig(run, options),
    serviceName: options.serviceName ?? "Mythra Code",
    serviceTier: run.serviceTier,
  };
  if (run.model.trim()) params.model = run.model.trim();
  const modelProvider = runtimeModelProviderId(run.provider);
  if (modelProvider) params.modelProvider = modelProvider;
  return params;
}

export function threadResumeParams(
  run: ScheduleRunSettings,
  threadId: string,
  cwd: string,
  options: Partial<Pick<ThreadStartOptions, "interactive" | "perTurnSystemPrompt" | "customAgents" | "modelContextWindow" | "additionalWorkspaceRoots" | "childAgentBridge" | "projectRunCommand" | "projectCheckCommand">> & {
    excludeTurns?: boolean;
    /**
     * Re-send the whole runtime config even with no bridge attached. This is
     * how a freshly loaded Codex thread learns that sub-agents were switched
     * on — or off — partway through a conversation. A thread already loaded
     * in app-server requires a managed runtime refresh before this resume.
     */
    refreshRuntimeConfig?: boolean;
  } = {},
): JsonObject {
  const developerInstructions = mythraCodeDeveloperInstructions(
    Boolean(options.childAgentBridge?.toolNames.includes("spawn_mythra_agent")),
    Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings")),
    runButtonContext(options),
    checkButtonContext(options),
    nativeCodexDelegation(run),
  );
  const modelProvider = runtimeModelProviderId(run.provider);
  return {
    threadId,
    cwd,
    runtimeWorkspaceRoots: [cwd, ...(options.additionalWorkspaceRoots ?? [])],
    // A thread may have been created under a different permission mode. Resume
    // it with the mode currently shown in the composer so a stale `on-request`
    // policy cannot survive after the user switches to Full access.
    approvalPolicy: options.interactive !== false && run.permission === "ask" ? "on-request" : "never",
    sandbox: sandboxMode(run.permission),
    // Honored when a durable thread is genuinely loaded into this process.
    // Already-loaded threads ignore this; current turn instructions use the
    // collaboration-mode override below instead of restarting shared runtime.
    baseInstructions: options.perTurnSystemPrompt ? "" : run.systemPrompt,
    developerInstructions,
    ...(options.excludeTurns ? { excludeTurns: true } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(run.provider === "openrouter" || run.provider === "lmstudio" || run.subagentEngine === "native" || options.childAgentBridge || options.refreshRuntimeConfig
      ? { config: threadRuntimeConfig(run, options) }
      : {}),
  };
}

export interface TurnSystemPromptOptions {
  /** Fully resolved current app/provider/project prompt. Empty explicitly clears it. */
  systemPrompt?: string;
  /** Actual thread/start or thread/resume response model when the run uses a default. */
  model?: string;
  /** Current Mythra tool/delegation guidance, which mode overrides replace. */
  developerInstructions?: string;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * Current app instruction state, delivered in the developer channel supported
 * by Codex's per-turn experimental API. Loaded-thread resume does not replace
 * base instructions. Prior overrides remain historical conversation items,
 * so every managed turn must carry its current snapshot, including clearing.
 */
export function withCurrentSystemPrompt(params: JsonObject, systemPrompt: string, currentModel?: string, developerInstructions?: string): JsonObject {
  const mode = objectValue(params.collaborationMode);
  const settings = objectValue(mode.settings);
  const selected = typeof params.model === "string" ? params.model.trim() : "";
  const model = selected || currentModel?.trim() || (typeof settings.model === "string" ? settings.model.trim() : "");
  if (!model) throw new Error("Mythra Code could not identify this thread's current model. Select a model before sending current system instructions.");
  const existing = typeof settings.developer_instructions === "string" ? settings.developer_instructions : "";
  const instructions = [
    existing,
    // collaborationMode supersedes thread developer instructions in the
    // actual app-server schema. Include the current app-owned guide here;
    // callers pass tool guidance only for their real active bridge surface.
    developerInstructions ?? mythraCodeDeveloperInstructions(false),
    "Mythra Code current app system-prompt configuration for this turn. The latest such snapshot is authoritative for this app configuration: it supersedes earlier app system-prompt snapshots, resolved system-skill envelopes, and unresolved @skill selections from earlier app system prompts. Earlier snapshots can remain in conversation history; do not treat their removed skill selections as current requirements. User-message skills and instructions remain valid independently. Native permissions, delegation policy, and other non-app-system instructions remain in force.",
    systemPrompt.trim() ? `Current effective app system prompt:\n${systemPrompt}` : "Current effective app system prompt: none. There is no additional app system prompt or system-selected skill for this turn.",
  ].filter(Boolean).join("\n\n");
  return {
    ...params,
    collaborationMode: {
      ...mode,
      mode: mode.mode === "plan" ? "plan" : "default",
      settings: {
        ...settings,
        model,
        reasoning_effort: params.effort ?? settings.reasoning_effort ?? null,
        developer_instructions: instructions,
      },
    },
  };
}

export function turnStartParams(
  run: ScheduleRunSettings,
  threadId: string,
  cwd: string,
  input: JsonObject[],
  additionalWritableRoots: string[] = [],
  interactive = true,
  instructions: TurnSystemPromptOptions = {},
): JsonObject {
  const params: JsonObject = {
    threadId,
    input,
    cwd,
    runtimeWorkspaceRoots: [cwd, ...additionalWritableRoots],
    // Both values are sticky in Codex app-server. Always override them
    // together on every turn so the visible permission mode is authoritative,
    // including for threads that were originally created with Ask to act.
    approvalPolicy: interactive && run.permission === "ask" ? "on-request" : "never",
    sandboxPolicy: commandSandbox(run.permission, cwd, additionalWritableRoots),
    model: run.model.trim() || undefined,
    effort: run.ultra ? "ultra" : run.reasoningEffort,
    serviceTier: run.serviceTier,
  };
  return instructions.systemPrompt === undefined ? params : withCurrentSystemPrompt(params, instructions.systemPrompt, instructions.model,
    instructions.developerInstructions ?? mythraCodeDeveloperInstructions(false, false, undefined, undefined, nativeCodexDelegation(run)));
}

export function scheduleRunSnapshot(
  settings: ScheduleRunSettings & Partial<Pick<AppSettings, "codexSystemPrompt" | "claudeSystemPrompt">>,
): ScheduleRunSettings {
  const compactError = parentAutoCompactionUnavailableReason(settings.provider, settings.autoCompactTokens);
  if (compactError) throw new Error(compactError);
  const nativeOptionsError = nativeCodexDelegation(settings) ? nativeSubagentOptionsError(settings.provider, settings.nativeSubagentOptions) : null;
  if (nativeOptionsError) throw new Error(nativeOptionsError);
  return {
    provider: settings.provider,
    model: settings.model,
    ...(settings.autoCompactTokens !== undefined ? { autoCompactTokens: settings.autoCompactTokens } : {}),
    lmStudioBaseUrl: normalizeLmStudioBaseUrl(settings.lmStudioBaseUrl),
    permission: settings.permission,
    systemPrompt: resolveProviderSystemPrompt(
      settings.systemPrompt,
      settings.provider,
      settings.codexSystemPrompt,
      settings.claudeSystemPrompt,
    ),
    projectInstructionsEnabled: settings.projectInstructionsEnabled,
    subagentsEnabled: settings.subagentsEnabled,
    subagentMax: settings.subagentMax,
    subagentEngine: settings.subagentEngine,
    nativeSubagentMax: settings.nativeSubagentMax,
    nativeSubagentOptions: sanitizeNativeSubagentOptions(settings.nativeSubagentOptions),
    reasoningEffort: settings.reasoningEffort,
    ultra: settings.ultra,
    serviceTier: settings.serviceTier,
  };
}
