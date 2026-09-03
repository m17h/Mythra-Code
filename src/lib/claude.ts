import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Activity,
  ChatMessage,
  CustomAgentProfile,
  PermissionMode,
  Thread,
} from "../types";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { JsonObject } from "./codex";
import { clampUsedPercent, type ProviderRateLimits } from "./providerUsage";
import { parseResetLabelToEpochSeconds } from "./resetTimeParsing";
import { forgetLocalTranscriptPersistence, loadLocalTranscript, loadLocalTranscriptPage, saveLocalTranscript, type LocalTranscriptPage } from "./localTranscriptPersistence";

export interface ClaudeRuntimeStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  warning: string | null;
}

interface ClaudeUsagePayload {
  windows?: Array<{
    label?: unknown;
    usedPercent?: unknown;
    resetLabel?: unknown;
  }>;
}

export function parseClaudeUsageLimits(payload: ClaudeUsagePayload | null | undefined, now = Date.now()): ProviderRateLimits | null {
  const windows = (payload?.windows ?? []).flatMap((window) => {
    if (typeof window.label !== "string" || window.usedPercent === undefined) return [];
    const resetLabel = typeof window.resetLabel === "string" && window.resetLabel.trim() ? window.resetLabel.trim() : null;
    return [{
      label: window.label,
      usedPercent: clampUsedPercent(window.usedPercent),
      resetsAt: parseResetLabelToEpochSeconds(resetLabel, now),
      resetLabel,
    }];
  });
  return windows.length ? { windows } : null;
}

/**
 * One selectable model from the Claude Code CLI's own catalog.
 *
 * `id` is the value passed to `--model`; `resolvedModel` is the concrete model
 * the CLI would route to, which is what the UI shows as the technical detail.
 */
export interface ClaudeModel {
  id: string;
  displayName: string;
  description: string;
  resolvedModel: string;
  /** Present but not selectable — policy or plan blocks it. */
  disabled: boolean;
  /** Why a disabled catalog row cannot start a turn. */
  unavailableReason?: "update-required" | "unavailable" | null;
  /** Minimum Claude Code version named by an update-required sentinel. */
  requiredVersion?: string | null;
  supportedEfforts: string[];
}

interface ClaudeModelPayload {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  resolvedModel?: unknown;
  isDisabled?: unknown;
  disabled?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UPDATE_REQUIRED_PATTERN = /\bupdate\s+to\s+v?(\d+\.\d+\.\d+)\+?/i;

function numericVersion(value: string): number[] | null {
  const match = value.match(/\b(\d+(?:\.\d+)*)\b/);
  return match ? match[1].split(".").map(Number) : null;
}

function compareNumericVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function modelFamilyVersion(model: ClaudeModel): { family: string; version: number[] } | null {
  if (model.id === "default" || /^default\b/i.test(model.displayName)) return null;
  // IDs are the only surviving description for a saved model that disappeared
  // from a refreshed catalog. Treat separators as word boundaries so
  // `claude-fable-5[1m]` can still be compared with a live `Fable 5.1` row.
  const text = `${model.displayName} ${model.description} ${model.id}`.replace(/[-_]+/g, " ");
  const match = text.match(/\b([a-z][a-z0-9-]*)\s+(\d+(?:\.\d+)*)\b/i);
  const version = match ? numericVersion(match[2]) : null;
  return match && version ? { family: match[1].toLowerCase(), version } : null;
}

function latestClaudeFamilyVersions(catalog: ClaudeModel[]): Map<string, number[]> {
  const latest = new Map<string, number[]>();
  for (const model of catalog) {
    const entry = modelFamilyVersion(model);
    if (!entry) continue;
    const current = latest.get(entry.family);
    if (!current || compareNumericVersions(entry.version, current) > 0) latest.set(entry.family, entry.version);
  }
  return latest;
}

/** True when a saved Claude model has a newer same-family catalog entry. */
export function isClaudeModelSuperseded(catalog: ClaudeModel[], modelId: string): boolean {
  if (!modelId) return false;
  const saved = catalog.find((model) => model.id === modelId) ?? {
    id: modelId,
    displayName: modelId,
    description: "",
    resolvedModel: modelId,
    disabled: false,
    supportedEfforts: [],
  };
  const current = modelFamilyVersion(saved);
  if (!current) return false;
  const latest = latestClaudeFamilyVersions(catalog).get(current.family);
  return Boolean(latest && compareNumericVersions(latest, current.version) > 0);
}

/**
 * Keeps only the newest catalog entry in each named family. The newer row may
 * be selectable or may carry update guidance; either way, an older duplicate
 * must not reappear after the CLI update makes its successor available.
 */
export function visibleClaudeModels(catalog: ClaudeModel[]): ClaudeModel[] {
  const latest = latestClaudeFamilyVersions(catalog);
  return catalog.filter((model) => {
    const current = modelFamilyVersion(model);
    if (!current) return true;
    const newest = latest.get(current.family);
    return !newest || compareNumericVersions(newest, current.version) <= 0;
  });
}

/**
 * Normalizes a `list_models` control response. Unknown fields are tolerated so
 * a newer CLI cannot break the picker, and anything without an id is dropped
 * rather than rendered as a blank row.
 */
export function parseClaudeModelCatalog(payload: unknown): ClaudeModel[] {
  const models = (payload as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const catalog: ClaudeModel[] = [];
  for (const entry of models as ClaudeModelPayload[]) {
    if (!entry || typeof entry !== "object") continue;
    const id = trimmed(entry.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const resolvedModel = trimmed(entry.resolvedModel) || id;
    const description = trimmed(entry.description);
    const disabled = entry.isDisabled === true || entry.disabled === true;
    const requiredVersion = disabled ? description.match(UPDATE_REQUIRED_PATTERN)?.[1] ?? null : null;
    const updateRequired = disabled && (/^cc-update-required(?:-|$)/i.test(id) || requiredVersion !== null);
    catalog.push({
      id,
      displayName: (trimmed(entry.displayName) || id).replace(/\s*\(disabled\)\s*$/i, ""),
      description,
      resolvedModel,
      disabled,
      unavailableReason: disabled ? (updateRequired ? "update-required" : "unavailable") : null,
      requiredVersion,
      supportedEfforts: Array.isArray(entry.supportedEffortLevels)
        ? entry.supportedEffortLevels.filter((effort): effort is string => typeof effort === "string")
        : [],
    });
  }
  return catalog;
}

/**
 * The Claude Code CLI exposes no `models` subcommand, so the catalog comes
 * from the stream-json control protocol the backend already speaks.
 */
export async function listClaudeModels(): Promise<ClaudeModel[]> {
  return parseClaudeModelCatalog(await invoke<unknown>("claude_models"));
}

export interface ClaudeEvent {
  threadId: string;
  turnId: string;
  message: JsonObject;
}

export interface ClaudeAttachment {
  path: string;
  kind: "file" | "image";
}

export interface ClaudeTurnOptions {
  threadId: string;
  cwd: string;
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  permission: PermissionMode;
  systemPrompt: string;
  resume: boolean;
  attachments: ClaudeAttachment[];
  subagentMax: number;
  customAgents: CustomAgentProfile[];
  skillsPluginPath?: string;
  /**
   * Path to the cross-provider delegation MCP configuration. Set only for a
   * root thread, so a child Claude process never receives delegation tools.
   */
  childAgentBridgeConfig?: string;
}

export interface ClaudeTranscript {
  thread: Thread;
  messages: ChatMessage[];
  activities: Activity[];
}

export type ClaudeTranscriptPage = ClaudeTranscript & LocalTranscriptPage;

export async function getClaudeRuntimeStatus(): Promise<ClaudeRuntimeStatus> {
  return invoke<ClaudeRuntimeStatus>("claude_runtime_status");
}

export async function getClaudeRateLimits(): Promise<ProviderRateLimits | null> {
  return parseClaudeUsageLimits(await invoke<ClaudeUsagePayload>("claude_usage"));
}

export async function startClaudeLogin(): Promise<void> {
  await invoke("claude_login");
}

export async function startClaudeTurn(
  options: ClaudeTurnOptions,
): Promise<{ turnId: string }> {
  return invoke<{ turnId: string }>("claude_turn_start", { options });
}

export async function steerClaudeTurn(
  threadId: string,
  prompt: string,
  attachments: ClaudeAttachment[],
): Promise<void> {
  await invoke("claude_turn_steer", { threadId, prompt, attachments });
}

export async function interruptClaudeTurn(threadId: string): Promise<void> {
  await invoke("claude_turn_interrupt", { threadId });
}

/**
 * Force-stop the Claude process for a thread, releasing its backend slot
 * immediately. The cooperative interrupt already escalates to a kill on its
 * own; this is for recovering a slot the UI no longer tracks.
 */
export async function killClaudeTurn(threadId: string): Promise<void> {
  await invoke("claude_turn_kill", { threadId });
}

export function isClaudeTurnActive(threadId: string): Promise<boolean> {
  return invoke<boolean>("claude_turn_active", { threadId });
}

/** Matches the backend's per-thread busy rejection from claude_turn_start. */
export function isClaudeThreadBusyError(reason: unknown): boolean {
  return String(reason).includes("Claude is already working in this thread");
}

/**
 * Answer a control request Mythra Code does not implement with an error
 * response, so a Claude CLI blocking on the reply cannot stall the turn.
 */
export async function respondClaudeControlError(
  threadId: string,
  requestId: string,
  message: string,
): Promise<void> {
  await invoke("claude_control_error", { threadId, requestId, message });
}

export async function respondToClaudePermission(
  threadId: string,
  requestId: string,
  result: JsonObject,
): Promise<void> {
  await invoke("claude_permission_respond", { threadId, requestId, result });
}

export async function onClaudeEvent(
  handler: (event: ClaudeEvent) => void,
): Promise<UnlistenFn> {
  // The backend emits single messages on "claude-event" and coalesced bursts
  // of stream deltas on "claude-events" as an ordered array. Keep both
  // subscriptions so either backend version works.
  const single = await listen<ClaudeEvent>("claude-event", ({ payload }) => handler(payload));
  try {
    const batched = await listen<ClaudeEvent[]>("claude-events", ({ payload }) => {
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

function transcriptKey(threadId: string): string {
  return `kiwi.claudeThread.${threadId}`;
}

export async function saveClaudeTranscript(
  transcript: ClaudeTranscript,
): Promise<void> {
  await saveLocalTranscript("claude", transcript);
}

export async function loadClaudeTranscript(
  threadId: string,
): Promise<ClaudeTranscript | null> {
  return loadLocalTranscript<ClaudeTranscript>("claude", threadId);
}

export function loadClaudeTranscriptPage(threadId: string, cursor?: string): Promise<ClaudeTranscriptPage | null> {
  return loadLocalTranscriptPage<ClaudeTranscriptPage>("claude", threadId, cursor);
}

export async function deleteClaudeTranscript(threadId: string): Promise<void> {
  await forgetLocalTranscriptPersistence("claude", threadId, () => (
    invoke("state_delete", { key: transcriptKey(threadId) })
  ));
}
