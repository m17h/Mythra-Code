import type { AppSettings, PermissionMode, Provider, ThreadReasoning, ThreadSubagentSettings } from "../../../types";
import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { settingsWithProjectSubagents, settingsWithoutChildDelegation } from "../../childAgents";
import { isSubAgentThread } from "../../threadList";
import { latestSolModel, modelForProvider, providerFromThread } from "../../threadProvider";
import { settingsForThreadSubagents } from "../../threadSubagentSettings";
import { resolveProviderSystemPrompt, resolveSystemPrompt } from "../../systemPrompt";
import { DEFAULT_OPENAI_MODEL } from "../../appConfig";
import { useTaskStore } from "../../taskStore";
import type { RuntimeModel } from "../../../components/ModelPowerControl";
import type { WorkspaceGitInfo } from "../../worktrees";
import type { DeviceGrant } from "../types";
import { HostReadError, requireThread, requireWorkspace, workspaceAllowed, type HostSources } from "./scope";
import type { WireExecutionSettings } from "../wire";
import { applyHostExecutionPreferences, getHostThreadPreferences } from "./executionPreferences";

export interface ExecutionSources extends HostSources {
  getSettings(): AppSettings;
  getThreadModels(): Readonly<Record<string, string>>;
  getThreadReasoning(): Readonly<Record<string, ThreadReasoning>>;
  getThreadSubagents(): Record<string, ThreadSubagentSettings | boolean>;
  getRuntimeModels(): RuntimeModel[];
  getBaseContext(): TurnRunnerContext;
  getWorkspaceGitInfo(workspaceId: string): WorkspaceGitInfo | null;
  isWorktreeBusy(threadId?: string): boolean;
  /** Thread-keyed bookkeeping; must not overwrite the selected thread's owner. */
  onRemoteCodexRuntimeOwned(threadId: string, instance: string): void;
}
export type ExecutionTarget = { threadId: string } | { workspaceId: string };
export function remotePermission(permission: PermissionMode, grant: DeviceGrant): PermissionMode {
  return permission === "read-only" ? "read-only" : permission === "full" && grant.capabilities.fullAccess ? "full" : "ask";
}
export function currentWorkGrant(sources: HostSources, device: string): DeviceGrant {
  const grant = sources.getGrant(device);
  if (!grant?.view || !grant.work) throw new HostReadError("forbidden", "Remote access was removed before this instruction could run.");
  return grant;
}
/** No selected thread, project, draft, or composer picker is authoritative here. */
export function resolveThreadExecutionContext(sources: ExecutionSources, target: ExecutionTarget, device?: string, draft?: WireExecutionSettings): TurnRunnerContext {
  const app = sources.getSettings();
  const grant = device ? currentWorkGrant(sources, device) : undefined;
  const thread = "threadId" in target ? sources.getKnownThreads()[target.threadId] : null;
  const unrestricted: DeviceGrant = { scope: { kind: "all" }, view: true, work: true,
    capabilities: { fullAccess: true, gitWrite: true, checkpointRestore: true, terminal: true }, revision: 0 };
  const workspace = "threadId" in target
    ? requireThread(sources, thread ?? undefined, grant ?? unrestricted).workspace
    : requireWorkspace(sources, target.workspaceId, grant ?? unrestricted);
  if (grant && !workspaceAllowed(workspace, grant)) throw new HostReadError("forbidden", "This workspace is not shared for work.");
  const project = workspace.isChat ? null : workspace;
  const defaults = project?.overrides?.defaults;
  const projectSettings = settingsWithProjectSubagents(defaults ? { ...app, provider: defaults.provider, model: defaults.model } : app, project?.overrides?.subagents);
  const provider: Provider = thread ? providerFromThread(thread, projectSettings.provider) : draft?.provider ?? projectSettings.provider;
  const prompts = Object.fromEntries((["openai", "claude", "cursor", "openrouter", "lmstudio"] as Provider[]).map((entry) => [entry,
    resolveSystemPrompt(resolveProviderSystemPrompt(projectSettings.systemPrompt, entry, projectSettings.codexSystemPrompt, projectSettings.claudeSystemPrompt), project?.overrides?.systemPrompt, project?.overrides?.systemPromptMode),
  ])) as TurnRunnerContext["subscriptionSystemPrompts"];
  const remembered = thread ? sources.getThreadReasoning()[thread.id] : undefined;
  const rawEffort = remembered?.reasoningEffort ?? projectSettings.reasoningEffort;
  const effort = rawEffort === "ultra" ? "max" : rawEffort;
  const model = thread ? sources.getThreadModels()[thread.id] ?? projectSettings.model
    : provider === "openai" && !defaults && !projectSettings.defaultModelExplicit && (!projectSettings.model || projectSettings.model === DEFAULT_OPENAI_MODEL)
      ? latestSolModel(sources.getRuntimeModels()) : projectSettings.model;
  let settings: AppSettings = {
    ...settingsForThreadSubagents(projectSettings, thread?.id, sources.getThreadSubagents()),
    provider, model: modelForProvider(provider, model), reasoningEffort: effort, ultra: false,
    systemPrompt: provider === "openai" || provider === "claude" ? prompts[provider]
      : resolveSystemPrompt(projectSettings.systemPrompt, project?.overrides?.systemPrompt, project?.overrides?.systemPromptMode),
    permission: grant ? remotePermission(projectSettings.permission, grant) : projectSettings.permission,
  };
  settings = applyHostExecutionPreferences(settings, thread ? getHostThreadPreferences(thread.id) : draft);
  if (grant) settings.permission = remotePermission(settings.permission, grant);
  if (thread && isSubAgentThread(thread, sources.getOwnershipLinks())) settings = settingsWithoutChildDelegation(settings);
  const base = sources.getBaseContext();
  const task = thread ? useTaskStore.getState().tasks[thread.id] : undefined;
  return {
    ...base, activeThread: thread ?? null, activeWorkspace: workspace, activeProject: project,
    effectiveSettings: settings, subscriptionSystemPrompts: prompts,
    activeThreadIsChild: Boolean(thread && isSubAgentThread(thread, sources.getOwnershipLinks())), running: task?.status === "running" || task?.status === "starting",
    workspaceGitInfo: sources.getWorkspaceGitInfo(workspace.id), worktreeBusy: sources.isWorktreeBusy(thread?.id),
    draftThreadIsolated: !thread && draft?.isolated === true, attachments: [], prepareAttachments: undefined,
    firstPromptAttemptId: undefined, activeFirstPromptIdRef: undefined,
    onFirstPromptStarted: undefined, onFirstPromptFinished: undefined,
    ...(device ? {
      deferredDelivery: true,
      onCodexRuntimeOwned: sources.onRemoteCodexRuntimeOwned,
      setActiveThread: () => undefined, setAttachments: () => undefined, setStartingDraftTurn: () => undefined,
      setDraftThreadIsolated: () => undefined, setError: () => undefined, setStatus: () => undefined,
      setTransientStatus: () => undefined, setRuntimeSetupOpen: () => undefined, setAuthRequiredOpen: () => undefined,
      openSettings: () => undefined, onSkillDependencyFailure: undefined,
    } : {}),
  };
}
