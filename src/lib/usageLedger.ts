import type { TokenUsageView } from "../components/StudioDock";
import type { Provider } from "../types";
import { loadStored, readStoredRaw, storeValue } from "./storage";
import type { UsageHistoryDelta } from "./usageHistory";

export const USAGE_LEDGER_KEY = "kiwi.usageLedger";
export const USAGE_HISTORY_KEY = "kiwi.usageHistory";
export const MODEL_PRICING_CATALOG_KEY = "kiwi.modelPricingCatalog";
export const OFFICIAL_PRICING_KEY = "kiwi.officialModelPricing";
export const MODEL_PRICING_CATALOG_URL = "https://raw.githubusercontent.com/m17h/Mythra-Code/main/model-pricing.json";
const MAX_EVENT_IDS = 100;
const MAX_RECEIPT_IDS = 1000;
const PERSIST_DELAY_MS = 180;
const PRICING_REFRESH_TIMEOUT_MS = 8_000;
/** The published catalog is a few kilobytes. Anything larger is a wrong or
 * hostile document, so cap the body before handing it to JSON.parse. */
const MAX_PRICING_CATALOG_BYTES = 256 * 1024;
/** Providers publish dated snapshot ids (`claude-opus-4-8-20260101`) that bill
 * at the base model's rate. A version bump like `-5-1` is a different model. */
const DATED_MODEL_SNAPSHOT = /-\d{6,8}$/;
/** Date the bundled fallback rates were last checked against the providers'
 * official pricing pages. Rates are chosen per model by the date each was
 * verified, so a cached catalog entry older than this never reinstates an
 * outdated price; it still supplies models the bundled table lacks. */
export const BUNDLED_PRICING_AS_OF = "2026-09-25";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  /** 5-minute cache writes, or the only cache-write rate a provider lists. */
  cacheWriteInputPerMillion?: number;
  /** Claude's 1-hour cache writes. */
  cacheWrite1hInputPerMillion?: number;
  source: "OpenAI" | "Anthropic" | "OpenRouter" | "Cursor";
  /** The day this rate was last verified against its source. */
  asOf: string;
  /** Where the rate came from: the provider's pricing page read by this app,
   * the published Mythra catalog, or the table bundled with this build. */
  origin?: "official" | "catalog" | "bundled";
  note?: string;
}

/** A catalog entry may carry the moment its rate stops applying, so a scheduled
 * reversion (an introductory price ending) still happens on time even if the
 * published catalog is never edited again. */
export interface ModelPricingCatalogEntry extends ModelPricing {
  effectiveUntil?: string;
  /** Catalog entries only: UTC day or exact UTC timestamp when this rate took
   * effect. A day means midnight UTC; use a timestamp for a mid-day change. */
  effectiveFrom?: string;
  /** Official entries only: still priced if used, but not offered for comparison. */
  status?: "retired" | "limited";
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
  /** Frozen provider attribution survives model/provider changes and retention. */
  providerUsage?: Partial<Record<UsageProvider, UsageAmounts>>;
  /** Cost-only receipts never contribute tokens or thread counts. */
  kind?: "openrouter-charge" | "pricing-correction";
  reportedCost?: number;
  reportedRequests?: number;
  eventIds?: string[];
  /** This thread's unique count already lives in the archive record. Its
   * resumed deltas still contribute tokens, but must not add another thread. */
  countedInArchive?: boolean;
  /** Set only on the synthetic archive record: how many pruned thread records
   * it stands for, so all-time totals keep an accurate thread count. */
  archivedThreads?: number;
  /** Set only on the synthetic repricing record: net cost change and tokens
   * moved from unpriced to priced, per provider, by dated corrections. */
  corrections?: Partial<Record<UsageProvider, UsageCorrection>>;
  /** Recently applied correction ids, so a repeated pass never adds twice. */
  appliedCorrections?: string[];
  /** Last correction per dated cohort. Its absolute delta and target rate let
   * either storage key recover when native writes finish in the other order. */
  correctionCheckpoints?: Record<string, PricingCorrectionCheckpoint>;
  /** Cohorts earlier than this retained day were deliberately discarded. A
   * stale native history copy must never replay their retired checkpoints. */
  correctionPrunedBefore?: string;
  /** Durable identities let a pruned thread resume without incrementing the
   * all-time thread count a second time. */
  archivedThreadIds?: string[];
  /** Cumulative-provider baselines retained after pruning, so a resumed Codex
   * counter only contributes usage newer than the archived snapshot. */
  archivedSnapshots?: Record<string, TokenUsageView>;
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

export type UsageProvider = Provider | "unknown";
export interface UsageCorrection { cost: number; tokens: number }
export type UsageAmounts = Omit<UsageTotals, "threads">;
export interface ProviderUsageTotals extends UsageAmounts { provider: UsageProvider }
const USAGE_PROVIDERS: UsageProvider[] = ["openai", "claude", "openrouter", "cursor", "lmstudio", "unknown"];
const AMOUNT_KEYS: Array<keyof UsageAmounts> = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "estimatedCost", "pricedTokens", "unpricedTokens"];
const usageListeners = new Set<() => void>();
let usageRevision = 0;
export function subscribeUsage(listener: () => void): () => void {
  usageListeners.add(listener);
  return () => { usageListeners.delete(listener); };
}
export function getUsageRevision(): number { return usageRevision; }
function notifyUsage(): void {
  usageRevision += 1;
  for (const listener of usageListeners) listener();
}
export interface PricingRefreshStatus {
  checking: boolean;
  checkedAt?: number;
  error?: string;
}
let pricingStatus: PricingRefreshStatus = { checking: false };
export function pricingRefreshStatus(): PricingRefreshStatus { return pricingStatus; }
let openRouterPrices = new Map<string, ModelPricing>();
export function updateOpenRouterPricing(models: Array<{ id: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }>): void {
  const next = new Map<string, ModelPricing>();
  const rate = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    return finiteRate(Number(value) * 1_000_000);
  };
  for (const model of models) {
    const inputPerMillion = rate(model.pricing?.prompt);
    const outputPerMillion = rate(model.pricing?.completion);
    if (inputPerMillion === undefined || outputPerMillion === undefined) continue;
    next.set(model.id, { inputPerMillion, outputPerMillion,
      cachedInputPerMillion: rate(model.pricing?.input_cache_read),
      cacheWriteInputPerMillion: rate(model.pricing?.input_cache_write),
      source: "OpenRouter", asOf: new Date().toISOString().slice(0, 10),
    });
  }
  if (next.size) openRouterPrices = next;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
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
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(usage.cachedInputTokens));
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    tokenCount(usage.cacheWriteInputTokens),
  );
  const cacheWrite1hInputTokens = Math.min(cacheWriteInputTokens, tokenCount(usage.cacheWrite1hInputTokens));
  return {
    totalTokens: Math.max(inputTokens + outputTokens, tokenCount(usage.totalTokens)),
    contextTokens: usage.contextTokens === undefined
      ? undefined
      : tokenCount(usage.contextTokens),
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    ...(cacheWrite1hInputTokens ? { cacheWrite1hInputTokens } : {}),
    outputTokens,
    reasoningOutputTokens: Math.min(outputTokens, tokenCount(usage.reasoningOutputTokens)),
    contextWindow: usage.contextWindow ?? null,
  };
}

let cachedLedger: ThreadUsageRecord[] | null = null;
let cachedRaw: string | null | undefined;
let ledgerDirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let cachedTotals: UsageTotals | null = null;
const catalogCache = new Map<string, { raw: string | null; catalog: ModelPricingCatalog | null }>();

/** Cursor rates only ever come from Cursor's own page, never the catalog. */
export function pricingSource(provider: string, official: boolean): ModelPricing["source"] | null {
  if (provider === "openai") return "OpenAI";
  if (provider === "claude") return "Anthropic";
  if (provider === "cursor" && official) return "Cursor";
  return null;
}

/** JSON `null`, `true`, `""`, and `[]` all coerce to a finite number, so a
 * numeric type check has to come first or a malformed entry becomes free. */
export function finiteRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : undefined;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/** A date is exactly midnight UTC; an intraday change must state its UTC
 * instant rather than silently applying the rate from that day's start. */
function effectiveMoment(value: unknown): number | undefined {
  if (isCalendarDate(value)) return Date.parse(value);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return new Date(at).toISOString() === (value.includes(".") ? value : `${value.slice(0, -1)}.000Z`) ? at : undefined;
}

/** Treat the downloaded catalog as untrusted input. A malformed entry is
 * skipped and a catalog with no usable entries is rejected wholesale. The
 * stored official rates use the same shape and must also be positive. */
export function parseModelPricingCatalog(value: unknown, official = false): ModelPricingCatalog | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { schemaVersion?: unknown; updatedAt?: unknown; models?: unknown };
  if (candidate.schemaVersion !== 1 || typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) return null;
  if (!candidate.models || typeof candidate.models !== "object" || Array.isArray(candidate.models)) return null;
  const models: Record<string, ModelPricingCatalogEntry> = {};
  for (const [key, raw] of Object.entries(candidate.models)) {
    const separator = key.indexOf(":");
    const provider = separator > 0 ? key.slice(0, separator) : "";
    const model = separator > 0 ? key.slice(separator + 1) : "";
    const source = pricingSource(provider, official);
    if (!source || !model || model.length > 160 || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const inputPerMillion = finiteRate(entry.inputPerMillion);
    const outputPerMillion = finiteRate(entry.outputPerMillion);
    if (inputPerMillion === undefined || outputPerMillion === undefined || !isCalendarDate(entry.asOf)) continue;
    if (official && !(inputPerMillion > 0 && outputPerMillion > 0)) continue;
    const cachedInputPerMillion = entry.cachedInputPerMillion === undefined ? undefined : finiteRate(entry.cachedInputPerMillion);
    const cacheWriteInputPerMillion = entry.cacheWriteInputPerMillion === undefined ? undefined : finiteRate(entry.cacheWriteInputPerMillion);
    const cacheWrite1hInputPerMillion = entry.cacheWrite1hInputPerMillion === undefined ? undefined : finiteRate(entry.cacheWrite1hInputPerMillion);
    if ((entry.cachedInputPerMillion !== undefined && cachedInputPerMillion === undefined)
      || (entry.cacheWriteInputPerMillion !== undefined && cacheWriteInputPerMillion === undefined)
      || (entry.cacheWrite1hInputPerMillion !== undefined && cacheWrite1hInputPerMillion === undefined)) continue;
    const effectiveUntil = typeof entry.effectiveUntil === "string" ? entry.effectiveUntil : undefined;
    if (entry.effectiveUntil !== undefined && effectiveUntil === undefined) continue;
    const untilAt = effectiveUntil === undefined ? undefined : effectiveMoment(effectiveUntil);
    if (effectiveUntil !== undefined && untilAt === undefined) continue;
    // Only the maintained catalog may attest a period; a page read by this app
    // knows only when it saw a rate.
    const effectiveFrom = official || entry.effectiveFrom === undefined ? undefined
      : typeof entry.effectiveFrom === "string" ? entry.effectiveFrom : undefined;
    if (!official && entry.effectiveFrom !== undefined && effectiveFrom === undefined) continue;
    const fromAt = effectiveFrom === undefined ? undefined : effectiveMoment(effectiveFrom);
    if (effectiveFrom !== undefined && (fromAt === undefined || fromAt >= Date.parse(entry.asOf) + 86_400_000
      || (untilAt !== undefined && fromAt >= untilAt))) continue;
    const note = typeof entry.note === "string" && entry.note.length <= 240 ? entry.note : undefined;
    models[`${provider}:${model}`] = {
      inputPerMillion,
      outputPerMillion,
      cachedInputPerMillion,
      cacheWriteInputPerMillion,
      ...(cacheWrite1hInputPerMillion !== undefined ? { cacheWrite1hInputPerMillion } : {}),
      source,
      asOf: entry.asOf,
      note,
      effectiveUntil,
      ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
      ...(official && (entry.status === "retired" || entry.status === "limited") ? { status: entry.status } : {}),
    };
  }
  return Object.keys(models).length ? { schemaVersion: 1, updatedAt: candidate.updatedAt, models } : null;
}

/** Keyed on the stored string the way `ledger()` is, so a snapshot that lands
 * after this module first read storage (native hydration, another window, the
 * official refresh) is picked up instead of latching the first answer forever. */
function storedCatalog(key: typeof MODEL_PRICING_CATALOG_KEY | typeof OFFICIAL_PRICING_KEY): ModelPricingCatalog | null {
  const raw = readStoredRaw(key);
  const cached = catalogCache.get(key);
  if (cached && raw === cached.raw) return cached.catalog;
  const catalog = parseModelPricingCatalog(loadStored<unknown>(key, null), key === OFFICIAL_PRICING_KEY);
  catalogCache.set(key, { raw, catalog });
  return catalog;
}

function modelPricingCatalog(): ModelPricingCatalog | null {
  return storedCatalog(MODEL_PRICING_CATALOG_KEY);
}

/** Resolve a catalog rate for `model` at time `at`, or undefined so the caller
 * falls back to the bundled table. */
function catalogEntry(provider: Provider, model: string): ModelPricingCatalogEntry | undefined {
  const catalog = modelPricingCatalog();
  if (!catalog) return undefined;
  const exact = catalog.models[`${provider}:${model}`];
  const base = model.replace(DATED_MODEL_SNAPSHOT, "");
  return exact ?? (base === model ? undefined : catalog.models[`${provider}:${base}`]);
}

function catalogPricing(provider: Provider, model: string, at: Date): ModelPricingCatalogEntry | undefined {
  const entry = catalogEntry(provider, model);
  if (!entry) return undefined;
  if (entry.effectiveFrom && at.getTime() < Date.parse(entry.effectiveFrom)) return undefined;
  return entry.effectiveUntil && at.getTime() >= Date.parse(entry.effectiveUntil) ? undefined : entry;
}

export function modelPricingCatalogRevision(): string {
  return modelPricingCatalog()?.updatedAt ?? "bundled";
}

/** Changes whenever any rate source does, so the active thread re-reads its rate. */
export function pricingRevision(): string {
  return `${modelPricingCatalogRevision()}|${storedCatalog(OFFICIAL_PRICING_KEY)?.updatedAt ?? ""}|${[...cursorModelNames.values()].join("\n")}`;
}

/** Refresh once at launch. The last valid snapshot remains available offline;
 * a stale or malformed response can never replace a newer cached catalog. */
export async function refreshModelPricingCatalog(
  fetcher: typeof fetch = fetch,
  url = MODEL_PRICING_CATALOG_URL,
): Promise<ModelPricingCatalog | null> {
  pricingStatus = { ...pricingStatus, checking: true, error: undefined };
  notifyUsage();
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
    const changed = JSON.stringify(parsed) !== JSON.stringify(current);
    storeValue(MODEL_PRICING_CATALOG_KEY, parsed);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(MODEL_PRICING_CATALOG_KEY);
    } catch {
      // Storage is unavailable; keep the freshly fetched catalog authoritative
      // for this session rather than re-reading nothing over it.
    }
    catalogCache.set(MODEL_PRICING_CATALOG_KEY, { raw, catalog: parsed });
    if (changed) requestUsageRepricing();
    return parsed;
  } catch (error) {
    pricingStatus = { ...pricingStatus, error: "Could not refresh pricing. Last known rates remain in use." };
    throw error;
  } finally {
    clearTimeout(timeout);
    pricingStatus = { ...pricingStatus, checking: false, checkedAt: Date.now() };
    notifyUsage();
  }
}

/**
 * Rates read from the providers' own pricing pages. `officialPricing` loads on
 * demand, parses the pages, and stores validated results under
 * `OFFICIAL_PRICING_KEY` in the catalog's shape. Keys are `openai:`, `claude:`
 * or `cursor:` (Cursor by normalized display name), and each entry is dated by
 * the day it was last seen. The ledger reads them back through the catalog's
 * own validator, so the parsers stay out of the startup bundle.
 */
let cursorModelNames = new Map<string, string>();

/** For `officialPricing`, after it stores a result or starts or ends a check. */
export function notifyPricingChanged(): void { notifyUsage(); }

/** Cursor's pricing page and its live model catalog share display names, not
 * ids. Names match only exactly, ignoring case, spacing and parentheses. */
export function cursorPricingKey(name: string): string {
  return name.toLowerCase().replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

/** The live Cursor catalog (`cursor_models`), so a model id can be matched to
 * its published name. */
export function updateCursorModelNames(models: Array<{ id: string; name: string }>): void {
  const next = new Map<string, string>();
  for (const model of models) if (model.id && model.name) next.set(model.id, model.name);
  if (!next.size) return;
  const changed = next.size !== cursorModelNames.size || [...next].some(([id, name]) => cursorModelNames.get(id) !== name);
  cursorModelNames = next;
  // Names only matter as evidence once a Cursor page read has been stored.
  if (changed && Object.keys(storedCatalog(OFFICIAL_PRICING_KEY)?.models ?? {}).some((key) => key.startsWith("cursor:"))) requestUsageRepricing();
}

function asPricing(entry: ModelPricingCatalogEntry | undefined, origin: ModelPricing["origin"]): ModelPricing | undefined {
  if (!entry) return undefined;
  const { effectiveUntil: _effectiveUntil, effectiveFrom: _effectiveFrom, status: _status, ...pricing } = entry;
  return { ...pricing, origin };
}

function cursorOfficialKey(model: string): string | undefined {
  const name = cursorModelNames.get(model);
  const key = name ? cursorPricingKey(name) : "";
  // Auto bills at whichever model it routed to, which Cursor doesn't report.
  if (!key || key === "auto" || model.trim().toLowerCase() === "auto") return undefined;
  return `cursor:${key}`;
}

function cursorPricing(model: string): ModelPricing | undefined {
  const key = cursorOfficialKey(model);
  return key ? asPricing(storedCatalog(OFFICIAL_PRICING_KEY)?.models[key], "official") : undefined;
}

/** The official key `model` is priced under: exact, then its base or alias. */
function officialKey(provider: Provider, model: string, has: (key: string) => boolean): string | undefined {
  const base = model.replace(DATED_MODEL_SNAPSHOT, "");
  // OpenAI bills `gpt-5.6` as Sol but lists only `gpt-5.6-sol`.
  const alias = provider === "openai" && model === "gpt-5.6" ? "gpt-5.6-sol" : base;
  return [`${provider}:${model}`, `${provider}:${alias}`].find(has);
}

function officialModelPricing(provider: Provider, model: string): ModelPricing | undefined {
  const models = storedCatalog(OFFICIAL_PRICING_KEY)?.models;
  if (!models) return undefined;
  const key = officialKey(provider, model, (candidate) => candidate in models);
  return key ? asPricing(models[key], "official") : undefined;
}

/** For `pricingEvidence`: the stored official key a model is priced under,
 * given the keys that exist, and the catalog entry it would use. */
export function evidenceSources(provider: UsageProvider, model: string, has: (key: string) => boolean): { key?: string; catalog?: ModelPricingCatalogEntry } {
  if (provider === "claude" && model === "unattributed") return {};
  if (provider === "cursor") return { key: cursorOfficialKey(model) };
  if (provider !== "openai" && provider !== "claude") return {};
  if (provider === "claude") model = claudeCanonicalModel(model);
  return { key: officialKey(provider, model, has), catalog: catalogEntry(provider, model) };
}

function ledger(): ThreadUsageRecord[] {
  if (cachedLedger && ledgerDirty) return cachedLedger;
  let raw: string | null = null;
  try { raw = localStorage.getItem(USAGE_LEDGER_KEY); } catch { /* Usage must not prevent starting a provider when storage is unavailable. */ }
  if (cachedLedger && raw === cachedRaw) return cachedLedger;
  cachedRaw = raw;
  const stored = loadStored<ThreadUsageRecord[]>(USAGE_LEDGER_KEY, []);
  cachedLedger = (Array.isArray(stored) ? stored : []).filter((record) => record && typeof record.threadId === "string" && record.usage && typeof record.usage === "object").map((record) => {
    const archivedThreadIds = Array.isArray(record.archivedThreadIds)
      ? [...new Set(record.archivedThreadIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]
      : undefined;
    const archivedSnapshots = record.archivedSnapshots && typeof record.archivedSnapshots === "object"
      ? Object.fromEntries(Object.entries(record.archivedSnapshots)
          .filter(([threadId, snapshot]) => Boolean(threadId.trim()) && snapshot && typeof snapshot === "object")
          .map(([threadId, snapshot]) => [threadId, cleanUsage(snapshot)]))
      : undefined;
    const normalized: ThreadUsageRecord = {
      ...record,
      usage: cleanUsage(record.usage),
      cumulativeSnapshot: record.cumulativeSnapshot ? cleanUsage(record.cumulativeSnapshot) : undefined,
      archivedThreadIds,
      archivedSnapshots,
    };
    if (record.providerUsage !== undefined) normalized.providerUsage = readProviderParts(record.providerUsage, normalized);
    if (record.kind === "pricing-correction") {
      normalized.corrections = readCorrections(record.corrections);
      normalized.appliedCorrections = Array.isArray(record.appliedCorrections)
        ? record.appliedCorrections.filter((id): id is string => typeof id === "string" && id.length <= 200)
        : [];
      normalized.correctionCheckpoints = readCorrectionCheckpoints(record.correctionCheckpoints);
      normalized.correctionPrunedBefore = isCalendarDate(record.correctionPrunedBefore) ? record.correctionPrunedBefore : undefined;
    } else {
      delete normalized.corrections;
      delete normalized.appliedCorrections;
      delete normalized.correctionCheckpoints;
      delete normalized.correctionPrunedBefore;
    }
    return normalized;
  });
  cachedTotals = null;
  return cachedLedger;
}

/** Threads quiet this long fold into the archive record on the next flush. */
const USAGE_RETENTION_MS = 90 * 86_400_000;
const USAGE_ARCHIVE_THREAD_ID = "openkiwi:archived-usage";

/**
 * The ledger keeps one record per thread forever so all-time totals survive
 * thread deletion; without retention it grows without bound. Fold records
 * whose last usage is older than the retention window into one synthetic
 * archive record that preserves every number `usageTotals` reports. The
 * archive also retains compact thread identities and cumulative baselines, so
 * a folded thread can resume without double-counting either its identity or
 * the provider's still-cumulative runtime counters.
 */
export function compactUsageRecords(records: ThreadUsageRecord[], now = Date.now()): ThreadUsageRecord[] {
  const cutoff = now - USAGE_RETENTION_MS;
  const stale = records.filter(
    (record) => record.threadId !== USAGE_ARCHIVE_THREAD_ID && !record.kind && record.updatedAt < cutoff,
  );
  if (stale.length === 0) return records;
  let archive = records.find((record) => record.threadId === USAGE_ARCHIVE_THREAD_ID) ?? {
    threadId: USAGE_ARCHIVE_THREAD_ID,
    usage: emptyUsage(),
    estimatedCost: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    archivedThreads: 0,
    updatedAt: 0,
  };
  for (const record of stale) {
    if (record.usage.totalTokens === 0 && !record.reportedRequests) continue;
    const archivedAmounts = amountsFor(archive);
    const cost = record.estimatedCost ?? estimateUsageCost(record.usage, record.pricing);
    const archivedThreadIds = new Set(archive.archivedThreadIds ?? []);
    const alreadyCounted = record.countedInArchive === true || archivedThreadIds.has(record.threadId);
    archivedThreadIds.add(record.threadId);
    const archivedSnapshots = {
      ...(archive.archivedSnapshots ?? {}),
      ...(record.cumulativeSnapshot ? { [record.threadId]: record.cumulativeSnapshot } : {}),
    };
    archive = {
      ...archive,
      providerUsage: mergeProviderUsage(providerParts(archive), providerParts(record)),
      usage: addUsage(archive.usage, record.usage),
      reportedCost: (archive.reportedCost ?? 0) + (record.reportedCost ?? 0),
      reportedRequests: (archive.reportedRequests ?? 0) + (record.reportedRequests ?? 0),
      estimatedCost: archivedAmounts.estimatedCost + (cost ?? 0),
      pricedTokens: archivedAmounts.pricedTokens + (record.pricedTokens ?? (cost === null ? 0 : tokensIn(record.usage))),
      unpricedTokens: archivedAmounts.unpricedTokens + (record.unpricedTokens ?? (cost === null ? tokensIn(record.usage) : 0)),
      archivedThreads: (archive.archivedThreads ?? 0) + (alreadyCounted ? 0 : 1),
      archivedThreadIds: [...archivedThreadIds],
      archivedSnapshots,
      updatedAt: Math.max(archive.updatedAt, record.updatedAt),
    };
  }
  const staleIds = new Set(stale.map((record) => record.threadId));
  return [
    ...records.filter((record) => !staleIds.has(record.threadId) && record.threadId !== USAGE_ARCHIVE_THREAD_ID),
    archive,
  ];
}

/**
 * Dated per-model detail lives in `usageHistory`, which loads on the first
 * accepted delta rather than at startup. Deltas accepted before it attaches
 * wait here in order and keep their own timestamp and frozen rate. If it never
 * loads, the queue stays bounded and the usage remains in the all-time ledger,
 * where the page reports it as earlier, undated usage.
 */
export interface UsageHistorySink { record(delta: UsageHistoryDelta): void; flush(): void; reset(): void; reprice(): void }
const MAX_PENDING_HISTORY = 2_000;
let historySink: UsageHistorySink | null = null;
let historyLoading: Promise<unknown> | null = null;
let pendingHistory: UsageHistoryDelta[] = [];

/** Called once by `usageHistory` when it is evaluated. */
export function attachUsageHistory(sink: UsageHistorySink): void {
  historySink = sink;
  const pending = pendingHistory;
  pendingHistory = [];
  for (const delta of pending) sink.record(delta);
  // Detail must never be saved ahead of the ledger that accounts for it. A
  // dirty ledger has a persist pending, which flushes this detail after it.
  if (pending.length && !ledgerDirty) sink.flush();
  // Finish any correction the ledger committed before an interruption, and
  // apply evidence that arrived while the detail wasn't loaded.
  requestUsageRepricing();
}

let repricingQueued = false;
/**
 * Re-checks dated usage against historical rate evidence after any rate
 * source changes. Coalesced, and a no-op until dated detail exists, so a
 * launch without usage never loads the detail module for it.
 */
export function requestUsageRepricing(): void {
  if (repricingQueued) return;
  if (!historySink) {
    const stored = readStoredRaw(USAGE_HISTORY_KEY);
    if (!stored) return;
  }
  repricingQueued = true;
  queueMicrotask(() => {
    repricingQueued = false;
    if (historySink) historySink.reprice();
    else historyLoading ??= import("./usageHistory").catch(() => { historyLoading = null; });
  });
}

export const PRICING_CORRECTIONS_ID = "openkiwi:pricing-corrections";
/** Ids only need to outlive the gap between the ledger's save and the
 * detail's, so a few passes' worth is kept, and always all of the latest. */
const MAX_APPLIED_CORRECTIONS = 500;
export interface PricingCorrectionCheckpoint {
  id: string;
  revision: number;
  /** Net change from the cohort's original cost and unpriced tokens. */
  cost: number;
  tokens: number;
  pricing: ModelPricing;
  basis: "observed" | "catalog";
}
export interface PricingCorrection extends UsageCorrection {
  id: string;
  provider: UsageProvider;
  cohortKey?: string;
  checkpoint?: PricingCorrectionCheckpoint;
}

export function pricingCorrectionCheckpoint(key: string): PricingCorrectionCheckpoint | undefined {
  return ledger().find((record) => record.threadId === PRICING_CORRECTIONS_ID)?.correctionCheckpoints?.[key];
}

export function correctionDayWasPruned(day: string): boolean {
  const before = ledger().find((record) => record.threadId === PRICING_CORRECTIONS_ID)?.correctionPrunedBefore;
  return before !== undefined && day < before;
}

/** Called when dated history drops old days. The fence and checkpoint removal
 * share one ledger write, so a stale native detail cannot replay a retired
 * cohort even if this ledger write reaches disk first. */
export function prunePricingCorrectionCheckpoints(retainedFrom: string): void {
  if (!isCalendarDate(retainedFrom)) return;
  const record = ledger().find((item) => item.threadId === PRICING_CORRECTIONS_ID);
  if (!record) return;
  if (record.correctionPrunedBefore && retainedFrom <= record.correctionPrunedBefore) return;
  upsert(PRICING_CORRECTIONS_ID, (previous) => {
    const checkpoints = Object.fromEntries(Object.entries(previous.correctionCheckpoints ?? {})
      .filter(([key]) => key.slice(0, 10) >= retainedFrom));
    return { ...previous, correctionPrunedBefore: retainedFrom, correctionCheckpoints: checkpoints, updatedAt: Date.now() };
  });
}

/** Older ledgers kept only a rolling list of ids. Once an id aged out, an
 * already applied correction cannot be distinguished from a lost native
 * write. Replay only when the id is still known, or no correction record
 * existed at all; otherwise keep the ledger's amount rather than double it. */
export function canReplayCorrectionWithoutCheckpoint(id: string): boolean {
  const record = ledger().find((item) => item.threadId === PRICING_CORRECTIONS_ID);
  return !record || (record.appliedCorrections ?? []).includes(id);
}

/**
 * Commits dated repricing to the authoritative ledger. Per-cohort checkpoints
 * let a later pass reconcile whichever native key reached disk first.
 */
export function commitPricingCorrections(corrections: PricingCorrection[]): void {
  if (!corrections.length) return;
  upsert(PRICING_CORRECTIONS_ID, (record) => {
    const applied = new Set(record.appliedCorrections ?? []);
    const checkpoints = { ...(record.correctionCheckpoints ?? {}) };
    const totals = { ...(record.corrections ?? {}) };
    let changed = false;
    for (const correction of corrections) {
      const previousCheckpoint = correction.cohortKey ? checkpoints[correction.cohortKey] : undefined;
      if (previousCheckpoint && correction.checkpoint && previousCheckpoint.revision >= correction.checkpoint.revision) continue;
      const alreadyApplied = applied.has(correction.id);
      const cost = previousCheckpoint && correction.checkpoint
        ? correction.checkpoint.cost - previousCheckpoint.cost : correction.cost;
      const tokens = previousCheckpoint && correction.checkpoint
        ? correction.checkpoint.tokens - previousCheckpoint.tokens : correction.tokens;
      if (!alreadyApplied) {
        const previous = totals[correction.provider] ?? { cost: 0, tokens: 0 };
        totals[correction.provider] = { cost: previous.cost + cost, tokens: previous.tokens + tokens };
        applied.add(correction.id);
      }
      if (correction.cohortKey && correction.checkpoint) checkpoints[correction.cohortKey] = correction.checkpoint;
      changed = true;
    }
    if (!changed) return record;
    return {
      ...record, kind: "pricing-correction", corrections: totals,
      correctionCheckpoints: checkpoints,
      appliedCorrections: [...applied].slice(-Math.max(MAX_APPLIED_CORRECTIONS, corrections.length)), updatedAt: Date.now(),
    };
  });
}

function readCorrectionCheckpoints(raw: unknown): Record<string, PricingCorrectionCheckpoint> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, PricingCorrectionCheckpoint> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const item = value as Partial<PricingCorrectionCheckpoint> | null;
    const pricing = item?.pricing;
    if (!key || key.length > 500 || !isCalendarDate(key.slice(0, 10)) || !item || typeof item.id !== "string" || item.id.length > 200
      || !Number.isSafeInteger(item.revision) || item.revision! < 1
      || typeof item.cost !== "number" || !Number.isFinite(item.cost)
      || typeof item.tokens !== "number" || !Number.isFinite(item.tokens) || item.tokens < 0
      || (item.basis !== "catalog" && item.basis !== "observed")
      || !pricing || finiteRate(pricing.inputPerMillion) === undefined || finiteRate(pricing.outputPerMillion) === undefined
      || (pricing.cachedInputPerMillion !== undefined && finiteRate(pricing.cachedInputPerMillion) === undefined)
      || (pricing.cacheWriteInputPerMillion !== undefined && finiteRate(pricing.cacheWriteInputPerMillion) === undefined)
      || (pricing.cacheWrite1hInputPerMillion !== undefined && finiteRate(pricing.cacheWrite1hInputPerMillion) === undefined)
      || !["OpenAI", "Anthropic", "OpenRouter", "Cursor"].includes(pricing.source)
      || !isCalendarDate(pricing.asOf)) continue;
    result[key] = {
      id: item.id, revision: item.revision!, cost: item.cost, tokens: item.tokens,
      pricing: { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion,
        ...(pricing.cachedInputPerMillion !== undefined ? { cachedInputPerMillion: pricing.cachedInputPerMillion } : {}),
        ...(pricing.cacheWriteInputPerMillion !== undefined ? { cacheWriteInputPerMillion: pricing.cacheWriteInputPerMillion } : {}),
        ...(pricing.cacheWrite1hInputPerMillion !== undefined ? { cacheWrite1hInputPerMillion: pricing.cacheWrite1hInputPerMillion } : {}),
        source: pricing.source, asOf: pricing.asOf }, basis: item.basis,
    };
  }
  return result;
}

function readCorrections(raw: unknown): Partial<Record<UsageProvider, UsageCorrection>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Partial<Record<UsageProvider, UsageCorrection>> = {};
  for (const [provider, value] of Object.entries(raw)) {
    const item = value as Partial<UsageCorrection> | null;
    if (!USAGE_PROVIDERS.includes(provider as UsageProvider) || !item || typeof item.cost !== "number" || !Number.isFinite(item.cost)
      || typeof item.tokens !== "number" || !Number.isFinite(item.tokens) || item.tokens < 0) return undefined;
    result[provider as UsageProvider] = { cost: item.cost, tokens: item.tokens };
  }
  return result;
}

function recordHistory(delta: UsageHistoryDelta): void {
  if (historySink) return historySink.record(delta);
  pendingHistory.push(delta);
  if (pendingHistory.length > MAX_PENDING_HISTORY) pendingHistory.shift();
  historyLoading ??= import("./usageHistory").catch(() => { historyLoading = null; });
}

/**
 * Writes the authoritative ledger first and the optional dated detail second.
 * Interrupted between the two, detail can only fall short of the ledger (an
 * undated remainder), never exceed it.
 */
export function flushUsageLedger(): void {
  if (ledgerDirty && cachedLedger) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const records = compactUsageRecords([...cachedLedger]).sort((left, right) => right.updatedAt - left.updatedAt);
    cachedLedger = records;
    cachedRaw = JSON.stringify(records);
    ledgerDirty = false;
    storeValue(USAGE_LEDGER_KEY, records);
    historySink?.flush();
    notifyUsage();
    return;
  }
  historySink?.flush();
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
  catalogCache.clear();
  pricingStatus = { checking: false };
  openRouterPrices = new Map();
  cursorModelNames = new Map();
  pendingHistory = [];
  repricingQueued = false;
  historySink?.reset();
  notifyUsage();
}

function positiveUsageDelta(next: TokenUsageView, previous: TokenUsageView): TokenUsageView {
  const inputTokens = Math.max(0, next.inputTokens - previous.inputTokens);
  const outputTokens = Math.max(0, next.outputTokens - previous.outputTokens);
  return cleanUsage({
    totalTokens: Math.max(inputTokens + outputTokens, next.totalTokens - previous.totalTokens),
    inputTokens,
    cachedInputTokens: Math.max(0, next.cachedInputTokens - previous.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, (next.cacheWriteInputTokens ?? 0) - (previous.cacheWriteInputTokens ?? 0)),
    cacheWrite1hInputTokens: Math.max(0, (next.cacheWrite1hInputTokens ?? 0) - (previous.cacheWrite1hInputTokens ?? 0)),
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
    cacheWrite1hInputTokens: (previous.cacheWrite1hInputTokens ?? 0) + (delta.cacheWrite1hInputTokens ?? 0),
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

function deltaPricing(record: ThreadUsageRecord): ModelPricing | undefined {
  // Background threads also adopt refreshed rates on their next usage event.
  return record.provider && record.model
    ? pricingForModel(record.provider, record.model) ?? record.pricing
    : record.pricing;
}

/** The resolved model a delta is attributed to in dated detail. */
function historyModel(record: ThreadUsageRecord): string | undefined {
  if (!record.model) return undefined;
  return record.provider === "claude" ? claudeCanonicalModel(record.model) : record.model;
}

/** Accepts one delta into both the all-time record and the dated detail. The
 * same frozen rate prices both, so detail can never drift from the ledger. */
function acceptDelta(record: ThreadUsageRecord, delta: TokenUsageView, turnId?: string): Pick<ThreadUsageRecord, "estimatedCost" | "pricedTokens" | "unpricedTokens" | "providerUsage"> {
  const pricing = deltaPricing(record);
  recordHistory({
    at: Date.now(),
    threadId: record.threadId,
    turnId,
    provider: USAGE_PROVIDERS.includes(record.provider as UsageProvider) ? record.provider! : "unknown",
    model: historyModel(record),
    usage: delta,
    pricing,
  });
  return withCostDelta(record, delta, pricing);
}

function withCostDelta(record: ThreadUsageRecord, delta: TokenUsageView, pricing: ModelPricing | undefined): Pick<ThreadUsageRecord, "estimatedCost" | "pricedTokens" | "unpricedTokens" | "providerUsage"> {
  const baseline = amountsFor(record);
  const tokens = tokensIn(delta);
  const cost = estimateUsageCost(delta, pricing);
  // Ordinary threads need no duplicate counters: their provider label already
  // attributes the whole record. Materialize subtotals only after a provider
  // change (or compaction), when that shortcut would lose history.
  const providerUsage = record.providerUsage
    ? mergeProviderUsage(providerParts(record), { [record.provider ?? "unknown"]: amountsFor({ ...record, usage: delta, estimatedCost: cost ?? 0, pricedTokens: cost === null ? 0 : tokens, unpricedTokens: cost === null ? tokens : 0 }) })
    : undefined;
  return cost === null
    ? {
        providerUsage,
        estimatedCost: baseline.estimatedCost,
        pricedTokens: baseline.pricedTokens,
        unpricedTokens: baseline.unpricedTokens + tokens,
      }
    : {
        providerUsage,
        estimatedCost: baseline.estimatedCost + cost,
        pricedTokens: baseline.pricedTokens + tokens,
        unpricedTokens: baseline.unpricedTokens,
      };
}

function upsert(threadId: string, update: (record: ThreadUsageRecord) => ThreadUsageRecord): ThreadUsageRecord {
  const records = ledger();
  const index = records.findIndex((record) => record.threadId === threadId);
  const archive = records.find((record) => record.threadId === USAGE_ARCHIVE_THREAD_ID);
  const archivedBefore = archive?.archivedThreadIds?.includes(threadId) === true;
  const current = index >= 0
    ? records[index]
    : {
        threadId,
        usage: emptyUsage(),
        cumulativeSnapshot: archive?.archivedSnapshots?.[threadId],
        countedInArchive: archivedBefore || undefined,
        updatedAt: Date.now(),
      };
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
export function recordCumulativeUsage(threadId: string, usage: TokenUsageView, turnId?: string): TokenUsageView {
  return upsert(threadId, (record) => {
    const nextSnapshot = cleanUsage(usage);
    const previousSnapshot = record.cumulativeSnapshot ?? record.usage;
    const reset = tokensIn(record.usage) > 0 && snapshotReset(nextSnapshot, previousSnapshot);
    const delta = reset ? emptyUsage() : positiveUsageDelta(nextSnapshot, previousSnapshot);
    return {
      ...record,
      ...acceptDelta(record, delta, turnId),
      usage: addUsage(record.usage, delta, nextSnapshot.contextWindow, nextSnapshot.contextTokens),
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
  turnId?: string,
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
      ...acceptDelta(record, delta, turnId),
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
      // Seal the outgoing provider before replacing its label. A first known
      // label can still attribute legacy records written before metadata arrived.
      providerUsage: record.provider && record.provider !== metadata.provider ? providerParts(record) : record.providerUsage,
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
    && left.cacheWrite1hInputPerMillion === right.cacheWrite1hInputPerMillion
    && left.source === right.source
    && left.asOf === right.asOf
    && left.note === right.note;
}

export function usageForThread(threadId: string): ThreadUsageRecord | null {
  return ledger().find((record) => record.threadId === threadId) ?? null;
}

/**
 * Reduces a Claude `--model` value to the model id pricing is published under.
 *
 * The CLI's live catalog offers decorated aliases (`opus[1m]`, `sonnet`,
 * `claude-haiku-4-5-20251001`) rather than bare pricing ids. Anything still
 * ambiguous after this — `default`, which Anthropic can repoint — is left
 * alone so it produces no estimate rather than a confidently wrong one.
 */
export function claudeCanonicalModel(model: string): string {
  const value = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  const dated = value.replace(/[-@]\d{8}$/, "");
  // A specific version is not a floating family alias. Never silently price
  // Fable 5.1 (or a future Opus) as an older generation.
  if (/^(fable|opus|sonnet|haiku)-\d/.test(dated)) return `claude-${dated}`;
  const families: Array<[RegExp, string]> = [
    [/^fable$/, "claude-fable-5"],
    [/^opus$/, "claude-opus-5"],
    [/^sonnet$/, "claude-sonnet-5"],
    [/^haiku$/, "claude-haiku-4-5"],
  ];
  for (const [pattern, id] of families) {
    if (pattern.test(dated)) return id;
  }
  return dated;
}

type BundledRate = [input: number, cacheRead: number, cacheWrite: number, output: number, asOf: string, note?: string];
/** Standard (not Batch/Flex/Priority) API rates per million tokens. Claude's
 * cache write here is the 5-minute rate; see `withClaudeHourCacheRate`. */
const BUNDLED_RATES: Record<"openai" | "claude", Record<string, BundledRate>> = {
  openai: {
    "gpt-6-astra": [10, 1, 12.5, 50, "2026-09-25"],
    "gpt-6-sol": [2, 0.2, 2.5, 10, "2026-09-25"],
    "gpt-6-luna": [0.1, 0.01, 0.125, 0.5, "2026-09-25"],
    // developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna}; cache
    // writes bill at 1.25x input. `gpt-5.6` redirects to Sol.
    "gpt-5.6-sol": [4, 0.4, 5, 20, "2026-09-25"],
    "gpt-5.6": [4, 0.4, 5, 20, "2026-09-25", "Alias of GPT-5.6 Sol"],
    "gpt-5.6-terra": [2, 0.2, 2.5, 12, "2026-09-25"],
    "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2, "2026-09-25"],
  },
  claude: {
    "claude-fable-5-1": [10, 0.25, 12.5, 50, "2026-09-25"],
    "claude-fable-5": [10, 1, 12.5, 50, "2026-09-25"],
    "claude-opus-5-5": [4, 0.2, 5, 20, "2026-09-25"],
    "claude-opus-5": [5, 0.5, 6.25, 25, "2026-09-25", "Same rate as Claude Opus 4.8"],
    "claude-opus-4-8": [5, 0.5, 6.25, 25, "2026-09-25"],
    // The launch-period $2/$10 rate became Sonnet 5's standard price; the
    // scheduled September 2026 increase was cancelled.
    "claude-sonnet-5": [2, 0.2, 2.5, 10, "2026-09-25"],
    "claude-haiku-4-5": [1, 0.1, 1.25, 5, "2026-09-25"],
  },
};

function bundledPricing(provider: Provider, model: string): ModelPricing | undefined {
  if (provider !== "openai" && provider !== "claude") return undefined;
  const table = BUNDLED_RATES[provider];
  const rate = table[model] ?? table[model.replace(DATED_MODEL_SNAPSHOT, "")]
    // Opus 4.8 variants have always billed at the 4.8 rate.
    ?? (provider === "claude" && model.startsWith("claude-opus-4-8") ? table["claude-opus-4-8"] : undefined);
  if (!rate) return undefined;
  const [inputPerMillion, cachedInputPerMillion, cacheWriteInputPerMillion, outputPerMillion, asOf, note] = rate;
  return {
    inputPerMillion, cachedInputPerMillion, cacheWriteInputPerMillion, outputPerMillion,
    source: provider === "openai" ? "OpenAI" : "Anthropic", asOf, ...(note ? { note } : {}),
  };
}

/** `provider:model` keys with a bundled, catalog or official rate (may
 * repeat). Retired and limited-access models are left out of this list, but
 * are still priced if they are used. */
export function pricingModelKeys(): string[] {
  return [
    ...Object.keys(BUNDLED_RATES.openai).map((model) => `openai:${model}`),
    ...Object.keys(BUNDLED_RATES.claude).map((model) => `claude:${model}`),
    ...Object.keys(modelPricingCatalog()?.models ?? {}),
    ...Object.entries(storedCatalog(OFFICIAL_PRICING_KEY)?.models ?? {})
      .filter(([key, entry]) => !entry.status && !key.startsWith("cursor:")).map(([key]) => key),
    ...[...cursorModelNames.keys()].filter((id) => cursorPricing(id)).map((id) => `cursor:${id}`),
  ];
}

/**
 * Picks, per model, the rate verified most recently: an official page read by
 * this app, the published catalog, or the bundled table. On the same day the
 * official page wins, then the catalog. A source's overall publish date never
 * matters, so an old entry in a freshly downloaded catalog cannot override a
 * newer bundled or official rate.
 */
export function pricingForModel(provider: Provider, model: string, at = new Date()): ModelPricing | undefined {
  // Internal sentinel for a Claude result that could not safely be assigned to
  // any model; even a coincidentally named catalog entry must not price it.
  if (provider === "claude" && model === "unattributed") return undefined;
  if (provider === "openrouter") return openRouterPrices.get(model);
  if (provider === "cursor") return cursorPricing(model);
  if (provider === "claude") model = claudeCanonicalModel(model);
  const bundled = bundledPricing(provider, model);
  const candidates = [
    officialModelPricing(provider, model),
    asPricing(catalogPricing(provider, model, at), "catalog"),
    bundled && { ...bundled, origin: "bundled" as const },
  ];
  let best: ModelPricing | undefined;
  for (const candidate of candidates) if (candidate && (!best || candidate.asOf > best.asOf)) best = candidate;
  return provider === "claude" ? withClaudeHourCacheRate(best) : best;
}

/** Claude's pricing page lists 1-hour cache writes at 2x base input for every
 * model. A rate read from the page keeps its published value; bundled and
 * catalog rates, and pages stored before the column was read, apply that rule. */
export function withClaudeHourCacheRate(pricing: ModelPricing | undefined): ModelPricing | undefined {
  if (!pricing || pricing.cacheWrite1hInputPerMillion !== undefined) return pricing;
  return { ...pricing, cacheWrite1hInputPerMillion: pricing.inputPerMillion * 2 };
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
    + cacheWriteCost(cacheWrite, usage.cacheWrite1hInputTokens ?? 0, pricing) * 1_000_000
    + usage.outputTokens * pricing.outputPerMillion
  ) / 1_000_000;
}

/** Cache writes at their duration's rate. A 1-hour write with no 1-hour rate
 * falls back to the cache-write rate, then to input, as every missing cache
 * rate does. */
export function cacheWriteCost(cacheWriteTokens: number, hourTokens: number, pricing: ModelPricing): number {
  const writeRate = pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion;
  const hour = Math.min(cacheWriteTokens, Math.max(0, hourTokens));
  return ((cacheWriteTokens - hour) * writeRate + hour * (pricing.cacheWrite1hInputPerMillion ?? writeRate)) / 1_000_000;
}

export function usageTotals(): UsageTotals {
  const records = ledger(); // Also observe late native hydration / storage changes.
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
  for (const record of records) {
    const { usage } = record;
    if (record.corrections) {
      for (const correction of Object.values(record.corrections)) {
        totals.estimatedCost += correction.cost;
        totals.pricedTokens += correction.tokens;
        totals.unpricedTokens -= correction.tokens;
      }
    }
    if (usage.totalTokens === 0) continue;
    totals.inputTokens += usage.inputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningOutputTokens += usage.reasoningOutputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.threads += record.threadId === USAGE_ARCHIVE_THREAD_ID
      ? (record.archivedThreads ?? 1)
      : (record.countedInArchive ? 0 : 1);
    const cost = record.estimatedCost ?? estimateUsageCost(usage, record.pricing);
    totals.estimatedCost += cost ?? 0;
    totals.pricedTokens += record.pricedTokens ?? (cost === null ? 0 : tokensIn(usage));
    totals.unpricedTokens += record.unpricedTokens ?? (cost === null ? tokensIn(usage) : 0);
  }
  totals.estimatedCost = Math.max(0, totals.estimatedCost);
  totals.unpricedTokens = Math.max(0, totals.unpricedTokens);
  cachedTotals = totals;
  return cachedTotals;
}

function amountsFor(record: ThreadUsageRecord): UsageAmounts {
  const usage = cleanUsage(record.usage);
  const cost = record.estimatedCost ?? estimateUsageCost(usage, record.pricing);
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    estimatedCost: cost ?? 0,
    pricedTokens: record.pricedTokens ?? (cost === null ? 0 : tokensIn(usage)),
    unpricedTokens: record.unpricedTokens ?? (cost === null ? tokensIn(usage) : 0),
  };
}

function providerParts(record: ThreadUsageRecord): Partial<Record<UsageProvider, UsageAmounts>> {
  if (record.providerUsage) return record.providerUsage;
  if (record.corrections) {
    const parts: Partial<Record<UsageProvider, UsageAmounts>> = {};
    for (const [provider, correction] of Object.entries(record.corrections) as Array<[UsageProvider, UsageCorrection]>) {
      parts[provider] = {
        ...Object.fromEntries(AMOUNT_KEYS.map((key) => [key, 0])) as UsageAmounts,
        estimatedCost: correction.cost, pricedTokens: correction.tokens, unpricedTokens: -correction.tokens,
      };
    }
    return parts;
  }
  if (!record.usage.totalTokens) return {};
  const provider = USAGE_PROVIDERS.includes(record.provider as UsageProvider) ? record.provider! : "unknown";
  return { [provider]: amountsFor(record) };
}

/** A damaged optional breakdown must not corrupt the authoritative totals. */
function readProviderParts(raw: unknown, record: ThreadUsageRecord): Partial<Record<UsageProvider, UsageAmounts>> {
  const fallback = { unknown: amountsFor(record) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const entries = Object.entries(raw);
  if (entries.some(([provider, value]) => !USAGE_PROVIDERS.includes(provider as UsageProvider) || !value
    || AMOUNT_KEYS.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0))) return fallback;
  const expected = amountsFor(record);
  for (const key of AMOUNT_KEYS) {
    const total = entries.reduce((sum, [, value]) => sum + value[key], 0);
    if (Math.abs(total - expected[key]) > Math.max(0.0000001, expected[key] * 1e-12)) return fallback;
  }
  return raw as Partial<Record<UsageProvider, UsageAmounts>>;
}

function mergeProviderUsage(left: Partial<Record<UsageProvider, UsageAmounts>>, right: Partial<Record<UsageProvider, UsageAmounts>>): Partial<Record<UsageProvider, UsageAmounts>> {
  const merged = { ...left };
  for (const provider of USAGE_PROVIDERS) {
    const incoming = right[provider];
    if (!incoming) continue;
    const previous = merged[provider];
    const total = { ...incoming };
    if (previous) for (const key of AMOUNT_KEYS) total[key] += previous[key];
    merged[provider] = total;
  }
  return merged;
}

export function providerUsageTotals(): ProviderUsageTotals[] {
  let parts: Partial<Record<UsageProvider, UsageAmounts>> = {};
  for (const record of ledger()) parts = mergeProviderUsage(parts, providerParts(record));
  // Corrections only move cost and tokens within usage already counted.
  return USAGE_PROVIDERS.flatMap((provider) => parts[provider]
    ? [{ provider, ...parts[provider]!, estimatedCost: Math.max(0, parts[provider]!.estimatedCost), unpricedTokens: Math.max(0, parts[provider]!.unpricedTokens) }]
    : [])
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Captured receipts are separate from runtime token counters, so streaming
 * usage never counts twice. No inferred thread association or balance deltas. */
export function recordOpenRouterCharge(id: unknown, cost: unknown): void {
  if (typeof id !== "string" || !id.trim() || id.length > 240 || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return;
  // One bounded aggregate, not an ever-growing record for every model call.
  // These are live HTTP receipts (never history replay); retain recent ids as
  // protection against duplicate event subscriptions and renderer reloads.
  upsert("openrouter:captured-charges", (record) => record.eventIds?.includes(id) ? record : {
    ...record, kind: "openrouter-charge", provider: "openrouter",
    reportedCost: (record.reportedCost ?? 0) + cost, reportedRequests: (record.reportedRequests ?? 0) + 1,
    eventIds: [...(record.eventIds ?? []), id].slice(-MAX_RECEIPT_IDS), updatedAt: Date.now(),
  });
}

export function openRouterReportedCost(): { cost: number; requests: number } {
  return ledger().reduce((sum, record) => ({
    cost: sum.cost + (record.reportedCost ?? 0), requests: sum.requests + (record.reportedRequests ?? 0),
  }), { cost: 0, requests: 0 });
}

export function formatEstimatedCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushUsageLedger);
}
