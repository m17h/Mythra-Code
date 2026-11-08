import type { HostHeaderSources } from "../hostSources";
import { invoke } from "@tauri-apps/api/core";
import { useTaskStore } from "../../taskStore";
import { usageForThread } from "../../usageLedger";
import type { HostContextResult, HostRequest, FilesSearchResult, WireEffort, WireHostProvider, WireHostUsage, WireProvider } from "../wire";
import { remotePermission, resolveThreadExecutionContext, type ExecutionSources } from "./executionContext";
import { currentGrant, HostReadError, idArg, normalizedHostPath, requireThread, requireWorkspace } from "./scope";
import { publicCrew, wireServiceTier } from "./executionPreferences";
import { hostDiscoveryPreferences } from "./discoverySettings";
import type { LocalSkill } from "../../skills";
import type { ChildAgentTarget } from "../../../types";

import type { HostResourceSources } from "./resources";

export const wireEfforts = new Set<WireEffort>(["low", "medium", "high", "xhigh", "max"]);
export interface HostContextSources extends ExecutionSources, HostResourceSources, HostHeaderSources {
  settleRemoteCheckpoint?(id: string, error: string): void;
  /** Refresh host-owned eligibility after confirmed Git initialization/snapshot. */
  refreshWorkspaceGitInfo?(workspaceId: string): Promise<void>;
  /** Must inspect all execution scopes, not just the selected Run/Checks UI.
   * Local start handlers also consult hostCommandBusy before dispatch. */
  isLocalCommandRunning?(root: string, kind: "run" | "checks"): boolean;
  /** Host engine instance, with remote-only delivery hooks; never selected-UI actions. */
  getParentObligations?(run: import("../../parentRun").ParentRun): readonly import("../../parentRun").ParentObligation[];
  getWorkflowEngine?(): import("./workflowExecution").RemoteWorkflowEngine;
  /** Same live catalogs as the local pickers, including their readiness. No secrets. */
  getProviderCatalog(): readonly WireHostProvider[];
  getPublicSkills(): readonly { name: string; description?: string; enabled?: boolean }[];
  /** Host-only identities; never serialized or supplied by a viewer. */
  getLocalSkills?(): readonly LocalSkill[];
  refreshProviderCatalog?(provider: WireProvider): Promise<void>;
  getAccountUsage?(): readonly { provider: WireProvider; label: string; usedPercent: number; resetsAt: number | null }[];
  refreshAccountUsage?(provider: WireProvider): Promise<void>;
  getPublicWorkflows(workspaceId: string): readonly { id: string; name: string; description?: string }[];
  /** The crew a started thread captured, with any change waiting for its next message. */
  getThreadCrew?(threadId: string): { maxConcurrent: number; targets: readonly ChildAgentTarget[] } | undefined;
  /** The saved record of an archived thread, which the live list no longer holds. */
  resolveArchivedThread?(threadId: string): { thread: import("../../../types").Thread; workspaceId: string } | null | Promise<{ thread: import("../../../types").Thread; workspaceId: string } | null>;
  /** True once archiving from another device has a native fence. */
  canArchiveThreads?(): boolean;
  /** Applies a crew change exactly as the local picker does. */
  stageThreadCrew?(threadId: string, next: { maxConcurrent: number; targets: ChildAgentTarget[] }, dryRun: boolean): "none" | "staged" | "busy" | "not-ready";
}
const providers = new Set(["openai", "openrouter", "lmstudio", "claude", "cursor"]);
function text(value: unknown, maximum: number): string { return typeof value === "string" ? value.slice(0, maximum) : ""; }
export function publicCatalog(sources: HostContextSources): WireHostProvider[] {
  return sources.getProviderCatalog().filter((p) => providers.has(p.id)).slice(0, 5).map((p) => ({
    id: p.id, name: text(p.name, 80), ready: p.ready === true,
    models: p.models.filter((m) => typeof m.id === "string" && m.id.length > 0 && m.id.length <= 256).slice(0, 128).map((m) => ({ id: m.id, name: text(m.name, 256),
      efforts: m.efforts.filter((e) => wireEfforts.has(e)).slice(0, 5),
      ...(m.defaultEffort && wireEfforts.has(m.defaultEffort) ? { defaultEffort: m.defaultEffort } : {}) })),
  }));
}
function usage(threadId?: string): WireHostUsage | null {
  if (!threadId) return null;
  const raw = useTaskStore.getState().tasks[threadId]?.usage ?? usageForThread(threadId)?.usage;
  if (!raw) return null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return { totalTokens: number(raw.totalTokens), inputTokens: number(raw.inputTokens), outputTokens: number(raw.outputTokens),
    cachedInputTokens: number(raw.cachedInputTokens), reasoningOutputTokens: number(raw.reasoningOutputTokens),
    ...(typeof raw.contextTokens === "number" ? { contextTokens: number(raw.contextTokens) } : {}),
    ...(typeof raw.contextWindow === "number" ? { contextWindow: number(raw.contextWindow) } : {}) };
}
export function hostContext(sources: HostContextSources, request: HostRequest, args: Record<string, unknown>): HostContextResult {
  const grant = currentGrant(sources, request.device, request.grant);
  const workspaceId = idArg(args.workspaceId), threadId = args.threadId === undefined ? undefined : idArg(args.threadId);
  const workspace = requireWorkspace(sources, workspaceId, grant);
  if (threadId && requireThread(sources, sources.getKnownThreads()[threadId], grant).workspace.id !== workspaceId) {
    throw new HostReadError("forbidden", "This conversation is not in this workspace.");
  }
  // Resolution without device leaves permission untouched; no permission value
  // is projected, and read-only viewers need not have Work to see the pickers.
  const ctx = resolveThreadExecutionContext(sources, threadId ? { threadId } : { workspaceId });
  const savedModel = threadId ? sources.getThreadModels()[threadId] : undefined;
  const savedEffort = threadId ? sources.getThreadReasoning()[threadId]?.reasoningEffort : undefined;
  const effort = ctx.effectiveSettings.reasoningEffort === "ultra" ? "max" : ctx.effectiveSettings.reasoningEffort;
  const rawSkills = sources.getPublicSkills(), rawWorkflows = sources.getPublicWorkflows(workspaceId);
  const run = workspace.overrides?.run, check = workspace.overrides?.check;
  const discovery = hostDiscoveryPreferences();
  const capability = grant.capabilities as typeof grant.capabilities & { manageProjects?: boolean };
  const nativeEngine = ctx.effectiveSettings.subagentEngine === "native";
  const capturedCrew = threadId && !nativeEngine ? sources.getThreadCrew?.(threadId) : undefined;
  const result: HostContextResult = { workspaceId, ...(threadId ? { threadId } : {}), providers: publicCatalog(sources),
    execution: { provider: ctx.effectiveSettings.provider, model: ctx.effectiveSettings.model, effort,
      permission: remotePermission(ctx.effectiveSettings.permission, grant), serviceTier: wireServiceTier(ctx.effectiveSettings.serviceTier),
      subagents: { enabled: ctx.effectiveSettings.subagentsEnabled, engine: ctx.effectiveSettings.subagentEngine === "native" ? "native" : "mythra",
        maxConcurrent: capturedCrew?.maxConcurrent ?? ctx.effectiveSettings.nativeSubagentMax ?? 6, crew: publicCrew(capturedCrew?.targets ?? ctx.effectiveSettings.childAgents.targets) },
      ...(threadId ? { isolated: normalizedHostPath(sources.executionPathFor(threadId, workspace.path)) !== normalizedHostPath(workspace.path) } : {}),
      ...(() => {
        if (threadId) return {};
        const git = ctx.workspaceGitInfo;
        const blocked = !capability.terminal ? "terminal" as const : workspace.isChat ? "repository" as const : !git ? undefined
          : !git.isRepo ? "repository" as const : !git.isRoot ? "root" as const : !git.hasCommit ? "commit" as const : undefined;
        return { canCreateIsolated: grant.work === true && capability.terminal === true && !workspace.isChat && !!git?.isRepo && git.isRoot && git.hasCommit,
          ...(blocked ? { isolationBlocked: blocked } : {}) };
      })() },
    selected: { provider: ctx.effectiveSettings.provider, model: text(ctx.effectiveSettings.model, 256), effort },
    ...(threadId ? { saved: { ...(savedModel ? { model: text(savedModel, 256) } : {}), ...(savedEffort ? { effort: savedEffort === "ultra" ? "max" : savedEffort } : {}) } } : {}),
    projectPrompt: text(workspace.overrides?.systemPrompt, 65536), projectPromptMode: workspace.overrides?.systemPromptMode === "append" ? "append" : "replace",
    skills: rawSkills.slice(0, 256).map((s) => ({ id: text(s.name, 256), name: text(s.name, 256), description: text(s.description, 1024), enabled: s.enabled !== false })),
    workflows: rawWorkflows.slice(0, 128).map((w) => ({ id: text(w.id, 256), name: text(w.name, 256), description: text(w.description, 1024) })),
    ...(run ? { run: { command: text(run.command, 4000), ...(run.setupCommand ? { setupCommand: text(run.setupCommand, 4000) } : {}), ...(run.label ? { label: text(run.label, 80) } : {}) } } : {}),
    ...(check ? { check: { command: text(check.command, 4000) } } : {}), usage: usage(threadId),
    discovery: { provider: discovery.provider, model: text(discovery.model, 256), effort: wireEfforts.has(discovery.effort as WireEffort) ? discovery.effort as WireEffort : "default", fast: discovery.fast },
    capabilities: { fullAccess: capability.fullAccess === true, gitWrite: capability.gitWrite === true,
      checkpointRestore: capability.checkpointRestore === true, terminal: capability.terminal === true, manageProjects: capability.manageProjects === true },
    truncated: rawSkills.length > 256 || rawWorkflows.length > 128 || (workspace.overrides?.systemPrompt?.length ?? 0) > 65536 || sources.getProviderCatalog().some((p) => p.models.length > 128),
  };
  while (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) {
    result.truncated = true;
    const longest = result.providers.reduce<typeof result.providers[number] | undefined>((best, entry) => !best || entry.models.length > best.models.length ? entry : best, undefined);
    if (longest?.models.length) longest.models.pop();
    else if (result.skills.length) result.skills.pop();
    else if (result.workflows.length) result.workflows.pop();
    else if (result.projectPrompt) result.projectPrompt = result.projectPrompt.slice(0, Math.floor(result.projectPrompt.length / 2));
    else throw new HostReadError("busy", "That's too much to load at once.");
  }
  return result;
}
/** Native bounded, contained name search; never shell/rg supplied by a viewer. */
export async function searchHostFiles(sources: HostContextSources, request: HostRequest, args: Record<string, unknown>, assertCurrent: () => void): Promise<FilesSearchResult> {
  const grant = currentGrant(sources, request.device, request.grant);
  const workspace = requireWorkspace(sources, idArg(args.workspaceId), grant);
  const threadId = args.threadId === undefined ? undefined : idArg(args.threadId);
  const root = () => {
    if (!threadId) return workspace.path;
    const target = requireThread(sources, sources.getKnownThreads()[threadId], grant);
    if (target.workspace.id !== workspace.id) throw new HostReadError("forbidden", "This conversation is not in this workspace.");
    return sources.executionPathFor(threadId, target.workspace.path);
  };
  const executionRoot = root();
  const query = args.query;
  if (typeof query !== "string" || !query.trim() || query.length > 256 || /[\u0000-\u001f]/.test(query)) throw new HostReadError("unsupported", "Enter a short file name to search.");
  const raw = await invoke<{ files: { id: string; name: string; relativePath: string }[]; truncated: boolean }>("remote_work_files_search", {
    generation: request.generation, device: request.device, grantRevision: grant.revision,
    workspaceId: workspace.id, threadId, root: executionRoot, query, limit: 100,
  });
  assertCurrent();
  currentGrant(sources, request.device, request.grant);
  if (requireWorkspace(sources, workspace.id, grant).path !== workspace.path) throw new HostReadError("stale_target", "This workspace changed.");
  if (root() !== executionRoot) throw new HostReadError("stale_target", "This checkout changed during file search.");
  if (!raw || !Array.isArray(raw.files) || raw.files.length > 100) throw new HostReadError("host_unavailable", "The other device couldn't search files.");
  const files = raw.files.map((file) => {
    const path = file.relativePath;
    if (typeof path !== "string" || path.length > 2048 || path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\:\u0000-\u001f]/.test(p))) {
      throw new HostReadError("host_unavailable", "The other device returned an unavailable file.");
    }
    return { id: idArg(file.id), name: text(file.name, 512), relativePath: path };
  });
  return { files, truncated: raw.truncated === true };
}
