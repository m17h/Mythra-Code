import { invoke } from "@tauri-apps/api/core";
import { useTaskStore } from "../../taskStore";
import { usageForThread } from "../../usageLedger";
import type { HostContextResult, HostRequest, FilesSearchResult, WireEffort, WireHostProvider, WireHostUsage } from "../wire";
import { resolveThreadExecutionContext, type ExecutionSources } from "./executionContext";
import { currentGrant, HostReadError, idArg, requireThread, requireWorkspace } from "./scope";

export const wireEfforts = new Set<WireEffort>(["low", "medium", "high", "xhigh", "max"]);
export interface HostContextSources extends ExecutionSources {
  /** Same live catalogs as the local pickers, including their readiness. No secrets. */
  getProviderCatalog(): readonly WireHostProvider[];
  getPublicSkills(): readonly { name: string; description?: string; enabled?: boolean }[];
  getPublicWorkflows(workspaceId: string): readonly { id: string; name: string; description?: string }[];
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
  const capability = grant.capabilities as typeof grant.capabilities & { manageProjects?: boolean };
  const result: HostContextResult = { workspaceId, ...(threadId ? { threadId } : {}), providers: publicCatalog(sources),
    selected: { provider: ctx.effectiveSettings.provider, model: text(ctx.effectiveSettings.model, 256), effort },
    ...(threadId ? { saved: { ...(savedModel ? { model: text(savedModel, 256) } : {}), ...(savedEffort ? { effort: savedEffort === "ultra" ? "max" : savedEffort } : {}) } } : {}),
    projectPrompt: text(workspace.overrides?.systemPrompt, 65536), projectPromptMode: workspace.overrides?.systemPromptMode === "append" ? "append" : "replace",
    skills: rawSkills.slice(0, 256).map((s) => ({ id: text(s.name, 256), name: text(s.name, 256), description: text(s.description, 1024), enabled: s.enabled !== false })),
    workflows: rawWorkflows.slice(0, 128).map((w) => ({ id: text(w.id, 256), name: text(w.name, 256), description: text(w.description, 1024) })),
    ...(run ? { run: { command: text(run.command, 4000), ...(run.setupCommand ? { setupCommand: text(run.setupCommand, 4000) } : {}), ...(run.label ? { label: text(run.label, 80) } : {}) } } : {}),
    ...(check ? { check: { command: text(check.command, 4000) } } : {}), usage: usage(threadId),
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
    else throw new HostReadError("busy", "This host context is too large.");
  }
  return result;
}
/** Native bounded, contained name search; never shell/rg supplied by a viewer. */
export async function searchHostFiles(sources: HostContextSources, request: HostRequest, args: Record<string, unknown>, assertCurrent: () => void): Promise<FilesSearchResult> {
  const grant = currentGrant(sources, request.device, request.grant);
  const workspace = requireWorkspace(sources, idArg(args.workspaceId), grant);
  const query = args.query;
  if (typeof query !== "string" || !query.trim() || query.length > 256 || /[\u0000-\u001f]/.test(query)) throw new HostReadError("unsupported", "Enter a short file name to search.");
  const raw = await invoke<{ files: { id: string; name: string; relativePath: string }[]; truncated: boolean }>("remote_work_files_search", {
    generation: request.generation, device: request.device, grantRevision: grant.revision,
    workspaceId: workspace.id, root: workspace.path, query, limit: 100,
  });
  assertCurrent();
  currentGrant(sources, request.device, request.grant);
  if (requireWorkspace(sources, workspace.id, grant).path !== workspace.path) throw new HostReadError("stale_target", "This workspace changed.");
  if (!raw || !Array.isArray(raw.files) || raw.files.length > 100) throw new HostReadError("host_unavailable", "The host could not search files.");
  const files = raw.files.map((file) => {
    const path = file.relativePath;
    if (typeof path !== "string" || path.length > 2048 || path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\:\u0000-\u001f]/.test(p))) {
      throw new HostReadError("host_unavailable", "The host returned an unavailable file.");
    }
    return { id: idArg(file.id), name: text(file.name, 512), relativePath: path };
  });
  return { files, truncated: raw.truncated === true };
}
