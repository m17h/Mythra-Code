import type { AppSettings, CustomAgentProfile, PermissionMode, ScheduleRunSettings } from "../types";
import type { ChildAgentBridgeLaunch } from "./agentBridge";
import type { JsonObject } from "./codex";
import { openKiwiDeveloperInstructions } from "./completionPrompt";
import { resolveProviderSystemPrompt } from "./systemPrompt";

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

/** Registers the OpenKiwi delegation bridge as a per-thread MCP server. */
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
  const openKiwiDelegation = Boolean(options.childAgentBridge?.toolNames.includes("spawn_agent"));
  const openKiwiSettings = Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings"));
  return {
    ...childAgentMcpConfig(options.childAgentBridge),
    project_doc_max_bytes: run.projectInstructionsEnabled ? 32_768 : 0,
    project_doc_fallback_filenames: [],
    developer_instructions: openKiwiDeveloperInstructions(openKiwiDelegation, openKiwiSettings),
    model_reasoning_effort: run.ultra ? "ultra" : run.reasoningEffort,
    ...(run.provider === "openrouter" && Number.isFinite(contextWindow) && contextWindow > 0
      ? { model_context_window: Math.floor(contextWindow) }
      : {}),
    agents: {
      max_threads: run.subagentMax,
      max_depth: 1,
      ...customAgentConfig(options.customAgents ?? []),
    },
    features: {
      // OpenKiwi is the only delegation authority. Provider-native spawning
      // bypasses the user's approved destinations, frozen concurrency budget,
      // ownership records, and child inbox. With no managed destination the
      // model receives no spawning route at all.
      multi_agent: false,
      ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: false, remote_plugin: false } : {}),
    },
    ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { apps: { _default: { enabled: false } } } : {}),
  };
}

export function threadStartParams(run: ScheduleRunSettings, cwd: string, options: ThreadStartOptions): JsonObject {
  const developerInstructions = openKiwiDeveloperInstructions(
    Boolean(options.childAgentBridge?.toolNames.includes("spawn_agent")),
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
    serviceName: options.serviceName ?? "OpenKiwi",
    serviceTier: run.serviceTier,
  };
  if (run.model.trim()) params.model = run.model.trim();
  if (run.provider === "openrouter" || run.provider === "lmstudio") params.modelProvider = run.provider;
  return params;
}

export function threadResumeParams(
  run: ScheduleRunSettings,
  threadId: string,
  cwd: string,
  options: Pick<ThreadStartOptions, "customAgents" | "modelContextWindow" | "additionalWorkspaceRoots" | "childAgentBridge"> & {
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
  const developerInstructions = openKiwiDeveloperInstructions(
    Boolean(options.childAgentBridge?.toolNames.includes("spawn_agent")),
    Boolean(options.childAgentBridge?.toolNames.includes("propose_agent_settings")),
  );
  return {
    threadId,
    cwd,
    runtimeWorkspaceRoots: [cwd, ...(options.additionalWorkspaceRoots ?? [])],
    developerInstructions,
    ...(options.excludeTurns ? { excludeTurns: true } : {}),
    ...(run.provider === "openrouter" || run.provider === "lmstudio" ? { modelProvider: run.provider } : {}),
    ...(run.provider === "openrouter" || run.provider === "lmstudio" || options.childAgentBridge || options.refreshRuntimeConfig
      ? { config: threadRuntimeConfig(run, options) }
      : {}),
  };
}

export function turnStartParams(run: ScheduleRunSettings, threadId: string, cwd: string, input: JsonObject[], additionalWritableRoots: string[] = []): JsonObject {
  return {
    threadId,
    input,
    cwd,
    runtimeWorkspaceRoots: [cwd, ...additionalWritableRoots],
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
