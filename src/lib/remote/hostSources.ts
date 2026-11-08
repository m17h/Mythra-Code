import { visibleClaudeModels, type ClaudeModel } from "../claude";
import type { CursorModel } from "../cursor";
import type { LMStudioModel } from "../lmStudio";
import type { OpenRouterModel } from "../openRouterCatalog";
import { OPENAI_MODELS, type RuntimeModel } from "../../components/ModelPowerControl";
import type { Thread } from "../../types";
import type { WireEffort, WireHostProvider } from "./wire";

import { nativeHostTransport as hostRepositoryTransport } from "./host/bridge";
import { isPullRequestMutationRunning as isHostRepositoryBusy } from "../pullRequestOperations";
import { hostCommandBusy as isHostCommandBusy } from "./host/commandActions";
import { sanitizeTerminalTimeoutMinutes as sanitizeHostTerminalTimeout } from "../appConfig";

const EFFORTS: readonly WireEffort[] = ["low", "medium", "high", "xhigh", "max"];
const wireEfforts = (values: readonly unknown[] | undefined): WireEffort[] => (values ?? []).filter((value): value is WireEffort => EFFORTS.includes(value as WireEffort));

export interface HostCatalogInputs {
  runtimeModels: RuntimeModel[]; claudeModels: ClaudeModel[]; cursorModels: CursorModel[];
  openRouterModels: OpenRouterModel[]; lmStudioModels: LMStudioModel[];
  ready: { openai: boolean; claude: boolean; cursor: boolean; openrouter: boolean; lmstudio: boolean };
}
/** The same catalogs the local pickers read. Names and choices only: no endpoint,
 * key or account record ever enters this list. */
export function hostProviderCatalog(inputs: HostCatalogInputs): WireHostProvider[] {
  const openai = inputs.runtimeModels.length
    ? inputs.runtimeModels.map((model) => {
      const efforts = wireEfforts(model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort));
      const [defaultEffort] = wireEfforts([model.defaultReasoningEffort]);
      return { id: model.model, name: model.displayName, efforts, ...(defaultEffort ? { defaultEffort } : {}) };
    })
    : OPENAI_MODELS.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] }));
  return [
    { id: "openai", name: "OpenAI", ready: inputs.ready.openai, models: openai },
    { id: "claude", name: "Claude", ready: inputs.ready.claude, models: visibleClaudeModels(inputs.claudeModels).filter((model) => !model.disabled).map((model) => ({
      id: model.id, name: model.displayName, efforts: wireEfforts(model.supportedEfforts),
    })) },
    { id: "cursor", name: "Cursor", ready: inputs.ready.cursor, models: inputs.cursorModels.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] })) },
    { id: "openrouter", name: "OpenRouter", ready: inputs.ready.openrouter, models: inputs.openRouterModels.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] })) },
    { id: "lmstudio", name: "LM Studio", ready: inputs.ready.lmstudio, models: inputs.lmStudioModels.map((model) => {
      const [defaultEffort] = wireEfforts([model.defaultReasoningEffort]);
      return { id: model.id, name: model.displayName, efforts: wireEfforts(model.reasoningEfforts), ...(defaultEffort ? { defaultEffort } : {}) };
    }) },
  ];
}

/** Read access to an archived conversation, without unarchiving or selecting it. */
export function synthesizedArchivedThread(record: { id: string; label: string; path: string; archivedAt: number; provider?: string }): Thread {
  return { id: record.id, name: record.label, preview: record.label, cwd: record.path,
    updatedAt: Math.floor(record.archivedAt / 1000), modelProvider: record.provider ?? "openai" };
}

/** Project Git facts for a workspace that may not be the one on screen. The first
 * read of another workspace returns unknown and fills in for the next request. */
const hostGitReads = new WeakMap<object, Map<string, Promise<unknown>>>();
const hostGitSelectedBaselines = new WeakMap<object, Map<string, string>>();
/** A confirmed Git init supersedes any older, still-pending eligibility read. */
export async function refreshHostWorkspaceGit<T>(cache: Map<string, T | null>, key: string, read: () => Promise<T>, selectedFact?: T | null): Promise<void> {
  let pending = hostGitReads.get(cache);
  if (!pending) { pending = new Map(); hostGitReads.set(cache, pending); }
  cache.delete(key);
  const request = Promise.resolve().then(read);
  pending.set(key, request);
  try {
    const info = await request;
    if (pending.get(key) === request) {
      cache.set(key, info);
      if (selectedFact !== undefined) {
        let baselines = hostGitSelectedBaselines.get(cache);
        if (!baselines) { baselines = new Map(); hostGitSelectedBaselines.set(cache, baselines); }
        baselines.set(key, JSON.stringify(selectedFact));
      }
    }
  } catch {
    if (pending.get(key) === request) cache.delete(key);
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
}
/** Remote refresh may supersede the selected host UI's old fact, but must not
 * mask a later LOCAL init/commit updating that fact. No local state is written. */
export function selectedHostWorkspaceGit<T>(cache: Map<string, T | null>, key: string, local: T | null): T | null {
  const baselines = hostGitSelectedBaselines.get(cache);
  if (baselines?.has(key)) {
    if (baselines.get(key) === JSON.stringify(local) && cache.has(key)) return cache.get(key) ?? null;
    baselines.delete(key);
  }
  return local;
}
export function hostWorkspaceGit<T>(cache: Map<string, T | null>, key: string, read: () => Promise<T>): T | null {
  if (!cache.has(key) && !hostGitReads.get(cache)?.has(key)) {
    // Cache misses are display-only reads. A failed read remains unknown and
    // the next inspection can try again; it is never proof of eligibility.
    cache.set(key, null);
    void refreshHostWorkspaceGit(cache, key, read);
  }
  return cache.get(key) ?? null;
}

/** Explicit projection shared by host.context source wiring. Never serialize
 * provider/account objects, account keys, endpoints, CLI errors or settings. */
export function hostQuotaView(provider: import("./wire").WireProvider, view: import("../providerUsage").AccountUsageView,
  display: import("../../types").UsageDisplayMode = "remaining"): import("./wire-studio").WireHostQuota {
  const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
  return { provider, label: text(view.label, 128), summary: text(view.summary, 512),
    ...(view.planLabel ? { planLabel: text(view.planLabel, 128) } : {}),
    ...(typeof view.updatedAt === "number" && Number.isFinite(view.updatedAt) ? { updatedAt: view.updatedAt } : {}),
    windows: (view.windows ?? []).slice(0, 16).filter((w) => Number.isFinite(w.percent)).map((w) => ({
      label: text(w.label, 120), usedPercent: Math.max(0, Math.min(100, display === "consumed" ? w.percent : 100 - w.percent)),
      resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt : null,
      resetLabel: text(w.resetLabel, 160),
    })) };
}

/** The local TerminalPanel/ProjectRunControl/ChecksControl wording and execution
 * deadlines (useTerminal/useProjectChecks and the remote command adapter). */
export function hostProcessPolicy(input: {
  permission: import("../../types").PermissionMode; scopeLabel: string; runtimeAvailable: boolean;
  terminalBusy: boolean; checksBusy: boolean; repositoryBusy: boolean; terminalTimeoutMinutes: number;
  terminalGranted: boolean;
}): import("./wire-studio").WireHostProcessPolicy {
  const scope = input.scopeLabel.slice(0, 256);
  const processPolicyReason = !input.terminalGranted ? "This action requires Terminal access." : null;
  const repositoryReason = input.repositoryBusy ? "Wait for the repository operation to finish." : null;
  return {
    readOnly: input.permission === "read-only",
    readOnlyReason: input.permission === "read-only" ? `Read only: commands run without permission to write inside ${scope}. Switch this thread to Ask or Full access before running anything that edits files.` : null,
    terminalBusy: input.terminalBusy, checksBusy: input.checksBusy, repositoryBusy: input.repositoryBusy,
    runBlockedReason: processPolicyReason ?? repositoryReason ?? (input.terminalBusy ? "The terminal is busy." : null),
    checksBlockedReason: processPolicyReason ?? (!input.runtimeAvailable ? "Start the local runtime to run checks." : repositoryReason),
    processPolicyReason,
    // remote_terminal_open and remote Run deliberately disable the deadline;
    // checks use the same five-minute limit as useProjectChecks.
    terminalTimeoutMs: null, runTimeoutMs: null, checksTimeoutMs: 300_000,
    configuredTerminalTimeoutMinutes: sanitizeHostTerminalTimeout(input.terminalTimeoutMinutes),
  };
}

/** The local copy-path action copies attachment.path. Return it as inert host
 * metadata; this does not mint a fileId or provide any file read operation. */
export function hostAttachmentMetadata(attachments: readonly { path?: string; name: string; kind: string }[]): import("./wire-studio").WireAttachmentMetadata[] {
  return attachments.slice(0, 8).map((attachment, index) => ({ index,
    name: attachment.name.replace(/\\/g, "/").split("/").at(-1)?.slice(0, 512) ?? "file",
    kind: attachment.kind === "image" ? "image" : "file",
    ...(attachment.path && attachment.path.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(attachment.path) ? { originalHostPath: attachment.path } : {}),
  }));
}

export interface HostHeaderSources {
  /** Feed the same accountUsageView objects as the local popover. No identity,
   * account keys, tokens or current header-window choice are accepted. */
  getHeaderAccountUsage?(): readonly { provider: import("./wire").WireProvider; view: import("../providerUsage").AccountUsageView; display: import("../../types").UsageDisplayMode }[];
}
/** Call after hostContext's normal scope resolution; this never changes host
 * selection, terminal state, settings or the viewer's window preferences. */
export function hostContextSupplement(sources: import("./host/hostContext").HostContextSources & HostHeaderSources,
  context: import("./wire").HostContextResult): Pick<import("./wire").HostContextResult, "quotas" | "processPolicy"> {
  const workspace = sources.getWorkspaces().find((w) => w.id === context.workspaceId);
  if (!workspace) return {};
  const root = sources.executionPathFor(context.threadId ?? "", workspace.path);
  const views = sources.getHeaderAccountUsage?.();
  const rows = sources.getAccountUsage?.() ?? [];
  const quotas = views ? views.slice(0, 5).map((row) => hostQuotaView(row.provider, row.view, row.display))
    : [...new Set(rows.map((row) => row.provider))].slice(0, 5).map((provider) => ({ provider, label: provider, summary: "",
      windows: rows.filter((row) => row.provider === provider && Number.isFinite(row.usedPercent)).slice(0, 16).map((row) => ({ label: row.label.slice(0, 120), usedPercent: Math.max(0, Math.min(100, row.usedPercent)), resetsAt: row.resetsAt !== null && Number.isFinite(row.resetsAt) ? row.resetsAt : null, resetLabel: "" })) }));
  return { quotas, processPolicy: hostProcessPolicy({
    permission: context.execution?.permission ?? "read-only", scopeLabel: context.threadId ? "this thread" : workspace.name,
    runtimeAvailable: sources.getRuntime().available, repositoryBusy: isHostRepositoryBusy(root),
    terminalBusy: sources.isLocalCommandRunning?.(root, "run") === true || isHostCommandBusy(root, "run"),
    checksBusy: sources.isLocalCommandRunning?.(root, "checks") === true || isHostCommandBusy(root, "checks"),
    terminalTimeoutMinutes: sanitizeHostTerminalTimeout(sources.getSettings().terminalTimeoutMinutes), terminalGranted: context.capabilities.terminal,
  }) };
}

/** HostDomains' two connection actions can delegate here before requiring a Git
 * baseline (an unborn checkout has no HEAD yet). Native owns durable replay. */
export async function executeHostRepositoryWrite(target: import("./host/nativeActions").NativeTarget,
  action: import("./wire-studio").RepositoryWriteAction,
  transport: import("./host/bridge").HostTransport = hostRepositoryTransport): Promise<import("./wire-studio").RepositoryWriteResult> {
  target.assertAllowed();
  const result = await transport.invoke<import("./wire-studio").RepositoryWriteResult>("remote_repository_execute", { stamp: target.stamp, root: target.root, action });
  if (result?.opId !== target.stamp.opId || result.state !== "accepted" && result.state !== "rejected") throw new Error("The repository change could not be confirmed.");
  return result;
}
