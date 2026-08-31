import type { AppSettings, CustomAgentProfile, PermissionMode, ScheduleRunSettings } from "../types";
import type { ChildAgentBridgeLaunch } from "./agentBridge";
import type { JsonObject } from "./codex";
import { MYTHRA_CODE_NATIVE_DELEGATION_POLICY, mythraCodeDeveloperInstructions } from "./completionPrompt";
import { resolveProviderSystemPrompt } from "./systemPrompt";
import { DEFAULT_LM_STUDIO_BASE_URL } from "./appConfig";
import { LM_STUDIO_RUNTIME_PROVIDER_ID, runtimeModelProviderId } from "./providerIds";

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
  additionalWorkspaceRoots?: string[];
  /**
   * Cross-provider delegation bridge. Attached only to a root thread, which is
   * what keeps sub-agent depth at one: a child's runtime is started without it
   * and therefore has no delegation tools at all.
   */
  childAgentBridge?: ChildAgentBridgeLaunch;
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
export function threadRuntimeConfig(run: ScheduleRunSettings, options: Pick<ThreadStartOptions, "customAgents" | "modelContextWindow" | "childAgentBridge"> = {}): JsonObject {
  const contextWindow = Number(options.modelContextWindow);
  const mythraDelegation = Boolean(options.childAgentBridge?.toolNames.includes("spawn_mythra_agent"));
  const mythraSettings = Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings"));
  return {
    ...childAgentMcpConfig(options.childAgentBridge),
    ...lmStudioProviderConfig(run),
    project_doc_max_bytes: run.projectInstructionsEnabled ? 32_768 : 0,
    project_doc_fallback_filenames: [],
    // Current Codex releases can enable their native team surface through the
    // host's multi-agent mode even while both legacy feature flags are false.
    // This suppresses that injected team role and leaves the exact Mythra Code
    // MCP destination enum as the sole provider/model authority.
    multi_agent_mode: { custom: MYTHRA_CODE_NATIVE_DELEGATION_POLICY },
    developer_instructions: mythraCodeDeveloperInstructions(mythraDelegation, mythraSettings),
    model_reasoning_effort: run.ultra ? "ultra" : run.reasoningEffort,
    ...((run.provider === "openrouter" || run.provider === "lmstudio") && Number.isFinite(contextWindow) && contextWindow > 0
      ? { model_context_window: Math.floor(contextWindow) }
      : {}),
    agents: {
      // Not `run.subagentMax`. That number is the Mythra Code bridge's budget and
      // the bridge enforces it itself, per spawn, against its own ownership
      // records. Handing the same number to Codex's native agent runtime gave
      // the model a second independent budget stacked on top of the bridge's,
      // so a thread configured for two children could reach four workers. This
      // matches the ceiling the managed `config.toml` already pins.
      max_threads: 1,
      max_depth: 1,
      ...customAgentConfig(options.customAgents ?? []),
    },
    features: {
      // Mythra Code is the only delegation authority. Provider-native spawning
      // bypasses the user's approved destinations, frozen concurrency budget,
      // ownership records, and child inbox. With no managed destination the
      // model receives no spawning route at all.
      multi_agent: false,
      // Codex 0.147 split its native team runtime into a second feature flag.
      // Keep both generations off so Mythra Code's approved bridge remains the
      // only delegation authority (and child threads cannot spawn children).
      multi_agent_v2: false,
      ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: false, remote_plugin: false } : {}),
    },
    ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: { _default: { enabled: false } } } : {}),
  };
}

export function threadStartParams(run: ScheduleRunSettings, cwd: string, options: ThreadStartOptions): JsonObject {
  const developerInstructions = mythraCodeDeveloperInstructions(
    Boolean(options.childAgentBridge?.toolNames.includes("spawn_mythra_agent")),
    Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings")),
  );
  const params: JsonObject = {
    cwd,
    runtimeWorkspaceRoots: [cwd, ...(options.additionalWorkspaceRoots ?? [])],
    sandbox: sandboxMode(run.permission),
    approvalPolicy: options.interactive && run.permission === "ask" ? "on-request" : "never",
    baseInstructions: run.systemPrompt,
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
  options: Pick<ThreadStartOptions, "customAgents" | "modelContextWindow" | "additionalWorkspaceRoots" | "childAgentBridge"> & {
    excludeTurns?: boolean;
    initialTurnsPage?: {
      limit: number;
      sortDirection: "desc";
      itemsView: "full";
    };
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
  );
  const modelProvider = runtimeModelProviderId(run.provider);
  return {
    threadId,
    cwd,
    runtimeWorkspaceRoots: [cwd, ...(options.additionalWorkspaceRoots ?? [])],
    // A thread may have been created under a different permission mode. Resume
    // it with the mode currently shown in the composer so a stale `on-request`
    // policy cannot survive after the user switches to Full access.
    approvalPolicy: run.permission === "ask" ? "on-request" : "never",
    sandbox: sandboxMode(run.permission),
    developerInstructions,
    ...(options.excludeTurns ? { excludeTurns: true } : {}),
    ...(options.initialTurnsPage ? { initialTurnsPage: options.initialTurnsPage } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(run.provider === "openrouter" || run.provider === "lmstudio" || options.childAgentBridge || options.refreshRuntimeConfig
      ? { config: threadRuntimeConfig(run, options) }
      : {}),
  };
}

export function turnStartParams(
  run: ScheduleRunSettings,
  threadId: string,
  cwd: string,
  input: JsonObject[],
  additionalWritableRoots: string[] = [],
  interactive = true,
): JsonObject {
  return {
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
}

export function scheduleRunSnapshot(
  settings: ScheduleRunSettings & Partial<Pick<AppSettings, "codexSystemPrompt" | "claudeSystemPrompt">>,
): ScheduleRunSettings {
  return {
    provider: settings.provider,
    model: settings.model,
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
    reasoningEffort: settings.reasoningEffort,
    ultra: settings.ultra,
    serviceTier: settings.serviceTier,
  };
}
