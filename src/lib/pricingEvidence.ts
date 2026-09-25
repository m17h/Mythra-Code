import { loadStored } from "./storage";
import {
  evidenceSources, finiteRate, OFFICIAL_PRICING_KEY, pricingSource, withClaudeHourCacheRate,
  type ModelPricing, type UsageProvider,
} from "./usageLedger";

/**
 * Historical rate evidence, loaded only with dated detail and the official
 * page parsers.
 *
 * A pricing page only says what a rate is when it is read. `officialPricing`
 * therefore keeps, per model, epochs of identical consecutive observations
 * (`[firstSeenAt, lastSeenAt, input, output, cacheRead, cacheWrite,
 * cacheWrite1h, open]`, missing rates as null). An epoch is extended only when
 * the same rate is seen again within `OBSERVATION_GAP_MS` and the model was
 * never missing from a successful read in between, so it brackets a span of
 * time in which the page showed one rate. The catalog can attest a period
 * explicitly with `effectiveFrom`. Nothing else, and in particular no rate
 * observed only after the usage happened, is evidence for a past moment.
 */
export const OBSERVATION_GAP_MS = 48 * 3_600_000;
// Dated usage is retained for 400 days. A four-period cap could discard an
// older observed rate before its usage is corrected; keep ample bounded
// evidence without turning local storage into an unbounded pricing log.
export const MAX_EPOCHS_PER_MODEL = 32;
export type RateEpoch = [firstSeenAt: number, lastSeenAt: number, input: number, output: number, cacheRead: number | null, cacheWrite: number | null, cacheWrite1h: number | null, open: 0 | 1];
const DAY_MS = 86_400_000;
let epochCache: { raw: string | null; epochs: Record<string, RateEpoch[]> } | null = null;

function positiveTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalRate(value: unknown): number | null | undefined {
  return value === null ? null : finiteRate(value);
}

/** Stored epochs, re-validated; a malformed model's epochs are dropped. */
export function parseRateEpochs(raw: unknown): Record<string, RateEpoch[]> {
  const epochs: Record<string, RateEpoch[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return epochs;
  for (const [key, list] of Object.entries(raw)) {
    if (key.length > 200 || !Array.isArray(list) || !pricingSource(key.slice(0, Math.max(0, key.indexOf(":"))), true)) continue;
    const parsed: RateEpoch[] = [];
    for (const item of list.slice(-MAX_EPOCHS_PER_MODEL)) {
      if (!Array.isArray(item) || item.length !== 8) { parsed.length = 0; break; }
      const [first, last, input, output, cacheRead, cacheWrite, cacheWrite1h, open] = item as unknown[];
      const rates = [optionalRate(cacheRead), optionalRate(cacheWrite), optionalRate(cacheWrite1h)];
      if (!positiveTime(first) || !positiveTime(last) || last < first || !finiteRate(input) || !finiteRate(output)
        || rates.includes(undefined) || (open !== 0 && open !== 1)
        || (parsed.length && first < parsed[parsed.length - 1][1])) { parsed.length = 0; break; }
      parsed.push([first, last, input as number, output as number, rates[0]!, rates[1]!, rates[2]!, open]);
    }
    if (parsed.length) epochs[key] = parsed;
  }
  return epochs;
}

function officialEpochs(): Record<string, RateEpoch[]> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(OFFICIAL_PRICING_KEY); } catch { /* No stored evidence. */ }
  if (epochCache && epochCache.raw === raw) return epochCache.epochs;
  const stored = loadStored<{ epochs?: unknown } | null>(OFFICIAL_PRICING_KEY, null);
  epochCache = { raw, epochs: parseRateEpochs(stored?.epochs) };
  return epochCache.epochs;
}

/** The rates each billable part is actually charged at, with the same
 * fallbacks `estimateUsageCost` applies. */
function effectiveRates(pricing: ModelPricing): number[] {
  const write = pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion;
  return [pricing.inputPerMillion, pricing.outputPerMillion, pricing.cachedInputPerMillion ?? pricing.inputPerMillion, write, pricing.cacheWrite1hInputPerMillion ?? write];
}

function sameEffectiveRates(left: ModelPricing, right: ModelPricing): boolean {
  const a = effectiveRates(left);
  const b = effectiveRates(right);
  return a.every((value, index) => value === b[index]);
}

export interface HistoricalPricing {
  pricing: ModelPricing;
  /** "observed": the provider's page showed this rate before and after the
   * usage; "catalog": the Mythra catalog attests the period. */
  basis: "observed" | "catalog";
}

const SOURCE: Partial<Record<UsageProvider, ModelPricing["source"]>> = { openai: "OpenAI", claude: "Anthropic", cursor: "Cursor" };

/**
 * The rate verified to have applied for the whole span `[from, to]` (epoch
 * ms), or undefined when nothing proves one. Sources that disagree about the
 * span return "conflict" so the caller changes nothing.
 */
export function historicalPricing(provider: UsageProvider, model: string, from: number, to: number): HistoricalPricing | "conflict" | undefined {
  const source = SOURCE[provider];
  if (!source || !model || to < from) return undefined;
  const epochs = officialEpochs();
  const { key, catalog } = evidenceSources(provider, model, (candidate) => candidate in epochs);
  const candidates: HistoricalPricing[] = [];
  if (catalog?.effectiveFrom) {
    const start = Date.parse(catalog.effectiveFrom);
    // The catalog vouches for the rate only through the day it was verified.
    const end = Math.min(catalog.effectiveUntil ? Date.parse(catalog.effectiveUntil) : Infinity, Date.parse(catalog.asOf) + DAY_MS);
    if (start <= from && to < end) {
      const { effectiveFrom: _from, effectiveUntil: _until, status: _status, ...pricing } = catalog;
      candidates.push({ pricing: { ...pricing, origin: "catalog" }, basis: "catalog" });
    }
  }
  const epoch = key ? epochs[key]?.find(([first, last]) => first <= from && to <= last) : undefined;
  if (epoch) {
    const [, last, inputPerMillion, outputPerMillion, cacheRead, cacheWrite, cacheWrite1h] = epoch;
    candidates.push({
      basis: "observed",
      pricing: {
        inputPerMillion, outputPerMillion,
        ...(cacheRead !== null ? { cachedInputPerMillion: cacheRead } : {}),
        ...(cacheWrite !== null ? { cacheWriteInputPerMillion: cacheWrite } : {}),
        ...(cacheWrite1h !== null ? { cacheWrite1hInputPerMillion: cacheWrite1h } : {}),
        source, asOf: new Date(last).toISOString().slice(0, 10), origin: "official",
      },
    });
  }
  const resolved = provider === "claude"
    ? candidates.map((candidate) => ({ ...candidate, pricing: withClaudeHourCacheRate(candidate.pricing)! }))
    : candidates;
  if (!resolved.length) return undefined;
  return resolved.every((candidate) => sameEffectiveRates(candidate.pricing, resolved[0].pricing)) ? resolved[0] : "conflict";
}
