import { create } from "zustand";
import type { AttachmentRecord } from "../components/StudioDock";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { AppSettings, NativeSubagentOptions, PermissionMode, Provider, SubagentEngine } from "../types";
import { nativeSubagentOptionsError, sanitizeNativeSubagentMax, sanitizeNativeSubagentOptions, sanitizeSubagentEngine, storedAutoCompactTokens } from "./threadSubagentSettings";
import { loadStored, removeStoredValue, storeValue } from "./storage";
import { normalizedProjectPath } from "./paths";
import { sanitizeStoredQueuedTurns, type QueuedTurn, type QueuedTurnStatus } from "./taskStore";

/**
 * A timed first prompt for a conversation that does not exist yet. There is
 * no thread id (and so no thread queue) until the provider creates one, so
 * each entry starts its own new thread when due, through the same delivery
 * path, preflight and approval policy as pressing Send in that draft.
 *
 * The snapshot pins the provider identity and isolation choice the user saw
 * when scheduling; changing the draft's model picker later must not reroute
 * an already scheduled prompt. It deliberately holds no credentials or system
 * prompt text.
 */
export interface NewThreadSettingsSnapshot {
  provider: Provider;
  model: string;
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
  permission: PermissionMode;
  serviceTier: string | null;
  subagentsEnabled: boolean;
  subagentEngine?: SubagentEngine;
  nativeSubagentMax?: number;
  nativeSubagentOptions?: NativeSubagentOptions;
  autoCompactTokens?: number;
  isolated: boolean;
}

export interface NewThreadTimedPrompt extends QueuedTurn {
  deliverAt: number;
  /** Logical workspace path (project or normal chat) the draft belonged to. */
  workspacePath: string;
  workspaceName: string;
  snapshot: NewThreadSettingsSnapshot;
}

const STORAGE_KEY = "kiwi.newThreadTimedPrompts";
const PROVIDERS = new Set<Provider>(["openai", "claude", "cursor", "openrouter", "lmstudio"]);
const PERMISSIONS = new Set<PermissionMode>(["read-only", "ask", "full"]);
const EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** Legacy path spellings can coexist; every matching schedule remains actionable. */
export function newThreadPromptsForWorkspace(prompts: Readonly<Record<string, readonly NewThreadTimedPrompt[]>>, path: string): NewThreadTimedPrompt[] {
  const key = normalizedProjectPath(path);
  return Object.entries(prompts).flatMap(([bucket, entries]) => normalizedProjectPath(bucket) === key ? entries : []);
}

export function newThreadSnapshot(settings: AppSettings, isolated: boolean): NewThreadSettingsSnapshot {
  return {
    provider: settings.provider,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    ultra: settings.ultra,
    permission: settings.permission,
    serviceTier: settings.serviceTier ?? null,
    subagentsEnabled: settings.subagentsEnabled && (settings.subagentEngine !== "native" || nativeSubagentOptionsError(settings.provider, settings.nativeSubagentOptions) === null),
    subagentEngine: sanitizeSubagentEngine(settings.subagentEngine),
    nativeSubagentMax: sanitizeNativeSubagentMax(settings.nativeSubagentMax),
    nativeSubagentOptions: sanitizeNativeSubagentOptions(settings.nativeSubagentOptions),
    ...(settings.autoCompactTokens !== undefined ? { autoCompactTokens: storedAutoCompactTokens(settings.autoCompactTokens) } : {}),
    isolated,
  };
}

/** Restore only fields the snapshot owns; everything else stays live. */
export function applyNewThreadSnapshot(settings: AppSettings, snapshot: NewThreadSettingsSnapshot): AppSettings {
  return {
    ...settings,
    provider: snapshot.provider,
    model: snapshot.model,
    reasoningEffort: snapshot.reasoningEffort,
    ultra: snapshot.ultra,
    permission: snapshot.permission,
    serviceTier: snapshot.serviceTier,
    subagentsEnabled: snapshot.subagentsEnabled && (snapshot.subagentEngine !== "native" || nativeSubagentOptionsError(snapshot.provider, snapshot.nativeSubagentOptions) === null),
    subagentEngine: sanitizeSubagentEngine(snapshot.subagentEngine),
    nativeSubagentMax: sanitizeNativeSubagentMax(snapshot.nativeSubagentMax),
    nativeSubagentOptions: sanitizeNativeSubagentOptions(snapshot.nativeSubagentOptions),
    autoCompactTokens: storedAutoCompactTokens(snapshot.autoCompactTokens),
  };
}

function sanitizeSnapshot(value: unknown): NewThreadSettingsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || !PROVIDERS.has(raw.provider as Provider)) return null;
  if (typeof raw.model !== "string") return null;
  // An unknown permission or effort could widen what an unattended start may do.
  if (!PERMISSIONS.has(raw.permission as PermissionMode) || !EFFORTS.has(raw.reasoningEffort as ReasoningEffort)) return null;
  return {
    provider: raw.provider as Provider,
    model: raw.model,
    reasoningEffort: raw.reasoningEffort as ReasoningEffort,
    ultra: raw.ultra === true,
    permission: raw.permission as PermissionMode,
    serviceTier: typeof raw.serviceTier === "string" ? raw.serviceTier : null,
    subagentsEnabled: raw.subagentsEnabled === true && (raw.subagentEngine === undefined || raw.subagentEngine === "mythra" || raw.subagentEngine === "native") && (raw.subagentEngine !== "native" || nativeSubagentOptionsError(raw.provider as Provider, raw.nativeSubagentOptions) === null),
    subagentEngine: sanitizeSubagentEngine(raw.subagentEngine),
    nativeSubagentMax: sanitizeNativeSubagentMax(raw.nativeSubagentMax),
    nativeSubagentOptions: sanitizeNativeSubagentOptions(raw.nativeSubagentOptions),
    ...(raw.autoCompactTokens !== undefined ? { autoCompactTokens: storedAutoCompactTokens(raw.autoCompactTokens) } : {}),
    isolated: raw.isolated === true,
  };
}

/** Reuse the queue sanitizer for text/attachments/status, then add draft identity. */
export function sanitizeStoredNewThreadPrompts(stored: unknown): Record<string, NewThreadTimedPrompt[]> {
  if (!stored || typeof stored !== "object") return {};
  const queued = sanitizeStoredQueuedTurns(stored);
  const result: Record<string, NewThreadTimedPrompt[]> = {};
  for (const [workspacePath, entries] of Object.entries(queued)) {
    const rawEntries = (stored as Record<string, unknown[]>)[workspacePath];
    const prompts: NewThreadTimedPrompt[] = [];
    for (const entry of entries) {
      const raw = rawEntries.find((candidate) => (candidate as { id?: unknown })?.id === entry.id) as Record<string, unknown> | undefined;
      const snapshot = sanitizeSnapshot(raw?.snapshot);
      // A first prompt without a time or provider identity cannot be sent
      // honestly; drop it rather than guessing the draft's current settings.
      if (!snapshot || entry.deliverAt === undefined) continue;
      const { releasedAt: _released, ...rest } = entry;
      prompts.push({
        ...rest,
        threadId: `new:${workspacePath}`,
        deliverAt: entry.deliverAt,
        workspacePath,
        workspaceName: typeof raw?.workspaceName === "string" && raw.workspaceName.trim() ? raw.workspaceName : workspacePath,
        snapshot,
      });
    }
    if (prompts.length) result[workspacePath] = prompts;
  }
  return result;
}

interface NewThreadTimedPromptState {
  prompts: Record<string, NewThreadTimedPrompt[]>;
  add: (input: { workspacePath: string; workspaceName: string; text: string; attachments: AttachmentRecord[]; deliverAt: number; snapshot: NewThreadSettingsSnapshot; skillInvocationText?: string }) => NewThreadTimedPrompt;
  setStatus: (id: string, status: QueuedTurnStatus, error?: string) => void;
  markMissed: (ids: string[], missedAt?: number) => void;
  /** The user's explicit go-ahead for a missed or failed prompt. */
  prepareManualStart: (id: string) => boolean;
  beginEdit: (id: string) => boolean;
  finishEdit: (id: string, text?: string) => boolean;
  reschedule: (id: string, deliverAt: number) => boolean;
  remove: (id: string) => void;
}

function persist(prompts: Record<string, NewThreadTimedPrompt[]>): void {
  storeValue(STORAGE_KEY, prompts);
}

function locate(prompts: Record<string, NewThreadTimedPrompt[]>, id: string): NewThreadTimedPrompt | undefined {
  for (const entries of Object.values(prompts)) {
    const found = entries.find((entry) => entry.id === id);
    if (found) return found;
  }
  return undefined;
}

function updated(prompts: Record<string, NewThreadTimedPrompt[]>, id: string, update: (entry: NewThreadTimedPrompt) => NewThreadTimedPrompt | null): Record<string, NewThreadTimedPrompt[]> {
  const next: Record<string, NewThreadTimedPrompt[]> = {};
  for (const [workspacePath, entries] of Object.entries(prompts)) {
    const mapped = entries.flatMap((entry) => {
      if (entry.id !== id) return [entry];
      const replacement = update(entry);
      return replacement ? [replacement] : [];
    });
    if (mapped.length) next[workspacePath] = mapped;
  }
  return next;
}

export const useNewThreadTimedPrompts = create<NewThreadTimedPromptState>((set, get) => ({
  prompts: sanitizeStoredNewThreadPrompts(loadStored<unknown>(STORAGE_KEY, {})),
  add: ({ workspacePath, workspaceName, text, attachments, deliverAt, snapshot, skillInvocationText }) => {
    const prompt: NewThreadTimedPrompt = {
      id: `scheduled-new-${crypto.randomUUID()}`,
      threadId: `new:${workspacePath}`,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      createdAt: Date.now(),
      status: "queued",
      deliverAt,
      workspacePath,
      workspaceName,
      snapshot: { ...snapshot, subagentsEnabled: snapshot.subagentsEnabled && (snapshot.subagentEngine !== "native" || nativeSubagentOptionsError(snapshot.provider, snapshot.nativeSubagentOptions) === null), nativeSubagentOptions: sanitizeNativeSubagentOptions(snapshot.nativeSubagentOptions), ...(snapshot.autoCompactTokens !== undefined ? { autoCompactTokens: storedAutoCompactTokens(snapshot.autoCompactTokens) } : {}) },
      ...(skillInvocationText !== undefined ? { skillInvocationText } : {}),
    };
    const prompts = { ...get().prompts, [workspacePath]: [...(get().prompts[workspacePath] ?? []), prompt] };
    persist(prompts);
    set({ prompts });
    return prompt;
  },
  setStatus: (id, status, error) => {
    const entry = locate(get().prompts, id);
    if (!entry || (status === "sending" && entry.editing)) return;
    const prompts = updated(get().prompts, id, (item) => ({ ...item, status, error: error || undefined }));
    persist(prompts);
    set({ prompts });
  },
  markMissed: (ids, missedAt = Date.now()) => {
    const wanted = new Set(ids);
    let prompts = get().prompts;
    let changed = false;
    for (const id of wanted) {
      const entry = locate(prompts, id);
      if (!entry || entry.missedAt !== undefined || entry.status === "sending") continue;
      prompts = updated(prompts, id, (item) => ({ ...item, missedAt }));
      changed = true;
    }
    if (!changed) return;
    persist(prompts);
    set({ prompts });
  },
  prepareManualStart: (id) => {
    const entry = locate(get().prompts, id);
    if (!entry || entry.status === "sending" || entry.editing) return false;
    const prompts = updated(get().prompts, id, (item) => {
      const { missedAt: _missed, ...rest } = item;
      return { ...rest, status: "queued", error: undefined };
    });
    persist(prompts);
    set({ prompts });
    return true;
  },
  beginEdit: (id) => {
    const entry = locate(get().prompts, id);
    if (!entry || entry.status === "sending" || entry.editing) return false;
    const prompts = updated(get().prompts, id, (item) => ({ ...item, editing: true }));
    persist(prompts);
    set({ prompts });
    return true;
  },
  finishEdit: (id, text) => {
    const entry = locate(get().prompts, id);
    if (!entry?.editing || entry.status === "sending" || (text !== undefined && !text.trim())) return false;
    const prompts = updated(get().prompts, id, (item) => {
      const nextText = text === undefined ? item.text : text.trim();
      return {
        ...item,
        text: nextText,
        editing: undefined,
        ...(nextText !== item.text && item.skillInvocationText !== undefined ? { skillInvocationText: "" } : {}),
      };
    });
    persist(prompts);
    set({ prompts });
    return true;
  },
  reschedule: (id, deliverAt) => {
    const entry = locate(get().prompts, id);
    if (!entry || entry.status === "sending" || entry.editing || !Number.isFinite(deliverAt) || deliverAt <= Date.now()) return false;
    const prompts = updated(get().prompts, id, (item) => {
      const { missedAt: _missed, ...rest } = item;
      return { ...rest, deliverAt, status: "queued", error: undefined };
    });
    persist(prompts);
    set({ prompts });
    return true;
  },
  remove: (id) => {
    if (!locate(get().prompts, id)) return;
    const prompts = updated(get().prompts, id, () => null);
    persist(prompts);
    set({ prompts });
  },
}));

export function findNewThreadTimedPrompt(id: string): NewThreadTimedPrompt | undefined {
  return locate(useNewThreadTimedPrompts.getState().prompts, id);
}

export function resetNewThreadTimedPromptsForTests(): void {
  removeStoredValue(STORAGE_KEY);
  useNewThreadTimedPrompts.setState({ prompts: {} });
}
