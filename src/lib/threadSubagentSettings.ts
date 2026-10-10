import type { AppSettings, NativeSubagentOptions, Provider, SubagentEngine, ThreadSubagentSettings } from "../types";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { ChildAgentReadiness } from "./childAgents";
import type { CodexRuntimeStatus } from "./codex";
import { claudeNativeCompactionConflict, type ClaudeRuntimeStatus } from "./claude";

export const DEFAULT_NATIVE_SUBAGENT_MAX = 6;
export const MAX_NATIVE_SUBAGENT_CONCURRENCY = 24;
export const MIN_NATIVE_AUTO_COMPACT_TOKENS = 100_000;
export const MAX_NATIVE_AUTO_COMPACT_TOKENS = 1_000_000;
/** Shared by parent conversations and individually approved workers. */
export function autoCompactTokensError(value: unknown): string | null {
  return value === undefined || (typeof value === "number" && Number.isInteger(value)
    && value >= MIN_NATIVE_AUTO_COMPACT_TOKENS && value <= MAX_NATIVE_AUTO_COMPACT_TOKENS)
    ? null : "Auto-compaction must be a whole number from 100,000 to 1,000,000 tokens.";
}

export function sanitizeAutoCompactTokens(value: unknown): number | undefined {
  return value !== undefined && autoCompactTokensError(value) === null ? value as number : undefined;
}

/** Zero is an invalid, durable marker; corrupt explicit choices never become defaults. */
export function storedAutoCompactTokens(value: unknown): number | undefined {
  return value === undefined ? undefined : sanitizeAutoCompactTokens(value) ?? 0;
}

export function parentAutoCompactionUnavailableReason(provider: Provider, tokens: unknown): string | null {
  return autoCompactTokensError(tokens) ?? (tokens !== undefined && provider === "cursor"
    ? "Cursor does not expose a supported auto-compaction window. Reset this conversation to provider default."
    : null);
}
const NATIVE_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max", "ultra"]);
function validNativeModel(model: string, claude = false): boolean {
  const identifier = claude ? model.replace(/\[1m\]$/i, "") : model;
  return model.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(identifier) && !["default", "inherit"].includes(identifier.toLowerCase());
}

/** Explicit runtime requests must not silently lose malformed preferences. */
export function nativeSubagentOptionsError(provider: Provider, value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Native sub-agent options must be a provider options object.";
  const key = provider === "openai" ? "codex" : provider === "claude" ? "claude" : null;
  if (!key) return null;
  const options = (value as Record<string, unknown>)[key];
  if (options === undefined) return null;
  if (!options || typeof options !== "object" || Array.isArray(options)) return "Native sub-agent provider options must be an object.";
  const fields = options as Record<string, unknown>;
  if (fields.model !== undefined && (typeof fields.model !== "string" || (fields.model.trim() && !validNativeModel(fields.model.trim(), key === "claude")))) return "Choose a valid native sub-agent model identifier.";
  if (fields.autoCompactTokens !== undefined && (typeof fields.autoCompactTokens !== "number" || !Number.isInteger(fields.autoCompactTokens) || fields.autoCompactTokens < MIN_NATIVE_AUTO_COMPACT_TOKENS || fields.autoCompactTokens > MAX_NATIVE_AUTO_COMPACT_TOKENS)) return "Native auto-compaction must be a whole number from 100,000 to 1,000,000 tokens.";
  if (key === "codex" && fields.reasoningEffort !== undefined && !NATIVE_EFFORTS.has(fields.reasoningEffort as ReasoningEffort)) return "Choose a supported native sub-agent reasoning effort.";
  return null;
}

/** Stored thread policies have no provider binding; reject malformed active preferences on either route. */
export function nativeSubagentOptionsAreValid(value: unknown): boolean {
  return nativeSubagentOptionsError("openai", value) === null && nativeSubagentOptionsError("claude", value) === null;
}

/** Persistence accepts only bounded scalar options, never runtime/config syntax. */
export function sanitizeNativeSubagentOptions(value: unknown): NativeSubagentOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: NativeSubagentOptions = {};
  const raw = value as Record<string, unknown>;
  for (const provider of ["claude", "codex"] as const) {
    const options = raw[provider];
    if (!options || typeof options !== "object" || Array.isArray(options)) continue;
    const fields = options as Record<string, unknown>;
    const cleaned: NonNullable<NativeSubagentOptions["codex"]> = {};
    const model = typeof fields.model === "string" ? fields.model.trim() : "";
    if (model && validNativeModel(model, provider === "claude")) cleaned.model = model;
    const threshold = fields.autoCompactTokens;
    if (typeof threshold === "number" && Number.isInteger(threshold) && threshold >= MIN_NATIVE_AUTO_COMPACT_TOKENS && threshold <= MAX_NATIVE_AUTO_COMPACT_TOKENS) cleaned.autoCompactTokens = threshold;
    if (provider === "codex" && NATIVE_EFFORTS.has(fields.reasoningEffort as ReasoningEffort)) cleaned.reasoningEffort = fields.reasoningEffort as ReasoningEffort;
    if (Object.keys(cleaned).length) result[provider] = cleaned;
  }
  return Object.keys(result).length ? result : undefined;
}
export const DEFAULT_THREAD_SUBAGENT_SETTINGS: ThreadSubagentSettings = {
  enabled: false,
  engine: "mythra",
  nativeMaxConcurrent: DEFAULT_NATIVE_SUBAGENT_MAX,
};

export function sanitizeSubagentEngine(value: unknown): SubagentEngine {
  return value === "native" ? "native" : "mythra";
}

export function sanitizeNativeSubagentMax(value: unknown): number {
  const number = Math.floor(Number(value));
  return value !== undefined && value !== null && Number.isFinite(number)
    ? Math.min(MAX_NATIVE_SUBAGENT_CONCURRENCY, Math.max(1, number))
    : DEFAULT_NATIVE_SUBAGENT_MAX;
}

export function threadSubagentSettingsFromApp(settings: Pick<AppSettings, "subagentsEnabled" | "subagentEngine" | "nativeSubagentMax" | "nativeSubagentOptions" | "autoCompactTokens">): ThreadSubagentSettings {
  const nativeOptions = sanitizeNativeSubagentOptions(settings.nativeSubagentOptions);
  return {
    enabled: settings.subagentsEnabled && (settings.subagentEngine !== "native" || nativeSubagentOptionsAreValid(settings.nativeSubagentOptions)),
    engine: sanitizeSubagentEngine(settings.subagentEngine),
    nativeMaxConcurrent: sanitizeNativeSubagentMax(settings.nativeSubagentMax),
    ...(nativeOptions ? { nativeOptions } : {}),
    ...(settings.autoCompactTokens !== undefined ? { autoCompactTokens: storedAutoCompactTokens(settings.autoCompactTokens) } : {}),
  };
}

function normalizeThreadSetting(value: unknown): ThreadSubagentSettings | null {
  if (typeof value === "boolean") return { ...DEFAULT_THREAD_SUBAGENT_SETTINGS, enabled: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.enabled !== "boolean") return null;
  // Unknown engine names cannot silently grant a different delegation route.
  const validEngine = stored.engine === undefined || stored.engine === "mythra" || stored.engine === "native";
  const nativeOptions = sanitizeNativeSubagentOptions(stored.nativeOptions);
  return {
    enabled: validEngine && stored.enabled && (stored.engine !== "native" || nativeSubagentOptionsAreValid(stored.nativeOptions)),
    engine: sanitizeSubagentEngine(stored.engine),
    nativeMaxConcurrent: sanitizeNativeSubagentMax(stored.nativeMaxConcurrent),
    ...(nativeOptions ? { nativeOptions } : {}),
    ...(stored.autoCompactTokens !== undefined ? { autoCompactTokens: storedAutoCompactTokens(stored.autoCompactTokens) } : {}),
  };
}

/** Missing entries belong to existing threads and retain their legacy policy. */
export function sanitizeThreadSubagentSettings(stored: unknown): Record<string, ThreadSubagentSettings> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
    const setting = normalizeThreadSetting(value);
    // A known damaged entry must stay distinguishable from an absent legacy
    // entry: only the latter is allowed to inherit the old global opt-in.
    return id ? [[id, setting ?? { ...DEFAULT_THREAD_SUBAGENT_SETTINGS }]] : [];
  }));
}

/** Fresh drafts keep the configured crew, but spawning requires a local opt-in. */
export function settingsForThreadSubagents(
  settings: AppSettings,
  threadId: string | null | undefined,
  policies: Record<string, ThreadSubagentSettings | boolean>,
  draft: ThreadSubagentSettings | boolean = DEFAULT_THREAD_SUBAGENT_SETTINGS,
): AppSettings {
  const saved = threadId && Object.hasOwn(policies, threadId)
    ? normalizeThreadSetting(policies[threadId]) ?? DEFAULT_THREAD_SUBAGENT_SETTINGS
    : null;
  const resolved = threadId
    ? saved ?? { ...DEFAULT_THREAD_SUBAGENT_SETTINGS, enabled: settings.subagentsEnabled }
    : normalizeThreadSetting(draft) ?? DEFAULT_THREAD_SUBAGENT_SETTINGS;
  return {
    ...settings,
    subagentsEnabled: resolved.enabled,
    subagentEngine: resolved.engine,
    nativeSubagentMax: sanitizeNativeSubagentMax(resolved.nativeMaxConcurrent),
    nativeSubagentOptions: sanitizeNativeSubagentOptions(resolved.nativeOptions),
    autoCompactTokens: storedAutoCompactTokens(resolved.autoCompactTokens),
  };
}

export function nativeSubagentVersionAtLeast(version: string | null | undefined, minimum: readonly number[]): boolean {
  const match = version?.match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?=[^\d]|$)/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  }
  // A prerelease of the minimum version has not yet reached that release.
  return !version?.slice((match.index ?? 0) + match[0].length).startsWith("-");
}

/** Availability describes this provider's actual native runtime, never a fallback route. */
export function nativeSubagentUnavailableReason(provider: Provider, context: {
  codexRuntime?: Pick<CodexRuntimeStatus, "available" | "version" | "runningVersion"> | null;
  claudeRuntime?: Pick<ClaudeRuntimeStatus, "available" | "version" | "loggedIn"> | null;
  readiness: ChildAgentReadiness;
  nativeOptions?: NativeSubagentOptions;
  nativeDefaultModel?: string;
  autoCompactTokens?: number;
  nativeReasoningEfforts?: Partial<Record<string, ReasoningEffort[]>>;
}): string | null {
  const optionsError = nativeSubagentOptionsError(provider, context.nativeOptions);
  if (optionsError) return optionsError;
  if (provider === "openai") {
    const preferred = context.nativeOptions?.codex;
    if (preferred?.autoCompactTokens !== undefined) return "Codex currently shares the parent compaction setting with native workers. Reset child compaction to inherited, or use Mythra Code for independent worker windows.";
    const model = preferred?.model?.trim() || context.nativeDefaultModel;
    const supported = model ? context.nativeReasoningEfforts?.[model] : undefined;
    if (preferred?.reasoningEffort && supported && !supported.includes(preferred.reasoningEffort)) return `The selected native sub-agent model does not support ${preferred.reasoningEffort} reasoning effort. Choose a supported effort or provider default.`;
    if (!context.codexRuntime?.available || !context.readiness.codexRuntimeAvailable) return "Install the Codex runtime to use native sub-agents.";
    if (!context.readiness.openAiSignedIn) return "Sign in to ChatGPT to use native sub-agents.";
    if (!nativeSubagentVersionAtLeast(context.codexRuntime.runningVersion ?? context.codexRuntime.version, [0, 161, 0])) return "Native sub-agents require Codex 0.161.0 or newer; update or refresh the runtime.";
    return null;
  }
  if (provider === "claude") {
    const preferred = context.nativeOptions?.claude;
    const compactConflict = claudeNativeCompactionConflict(context.nativeDefaultModel ?? "", context.autoCompactTokens, preferred?.model, preferred?.autoCompactTokens);
    if (compactConflict) return compactConflict;
    if (!context.claudeRuntime?.available) return "Install Claude Code to use native sub-agents.";
    if (!context.claudeRuntime.loggedIn || !context.readiness.claudeReady) return "Sign in to Claude Code to use native sub-agents.";
    if (!nativeSubagentVersionAtLeast(context.claudeRuntime.version, [2, 1, 267])) return "Native sub-agents require Claude Code 2.1.267 or newer for inherited permissions; update Claude Code and start the next turn with the refreshed runtime.";
    if (preferred?.autoCompactTokens !== undefined && !nativeSubagentVersionAtLeast(context.claudeRuntime.version, [2, 1, 288])) return "Independent Claude model compaction requires Claude Code 2.1.288 or newer; update Claude Code.";
    const nativeModel = preferred?.model?.trim().toLowerCase().replace(/\[1m\]$/, "");
    if ((nativeModel === "haiku" || nativeModel?.startsWith("claude-haiku-5-5")) && !nativeSubagentVersionAtLeast(context.claudeRuntime.version, [2, 1, 293])) return "Haiku 5.5 native sub-agents require Claude Code 2.1.293 or newer; update Claude Code and refresh the runtime.";
    return null;
  }
  return "Native sub-agents are available with Codex and Claude Code. Choose one of those providers.";
}
