import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TokenUsageView } from "../components/StudioDock";
import type { Provider } from "../types";
import { recordAuxiliaryUsage } from "./usageLedger";

export const BACKGROUND_USAGE_EVENT = "background-helper-usage";
const PROVIDERS: Provider[] = ["openai", "claude", "cursor", "openrouter", "lmstudio"];
const PURPOSES = ["thread-title", "run-discovery", "check-discovery"] as const;
const SOURCES = ["reported", "requested", "unknown"] as const;
const OUTCOMES = ["completed", "failed", "cancelled", "timed-out", "unknown"] as const;
const TOKEN_KEYS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
type Source = typeof SOURCES[number];
type Counts = Record<typeof TOKEN_KEYS[number], number | null>;

export interface BackgroundUsageEvent {
  executionId: string;
  provider: Provider;
  model: string;
  modelSource: Source;
  purpose: typeof PURPOSES[number];
  serviceTier: string | null;
  serviceTierSource: Source;
  requestedServiceTier: string | null;
  outcome: typeof OUTCOMES[number];
  tokenAvailability: "reported" | "partial" | "unavailable";
  usage: Counts | null;
  reportedCost: number | null;
}

const EVENT_KEYS = ["executionId", "provider", "model", "modelSource", "purpose", "serviceTier", "serviceTierSource", "requestedServiceTier", "outcome", "tokenAvailability", "usage", "reportedCost"];
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
const count = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const tier = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value));

/** Validate only metadata. Never persist arbitrary helper bodies or diagnostics. */
export function parseBackgroundUsageEvent(value: unknown): BackgroundUsageEvent | null {
  const event = object(value);
  if (!event || Object.keys(event).some((key) => !EVENT_KEYS.includes(key))
    || EVENT_KEYS.some((key) => !(key in event))
    || typeof event.executionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.executionId)
    || !PROVIDERS.includes(event.provider as Provider) || !identity(event.model)
    || !SOURCES.includes(event.modelSource as Source) || !PURPOSES.includes(event.purpose as BackgroundUsageEvent["purpose"])
    || !SOURCES.includes(event.serviceTierSource as Source) || !tier(event.serviceTier) || !tier(event.requestedServiceTier)
    || !OUTCOMES.includes(event.outcome as BackgroundUsageEvent["outcome"])
    || !["reported", "partial", "unavailable"].includes(String(event.tokenAvailability))
    || !(event.reportedCost === null || (typeof event.reportedCost === "number" && Number.isFinite(event.reportedCost) && event.reportedCost >= 0))) return null;
  if ((event.serviceTier === null) !== (event.serviceTierSource === "unknown")) return null;
  const usage = event.usage === null ? null : object(event.usage);
  if (event.usage !== null && (!usage || Object.keys(usage).some((key) => !TOKEN_KEYS.includes(key as typeof TOKEN_KEYS[number]))
    || TOKEN_KEYS.some((key) => !(key in usage) || !count(usage[key])))) return null;
  const any = usage && TOKEN_KEYS.some((key) => usage[key] !== null);
  const complete = usage && ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"].every((key) => usage[key] !== null);
  // A multi-turn execution can be partial even if its merged object has every
  // category: one constituent turn may have omitted a count entirely.
  if (event.tokenAvailability === "unavailable" ? usage !== null : !any
    || (event.tokenAvailability === "reported" && !complete)) return null;
  if (usage && typeof usage.inputTokens === "number") {
    const cached = typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
    const written = typeof usage.cacheWriteInputTokens === "number" ? usage.cacheWriteInputTokens
      : typeof usage.cacheWrite1hInputTokens === "number" ? usage.cacheWrite1hInputTokens : 0;
    if (cached + written > usage.inputTokens) return null;
  }
  if (usage && typeof usage.cacheWrite1hInputTokens === "number" && typeof usage.cacheWriteInputTokens === "number"
    && usage.cacheWrite1hInputTokens > usage.cacheWriteInputTokens) return null;
  if (usage && typeof usage.reasoningOutputTokens === "number" && typeof usage.outputTokens === "number"
    && usage.reasoningOutputTokens > usage.outputTokens) return null;
  return event as unknown as BackgroundUsageEvent;
}

export function recordBackgroundUsage(value: unknown): boolean {
  const event = parseBackgroundUsageEvent(value);
  if (!event) return false;
  const counts = event.usage;
  const knownWrites = counts?.cacheWriteInputTokens ?? counts?.cacheWrite1hInputTokens ?? 0;
  const knownInput = counts?.inputTokens ?? ((counts?.cachedInputTokens ?? 0) + knownWrites);
  const knownOutput = counts?.outputTokens ?? counts?.reasoningOutputTokens ?? 0;
  const usage: TokenUsageView | null = counts ? {
    inputTokens: knownInput,
    cachedInputTokens: counts.cachedInputTokens ?? 0,
    cacheWriteInputTokens: knownWrites,
    cacheWrite1hInputTokens: counts.cacheWrite1hInputTokens ?? 0,
    outputTokens: knownOutput,
    reasoningOutputTokens: counts.reasoningOutputTokens ?? 0,
    totalTokens: counts.totalTokens ?? (knownInput + knownOutput),
    // A partial multi-terminal aggregate can have every counter populated
    // even though a constituent omitted input/cache data. Without per-terminal
    // coverage, preserve its known counts but never infer a complete cache share.
    cacheReadReported: event.tokenAvailability === "reported" && counts.cachedInputTokens !== null,
    cacheWriteReported: event.tokenAvailability === "reported" && counts.cacheWriteInputTokens !== null,
    tokenAvailability: event.tokenAvailability,
    serviceTier: event.serviceTier ?? undefined,
    serviceTierSource: event.serviceTierSource,
    requestedServiceTier: event.requestedServiceTier ?? undefined,
    contextWindow: null,
  } : null;
  return recordAuxiliaryUsage({ executionId: event.executionId, provider: event.provider, model: event.model, modelSource: event.modelSource,
    purpose: event.purpose, usage, serviceTier: event.serviceTier ?? undefined, serviceTierSource: event.serviceTierSource,
    requestedServiceTier: event.requestedServiceTier ?? undefined, reportedCost: event.reportedCost ?? undefined,
    tokenAvailability: event.tokenAvailability });
}

/** Immediate cleanup works even while Tauri's asynchronous registration is pending. */
export function subscribeBackgroundUsage(onError?: () => void): UnlistenFn {
  let disposed = false;
  let stop: UnlistenFn | undefined;
  void listen<unknown>(BACKGROUND_USAGE_EVENT, ({ payload }) => {
    if (disposed) return;
    try { recordBackgroundUsage(payload); } catch { onError?.(); }
  }).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  }).catch(() => { if (!disposed) onError?.(); });
  return () => {
    if (disposed) return;
    disposed = true;
    stop?.();
  };
}
