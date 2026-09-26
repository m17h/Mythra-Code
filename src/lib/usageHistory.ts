import type { TokenUsageView } from "../components/StudioDock";
import {
  attachUsageHistory, cacheWriteCost, canReplayCorrectionWithoutCheckpoint, commitPricingCorrections, correctionDayWasPruned,
  flushUsageLedger, pricingCorrectionCheckpoint, prunePricingCorrectionCheckpoints, USAGE_HISTORY_KEY,
  type ModelPricing, type PricingCorrection, type PricingCorrectionCheckpoint, type UsageProvider,
} from "./usageLedger";
import { historicalPricing } from "./pricingEvidence";
import { loadStored, storeValue } from "./storage";

export { USAGE_HISTORY_KEY };

/**
 * Dated, per-model usage detail recorded alongside the all-time ledger.
 *
 * The ledger stays authoritative for all-time totals. This history only holds
 * the exact deltas the ledger accepted from the moment it was introduced, split
 * by local calendar day, provider and resolved model, with each component's
 * cost frozen at the rate active when it was recorded. Anything the ledger
 * holds that this history does not (usage from before tracking began, or
 * detail aged out of retention) is reported as unallocated rather than guessed.
 *
 * The ledger loads this module on its first accepted delta, not at startup.
 */
/** Daily detail older than this is dropped; all-time totals remain in the ledger. */
export const USAGE_HISTORY_RETENTION_DAYS = 400;
/** Hard cap on stored buckets regardless of age (days × models). */
const MAX_BUCKETS = 4_000;
/** Recent (thread, turn) and (thread, turn, model) identities, so a turn is
 * counted once even when its usage arrives as several deltas or continues
 * after a renderer reload. */
const MAX_RECENT_TURNS = 1_000;
const MAX_TURN_KEY = 900;
const PERSISTED_FIELDS = 19;
/** Distinct rates (or unpriced spells) tracked per day and model. Usage past
 * this stays in the bucket's totals but can't be repriced. */
const MAX_COHORTS = 4;
const MINUTE_MS = 60_000;

export interface UsageComponentAmounts {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  uncachedInputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  pricedTokens: number;
  unpricedTokens: number;
  /** Distinct provider turns whose first usage landed in this bucket. Each
   * turn is counted exactly once, so this sums to the number of prompts. */
  turns: number;
  /** Input/output tokens recorded without a turn identity. */
  unturnedTokens: number;
  /** Turns that used this bucket's model. A turn that switched models counts
   * once for each model it used, so per-model averages have a real
   * denominator; unlike `turns`, this never sums to a prompt count. */
  modelTurns: number;
  /** Part of `cacheWriteTokens` written to Claude's 1-hour cache. Zero for
   * detail recorded before the split was read. */
  cacheWrite1hTokens: number;
}

export interface UsageBucket extends UsageComponentAmounts {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  provider: UsageProvider;
  /** Resolved model id at the time of the delta; empty when never reported. */
  model: string;
  /** The part of this bucket whose rate and time of use are known. Detail
   * recorded before cohorts existed has none, except a wholly unpriced
   * bucket, which is attributable as it stands. */
  cohorts?: RateCohort[];
}

/**
 * Usage in one bucket recorded at one rate (or unpriced), with the span of
 * time it happened in. This is what makes a later, evidence-backed repricing
 * exact: the token split and moment are known, and so is the old rate.
 */
export interface RateCohort {
  /** Unique per cohort; a correction's id also includes its revision. */
  id: string;
  /** Index into the rate table, or -1 when unpriced. */
  rate: number;
  /** Epoch ms, widened to whole minutes. */
  firstAt: number;
  lastAt: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  /** Once repriced: the rate it was first recorded at (-1 unpriced), and
   * what showed the new rate applied when this usage happened. */
  was?: number;
  basis?: "observed" | "catalog";
  /** Monotone correction number, persisted so A→B→A→B cannot reuse an id. */
  revision?: number;
  /** This correction was written with a ledger checkpoint. If history reached
   * native storage first, a missing checkpoint proves the ledger is older. */
  checkpointed?: true;
}

interface UsageHistoryState {
  /** When detailed tracking began on this device. */
  startedAt: number;
  /** Earliest day still retained after pruning, when anything was pruned. */
  retainedFrom?: string;
  buckets: Map<string, UsageBucket>;
  recentTurns: string[];
  /** Local day each recent turn began, so a turn that runs past midnight
   * keeps all its usage on the day its prompt (and its turn count) landed. */
  turnDays: Map<string, string>;
  /** Rates cohorts were priced at, deduplicated. */
  rates: ModelPricing[];
}

type PersistedCohort = [id: string, rate: number, firstMinute: number, lastMinute: number, uncached: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, output: number, was?: number, basis?: "o" | "c", revision?: number, checkpointed?: "k"];
type PersistedBucket = [string, string, string, ...Array<number | PersistedCohort[]>];
type PersistedRate = [input: number, output: number, cacheRead: number | null, cacheWrite: number | null, cacheWrite1h: number | null, source: ModelPricing["source"], origin: string, asOf: string];
interface PersistedHistory {
  schemaVersion: 1;
  startedAt: number;
  retainedFrom?: string;
  buckets: PersistedBucket[];
  recentTurns: string[];
  turnDays?: Array<[string, string]>;
  rates?: PersistedRate[];
}

const PROVIDERS: UsageProvider[] = ["openai", "claude", "openrouter", "cursor", "lmstudio", "unknown"];
const NUMBER_KEYS: Array<keyof UsageComponentAmounts> = [
  "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningOutputTokens", "totalTokens",
  "uncachedInputCost", "cacheReadCost", "cacheWriteCost", "outputCost", "pricedTokens", "unpricedTokens", "turns", "unturnedTokens", "modelTurns", "cacheWrite1hTokens",
];

export function emptyComponentAmounts(): UsageComponentAmounts {
  return {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    uncachedInputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0, pricedTokens: 0, unpricedTokens: 0, turns: 0, unturnedTokens: 0, modelTurns: 0, cacheWrite1hTokens: 0,
  };
}

export function addComponentAmounts(target: UsageComponentAmounts, source: UsageComponentAmounts): UsageComponentAmounts {
  for (const key of NUMBER_KEYS) target[key] += source[key];
  return target;
}

/** Splits usage into its four billable parts. Cache reads and writes are
 * subsets of input; a missing cache rate falls back to the input rate exactly
 * as the ledger's single-number estimate always has, so the parts sum to it. */
export function usageCostParts(usage: TokenUsageView, pricing?: ModelPricing): {
  uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; outputTokens: number;
  costs: { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number } | null;
} {
  const cacheReadTokens = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens));
  const cacheWriteTokens = Math.min(Math.max(0, usage.inputTokens - cacheReadTokens), Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const cacheWrite1hTokens = Math.min(cacheWriteTokens, Math.max(0, usage.cacheWrite1hInputTokens ?? 0));
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = usage.outputTokens;
  if (!pricing) return { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens, outputTokens, costs: null };
  return {
    uncachedInputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens, outputTokens,
    costs: {
      uncachedInput: uncachedInputTokens * pricing.inputPerMillion / 1_000_000,
      cacheRead: cacheReadTokens * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) / 1_000_000,
      cacheWrite: cacheWriteCost(cacheWriteTokens, cacheWrite1hTokens, pricing),
      output: outputTokens * pricing.outputPerMillion / 1_000_000,
    },
  };
}

/** Adds one usage delta's tokens and frozen component costs to `amounts`. */
export function addUsageToAmounts(amounts: UsageComponentAmounts, usage: TokenUsageView, pricing?: ModelPricing): UsageComponentAmounts {
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = usageCostParts(usage, pricing);
  amounts.uncachedInputTokens += parts.uncachedInputTokens;
  amounts.cacheReadTokens += parts.cacheReadTokens;
  amounts.cacheWriteTokens += parts.cacheWriteTokens;
  amounts.cacheWrite1hTokens += parts.cacheWrite1hTokens;
  amounts.outputTokens += parts.outputTokens;
  amounts.reasoningOutputTokens += Math.min(usage.outputTokens, usage.reasoningOutputTokens);
  amounts.totalTokens += usage.totalTokens;
  if (parts.costs) {
    amounts.uncachedInputCost += parts.costs.uncachedInput;
    amounts.cacheReadCost += parts.costs.cacheRead;
    amounts.cacheWriteCost += parts.costs.cacheWrite;
    amounts.outputCost += parts.costs.output;
    amounts.pricedTokens += tokens;
  } else {
    amounts.unpricedTokens += tokens;
  }
  return amounts;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

/** Local calendar day for a timestamp; ranges are chosen in local days. */
export function localDayKey(at: number | Date = Date.now()): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds whole calendar days to a YYYY-MM-DD key without DST drift. */
export function shiftDayKey(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDayKey(new Date(year, month - 1, date + days, 12));
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const [year, month, date] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, date, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === date;
}

function bucketKey(day: string, provider: UsageProvider, model: string): string {
  return `${day}\0${provider}\0${model}`;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const SOURCES: Array<ModelPricing["source"]> = ["OpenAI", "Anthropic", "OpenRouter", "Cursor"];
const ORIGINS = ["official", "catalog", "bundled"];

function parseRate(raw: unknown): ModelPricing | null {
  if (!Array.isArray(raw) || raw.length !== 8) return null;
  const [input, output, cacheRead, cacheWrite, cacheWrite1h, source, origin, asOf] = raw as unknown[];
  const optional = [cacheRead, cacheWrite, cacheWrite1h].map((value) => value === null ? undefined : nonNegative(value)) as Array<number | undefined | null>;
  if (nonNegative(input) === null || nonNegative(output) === null || optional.includes(null)
    || !SOURCES.includes(source as ModelPricing["source"]) || typeof origin !== "string" || !isDayKey(asOf)) return null;
  return {
    inputPerMillion: input as number, outputPerMillion: output as number,
    ...(typeof optional[0] === "number" ? { cachedInputPerMillion: optional[0] } : {}),
    ...(typeof optional[1] === "number" ? { cacheWriteInputPerMillion: optional[1] } : {}),
    ...(typeof optional[2] === "number" ? { cacheWrite1hInputPerMillion: optional[2] } : {}),
    source: source as ModelPricing["source"], asOf, ...(ORIGINS.includes(origin) ? { origin: origin as ModelPricing["origin"] } : {}),
  };
}

function serializeRate(rate: ModelPricing): PersistedRate {
  return [
    rate.inputPerMillion, rate.outputPerMillion, rate.cachedInputPerMillion ?? null, rate.cacheWriteInputPerMillion ?? null,
    rate.cacheWrite1hInputPerMillion ?? null, rate.source, rate.origin ?? "", rate.asOf,
  ];
}

/** Rates are the same cohort when every billable part costs the same. */
function rateIdentity(rate: ModelPricing): string {
  const write = rate.cacheWriteInputPerMillion ?? rate.inputPerMillion;
  return JSON.stringify([rate.source, rate.inputPerMillion, rate.outputPerMillion, rate.cachedInputPerMillion ?? rate.inputPerMillion, write, rate.cacheWrite1hInputPerMillion ?? write]);
}

const COHORT_TOKENS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite1hTokens", "outputTokens"] as const;

function parseCohort(raw: unknown, rates: number): RateCohort | null {
  if (!Array.isArray(raw) || (raw.length !== 9 && raw.length !== 11 && raw.length !== 12 && raw.length !== 13)) return null;
  const [id, rate, first, last, ...rest] = raw as unknown[];
  const tokens = rest.slice(0, 5).map(nonNegative);
  if (typeof id !== "string" || !id || id.length > 64 || !Number.isInteger(rate) || (rate as number) < -1 || (rate as number) >= rates
    || nonNegative(first) === null || nonNegative(last) === null || (last as number) < (first as number) || tokens.includes(null)) return null;
  const cohort = { id, rate: rate as number, firstAt: (first as number) * MINUTE_MS, lastAt: (last as number) * MINUTE_MS } as RateCohort;
  COHORT_TOKENS.forEach((key, index) => { cohort[key] = tokens[index]!; });
  if (cohort.cacheWrite1hTokens > cohort.cacheWriteTokens) return null;
  if (raw.length >= 11) {
    const [was, basis] = rest.slice(5);
    if (!Number.isInteger(was) || (was as number) < -1 || (was as number) >= rates || (basis !== "o" && basis !== "c")) return null;
    cohort.was = was as number;
    cohort.basis = basis === "o" ? "observed" : "catalog";
    // Existing 11-field cohorts already had one correction before revisions
    // were tracked. New 12-field cohorts carry their exact correction count.
    const revision = raw.length >= 12 ? rest[7] : 1;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) return null;
    cohort.revision = revision as number;
    if (raw.length === 13) {
      if (rest[8] !== "k") return null;
      cohort.checkpointed = true;
    }
  }
  return cohort;
}

function cohortTokens(cohort: RateCohort): number {
  return cohort.uncachedInputTokens + cohort.cacheReadTokens + cohort.cacheWriteTokens + cohort.outputTokens;
}

/** Local midnight at the start of `day`. */
function dayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

function hash(text: string): string {
  // Two independent 32-bit streams keep legacy cohort ids compact without
  // relying on BigInt, which the Safari 13 compatibility build cannot parse.
  let first = 0x811c9dc5;
  let second = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = (Math.imul(second, 33) + code) >>> 0;
  }
  return `${first.toString(36)}-${second.toString(36)}`;
}

/**
 * Detail from before cohorts existed holds no rate or time of use. A bucket
 * that was entirely unpriced is still attributable: its token split is
 * exact, and its usage happened on its day or, for a turn that ran past
 * midnight, the next one. Claude cache writes recorded before the 1-hour
 * split was read can't be priced exactly, so those buckets stay as they are.
 */
function legacyCohort(bucket: UsageBucket): RateCohort | null {
  if (bucket.pricedTokens > 0 || bucket.unpricedTokens <= 0) return null;
  if (bucket.provider === "claude" && bucket.cacheWriteTokens > bucket.cacheWrite1hTokens) return null;
  const cohort: RateCohort = {
    id: `L${hash(bucketKey(bucket.day, bucket.provider, bucket.model))}`, rate: -1,
    firstAt: dayStart(bucket.day), lastAt: dayStart(shiftDayKey(bucket.day, 2)),
    uncachedInputTokens: bucket.uncachedInputTokens, cacheReadTokens: bucket.cacheReadTokens, cacheWriteTokens: bucket.cacheWriteTokens,
    cacheWrite1hTokens: bucket.cacheWrite1hTokens, outputTokens: bucket.outputTokens,
  };
  return cohortTokens(cohort) === bucket.unpricedTokens ? cohort : null;
}

/** Stored detail is optional. A malformed bucket is dropped on its own; it can
 * never affect the ledger's all-time totals. */
function parseHistory(raw: unknown): UsageHistoryState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<PersistedHistory>;
  if (value.schemaVersion !== 1 || nonNegative(value.startedAt) === null || !Array.isArray(value.buckets)) return null;
  const rates: ModelPricing[] = [];
  if (Array.isArray(value.rates)) {
    for (const raw of value.rates) {
      const rate = parseRate(raw);
      // Indices must stay aligned, so one bad rate invalidates every cohort.
      if (!rate) { rates.length = 0; break; }
      rates.push(rate);
    }
  }
  const buckets = new Map<string, UsageBucket>();
  for (let entry of value.buckets) {
    let cohorts: RateCohort[] | undefined;
    if (Array.isArray(entry) && entry.length === PERSISTED_FIELDS + 1) {
      const raw = entry[PERSISTED_FIELDS];
      entry = entry.slice(0, PERSISTED_FIELDS) as PersistedBucket;
      const parsed = Array.isArray(raw) ? raw.slice(0, MAX_COHORTS).map((item) => parseCohort(item, rates.length)) : [null];
      // Damaged provenance is dropped; the bucket's own totals still count.
      cohorts = parsed.includes(null) ? [] : parsed as RateCohort[];
    }
    // Buckets written before `modelTurns` existed attributed each turn only
    // to the model it started on; before `cacheWrite1hTokens`, the cache
    // duration of a write was not recorded.
    if (Array.isArray(entry) && entry.length === PERSISTED_FIELDS - 2) entry = [...entry, entry[3 + NUMBER_KEYS.indexOf("turns")]] as PersistedBucket;
    if (Array.isArray(entry) && entry.length === PERSISTED_FIELDS - 1) entry = [...entry, 0] as PersistedBucket;
    if (!Array.isArray(entry) || entry.length !== PERSISTED_FIELDS) continue;
    const [day, provider, model, ...numbers] = entry as unknown[];
    if (!isDayKey(day) || !PROVIDERS.includes(provider as UsageProvider) || typeof model !== "string" || model.length > 200) continue;
    const parsed = numbers.map(nonNegative);
    if (parsed.some((item) => item === null)) continue;
    const bucket = { day, provider: provider as UsageProvider, model } as UsageBucket;
    NUMBER_KEYS.forEach((key, index) => { bucket[key] = parsed[index]!; });
    if (cohorts === undefined) {
      const legacy = legacyCohort(bucket);
      if (legacy) cohorts = [legacy];
    } else if (!cohortsFit(bucket, cohorts)) cohorts = [];
    if (cohorts?.length) bucket.cohorts = cohorts;
    const key = bucketKey(day, bucket.provider, model);
    const existing = buckets.get(key);
    // Duplicate keys are never written; if one appears, keep totals but no
    // provenance, since which usage each copy held is unknown.
    buckets.set(key, existing ? { ...addComponentAmounts({ ...existing }, bucket), day, provider: bucket.provider, model, cohorts: undefined } : bucket);
  }
  const recentTurns = Array.isArray(value.recentTurns)
    ? value.recentTurns.filter((id): id is string => typeof id === "string" && id.length <= MAX_TURN_KEY).slice(-MAX_RECENT_TURNS)
    : [];
  const turnDays = new Map<string, string>();
  if (Array.isArray(value.turnDays)) {
    for (const entry of value.turnDays.slice(-MAX_RECENT_TURNS)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length <= MAX_TURN_KEY && isDayKey(entry[1])) turnDays.set(entry[0], entry[1]);
    }
  }
  return {
    startedAt: value.startedAt!,
    retainedFrom: isDayKey(value.retainedFrom) ? value.retainedFrom : undefined,
    buckets,
    recentTurns,
    turnDays,
    rates,
  };
}

/** Cohorts can never claim more than their bucket holds. */
function cohortsFit(bucket: UsageBucket, cohorts: RateCohort[]): boolean {
  const sum = (key: (typeof COHORT_TOKENS)[number]) => cohorts.reduce((total, cohort) => total + cohort[key], 0);
  const priced = cohorts.filter((cohort) => cohort.rate >= 0).reduce((total, cohort) => total + cohortTokens(cohort), 0);
  const unpriced = cohorts.filter((cohort) => cohort.rate < 0).reduce((total, cohort) => total + cohortTokens(cohort), 0);
  return COHORT_TOKENS.every((key) => sum(key) <= bucket[key]) && priced <= bucket.pricedTokens && unpriced <= bucket.unpricedTokens;
}

function serialize(state: UsageHistoryState): PersistedHistory {
  // Only rates some retained cohort still refers to are written.
  const rates: PersistedRate[] = [];
  const remap = new Map<number, number>([[-1, -1]]);
  const indexOf = (rate: number) => {
    if (!remap.has(rate)) { remap.set(rate, rates.length); rates.push(serializeRate(state.rates[rate])); }
    return remap.get(rate)!;
  };
  const cohort = (item: RateCohort): PersistedCohort => [
    item.id, indexOf(item.rate), Math.floor(item.firstAt / MINUTE_MS), Math.ceil(item.lastAt / MINUTE_MS),
    ...COHORT_TOKENS.map((key) => item[key]),
    ...(item.was !== undefined ? [indexOf(item.was), item.basis === "observed" ? "o" : "c", item.revision ?? 1,
      ...(item.checkpointed ? ["k"] : [])] : []),
  ] as PersistedCohort;
  const buckets = [...state.buckets.values()].map((bucket) => [
    bucket.day, bucket.provider, bucket.model,
    ...NUMBER_KEYS.map((key) => Number(bucket[key].toPrecision(12))),
    // A bucket with no cohorts is written in the original shape.
    ...(bucket.cohorts?.length ? [bucket.cohorts.map(cohort)] : []),
  ] as PersistedBucket);
  return {
    schemaVersion: 1,
    startedAt: state.startedAt,
    ...(state.retainedFrom ? { retainedFrom: state.retainedFrom } : {}),
    buckets,
    recentTurns: state.recentTurns,
    ...(state.turnDays.size ? { turnDays: [...state.turnDays] } : {}),
    ...(rates.length ? { rates } : {}),
  };
}

let cachedState: UsageHistoryState | null = null;
let cachedRaw: string | null | undefined;
let dirty = false;
let recentTurnSet: Set<string> | null = null;
let rateIndex: Map<string, number> | null = null;
let cohortSequence = 0;

function readRaw(): string | null {
  try { return localStorage.getItem(USAGE_HISTORY_KEY); } catch { return null; }
}

function state(): UsageHistoryState | null {
  if (cachedState && dirty) return cachedState;
  const raw = readRaw();
  if (cachedRaw !== undefined && raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  cachedState = parseHistory(loadStored<unknown>(USAGE_HISTORY_KEY, null));
  recentTurnSet = null;
  rateIndex = null;
  return cachedState;
}

export interface UsageHistoryDelta {
  at: number;
  threadId: string;
  turnId?: string;
  provider: UsageProvider;
  model?: string;
  usage: TokenUsageView;
  pricing?: ModelPricing;
}

/** True the first time `key` is seen among the recent turn identities. */
function firstSighting(current: UsageHistoryState, key: string): boolean {
  const id = key.slice(0, MAX_TURN_KEY);
  recentTurnSet ??= new Set(current.recentTurns);
  if (recentTurnSet.has(id)) return false;
  current.recentTurns.push(id);
  recentTurnSet.add(id);
  if (current.recentTurns.length > MAX_RECENT_TURNS) {
    for (const removed of current.recentTurns.splice(0, current.recentTurns.length - MAX_RECENT_TURNS)) recentTurnSet.delete(removed);
  }
  return true;
}

/** Records one delta the ledger has just accepted. The caller guarantees it
 * is called exactly once per accepted delta, after its own duplicate checks. */
export function recordUsageHistory(delta: UsageHistoryDelta): void {
  const usage = delta.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  if (usage.totalTokens <= 0 && tokens <= 0) return;
  const current: UsageHistoryState = state() ?? { startedAt: delta.at, buckets: new Map(), recentTurns: [], turnDays: new Map(), rates: [] };
  const turnKey = delta.turnId ? `${delta.threadId}\0${delta.turnId}`.slice(0, MAX_TURN_KEY) : null;
  const day = (turnKey && current.turnDays.get(turnKey)) || localDayKey(delta.at);
  if (turnKey && !current.turnDays.has(turnKey)) {
    current.turnDays.set(turnKey, day);
    if (current.turnDays.size > MAX_RECENT_TURNS) current.turnDays.delete(current.turnDays.keys().next().value!);
  }
  const model = (delta.model ?? "").trim().slice(0, 200);
  const key = bucketKey(day, delta.provider, model);
  const bucket = current.buckets.get(key) ?? { day, provider: delta.provider, model, ...emptyComponentAmounts() };
  addUsageToAmounts(bucket, usage, delta.pricing);
  addToCohort(current, bucket, delta);
  if (turnKey) {
    if (firstSighting(current, turnKey)) bucket.turns += 1;
    if (firstSighting(current, `${turnKey}\0${delta.provider}\0${model}`)) bucket.modelTurns += 1;
  } else {
    bucket.unturnedTokens += tokens;
  }
  current.buckets.set(key, bucket);
  cachedState = current;
  dirty = true;
}

function indexRate(current: UsageHistoryState, pricing: ModelPricing): number {
  if (!rateIndex) {
    rateIndex = new Map();
    current.rates.forEach((rate, index) => { if (!rateIndex!.has(rateIdentity(rate))) rateIndex!.set(rateIdentity(rate), index); });
  }
  const identity = rateIdentity(pricing);
  let index = rateIndex.get(identity);
  if (index === undefined) {
    index = current.rates.length;
    const { note: _note, ...rate } = pricing;
    current.rates.push(rate);
    rateIndex.set(identity, index);
  }
  return index;
}

/** Adds the delta to the cohort of its rate, widening its span to whole
 * minutes. A repriced cohort is closed: new usage never inherits its label. */
function addToCohort(current: UsageHistoryState, bucket: UsageBucket, delta: UsageHistoryDelta): void {
  const rate = delta.pricing ? indexRate(current, delta.pricing) : -1;
  const parts = usageCostParts(delta.usage);
  const firstAt = Math.floor(delta.at / MINUTE_MS) * MINUTE_MS;
  const lastAt = Math.ceil(delta.at / MINUTE_MS) * MINUTE_MS;
  const cohorts = bucket.cohorts ?? [];
  // A cohort is one contiguous rate spell, not every use of that rate in a
  // day. A→B→A must keep two A spans: widening the first across B would
  // obscure which historical evidence covers either side of the change.
  const latest = cohorts[cohorts.length - 1];
  // The native ledger may already contain a correction while this key's
  // older history snapshot is being hydrated. Do not add fresh tokens to that
  // checkpointed cohort before recovery replays its exact original amount.
  const canExtend = latest?.rate === rate && latest.was === undefined;
  const correctionPending = canExtend && (pricingCorrectionCheckpoint(correctionKey(bucket, latest))?.revision ?? 0) > (latest.revision ?? 0);
  let cohort = canExtend && !correctionPending ? latest : undefined;
  if (!cohort) {
    if (cohorts.length >= MAX_COHORTS) return;
    cohort = {
      id: `${Date.now().toString(36)}${(cohortSequence++).toString(36)}`, rate, firstAt, lastAt,
      uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0,
    };
    cohorts.push(cohort);
    bucket.cohorts = cohorts;
  }
  cohort.firstAt = Math.min(cohort.firstAt, firstAt);
  cohort.lastAt = Math.max(cohort.lastAt, lastAt);
  for (const key of COHORT_TOKENS) cohort[key] += parts[key];
}

function cohortUsage(cohort: RateCohort): TokenUsageView {
  const inputTokens = cohort.uncachedInputTokens + cohort.cacheReadTokens + cohort.cacheWriteTokens;
  return {
    inputTokens, cachedInputTokens: cohort.cacheReadTokens, cacheWriteInputTokens: cohort.cacheWriteTokens,
    cacheWrite1hInputTokens: cohort.cacheWrite1hTokens, outputTokens: cohort.outputTokens, reasoningOutputTokens: 0,
    totalTokens: inputTokens + cohort.outputTokens, contextWindow: null,
  };
}

type CostParts = NonNullable<ReturnType<typeof usageCostParts>["costs"]>;
const COST_FIELDS: Array<[keyof CostParts, keyof UsageComponentAmounts]> = [
  ["uncachedInput", "uncachedInputCost"], ["cacheRead", "cacheReadCost"], ["cacheWrite", "cacheWriteCost"], ["output", "outputCost"],
];
const totalCost = (costs: CostParts | null) => costs ? costs.uncachedInput + costs.cacheRead + costs.cacheWrite + costs.output : 0;

function correctionKey(bucket: UsageBucket, cohort: RateCohort): string {
  return `${bucketKey(bucket.day, bucket.provider, bucket.model)}\0${cohort.id}`;
}

function correctionFor(current: UsageHistoryState, bucket: UsageBucket, cohort: RateCohort,
  pricing: ModelPricing, basis: "observed" | "catalog", revision: number, incrementalCost: number, incrementalTokens: number): PricingCorrection {
  const usage = cohortUsage(cohort);
  const originalRate = cohort.was ?? cohort.rate;
  const original = originalRate >= 0 ? usageCostParts(usage, current.rates[originalRate]).costs : null;
  const desired = usageCostParts(usage, pricing).costs!;
  const checkpoint: PricingCorrectionCheckpoint = {
    id: `${cohort.id}:${revision}>${hash(rateIdentity(pricing))}`, revision,
    cost: totalCost(desired) - totalCost(original), tokens: original ? 0 : cohortTokens(cohort),
    pricing: { ...pricing }, basis,
  };
  return { id: checkpoint.id, provider: bucket.provider, cohortKey: correctionKey(bucket, cohort),
    checkpoint, cost: incrementalCost, tokens: incrementalTokens };
}

function checkpointFitsCohort(current: UsageHistoryState, cohort: RateCohort, checkpoint: PricingCorrectionCheckpoint): boolean {
  const usage = cohortUsage(cohort);
  const originalRate = cohort.was ?? cohort.rate;
  const original = originalRate >= 0 ? usageCostParts(usage, current.rates[originalRate]).costs : null;
  const target = usageCostParts(usage, checkpoint.pricing).costs!;
  return Math.abs(checkpoint.cost - (totalCost(target) - totalCost(original))) <= 1e-8
    && checkpoint.tokens === (original ? 0 : cohortTokens(cohort));
}

function applyCohortRate(current: UsageHistoryState, bucket: UsageBucket, cohort: RateCohort,
  pricing: ModelPricing, basis: "observed" | "catalog", revision: number): void {
  const usage = cohortUsage(cohort);
  const before = cohort.rate >= 0 ? usageCostParts(usage, current.rates[cohort.rate]).costs : null;
  const after = usageCostParts(usage, pricing).costs!;
  for (const [part, field] of COST_FIELDS) bucket[field] = Math.max(0, bucket[field] + after[part] - (before?.[part] ?? 0));
  if (!before) {
    const tokens = cohortTokens(cohort);
    bucket.pricedTokens += tokens;
    bucket.unpricedTokens = Math.max(0, bucket.unpricedTokens - tokens);
  }
  cohort.was ??= cohort.rate;
  cohort.rate = indexRate(current, pricing);
  cohort.basis = basis;
  cohort.revision = revision;
  cohort.checkpointed = true;
}

/** A cohort's cost at a rate in the table; null when unpriced. */
function cohortCost(current: UsageHistoryState, cohort: RateCohort, rate: number): number | null {
  return rate < 0 ? null : totalCost(usageCostParts(cohortUsage(cohort), current.rates[rate]).costs);
}

/**
 * Reprices dated usage wherever evidence shows which rate applied when it
 * happened (see `historicalPricing`): unpriced cohorts gain a cost, and
 * cohorts recorded at a different rate are corrected. Usage without a cohort
 * (mixed legacy days, anything past the cohort cap) and usage outside the
 * dated detail, including the ledger's archive, is never touched.
 *
 * Both stores carry a cohort revision, so the next pass recovers whichever
 * native write finished first. Returns the number of cohorts changed or
 * reconciled.
 */
export function repriceUsageHistory(): number {
  const current = state();
  if (!current) return 0;
  let reconciled = 0;
  const replayLedger: PricingCorrection[] = [];
  const unreliableCohorts = new Set<string>();
  for (const bucket of current.buckets.values()) {
    if (correctionDayWasPruned(bucket.day)) continue;
    for (const cohort of bucket.cohorts ?? []) {
      const key = correctionKey(bucket, cohort);
      const checkpoint = pricingCorrectionCheckpoint(key);
      if (checkpoint && !checkpointFitsCohort(current, cohort, checkpoint)) {
        unreliableCohorts.add(key);
        continue;
      }
      const revision = cohort.revision ?? 0;
      if (checkpoint && checkpoint.revision > revision) {
        applyCohortRate(current, bucket, cohort, checkpoint.pricing, checkpoint.basis, checkpoint.revision);
        reconciled += 1;
      } else if (revision > 0 && (!checkpoint || revision > checkpoint.revision)) {
        const pricing = current.rates[cohort.rate];
        const original = cohort.was! >= 0 ? usageCostParts(cohortUsage(cohort), current.rates[cohort.was!]).costs : null;
        const after = usageCostParts(cohortUsage(cohort), pricing).costs!;
        const correction = correctionFor(current, bucket, cohort, pricing, cohort.basis ?? "catalog", revision,
          totalCost(after) - totalCost(original), original ? 0 : cohortTokens(cohort));
        if (!checkpoint && !cohort.checkpointed && !canReplayCorrectionWithoutCheckpoint(correction.id)) continue;
        replayLedger.push(correction);
        reconciled += 1;
      }
    }
  }
  if (replayLedger.length) commitPricingCorrections(replayLedger);
  const pending: Array<{ bucket: UsageBucket; cohort: RateCohort; pricing: ModelPricing; basis: "observed" | "catalog"; correction: PricingCorrection }> = [];
  for (const bucket of current.buckets.values()) {
    if (correctionDayWasPruned(bucket.day)) continue;
    for (const cohort of bucket.cohorts ?? []) {
      if (unreliableCohorts.has(correctionKey(bucket, cohort))) continue;
      const evidence = historicalPricing(bucket.provider, bucket.model, cohort.firstAt, cohort.lastAt);
      if (!evidence || evidence === "conflict") continue;
      const usage = cohortUsage(cohort);
      const before = cohort.rate >= 0 ? usageCostParts(usage, current.rates[cohort.rate]).costs : null;
      const after = usageCostParts(usage, evidence.pricing).costs!;
      if (before && COST_FIELDS.every(([part]) => Math.abs(after[part] - before[part]) <= 1e-12)) continue;
      pending.push({
        bucket, cohort, pricing: evidence.pricing, basis: evidence.basis,
        correction: correctionFor(current, bucket, cohort, evidence.pricing, evidence.basis,
          (cohort.revision ?? 0) + 1, totalCost(after) - totalCost(before), before ? 0 : cohortTokens(cohort)),
      });
    }
  }
  if (!pending.length && !reconciled) return 0;
  if (pending.length) commitPricingCorrections(pending.map((item) => item.correction));
  for (const { bucket, cohort, pricing, basis } of pending)
    applyCohortRate(current, bucket, cohort, pricing, basis, (cohort.revision ?? 0) + 1);
  cachedState = current;
  dirty = true;
  flushUsageLedger();
  return pending.length + reconciled;
}

export interface RepricingSummary {
  /** Tokens that were unpriced and now have a verified rate. */
  pricedTokens: number;
  /** Tokens moved from one rate to the rate verified for their time. */
  correctedTokens: number;
  /** Net change in estimated cost. */
  costChange: number;
}

/** What evidence-backed repricing changed in these buckets. */
export function repricingSummary(buckets: Iterable<UsageBucket>): RepricingSummary {
  const summary: RepricingSummary = { pricedTokens: 0, correctedTokens: 0, costChange: 0 };
  const current = state();
  if (!current) return summary;
  for (const bucket of buckets) {
    for (const cohort of bucket.cohorts ?? []) {
      if (cohort.was === undefined || cohort.rate >= current.rates.length || cohort.was >= current.rates.length) continue;
      if (cohort.was < 0) summary.pricedTokens += cohortTokens(cohort);
      else summary.correctedTokens += cohortTokens(cohort);
      summary.costChange += (cohortCost(current, cohort, cohort.rate) ?? 0) - (cohortCost(current, cohort, cohort.was) ?? 0);
    }
  }
  return summary;
}

/** Drops detail older than the retention window, and the oldest days beyond
 * the bucket cap. The earliest retained day is remembered for the UI. */
export function pruneUsageHistory(now = Date.now()): void {
  const current = state();
  if (!current) return;
  const cutoff = shiftDayKey(localDayKey(now), -USAGE_HISTORY_RETENTION_DAYS);
  let pruned = false;
  for (const [key, bucket] of current.buckets) {
    if (bucket.day < cutoff) { current.buckets.delete(key); pruned = true; }
  }
  if (current.buckets.size > MAX_BUCKETS) {
    const ordered = [...current.buckets.entries()].sort((left, right) => left[1].day.localeCompare(right[1].day));
    const excess = ordered.length - MAX_BUCKETS;
    // Drop whole days so a retained day is never partially represented.
    const lastDroppedDay = ordered[excess - 1][1].day;
    for (const [key, bucket] of ordered) if (bucket.day <= lastDroppedDay) current.buckets.delete(key);
    pruned = true;
  }
  if (pruned) {
    const days = [...current.buckets.values()].map((bucket) => bucket.day).sort();
    current.retainedFrom = days[0] ?? localDayKey(now);
    prunePricingCorrectionCheckpoints(current.retainedFrom);
    dirty = true;
  }
}

export function flushUsageHistory(now = Date.now()): void {
  if (!dirty || !cachedState) return;
  pruneUsageHistory(now);
  const serialized = serialize(cachedState);
  cachedRaw = JSON.stringify(serialized);
  dirty = false;
  storeValue(USAGE_HISTORY_KEY, serialized);
}

export function resetUsageHistoryCache(): void {
  cachedState = null;
  cachedRaw = undefined;
  dirty = false;
  recentTurnSet = null;
  rateIndex = null;
}

/** Retained buckets and tracking metadata, for read-side summaries. */
export function retainedUsageHistory(): { buckets: Iterable<UsageBucket>; startedDay: string | null; retainedFrom?: string } {
  const current = state();
  return {
    buckets: current?.buckets.values() ?? [],
    startedDay: current ? localDayKey(current.startedAt) : null,
    retainedFrom: current?.retainedFrom,
  };
}

attachUsageHistory({ record: recordUsageHistory, flush: flushUsageHistory, reset: resetUsageHistoryCache, reprice: () => { repriceUsageHistory(); } });
