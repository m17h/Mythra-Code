import type { Provider } from "../types";
import {
  pricingForModel, pricingModelKeys, providerUsageTotals, usageTotals, type UsageAmounts, type UsageProvider, type UsageTotals,
} from "./usageLedger";
import {
  addComponentAmounts, emptyComponentAmounts, retainedUsageHistory, shiftDayKey, type UsageBucket, type UsageComponentAmounts,
} from "./usageHistory";

/**
 * Read-side views over dated usage detail. Only the Settings usage page needs
 * these, so they live apart from the recording path and load with that page.
 */

export interface UsageRange {
  /** Inclusive local days. */
  from: string;
  to: string;
}

export interface UsageSelectionTotals extends UsageComponentAmounts { estimatedCost: number }
export interface ModelUsageSummary extends UsageComponentAmounts { provider: UsageProvider; model: string }
export interface ProviderUsageSummary extends UsageComponentAmounts {
  provider: UsageProvider;
  models: ModelUsageSummary[];
  /** All time only: this provider's ledger usage with no dated detail. Its
   * token split is known; its cost only in total, and never by model. */
  earlier?: UsageSelectionTotals;
}
export interface UsageHistorySummary {
  totals: UsageComponentAmounts;
  providers: ProviderUsageSummary[];
  /** When detailed tracking began, or null if nothing was ever recorded. */
  startedDay: string | null;
  /** Earliest retained day when older detail has been pruned. */
  retainedFrom?: string;
  /** The dated buckets in range, for per-day views. */
  buckets: UsageBucket[];
}

export interface UsageDetail {
  totals: UsageSelectionTotals;
  /** Dated detail by provider and resolved model; for all time, also each
   * provider's earlier, undated ledger usage where the provider is known. */
  providers: ProviderUsageSummary[];
  /** Turn-level averages use only dated detail, never the unallocated remainder. */
  detailTotals: UsageComponentAmounts;
  /** All-time only: ledger usage with no dated detail (recorded before
   * tracking began or aged out of retention). Its cost is known only in total. */
  unallocated: UsageSelectionTotals | null;
  /** All-time only: dated detail holds more than the authoritative ledger,
   * which only an interrupted save can cause. Totals then use the ledger. */
  detailAhead?: boolean;
  startedDay: string | null;
  retainedFrom?: string;
  /** Dated detail in range, one bucket per day, provider and model. */
  buckets: UsageBucket[];
}

/** The all-time ledger view dated detail is anchored to. */
export interface LedgerUsage { totals: UsageTotals; providers: Array<UsageAmounts & { provider: UsageProvider }> }

export function componentCost(amounts: UsageComponentAmounts): number {
  return amounts.uncachedInputCost + amounts.cacheReadCost + amounts.cacheWriteCost + amounts.outputCost;
}

/** Pure aggregation over buckets for an inclusive local-day range, or all of
 * them when `range` is null. Never touches transcripts. */
export function summarizeUsageBuckets(
  buckets: Iterable<UsageBucket>,
  range: UsageRange | null,
  startedDay: string | null,
  retainedFrom?: string,
): UsageHistorySummary {
  const totals = emptyComponentAmounts();
  const providers = new Map<UsageProvider, ProviderUsageSummary>();
  const models = new Map<string, ModelUsageSummary>();
  const inRange: UsageBucket[] = [];
  for (const bucket of buckets) {
    if (range && (bucket.day < range.from || bucket.day > range.to)) continue;
    inRange.push(bucket);
    addComponentAmounts(totals, bucket);
    let provider = providers.get(bucket.provider);
    if (!provider) {
      provider = { provider: bucket.provider, models: [], ...emptyComponentAmounts() };
      providers.set(bucket.provider, provider);
    }
    addComponentAmounts(provider, bucket);
    const modelKey = `${bucket.provider}\0${bucket.model}`;
    let model = models.get(modelKey);
    if (!model) {
      model = { provider: bucket.provider, model: bucket.model, ...emptyComponentAmounts() };
      models.set(modelKey, model);
      provider.models.push(model);
    }
    addComponentAmounts(model, bucket);
  }
  const byTokens = (left: UsageComponentAmounts, right: UsageComponentAmounts) => right.totalTokens - left.totalTokens;
  const list = [...providers.values()].sort(byTokens);
  for (const provider of list) provider.models.sort(byTokens);
  return { totals, providers: list, startedDay, retainedFrom, buckets: inRange };
}

export function summarizeUsageHistory(range: UsageRange | null): UsageHistorySummary {
  const history = retainedUsageHistory();
  return summarizeUsageBuckets(history.buckets, range, history.startedDay, history.retainedFrom);
}

/** Usage for an inclusive local-day range, or all time when `range` is null.
 * All-time totals stay anchored to the authoritative ledger. */
export function usageDetail(range: UsageRange | null): UsageDetail {
  const ledger = { totals: usageTotals(), providers: providerUsageTotals() };
  const allHistory = summarizeUsageHistory(null);
  // A crash or out-of-order native storage write can leave optional detail
  // ahead of the saved ledger. Suppress that detail in *every* date range;
  // otherwise a range or provider could still show more than All time.
  if (historyExceedsLedger(allHistory, ledger)) {
    const empty = { ...allHistory, totals: emptyComponentAmounts(), providers: [], buckets: [] };
    return { ...combineUsageDetail(empty, range ? null : ledger), detailAhead: true };
  }
  return combineUsageDetail(range ? summarizeUsageHistory(range) : allHistory, range ? null : ledger);
}

function historyExceedsLedger(history: UsageHistorySummary, ledger: LedgerUsage): boolean {
  if (exceedsLedger(ledger.totals, history.totals)) return true;
  return history.providers.some((provider) => {
    const saved = ledger.providers.find((item) => item.provider === provider.provider);
    return !saved || exceedsLedger(saved, provider);
  });
}

/** Ledger usage that dated detail does not account for. Token types are
 * known from the ledger; cost only as a total. Null when nothing remains. */
function remainderOf(ledger: UsageAmounts, detail: UsageComponentAmounts): UsageSelectionTotals | null {
  const remaining = (value: number) => Math.max(0, value);
  const rest: UsageSelectionTotals = {
    ...emptyComponentAmounts(),
    uncachedInputTokens: remaining(ledger.inputTokens - ledger.cachedInputTokens - ledger.cacheWriteInputTokens - detail.uncachedInputTokens),
    cacheReadTokens: remaining(ledger.cachedInputTokens - detail.cacheReadTokens),
    cacheWriteTokens: remaining(ledger.cacheWriteInputTokens - detail.cacheWriteTokens),
    outputTokens: remaining(ledger.outputTokens - detail.outputTokens),
    reasoningOutputTokens: remaining(ledger.reasoningOutputTokens - detail.reasoningOutputTokens),
    totalTokens: remaining(ledger.totalTokens - detail.totalTokens),
    pricedTokens: remaining(ledger.pricedTokens - detail.pricedTokens),
    unpricedTokens: remaining(ledger.unpricedTokens - detail.unpricedTokens),
    estimatedCost: 0,
  };
  const cost = ledger.estimatedCost - componentCost(detail);
  // Floating-point residue from summing the same deltas two ways is not usage.
  rest.estimatedCost = cost > 1e-9 ? cost : 0;
  return rest.totalTokens > 0 || rest.pricedTokens + rest.unpricedTokens > 0 ? rest : null;
}

/**
 * Anchors dated detail to the all-time ledger (pass null for a date range).
 * Each provider's undated remainder comes from the ledger's own frozen
 * provider attribution; usage with no saved provider label stays under
 * "unknown" and is never assigned to a guessed provider.
 */
export function combineUsageDetail(summary: UsageHistorySummary, ledger: LedgerUsage | null): UsageDetail {
  const detail = summary.totals;
  const base = { detailTotals: detail, startedDay: summary.startedDay, retainedFrom: summary.retainedFrom, buckets: summary.buckets };
  const detailTotals = { ...detail, estimatedCost: componentCost(detail) };
  if (!ledger) return { ...base, providers: summary.providers, totals: detailTotals, unallocated: null };
  if (historyExceedsLedger(summary, ledger)) {
    const ledgerOnly = ledgerTotals(ledger.totals);
    const providers = ledger.providers.filter((amounts) => amounts.totalTokens > 0).map((amounts) => ({
      provider: amounts.provider, models: [], ...emptyComponentAmounts(), earlier: ledgerTotals(amounts),
    })).sort((left, right) => right.earlier.totalTokens - left.earlier.totalTokens);
    return { ...base, detailTotals: emptyComponentAmounts(), buckets: [], providers, totals: ledgerOnly, unallocated: ledgerOnly, detailAhead: true };
  }
  const unallocated = remainderOf(ledger.totals, detail);
  const byProvider = new Map(summary.providers.map((provider) => [provider.provider, { ...provider }]));
  for (const amounts of ledger.providers) {
    const provider = byProvider.get(amounts.provider) ?? { provider: amounts.provider, models: [], ...emptyComponentAmounts() };
    const earlier = remainderOf(amounts, provider);
    if (earlier) provider.earlier = earlier;
    byProvider.set(amounts.provider, provider);
  }
  const allTimeTokens = (provider: ProviderUsageSummary) => provider.totalTokens + (provider.earlier?.totalTokens ?? 0);
  const providers = [...byProvider.values()].filter((provider) => allTimeTokens(provider) > 0 || provider.models.length)
    .sort((left, right) => allTimeTokens(right) - allTimeTokens(left));
  const totals = unallocated
    ? { ...addComponentAmounts({ ...detail }, unallocated), estimatedCost: detailTotals.estimatedCost + unallocated.estimatedCost }
    : detailTotals;
  return { ...base, providers, totals, unallocated };
}

/** The ledger and detail sum the same deltas in different orders, so allow
 * rounding residue before calling detail "ahead". */
function exceedsLedger(ledger: UsageAmounts, detail: UsageComponentAmounts): boolean {
  const over = (value: number, limit: number) => value > limit + Math.max(1e-6, Math.abs(limit) * 1e-9);
  return over(detail.totalTokens, ledger.totalTokens)
    || over(detail.outputTokens, ledger.outputTokens)
    || over(detail.cacheReadTokens, ledger.cachedInputTokens)
    || over(detail.cacheWriteTokens, ledger.cacheWriteInputTokens)
    || over(detail.uncachedInputTokens + detail.cacheReadTokens + detail.cacheWriteTokens, ledger.inputTokens)
    || over(componentCost(detail), ledger.estimatedCost);
}

/** Ledger totals in the page's shape. The ledger knows cost only in total. */
function ledgerTotals(ledger: UsageAmounts): UsageSelectionTotals {
  return {
    ...emptyComponentAmounts(),
    uncachedInputTokens: Math.max(0, ledger.inputTokens - ledger.cachedInputTokens - ledger.cacheWriteInputTokens),
    cacheReadTokens: ledger.cachedInputTokens,
    cacheWriteTokens: ledger.cacheWriteInputTokens,
    outputTokens: ledger.outputTokens,
    reasoningOutputTokens: ledger.reasoningOutputTokens,
    totalTokens: ledger.totalTokens,
    pricedTokens: ledger.pricedTokens,
    unpricedTokens: ledger.unpricedTokens,
    estimatedCost: ledger.estimatedCost,
  };
}

/** Models with a known first-party rate, for hypothetical comparisons. */
export function knownPricedModels(): Array<{ provider: Provider; model: string }> {
  const seen = new Set<string>();
  const models: Array<{ provider: Provider; model: string }> = [];
  for (const key of pricingModelKeys()) {
    const separator = key.indexOf(":");
    const provider = key.slice(0, separator) as Provider;
    const model = key.slice(separator + 1);
    if (seen.has(key) || !pricingForModel(provider, model)) continue;
    seen.add(key);
    models.push({ provider, model });
  }
  return models;
}

/** The four billable parts of usage. Cache reads and writes are parts of input. */
export const USAGE_COMPONENTS = [
  { id: "input", label: "Uncached input", tokens: "uncachedInputTokens", cost: "uncachedInputCost" },
  { id: "cacheRead", label: "Cache read", tokens: "cacheReadTokens", cost: "cacheReadCost" },
  { id: "cacheWrite", label: "Cache write", tokens: "cacheWriteTokens", cost: "cacheWriteCost" },
  { id: "output", label: "Output", tokens: "outputTokens", cost: "outputCost" },
] as const;
export type UsageComponentId = (typeof USAGE_COMPONENTS)[number]["id"];
export type PerComponent = Record<UsageComponentId | "total", number>;

function perComponent(amounts: UsageComponentAmounts, kind: "tokens" | "cost", divisor: number): PerComponent {
  const result = { total: 0 } as PerComponent;
  for (const component of USAGE_COMPONENTS) {
    result[component.id] = amounts[component[kind]] / divisor;
    result.total += result[component.id];
  }
  return result;
}

export interface PromptAverages {
  /** Prompts behind the token averages. */
  prompts: number;
  /** Tokens per prompt by billable part; null without identified prompts. */
  tokens: PerComponent | null;
  /** Prompts behind the cost averages: those whose usage was all priced. */
  pricedPrompts: number;
  /** Estimated cost per priced prompt by billable part. */
  cost: PerComponent | null;
  /** Aggregate buckets cannot identify which prompt switched into an
   * unpriced model, so a partial cost average would claim false coverage. */
  ambiguousCost: boolean;
  /** Tokens left out of every average: model-days that include usage
   * reported without a prompt id, which can't be divided per prompt. */
  excludedTokens: number;
}

/**
 * Per-prompt averages over dated buckets. A bucket (one day, provider and
 * model) is averaged whole or not at all, so every numerator has exactly the
 * prompts it came from as its denominator: token averages skip buckets with
 * usage that lacked a prompt id, and cost averages further skip buckets with
 * any unpriced usage rather than treat those tokens as free. `turns` counts
 * each prompt once across models; `modelTurns` counts the prompts that used
 * one model, for that model's own averages.
 */
export function promptAverages(buckets: Iterable<UsageComponentAmounts>, per: "turns" | "modelTurns"): PromptAverages {
  const selected = [...buckets];
  const ambiguousCost = per === "turns"
    && selected.some((bucket) => bucket.modelTurns > bucket.turns)
    && selected.some((bucket) => bucket.unpricedTokens > 0);
  const identified = emptyComponentAmounts();
  const priced = emptyComponentAmounts();
  let prompts = 0; let pricedPrompts = 0; let excludedTokens = 0;
  for (const bucket of selected) {
    if (bucket.unturnedTokens > 0) { excludedTokens += bucket.totalTokens; continue; }
    addComponentAmounts(identified, bucket);
    prompts += bucket[per];
    if (bucket.unpricedTokens > 0) continue;
    addComponentAmounts(priced, bucket);
    pricedPrompts += bucket[per];
  }
  return {
    prompts,
    tokens: prompts ? perComponent(identified, "tokens", prompts) : null,
    pricedPrompts: ambiguousCost ? 0 : pricedPrompts,
    cost: !ambiguousCost && pricedPrompts ? perComponent(priced, "cost", pricedPrompts) : null,
    ambiguousCost,
    excludedTokens,
  };
}

export interface ComponentBreakdownRow {
  id: UsageComponentId;
  label: string;
  /** Every known token of this part, including undated earlier usage. */
  tokens: number;
  /** Estimated cost of the tokens this part's cost can be split for. */
  cost: number;
  /** Tokens whose cost is certainly included in `cost`. */
  costedTokens: number;
  /** Tokens recorded on a model-day that was only partly priced; some of
   * them are in `cost`, and which ones is unknown. */
  partlyCostedTokens: number;
}

export interface ComponentBreakdown {
  rows: ComponentBreakdownRow[];
  /** Undated earlier usage: its token split is known and counted in the rows;
   * its cost is known only in total. */
  earlier: { tokens: number; cost: number; priced: boolean } | null;
  total: { tokens: number; cost: number };
}

/**
 * Tokens and estimated cost by billable part, with how much of each part the
 * cost covers. Nothing is apportioned: a fully priced bucket covers its
 * tokens, an unpriced one covers none, a partly priced one is reported as such,
 * and earlier usage adds its known tokens but only a total cost.
 */
export function componentBreakdown(buckets: Iterable<UsageComponentAmounts>, earlier?: UsageSelectionTotals | null): ComponentBreakdown {
  const rows: ComponentBreakdownRow[] = USAGE_COMPONENTS.map((component) => ({
    id: component.id, label: component.label, tokens: earlier?.[component.tokens] ?? 0, cost: 0, costedTokens: 0, partlyCostedTokens: 0,
  }));
  for (const bucket of buckets) {
    USAGE_COMPONENTS.forEach((component, index) => {
      const row = rows[index];
      const tokens = bucket[component.tokens];
      row.tokens += tokens;
      row.cost += bucket[component.cost];
      if (!bucket.pricedTokens) return;
      if (bucket.unpricedTokens) row.partlyCostedTokens += tokens;
      else row.costedTokens += tokens;
    });
  }
  const earlierPart = earlier && earlier.totalTokens > 0
    ? { tokens: earlier.totalTokens, cost: earlier.estimatedCost, priced: earlier.pricedTokens > 0 }
    : null;
  return {
    rows,
    earlier: earlierPart,
    total: {
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      cost: rows.reduce((sum, row) => sum + row.cost, 0) + (earlierPart?.cost ?? 0),
    },
  };
}

export type UsageGrain = "day" | "week";

/** Monday of the local week containing `day`. */
export function weekStart(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = (new Date(year, month - 1, date, 12).getDay() + 6) % 7;
  return shiftDayKey(day, -weekday);
}

export interface UsagePeriod {
  /** First and last local day of the period that fall inside the range. */
  from: string;
  to: string;
  /** False when the range cuts the week short. */
  complete: boolean;
  amounts: UsageComponentAmounts;
}

/** Consecutive days or weeks across an inclusive range, including empty ones,
 * each summing the buckets `include` accepts. */
export function usagePeriods(
  buckets: Iterable<UsageBucket>, range: UsageRange, grain: UsageGrain, include: (bucket: UsageBucket) => boolean = () => true,
): UsagePeriod[] {
  const periods: UsagePeriod[] = [];
  const index = new Map<string, UsagePeriod>();
  for (let day = range.from; day <= range.to && periods.length < 800;) {
    const start = grain === "week" ? weekStart(day) : day;
    const end = grain === "week" ? shiftDayKey(start, 6) : day;
    const period = {
      from: day, to: end < range.to ? end : range.to, complete: grain === "day" || (start >= range.from && end <= range.to), amounts: emptyComponentAmounts(),
    };
    periods.push(period);
    index.set(start, period);
    day = shiftDayKey(end, 1);
  }
  for (const bucket of buckets) {
    if (bucket.day < range.from || bucket.day > range.to || !include(bucket)) continue;
    const period = index.get(grain === "week" ? weekStart(bucket.day) : bucket.day);
    if (period) addComponentAmounts(period.amounts, bucket);
  }
  return periods;
}
