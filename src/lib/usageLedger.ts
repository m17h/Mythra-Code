import type { TokenUsageView } from "../components/StudioDock";
import type { Provider } from "../types";
import { loadStored, storeValue } from "./storage";

export const USAGE_LEDGER_KEY = "kiwi.usageLedger";
export const MODEL_PRICING_CATALOG_KEY = "kiwi.modelPricingCatalog";
export const MODEL_PRICING_CATALOG_URL = "https://raw.githubusercontent.com/m17h/OpenKiwi/main/model-pricing.json";
const MAX_EVENT_IDS = 100;
const PERSIST_DELAY_MS = 180;
const PRICING_REFRESH_TIMEOUT_MS = 8_000;
/** The published catalog is a few kilobytes. Anything larger is a wrong or
 * hostile document, so cap the body before handing it to JSON.parse. */
const MAX_PRICING_CATALOG_BYTES = 256 * 1024;
/** Providers publish dated snapshot ids (`claude-opus-4-8-20260101`) that bill
 * at the base model's rate. A version bump like `-5-1` is a different model. */
const DATED_MODEL_SNAPSHOT = /-\d{6,8}$/;

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWriteInputPerMillion?: number;
  source: "OpenAI" | "Anthropic" | "OpenRouter";
  asOf: string;
  note?: string;
}

/** A catalog entry may carry the date its rate stops applying, so a scheduled
 * reversion (an introductory price ending) still happens on time even if the
 * published catalog is never edited again. */
export interface ModelPricingCatalogEntry extends ModelPricing {
  effectiveUntil?: string;
}

export interface ModelPricingCatalog {
  schemaVersion: 1;
  updatedAt: string;
  models: Record<string, ModelPricingCatalogEntry>;
}

export interface ThreadUsageRecord {
  threadId: string;
  provider?: Provider;
  model?: string;
  projectPath?: string;
  usage: TokenUsageView;
  /** Last cumulative snapshot received from Codex. Kept separately from the
   * monotonic all-time total so a resumed runtime can safely rebaseline. */
  cumulativeSnapshot?: TokenUsageView;
  pricing?: ModelPricing;
  estimatedCost?: number;
  pricedTokens?: number;
  unpricedTokens?: number;
  eventIds?: string[];
  updatedAt: number;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  pricedTokens: number;
  unpricedTokens: number;
  threads: number;
}

function emptyUsage(): TokenUsageView {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    contextWindow: null,
  };
}

function cleanUsage(usage: TokenUsageView): TokenUsageView {
  const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens) || 0));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Math.round(Number(usage.cachedInputTokens) || 0)));
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    Math.max(0, Math.round(Number(usage.cacheWriteInputTokens) || 0)),
  );
  return {
    totalTokens: Math.max(inputTokens + outputTokens, Math.round(Number(usage.totalTokens) || 0)),
    contextTokens: usage.contextTokens === undefined
      ? undefined
      : Math.max(0, Math.round(Number(usage.contextTokens) || 0)),
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: Math.min(outputTokens, Math.max(0, Math.round(Number(usage.reasoningOutputTokens) || 0))),
    contextWindow: usage.contextWindow ?? null,
  };
}

let cachedLedger: ThreadUsageRecord[] | null = null;
let cachedRaw: string | null | undefined;
let ledgerDirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let cachedTotals: UsageTotals | null = null;
let cachedPricingCatalog: ModelPricingCatalog | null | undefined;
let cachedPricingRaw: string | null | undefined;

function pricingSource(provider: string): ModelPricing["source"] | null {
  if (provider === "openai") return "OpenAI";
  if (provider === "claude") return "Anthropic";
  return null;
}

/** JSON `null`, `true`, `""`, and `[]` all coerce to a finite number, so a
 * numeric type check has to come first or a malformed entry becomes free. */
function finiteRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : undefined;
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
}

/** Treat the downloaded catalog as untrusted input. A malformed entry is
 * skipped and a catalog with no usable entries is rejected wholesale. */
export function parseModelPricingCatalog(value: unknown): ModelPricingCatalog | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { schemaVersion?: unknown; updatedAt?: unknown; models?: unknown };
  if (candidate.schemaVersion !== 1 || typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) return null;
  if (!candidate.models || typeof candidate.models !== "object" || Array.isArray(candidate.models)) return null;
  const models: Record<string, ModelPricingCatalogEntry> = {};
  for (const [key, raw] of Object.entries(candidate.models)) {
    const separator = key.indexOf(":");
    const provider = separator > 0 ? key.slice(0, separator) : "";
    const model = separator > 0 ? key.slice(separator + 1) : "";
    const source = pricingSource(provider);
    if (!source || !model || model.length > 160 || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const inputPerMillion = finiteRate(entry.inputPerMillion);
    const outputPerMillion = finiteRate(entry.outputPerMillion);
    if (inputPerMillion === undefined || outputPerMillion === undefined || !isCalendarDate(entry.asOf)) continue;
    const cachedInputPerMillion = entry.cachedInputPerMillion === undefined ? undefined : finiteRate(entry.cachedInputPerMillion);
    const cacheWriteInputPerMillion = entry.cacheWriteInputPerMillion === undefined ? undefined : finiteRate(entry.cacheWriteInputPerMillion);
    if ((entry.cachedInputPerMillion !== undefined && cachedInputPerMillion === undefined)
      || (entry.cacheWriteInputPerMillion !== undefined && cacheWriteInputPerMillion === undefined)) continue;
    const effectiveUntil = entry.effectiveUntil;
    if (effectiveUntil !== undefined && !isCalendarDate(effectiveUntil)) continue;
    const note = typeof entry.note === "string" && entry.note.length <= 240 ? entry.note : undefined;
    models[`${provider}:${model}`] = {
      inputPerMillion,
      outputPerMillion,
      cachedInputPerMillion,
      cacheWriteInputPerMillion,
      source,
      asOf: entry.asOf,
      note,
      effectiveUntil,
    };
  }
  return Object.keys(models).length ? { schemaVersion: 1, updatedAt: candidate.updatedAt, models } : null;
}

/** Keyed on the stored string the way `ledger()` is, so a snapshot that lands
 * after this module first read storage (native hydration, another window) is
 * picked up instead of latching the first answer forever. */
function modelPricingCatalog(): ModelPricingCatalog | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MODEL_PRICING_CATALOG_KEY);
  } catch {
    // Privacy-mode storage failures leave the bundled table as the fallback.
  }
  if (cachedPricingCatalog !== undefined && raw === cachedPricingRaw) return cachedPricingCatalog;
  cachedPricingRaw = raw;
  cachedPricingCatalog = parseModelPricingCatalog(loadStored<unknown>(MODEL_PRICING_CATALOG_KEY, null));
  return cachedPricingCatalog;
}

/** Resolve a catalog rate for `model` at time `at`, or undefined so the caller
 * falls back to the bundled table. */
function catalogPricing(provider: Provider, model: string, at: Date): ModelPricingCatalogEntry | undefined {
  const catalog = modelPricingCatalog();
  if (!catalog) return undefined;
  const exact = catalog.models[`${provider}:${model}`];
  const base = model.replace(DATED_MODEL_SNAPSHOT, "");
  const entry = exact ?? (base === model ? undefined : catalog.models[`${provider}:${base}`]);
  if (!entry) return undefined;
  return entry.effectiveUntil && at.getTime() >= Date.parse(entry.effectiveUntil) ? undefined : entry;
}

export function modelPricingCatalogRevision(): string {
  return modelPricingCatalog()?.updatedAt ?? "bundled";
}

/** Refresh once at launch. The last valid snapshot remains available offline;
 * a stale or malformed response can never replace a newer cached catalog. */
export async function refreshModelPricingCatalog(
  fetcher: typeof fetch = fetch,
  url = MODEL_PRICING_CATALOG_URL,
): Promise<ModelPricingCatalog | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICING_REFRESH_TIMEOUT_MS);
  try {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetcher(`${url}${separator}openkiwi=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Pricing catalog request failed (${response.status})`);
    const body = await response.text();
    if (body.length > MAX_PRICING_CATALOG_BYTES) throw new Error("Pricing catalog response was too large");
    const parsed = parseModelPricingCatalog(JSON.parse(body));
    if (!parsed) throw new Error("Pricing catalog response was invalid");
    const current = modelPricingCatalog();
    if (current && Date.parse(parsed.updatedAt) < Date.parse(current.updatedAt)) return current;
    storeValue(MODEL_PRICING_CATALOG_KEY, parsed);
    cachedPricingCatalog = parsed;
    try {
      cachedPricingRaw = localStorage.getItem(MODEL_PRICING_CATALOG_KEY);
    } catch {
      // Storage is unavailable; keep the freshly fetched catalog authoritative
      // for this session rather than re-reading nothing over it.
      cachedPricingRaw = null;
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function ledger(): ThreadUsageRecord[] {
  if (cachedLedger && ledgerDirty) return cachedLedger;
  const raw = localStorage.getItem(USAGE_LEDGER_KEY);
  if (cachedLedger && raw === cachedRaw) return cachedLedger;
  cachedRaw = raw;
  const stored = loadStored<ThreadUsageRecord[]>(USAGE_LEDGER_KEY, []);
  cachedLedger = (Array.isArray(stored) ? stored : []).map((record) => ({
    ...record,
    usage: cleanUsage(record.usage),
    cumulativeSnapshot: record.cumulativeSnapshot ? cleanUsage(record.cumulativeSnapshot) : undefined,
  }));
  cachedTotals = null;
  return cachedLedger;
}

export function flushUsageLedger(): void {
  if (!ledgerDirty || !cachedLedger) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const records = [...cachedLedger].sort((left, right) => right.updatedAt - left.updatedAt);
  cachedLedger = records;
  cachedRaw = JSON.stringify(records);
  ledgerDirty = false;
  storeValue(USAGE_LEDGER_KEY, records);
}

function save(records: ThreadUsageRecord[]): void {
  cachedLedger = records;
  cachedTotals = null;
  ledgerDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushUsageLedger();
  }, PERSIST_DELAY_MS);
}

/** Clears module caches after tests or explicit storage resets. */
export function resetUsageLedgerCache(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  cachedLedger = null;
  cachedRaw = undefined;
  cachedTotals = null;
  ledgerDirty = false;
  cachedPricingCatalog = undefined;
  cachedPricingRaw = undefined;
}

function positiveUsageDelta(next: TokenUsageView, previous: TokenUsageView): TokenUsageView {
  const inputTokens = Math.max(0, next.inputTokens - previous.inputTokens);
  const outputTokens = Math.max(0, next.outputTokens - previous.outputTokens);
  return cleanUsage({
    totalTokens: Math.max(inputTokens + outputTokens, next.totalTokens - previous.totalTokens),
    inputTokens,
    cachedInputTokens: Math.max(0, next.cachedInputTokens - previous.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, (next.cacheWriteInputTokens ?? 0) - (previous.cacheWriteInputTokens ?? 0)),
    outputTokens,
    reasoningOutputTokens: Math.max(0, next.reasoningOutputTokens - previous.reasoningOutputTokens),
    contextWindow: next.contextWindow,
  });
}

function addUsage(
  previous: TokenUsageView,
  delta: TokenUsageView,
  contextWindow = delta.contextWindow,
  contextTokens = previous.contextTokens,
): TokenUsageView {
  return cleanUsage({
    totalTokens: previous.totalTokens + delta.totalTokens,
    contextTokens,
    inputTokens: previous.inputTokens + delta.inputTokens,
    cachedInputTokens: previous.cachedInputTokens + delta.cachedInputTokens,
    cacheWriteInputTokens: (previous.cacheWriteInputTokens ?? 0) + (delta.cacheWriteInputTokens ?? 0),
    outputTokens: previous.outputTokens + delta.outputTokens,
    reasoningOutputTokens: previous.reasoningOutputTokens + delta.reasoningOutputTokens,
    contextWindow: contextWindow ?? previous.contextWindow,
  });
}

function snapshotReset(next: TokenUsageView, previous: TokenUsageView): boolean {
  return next.inputTokens < previous.inputTokens
    || next.outputTokens < previous.outputTokens
    || next.cachedInputTokens < previous.cachedInputTokens
    || (next.cacheWriteInputTokens ?? 0) < (previous.cacheWriteInputTokens ?? 0)
    || next.reasoningOutputTokens < previous.reasoningOutputTokens
    || next.totalTokens < previous.totalTokens;
}

function tokensIn(usage: TokenUsageView): number {
  return usage.inputTokens + usage.outputTokens;
}

function withCostDelta(record: ThreadUsageRecord, delta: TokenUsageView): Pick<ThreadUsageRecord, "estimatedCost" | "pricedTokens" | "unpricedTokens"> {
  const tokens = tokensIn(delta);
  const cost = estimateUsageCost(delta, record.pricing);
  return cost === null
    ? {
        estimatedCost: record.estimatedCost ?? 0,
        pricedTokens: record.pricedTokens ?? 0,
        unpricedTokens: (record.unpricedTokens ?? 0) + tokens,
      }
    : {
        estimatedCost: (record.estimatedCost ?? 0) + cost,
        pricedTokens: (record.pricedTokens ?? 0) + tokens,
        unpricedTokens: record.unpricedTokens ?? 0,
      };
}

function upsert(threadId: string, update: (record: ThreadUsageRecord) => ThreadUsageRecord): ThreadUsageRecord {
  const records = ledger();
  const index = records.findIndex((record) => record.threadId === threadId);
  const current = index >= 0
    ? records[index]
    : { threadId, usage: emptyUsage(), updatedAt: Date.now() };
  const next = update(current);
  if (next === current) return current;
  if (index >= 0) records[index] = next;
  else records.push(next);
  save(records);
  return next;
}

/** Codex reports a cumulative runtime snapshot. Accumulate its deltas into a
 * monotonic thread total and rebaseline without shrinking when a resume starts
 * a fresh, lower runtime counter. */
export function recordCumulativeUsage(threadId: string, usage: TokenUsageView): TokenUsageView {
  return upsert(threadId, (record) => {
    const nextSnapshot = cleanUsage(usage);
    const previousSnapshot = record.cumulativeSnapshot ?? record.usage;
    const reset = tokensIn(record.usage) > 0 && snapshotReset(nextSnapshot, previousSnapshot);
    const delta = reset ? emptyUsage() : positiveUsageDelta(nextSnapshot, previousSnapshot);
    return {
      ...record,
      ...withCostDelta(record, delta),
      usage: addUsage(record.usage, delta, nextSnapshot.contextWindow, nextSnapshot.totalTokens),
      cumulativeSnapshot: nextSnapshot,
      updatedAt: Date.now(),
    };
  }).usage;
}

/** Claude reports a per-run result, so add it exactly once to the thread. */
export function recordUsageDelta(
  threadId: string,
  usage: TokenUsageView,
  eventId?: string,
): TokenUsageView {
  return upsert(threadId, (record) => {
    if (eventId && record.eventIds?.includes(eventId)) return record;
    const delta = cleanUsage(usage);
    const nextUsage = addUsage(record.usage, delta);
    const eventIds = eventId
      ? [...(record.eventIds ?? []).filter((id) => id !== eventId), eventId].slice(-MAX_EVENT_IDS)
      : record.eventIds;
    return {
      ...record,
      ...withCostDelta(record, delta),
      usage: nextUsage,
      eventIds,
      updatedAt: Date.now(),
    };
  }).usage;
}

export function annotateThreadUsage(
  threadId: string,
  metadata: {
    provider: Provider;
    model: string;
    projectPath?: string;
    pricing?: ModelPricing;
  },
): void {
  if (!threadId) return;
  upsert(threadId, (record) => {
    const sameModel = record.provider === metadata.provider && record.model === metadata.model;
    const proposedPricing = metadata.pricing
      ?? pricingForModel(metadata.provider, metadata.model)
      ?? (sameModel ? record.pricing : undefined);
    const pricing = samePricing(proposedPricing, record.pricing) ? record.pricing : proposedPricing;
    const unchanged = record.provider === metadata.provider
      && record.model === metadata.model
      && record.projectPath === metadata.projectPath
      && record.pricing === pricing;
    if (unchanged) return record;
    // Records written before per-delta cost accumulation carry no frozen total,
    // so usageTotals recomputes them from whatever rate is on the record. Seal
    // such a record at its outgoing price before a refreshed rate replaces it,
    // or a catalog update would silently reprice history.
    const stale = record.estimatedCost === undefined && tokensIn(record.usage) > 0;
    const sealedTokens = stale ? tokensIn(record.usage) : 0;
    return {
      ...record,
      ...metadata,
      pricing,
      ...(stale ? {
        estimatedCost: estimateUsageCost(record.usage, record.pricing) ?? 0,
        pricedTokens: record.pricing ? sealedTokens : 0,
        unpricedTokens: record.pricing ? 0 : sealedTokens,
      } : {}),
      updatedAt: Date.now(),
    };
  });
}

function samePricing(left?: ModelPricing, right?: ModelPricing): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.inputPerMillion === right.inputPerMillion
    && left.outputPerMillion === right.outputPerMillion
    && left.cachedInputPerMillion === right.cachedInputPerMillion
    && left.cacheWriteInputPerMillion === right.cacheWriteInputPerMillion
    && left.source === right.source
    && left.asOf === right.asOf
    && left.note === right.note;
}

export function usageForThread(threadId: string): ThreadUsageRecord | null {
  return ledger().find((record) => record.threadId === threadId) ?? null;
}

export function pricingForModel(provider: Provider, model: string, at = new Date()): ModelPricing | undefined {
  const refreshed = catalogPricing(provider, model, at);
  if (refreshed) return refreshed;
  if (provider === "openai") {
    if (model === "gpt-5.6-sol" || model === "gpt-5.6") {
      return { inputPerMillion: 5, cachedInputPerMillion: 0.5, cacheWriteInputPerMillion: 6.25, outputPerMillion: 30, source: "OpenAI", asOf: "2026-07-28" };
    }
    if (model === "gpt-5.6-terra") {
      return { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, cacheWriteInputPerMillion: 3.125, outputPerMillion: 15, source: "OpenAI", asOf: "2026-07-28" };
    }
    if (model === "gpt-5.6-luna") {
      return { inputPerMillion: 1, cachedInputPerMillion: 0.1, cacheWriteInputPerMillion: 1.25, outputPerMillion: 6, source: "OpenAI", asOf: "2026-07-28" };
    }
  }
  if (provider === "claude") {
    if (model === "claude-fable-5") {
      return { inputPerMillion: 10, cachedInputPerMillion: 1, cacheWriteInputPerMillion: 12.5, outputPerMillion: 50, source: "Anthropic", asOf: "2026-07-28" };
    }
    if (model === "claude-sonnet-5") {
      const introductory = at.getTime() < Date.UTC(2026, 8, 1);
      return {
        inputPerMillion: introductory ? 2 : 3,
        cachedInputPerMillion: introductory ? 0.2 : 0.3,
        cacheWriteInputPerMillion: introductory ? 2.5 : 3.75,
        outputPerMillion: introductory ? 10 : 15,
        source: "Anthropic",
        asOf: "2026-07-28",
        note: introductory ? "Introductory pricing through August 31, 2026" : undefined,
      };
    }
    if (model === "claude-haiku-4-5") {
      return { inputPerMillion: 1, cachedInputPerMillion: 0.1, cacheWriteInputPerMillion: 1.25, outputPerMillion: 5, source: "Anthropic", asOf: "2026-07-28" };
    }
    if (model === "claude-opus-5" || model.startsWith("claude-opus-4-8")) {
      return {
        inputPerMillion: 5,
        cachedInputPerMillion: 0.5,
        cacheWriteInputPerMillion: 6.25,
        outputPerMillion: 25,
        source: "Anthropic",
        asOf: "2026-07-28",
        note: model === "claude-opus-5" ? "Same rate as Claude Opus 4.8" : undefined,
      };
    }
  }
  return undefined;
}

export function estimateUsageCost(usage: TokenUsageView, pricing?: ModelPricing): number | null {
  if (!pricing) return null;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const cacheWrite = Math.min(
    Math.max(0, usage.inputTokens - cached),
    Math.max(0, usage.cacheWriteInputTokens ?? 0),
  );
  const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
  return (
    uncached * pricing.inputPerMillion
    + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
    + cacheWrite * (pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion)
    + usage.outputTokens * pricing.outputPerMillion
  ) / 1_000_000;
}

export function usageTotals(): UsageTotals {
  if (cachedTotals) return cachedTotals;
  const totals: UsageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    threads: 0,
  };
  for (const record of ledger()) {
    const { usage } = record;
    if (tokensIn(usage) === 0) continue;
    totals.inputTokens += usage.inputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningOutputTokens += usage.reasoningOutputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.threads += 1;
    const cost = record.estimatedCost ?? estimateUsageCost(usage, record.pricing);
    totals.estimatedCost += cost ?? 0;
    totals.pricedTokens += record.pricedTokens ?? (cost === null ? 0 : tokensIn(usage));
    totals.unpricedTokens += record.unpricedTokens ?? (cost === null ? tokensIn(usage) : 0);
  }
  cachedTotals = totals;
  return cachedTotals;
}

export function formatEstimatedCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushUsageLedger);
}
