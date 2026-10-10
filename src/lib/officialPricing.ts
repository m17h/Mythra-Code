import { invoke } from "@tauri-apps/api/core";
import { loadStored, storeValue } from "./storage";
import {
  cursorPricingKey, notifyPricingChanged, parseModelPricingCatalog, requestUsageRepricing, OFFICIAL_PRICING_KEY, type ModelPricingCatalogEntry,
} from "./usageLedger";
import { MAX_EPOCHS_PER_MODEL, OBSERVATION_GAP_MS, parseRateEpochs, type RateEpoch } from "./pricingEvidence";

export type OfficialPricingSource = "openai" | "anthropic" | "cursor";
export const OFFICIAL_PRICING_SOURCES: readonly OfficialPricingSource[] = ["openai", "anthropic", "cursor"];
/** One model's rates as read from a page, per million tokens. */
export interface OfficialRate {
  serviceTier?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Claude's 1-hour cache write; `cacheWrite` is the 5-minute rate. */
  cacheWrite1h?: number;
  /** Day the rate was read. */
  asOf: string;
  /** Published display name, where the key is derived from it. */
  name?: string;
  /** Cursor's "Provider" column. */
  vendor?: string;
  status?: "retired" | "limited";
  /** Explicitly published standard long-context rates; never used to replace
   * the ledger's short-context rate. */
  longContext?: Omit<OfficialRate, "longContext" | "name" | "vendor" | "status">;
  longContextThresholdTokens?: number;
}
export type OfficialPricingResult = { ok: true; models: Record<string, OfficialRate>; catalogModels?: Record<string, OfficialRate>; skipped?: number } | { ok: false; error: string };
interface SourceState {
  /** Last attempt, successful or not. */
  checkedAt?: number;
  /** Last attempt whose page parsed and validated. */
  verifiedAt?: number;
  /** Count from the last successfully parsed page, including same-day removals. */
  lastModelCount?: number;
  /** Why the last attempt failed; cleared by a successful one. */
  error?: string;
  /** Exact last successful listing for the settings catalog. The ledger
   * deliberately retains older removed rows for historical usage. */
  catalog?: Record<string, OfficialRate>;
}
export interface OfficialPricingStatus extends SourceState {
  source: OfficialPricingSource;
  checking: boolean;
  /** Saved provenance stays intact when the clock moves backward. These
   * flags prevent future timestamps from attesting present freshness. */
  verificationTimeUncertain: boolean;
  checkedTimeUncertain: boolean;
  /** Models the page listed at its last successful check. */
  models: number;
}

/** Stored rates are keyed the way the ledger looks them up. */
const PROVIDER_KEY: Record<OfficialPricingSource, string> = { openai: "openai", anthropic: "claude", cursor: "cursor" };
const MAX_MODELS_PER_SOURCE = 300;
const CURSOR_NOTE = "Cursor list price. Cursor doesn’t report cache writes, and plan token fees aren’t included.";
let checking = false;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : undefined;
/** Allow minor device-clock drift; larger forward timestamps require another
 * observation, without clamping or rewriting retained rate evidence. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
const timestampAhead = (at: number | undefined, now: number) => at !== undefined && at > now + CLOCK_SKEW_TOLERANCE_MS;
// These published Claude 3 names have a different canonical API-id order.
// Keep the bounded mapping in the display catalog; usage pricing retains its
// existing model scope. Source:
// https://platform.claude.com/docs/en/about-claude/model-deprecations
const LEGACY_CLAUDE_IDS: Readonly<Record<string, string>> = {
  "Claude Haiku 3.5": "claude-3-5-haiku", "Claude Haiku 3": "claude-3-haiku",
  "Claude Sonnet 3.7": "claude-3-7-sonnet", "Claude Sonnet 3.5": "claude-3-5-sonnet",
  "Claude Sonnet 3": "claude-3-sonnet", "Claude Opus 3": "claude-3-opus",
};
const isLegacyClaudeId = (id: string) => Object.values(LEGACY_CLAUDE_IDS).includes(id);
export const isAnthropicPricingModelId = (id: string) => /^claude-[a-z]+-\d+(?:-\d+)?$/.test(id) || isLegacyClaudeId(id);

/** The stored snapshot, re-validated: rates through the ledger's own catalog
 * validator (the same one it prices from), source states field by field. */
function readStore(): { models: Record<string, ModelPricingCatalogEntry>; sources: Partial<Record<OfficialPricingSource, SourceState>>; epochs: Record<string, RateEpoch[]> } {
  const raw = loadStored<{ schemaVersion?: unknown; updatedAt?: unknown; models?: unknown; sources?: Record<string, Record<string, unknown>>; epochs?: unknown } | null>(OFFICIAL_PRICING_KEY, null);
  const sources: Partial<Record<OfficialPricingSource, SourceState>> = {};
  // Source metadata cannot attest a listing from a corrupt or unknown schema.
  // Empty model dictionaries remain valid for catalog-only rows or failures.
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1
    || typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))
    || !raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) return { models: {}, sources, epochs: {} };
  for (const source of OFFICIAL_PRICING_SOURCES) {
    const state = raw?.sources?.[source];
    if (!state || typeof state !== "object") continue;
    const verifiedAt = timestamp(state.verifiedAt);
    const parsedCatalog = verifiedAt ? validatedRateSnapshot(state.catalog, dayOf(verifiedAt)) : undefined;
    const idsValid = parsedCatalog && Object.keys(parsedCatalog).every((id) => source === "openai"
      ? /^[a-z0-9][a-z0-9.-]{0,79}(?:@(fast|flex|batch|ultrafast))?$/.test(id)
      : source === "anthropic" ? isAnthropicPricingModelId(id) : true);
    const catalog = idsValid ? parsedCatalog : undefined;
    sources[source] = {
      checkedAt: timestamp(state.checkedAt),
      verifiedAt,
      ...(typeof state.lastModelCount === "number" && Number.isSafeInteger(state.lastModelCount)
        && state.lastModelCount >= 0 && state.lastModelCount <= MAX_ROWS ? { lastModelCount: state.lastModelCount } : {}),
      ...(typeof state.error === "string" ? { error: state.error.slice(0, 240) } : {}),
      // A corrupt new-format listing must not silently fall back to older,
      // deliberately retained historical ledger rows.
      ...(state.catalog !== undefined ? { catalog: catalog ?? {} } : {}),
      ...(state.catalog !== undefined && !catalog ? { error: "Stored pricing listing is invalid; refresh to read the official prices." } : {}),
    };
  }
  return { models: parseModelPricingCatalog(raw, true)?.models ?? {}, sources, epochs: parseRateEpochs(raw?.epochs) };
}

/** Revalidate persisted display snapshots independently of their successful
 * download. Invalid cache values cannot become free prices or fresh evidence. */
function validatedRateSnapshot(value: unknown, observedDay?: string, depth = 0): Record<string, OfficialRate> | undefined {
  if (depth > 1) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rows = Object.entries(value);
  if (rows.length > MAX_ROWS) return undefined;
  const models: Record<string, OfficialRate> = {};
  for (const [id, raw] of rows) {
    if (!id || id.length > 160 || id === "__proto__" || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const rate = raw as Record<string, unknown>;
    if (rate.serviceTier !== undefined && (typeof rate.serviceTier !== "string"
      || !["standard", "fast", "flex", "batch", "ultrafast"].includes(rate.serviceTier))) return undefined;
    if (id.includes("@") ? id.split("@").length !== 2 || id.split("@")[1] !== rate.serviceTier
      : rate.serviceTier !== undefined && rate.serviceTier !== "standard") return undefined;
    if (typeof rate.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rate.asOf)
      || !Number.isFinite(Date.parse(rate.asOf)) || dayOf(Date.parse(rate.asOf)) !== rate.asOf
      || (observedDay !== undefined && rate.asOf > observedDay)) return undefined;
    const numeric: Record<string, number> = {};
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
      const amount = rate[field];
      if (amount === undefined && field !== "input" && field !== "output") continue;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_RATE) return undefined;
      numeric[field] = amount;
    }
    if ((numeric.cacheRead !== undefined && numeric.cacheRead > numeric.input)
      || (numeric.cacheWrite !== undefined && numeric.cacheWrite < numeric.input)
      || (numeric.cacheWrite1h !== undefined && numeric.cacheWrite1h < (numeric.cacheWrite ?? numeric.input))) return undefined;
    const long = rate.longContext === undefined ? undefined : validatedRateSnapshot({ [id]: rate.longContext }, observedDay, depth + 1);
    if (rate.longContext !== undefined && !long) return undefined;
    models[id] = {
      ...numeric, asOf: rate.asOf,
      ...(typeof rate.name === "string" && rate.name.length <= 120 ? { name: rate.name } : {}),
      ...(typeof rate.serviceTier === "string" && ["standard", "fast", "flex", "batch", "ultrafast"].includes(rate.serviceTier) ? { serviceTier: rate.serviceTier } : {}),
      ...(rate.status === "retired" || rate.status === "limited" ? { status: rate.status } : {}),
      ...(long ? { longContext: long[id] } : {}),
      ...(typeof rate.longContextThresholdTokens === "number" && Number.isSafeInteger(rate.longContextThresholdTokens)
        && rate.longContextThresholdTokens > 0 && rate.longContextThresholdTokens <= 2_000_000
        ? { longContextThresholdTokens: rate.longContextThresholdTokens } : {}),
    } as OfficialRate;
  }
  return models;
}

/** Observed official catalog only: no bundled prices or inferred freshness. */
export function officialPricingSnapshot(source: OfficialPricingSource): Record<string, OfficialRate> {
  const store = readStore();
  const state = store.sources[source];
  if (!state?.verifiedAt) return {};
  if (state.catalog) return state.catalog;
  // Existing installations had no exact listing metadata. Keep their dated
  // standard rates visible until the next successful refresh upgrades them.
  return validatedRateSnapshot(Object.fromEntries(Object.entries(store.models)
    .filter(([key]) => key.startsWith(`${PROVIDER_KEY[source]}:`))
    .map(([key, rate]) => [key.slice(PROVIDER_KEY[source].length + 1), {
      input: rate.inputPerMillion, output: rate.outputPerMillion, asOf: rate.asOf,
      ...(rate.cachedInputPerMillion !== undefined ? { cacheRead: rate.cachedInputPerMillion } : {}),
      ...(rate.cacheWriteInputPerMillion !== undefined ? { cacheWrite: rate.cacheWriteInputPerMillion } : {}),
      ...(rate.cacheWrite1hInputPerMillion !== undefined ? { cacheWrite1h: rate.cacheWrite1hInputPerMillion } : {}),
      ...(rate.serviceTier ? { serviceTier: rate.serviceTier } : {}),
      ...(rate.status ? { status: rate.status } : {}),
    }])), dayOf(state.verifiedAt)) ?? {};
}

/**
 * Extends each listed model's latest epoch when the page shows the same rate
 * again within the observation gap, and otherwise starts a new one. A model a
 * successful read no longer lists has its epoch closed, so a rate is never
 * assumed across a time the page didn't show it.
 */
export function observeRates(
  epochs: Record<string, RateEpoch[]>, prefix: string, models: Record<string, OfficialRate>, now: number,
): Record<string, RateEpoch[]> {
  const next = { ...epochs };
  for (const [key, list] of Object.entries(next)) {
    const last = list[list.length - 1];
    if (key.startsWith(prefix) && !(key.slice(prefix.length) in models) && last?.[7] === 1 && now >= last[1]) next[key] = [...list.slice(0, -1), [...last.slice(0, 7), 0] as RateEpoch];
  }
  for (const [model, rate] of Object.entries(models)) {
    const key = `${prefix}${model}`;
    const observed = [rate.input, rate.output, rate.cacheRead ?? null, rate.cacheWrite ?? null, rate.cacheWrite1h ?? null] as const;
    const list = next[key] ?? [];
    const last = list[list.length - 1];
    // A device-clock correction must not append an epoch before the latest
    // observation or poison the entire stored history on the next read.
    if (last && now < last[1]) continue;
    const same = last && last[7] === 1 && now >= last[1] && now - last[1] <= OBSERVATION_GAP_MS
      && observed.every((value, index) => value === last[index + 2]);
    next[key] = same
      ? [...list.slice(0, -1), [last[0], now, ...observed, 1]]
      : [...list, [now, now, ...observed, 1] as RateEpoch].slice(-MAX_EPOCHS_PER_MODEL);
  }
  return next;
}

function modelsSeenAtLastCheck(source: OfficialPricingSource, store = readStore()): number {
  // Snapshots written before `lastModelCount` still need a best-effort count
  // until their next successful check upgrades the stored source state.
  const storedCount = store.sources[source]?.lastModelCount;
  if (storedCount !== undefined) return storedCount;
  const verifiedAt = store.sources[source]?.verifiedAt;
  if (!verifiedAt) return 0;
  const prefix = `${PROVIDER_KEY[source]}:`;
  const day = dayOf(verifiedAt);
  return Object.entries(store.models).filter(([key, entry]) => key.startsWith(prefix) && !key.includes("@") && entry.asOf === day).length;
}

export function officialPricingStatus(now = Date.now()): OfficialPricingStatus[] {
  const store = readStore();
  return OFFICIAL_PRICING_SOURCES.map((source) => {
    const state = store.sources[source];
    return {
      source, checking, checkedAt: state?.checkedAt, verifiedAt: state?.verifiedAt, error: state?.error,
      verificationTimeUncertain: timestampAhead(state?.verifiedAt, now),
      checkedTimeUncertain: timestampAhead(state?.checkedAt, now), models: modelsSeenAtLastCheck(source, store),
    };
  });
}

/**
 * Records one source's check. A success merges the page's rates over the
 * previous ones: listed models take the new rate and date, and a model no
 * longer listed keeps its last verified rate at its older date, so a newer
 * catalog or bundled rate supersedes it. A failure only records the attempt,
 * leaving every previously verified rate in place.
 */
export function recordOfficialPricingResult(source: OfficialPricingSource, result: OfficialPricingResult, now = Date.now()): void {
  const store = readStore();
  const prefix = `${PROVIDER_KEY[source]}:`;
  const models = { ...store.models };
  let epochs = store.epochs;
  if (result.ok) {
    // This boundary also protects callers recording a parsed Claude page
    // directly: an explicit prompt band cannot become an all-context estimate.
    const ledgerModels = source === "anthropic" ? Object.fromEntries(Object.entries(result.models)
      .filter(([id, rate]) => !isLegacyClaudeId(id) && rate.longContextThresholdTokens === undefined)) : result.models;
    epochs = observeRates(epochs, prefix, ledgerModels, now);
    for (const [model, rate] of Object.entries(ledgerModels)) {
      models[`${prefix}${model}`] = {
        inputPerMillion: rate.input, outputPerMillion: rate.output,
        ...(rate.cacheRead !== undefined ? { cachedInputPerMillion: rate.cacheRead } : {}),
        ...(rate.cacheWrite !== undefined ? { cacheWriteInputPerMillion: rate.cacheWrite } : {}),
        ...(rate.cacheWrite1h !== undefined ? { cacheWrite1hInputPerMillion: rate.cacheWrite1h } : {}),
        asOf: rate.asOf,
        ...(rate.serviceTier ? { serviceTier: rate.serviceTier } : {}),
        ...(rate.status ? { status: rate.status } : {}),
        ...(source === "cursor" ? { note: CURSOR_NOTE } : {}),
      } as ModelPricingCatalogEntry;
    }
    const own = Object.entries(models).filter(([key]) => key.startsWith(prefix)).sort((left, right) => right[1].asOf.localeCompare(left[1].asOf));
    for (const [key] of own.slice(MAX_MODELS_PER_SOURCE)) delete models[key];
    for (const key of Object.keys(epochs)) if (!(key in models)) delete epochs[key];
  }
  const state: SourceState = result.ok
    ? { checkedAt: now, verifiedAt: now, lastModelCount: Object.keys(result.catalogModels ?? result.models).filter((model) => !model.includes("@")).length, catalog: result.catalogModels ?? result.models }
    : { ...store.sources[source], checkedAt: now, error: result.error.slice(0, 240) };
  storeValue(OFFICIAL_PRICING_KEY, { schemaVersion: 1, updatedAt: new Date(now).toISOString(), models, sources: { ...store.sources, [source]: state }, epochs });
  notifyPricingChanged();
  if (result.ok) requestUsageRepricing();
}

function setChecking(value: boolean): void {
  checking = value;
  notifyPricingChanged();
}

/**
 * Reads per-model rates from the providers' official Markdown pricing pages.
 *
 * Loaded on demand (a deferred launch check and the Settings refresh button),
 * never at startup. Each parser reads only the one table it knows, checks its
 * exact columns, and fails the whole source on anything it does not
 * recognise: a moved heading, a renamed or added column, a row with the wrong
 * cell count, an unreadable rate, or two different rates for one model. A
 * failed source changes nothing, and its last verified rates stay in use.
 * Rows it cannot map to a model id with certainty are skipped rather than
 * guessed. Tier rates come only from their explicitly labelled tables;
 * long-context columns are retained separately for the settings catalog.
 */

const MAX_ROWS = 400;
const MAX_RATE = 10_000;
const DAY_MS = 86_400_000;
const RETRY_FAILED_MS = 3_600_000;

type Parsed = { ok: true; models: Record<string, OfficialRate>; skipped: number } | { ok: false; error: string };
const fail = (error: string): Parsed => ({ ok: false, error });

/** Splits a Markdown table row on unescaped pipes. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return null;
  const result: string[] = [];
  let current = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (char === "|") { result.push(current.trim()); current = ""; continue; }
    current += char;
  }
  result.push(current.trim());
  return result;
}

const SEPARATOR_CELL = /^:?-{3,}:?$/;

interface Table { header: string[]; rows: string[][] }

/** The first table after `anchor` (an exact line) and before the next heading. */
function tableAfter(lines: string[], anchor: string, required: boolean): Table | "missing" | string {
  const matches = lines.flatMap((line, index) => line.trim() === anchor ? [index] : []);
  if (matches.length === 0) return required ? `“${anchor}” not found` : "missing";
  if (matches.length > 1) return `“${anchor}” appears more than once`;
  let index = matches[0] + 1;
  while (index < lines.length && !lines[index].trim().startsWith("|")) {
    if (/^#{1,6}\s/.test(lines[index].trim())) return `No table under “${anchor}”`;
    index += 1;
  }
  const header = cells(lines[index] ?? "");
  const separator = cells(lines[index + 1] ?? "");
  if (!header || !separator || separator.length !== header.length || !separator.every((cell) => SEPARATOR_CELL.test(cell))) {
    return `No table under “${anchor}”`;
  }
  const rows: string[][] = [];
  for (index += 2; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
    const row = cells(lines[index]);
    if (!row || row.length !== header.length) return `A row under “${anchor}” has ${row?.length ?? 0} cells, expected ${header.length}`;
    rows.push(row);
    if (rows.length > MAX_ROWS) return `Too many rows under “${anchor}”`;
  }
  return rows.length ? { header, rows } : `Empty table under “${anchor}”`;
}

function normalizedHeader(cell: string): string {
  return cell.replace(/\s+/g, " ").trim().toLowerCase();
}

function headerMatches(header: string[], expected: Array<string | RegExp>): boolean {
  return header.length === expected.length && header.every((cell, index) => {
    const want = expected[index];
    const value = normalizedHeader(cell);
    return typeof want === "string" ? value === want : want.test(value);
  });
}

/** Link text, without emphasis, code marks or footnote superscripts. */
function plainText(cell: string): string {
  return cell
    .replace(/<sup>[^<]*<\/sup>/gi, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MISSING = new Set(["-", "–", "—", ""]);
/** `$1.25`, `$0.3`, `$5 / MTok`. Undefined for a published "no rate" dash;
 * null for anything else, which fails the source. */
function rateCell(cell: string): number | undefined | null {
  const text = plainText(cell);
  if (MISSING.has(text)) return undefined;
  const match = /^\$(\d{1,5}(?:\.\d{1,6})?)(?:\s*\/\s*MTok)?$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value <= MAX_RATE ? value : null;
}

interface RowRates { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; output?: number }

/** Adds one model, rejecting unreadable or implausible rates and conflicting
 * duplicates. Returns an error, or null when the row was accepted or skipped. */
function addModel(
  models: Record<string, OfficialRate>, key: string,
  raw: Record<Exclude<keyof RowRates, "cacheWrite1h">, string> & { cacheWrite1h?: string }, extra: Partial<OfficialRate>,
): string | null | "skipped" {
  const rates: RowRates = {};
  for (const component of ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output"] as const) {
    const cell = raw[component];
    if (cell === undefined) continue;
    const value = rateCell(cell);
    if (value === null) return `Unreadable ${component} rate for ${key}`;
    rates[component] = value;
  }
  // A model without both base rates cannot be priced; it is not a layout change.
  if (rates.input === undefined || rates.output === undefined) return "skipped";
  // Cache reads are discounted input and cache writes are a premium on it.
  // Anything else means columns moved.
  if ((rates.cacheRead !== undefined && rates.cacheRead > rates.input)
    || (rates.cacheWrite !== undefined && rates.cacheWrite < rates.input)
    || (rates.cacheWrite1h !== undefined && rates.cacheWrite1h < (rates.cacheWrite ?? rates.input))) return `Unexpected cache rates for ${key}`;
  const rate: OfficialRate = {
    input: rates.input, output: rates.output,
    ...(rates.cacheRead !== undefined ? { cacheRead: rates.cacheRead } : {}),
    ...(rates.cacheWrite !== undefined ? { cacheWrite: rates.cacheWrite } : {}),
    ...(rates.cacheWrite1h !== undefined ? { cacheWrite1h: rates.cacheWrite1h } : {}),
    ...extra,
  } as OfficialRate;
  const existing = models[key];
  if (existing && (existing.input !== rate.input || existing.output !== rate.output
    || existing.cacheRead !== rate.cacheRead || existing.cacheWrite !== rate.cacheWrite || existing.cacheWrite1h !== rate.cacheWrite1h)) return `Conflicting rates for ${key}`;
  models[key] = existing ?? rate;
  return null;
}

function finish(models: Record<string, OfficialRate>, skipped: number): Parsed {
  return Object.keys(models).length ? { ok: true, models, skipped } : fail("No priced models found");
}

const OPENAI_ANCHOR = "### Standard pricing data";
const OPENAI_HEADER = [
  "model", "short context input", "short context cached input", "short context cache writes", "short context output",
  "long context input", "long context cached input", "long context cache writes", "long context output",
];
const OPENAI_MODEL = /^[a-z0-9][a-z0-9.-]{0,79}$/;
/** The short-context columns apply below this annotated threshold, so the
 * annotation does not change which model the row describes. */
const OPENAI_CONTEXT_NOTE = /\s*\(<\s*\d+K context length\)$/i;

/** Explicitly labelled tier tables only; never infer one tier from another. */
export function parseOpenAIPricing(markdown: string, asOf: string, options: { includeLongContext?: boolean; includeCatalogDetails?: boolean } = {}): Parsed {
  const table = tableAfter(markdown.split(/\r?\n/), OPENAI_ANCHOR, true);
  if (typeof table === "string") return fail(table);
  if (!headerMatches(table.header, OPENAI_HEADER)) return fail("OpenAI's standard pricing columns changed");
  const models: Record<string, OfficialRate> = {};
  let skipped = 0;
  for (const row of table.rows) {
    const id = plainText(row[0]).replace(OPENAI_CONTEXT_NOTE, "");
    if (!OPENAI_MODEL.test(id)) { skipped += 1; continue; }
    const error = addModel(models, id, { input: row[1], cacheRead: row[2], cacheWrite: row[3], output: row[4] }, { asOf });
    if (error === "skipped") skipped += 1;
    else if (error) return fail(error);
    if (options.includeLongContext && models[id]) {
      const long: Record<string, OfficialRate> = models[id].longContext ? { [id]: models[id].longContext } : {};
      const longError = addModel(long, id, { input: row[5], cacheRead: row[6], cacheWrite: row[7], output: row[8] }, { asOf });
      if (longError && longError !== "skipped") return fail(longError);
      // All dashes mean the provider publishes no separate long-context rate.
      // A partially published base pair signals a malformed table.
      if (longError === "skipped" && row.slice(5).some((cell) => !MISSING.has(plainText(cell)))) return fail(`Incomplete long-context rates for ${id}`);
      if (long[id]) models[id].longContext = long[id];
    }
  }
  if (options.includeCatalogDetails) {
    const lines = markdown.split(/\r?\n/);
    for (const [section, endLabel, expected] of [
      ["Cyber models", "Life sciences models", OPENAI_HEADER],
      ["Life sciences models", "Multimodal models", ["model", "input", "cached input", "output"]],
      ["Specialized models", "Fast", ["category", "model", "input", "cached input", "output"]],
    ] as const) {
      const starts = lines.flatMap((line, index) => line.trim() === section ? [index] : []);
      if (!starts.length) continue;
      if (starts.length !== 1) return fail(`OpenAI's ${section} section appears more than once`);
      const start = starts[0];
      const end = lines.findIndex((line, index) => index > start && line.trim() === endLabel);
      const scoped = lines.slice(start, end < 0 ? undefined : end);
      if (!scoped.some((line) => line.trim() === "Prices per 1M tokens.")) return fail(`OpenAI's ${section} units changed`);
      const beforeTable = scoped.slice(0, scoped.findIndex((line) => line.trim() === "### Grouped Pricing Table data"));
      const tierLabels = beforeTable.map((line) => line.trim()).filter((line) => ["Standard", "Batch", "Fast", "Flex", "Ultrafast"].includes(line));
      if (section === "Specialized models" ? tierLabels.length !== 1 || tierLabels[0] !== "Standard"
        : tierLabels.some((label) => label !== "Standard")) return fail(`OpenAI's ${section} Standard label changed`);
      const extra = tableAfter(scoped, "### Grouped Pricing Table data", true);
      if (typeof extra === "string") return fail(extra);
      if (!headerMatches(extra.header, [...expected])) return fail(`OpenAI's ${section} pricing columns changed`);
      for (const row of extra.rows) {
        if (section === "Specialized models" && ["Embedding", "Moderation"].includes(plainText(row[0]))) continue;
        const offset = section === "Specialized models" ? 1 : 0;
        const id = plainText(row[offset]).replace(OPENAI_CONTEXT_NOTE, "");
        if (!OPENAI_MODEL.test(id)) { skipped += 1; continue; }
        const raw = section === "Cyber models"
          ? { input: row[1], cacheRead: row[2], cacheWrite: row[3], output: row[4] }
          : { input: row[offset + 1], cacheRead: row[offset + 2], cacheWrite: "-", output: row[offset + 3] };
        const error = addModel(models, id, raw, { asOf });
        if (error === "skipped") skipped += 1;
        else if (error) return fail(error);
        if (options.includeLongContext && section === "Cyber models" && models[id]) {
          const long: Record<string, OfficialRate> = models[id].longContext ? { [id]: models[id].longContext } : {};
          const error = addModel(long, id, { input: row[5], cacheRead: row[6], cacheWrite: row[7], output: row[8] }, { asOf });
          if (error && error !== "skipped") return fail(error);
          if (error === "skipped" && row.slice(5).some((cell) => !MISSING.has(plainText(cell)))) return fail(`Incomplete long-context rates for ${id}`);
          if (long[id]) models[id].longContext = long[id];
        }
      }
    }
  }
  if (options.includeLongContext) {
    const contextNote = /^Short context: ≤(\d+)K input tokens\. Long context: >(\d+)K input tokens\.$/m.exec(markdown);
    if (contextNote && contextNote[1] === contextNote[2]) {
      const threshold = Number(contextNote[1]) * 1_000;
      if (threshold > 0 && threshold <= 2_000_000) {
        for (const rate of Object.values(models)) if (rate.longContext) rate.longContextThresholdTokens = threshold;
      }
    }
  }
  for (const [tier, label] of [["fast", "Fast"], ["flex", "Flex"], ["batch", "Batch"]] as const) {
    const extra = tableAfter(markdown.split(/\r?\n/), `### ${label} pricing data`, false);
    if (extra === "missing") continue;
    if (typeof extra === "string") return fail(extra);
    if (!headerMatches(extra.header, OPENAI_HEADER)) return fail(`OpenAI's ${tier} pricing columns changed`);
    for (const row of extra.rows) {
      const id = plainText(row[0]).replace(OPENAI_CONTEXT_NOTE, "");
      if (!OPENAI_MODEL.test(id)) { skipped += 1; continue; }
      const error = addModel(models, `${id}@${tier}`, { input: row[1], cacheRead: row[2], cacheWrite: row[3], output: row[4] }, { asOf, serviceTier: tier });
      if (error === "skipped") skipped += 1;
      else if (error) return fail(error);
    }
  }
  return finish(models, skipped);
}

const ANTHROPIC_ANCHOR = "The following table shows pricing for all Claude models:";
const ANTHROPIC_HEADER = [
  "model", /^base input( tokens)?$/, /^5m cache writes?$/, /^1h cache writes?$/, /^cache (hits|reads)( and refreshes)?$/, /^output( tokens)?$/,
];
const CLAUDE_NAME = /^Claude ([A-Z][a-z]+) (\d+)(?:\.(\d+))?(?: \(([^()]*)\))?$/;
const CLAUDE_CONTEXT_NOTE = / \(for prompts (up to|over) ([1-9]\d{0,2}(?:,\d{3})+) tokens\)$/;

/** Maps a published display name to the API id scheme used since Claude 4
 * (`Claude Opus 5.5` → `claude-opus-5-5`). Earlier generations used a
 * different id order, and an unrecognised annotation could mean a different
 * price tier. Known older names are included only when the caller requests
 * the reference catalog, leaving the historical ledger's scope unchanged. */
export function claudeModelId(name: string, options: { includeCatalogDetails?: boolean } = {}): { id: string; status?: OfficialRate["status"] } | null {
  const match = CLAUDE_NAME.exec(name.replace(CLAUDE_CONTEXT_NOTE, ""));
  if (!match) return null;
  const baseName = name.replace(CLAUDE_CONTEXT_NOTE, "").replace(/ \(.*\)$/, "");
  const legacyId = options.includeCatalogDetails ? LEGACY_CLAUDE_IDS[baseName] : undefined;
  if (Number(match[2]) < 4 && !legacyId) return null;
  const note = match[4]?.toLowerCase();
  const status = note === undefined ? undefined : note.startsWith("retired") ? "retired" : note.startsWith("limited") ? "limited" : null;
  if (status === null) return null;
  return { id: legacyId ?? `claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ""}`, ...(status ? { status } : {}) };
}

/** Claude's base rates, with both cache-write durations: Claude Code reports
 * how many cache-write tokens used the 1-hour cache. */
export function parseAnthropicPricing(markdown: string, asOf: string, options: { includeCatalogDetails?: boolean } = {}): Parsed {
  const table = tableAfter(markdown.split(/\r?\n/), ANTHROPIC_ANCHOR, true);
  if (typeof table === "string") return fail(table);
  if (!headerMatches(table.header, ANTHROPIC_HEADER)) return fail("Claude's model pricing columns changed");
  const models: Record<string, OfficialRate> = {};
  const longModels: Record<string, OfficialRate> = {};
  const shortThresholds = new Map<string, number>();
  const longThresholds = new Map<string, number>();
  let skipped = 0;
  for (const row of table.rows) {
    const name = plainText(row[0]);
    const model = claudeModelId(name, options);
    if (!model) { skipped += 1; continue; }
    const context = CLAUDE_CONTEXT_NOTE.exec(name);
    const threshold = context ? Number(context[2].replaceAll(",", "")) : undefined;
    if (threshold !== undefined && threshold > 2_000_000) return fail(`Unexpected context threshold for ${model.id}`);
    const long = context?.[1] === "over";
    if (threshold !== undefined) {
      const thresholds = long ? longThresholds : shortThresholds;
      if (thresholds.has(model.id) && thresholds.get(model.id) !== threshold) return fail(`Conflicting context thresholds for ${model.id}`);
      thresholds.set(model.id, threshold);
    }
    const error = addModel(long ? longModels : models, model.id, { input: row[1], cacheWrite: row[2], cacheWrite1h: row[3], cacheRead: row[4], output: row[5] }, {
      asOf, name: name.replace(/ \(.*\)$/, ""), ...(model.status ? { status: model.status } : {}),
    });
    if (error === "skipped") skipped += 1;
    else if (error) return fail(error);
  }
  for (const [id, rate] of Object.entries(longModels)) {
    if (!models[id] || shortThresholds.get(id) !== longThresholds.get(id)) return fail(`Incomplete context tiers for ${id}`);
    models[id].longContext = rate;
    models[id].longContextThresholdTokens = longThresholds.get(id);
  }
  for (const id of shortThresholds.keys()) if (!longModels[id]) return fail(`Incomplete context tiers for ${id}`);
  return finish(models, skipped);
}

const CURSOR_HEADER = ["model", "provider", "input", "cache write", "cache read", "output", "notes"];

/** Cursor's own models and its third-party models share one layout. Keys are
 * normalized display names, matched later against the live model catalog's
 * names; Auto is never priced because Cursor does not report where it routed. */
export function parseCursorPricing(markdown: string, asOf: string): Parsed {
  const lines = markdown.split(/\r?\n/);
  const tables: Table[] = [];
  for (const [anchor, required] of [["### Model pricing", true], ["## Cursor Models", false]] as const) {
    const table = tableAfter(lines, anchor, required);
    if (table === "missing") continue;
    if (typeof table === "string") return fail(table);
    if (!headerMatches(table.header, CURSOR_HEADER)) return fail("Cursor's model pricing columns changed");
    tables.push(table);
  }
  const models: Record<string, OfficialRate> = {};
  let skipped = 0;
  for (const row of tables.flatMap((table) => table.rows)) {
    const name = plainText(row[0]);
    const key = cursorPricingKey(name);
    if (!key || key === "auto" || name.length > 120) { skipped += 1; continue; }
    const vendor = plainText(row[1]).slice(0, 60);
    const error = addModel(models, key, { input: row[2], cacheWrite: row[3], cacheRead: row[4], output: row[5] }, { asOf, name, ...(vendor ? { vendor } : {}) });
    if (error === "skipped") skipped += 1;
    else if (error) return fail(error);
  }
  return finish(models, skipped);
}

const PARSERS: Record<OfficialPricingSource, (markdown: string, asOf: string) => Parsed> = {
  openai: (markdown, asOf) => parseOpenAIPricing(markdown, asOf, { includeLongContext: true, includeCatalogDetails: true }),
  anthropic: (markdown, asOf) => parseAnthropicPricing(markdown, asOf, { includeCatalogDetails: true }),
  cursor: parseCursorPricing,
};

/** A page that suddenly lists far fewer models than last time is more likely
 * a truncated or restructured table than a mass retirement. */
function shrankSuspiciously(source: OfficialPricingSource, result: OfficialPricingResult): boolean {
  if (!result.ok) return false;
  const before = modelsSeenAtLastCheck(source);
  return before >= 6 && Object.keys(result.catalogModels ?? result.models).filter((model) => !model.includes("@")).length < before / 2;
}

export type PricingDocumentFetcher = (source: OfficialPricingSource) => Promise<string>;
const fetchPricingDocument: PricingDocumentFetcher = (source) => invoke<string>("fetch_pricing_document", { source });

function describeFetchError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (text || "Could not download the pricing page").slice(0, 200);
}

export interface OfficialPricingRefresh { checked: OfficialPricingSource[]; failed: OfficialPricingSource[] }

let inFlight: Promise<OfficialPricingRefresh> | null = null;
let inFlightForced = false;
let forcedAfterRoutine: Promise<OfficialPricingRefresh> | null = null;

/**
 * Checks each official page and records a validated snapshot per source.
 * Without `force`, a source is skipped when it was checked in the last day (or
 * the last hour after a failure), so a launch check never polls. Concurrent
 * calls share one run.
 */
export function refreshOfficialPricing(options: { force?: boolean; fetchDocument?: PricingDocumentFetcher; now?: () => number } = {}): Promise<OfficialPricingRefresh> {
  if (inFlight) {
    // A manual refresh must check every source even if it arrives while the
    // routine launch poll is checking only the sources currently due.
    if (options.force && !inFlightForced) {
      forcedAfterRoutine ??= inFlight.then(() => refreshOfficialPricing(options)).finally(() => { forcedAfterRoutine = null; });
      return forcedAfterRoutine;
    }
    return inFlight;
  }
  inFlightForced = !!options.force;
  inFlight = run(options).finally(() => { inFlight = null; inFlightForced = false; });
  return inFlight;
}

async function run({ force = false, fetchDocument = fetchPricingDocument, now = Date.now }: { force?: boolean; fetchDocument?: PricingDocumentFetcher; now?: () => number }): Promise<OfficialPricingRefresh> {
  const { sources } = readStore();
  const due = OFFICIAL_PRICING_SOURCES.filter((source) => {
    if (force) return true;
    const state = sources[source];
    const at = now();
    return !state?.checkedAt || timestampAhead(state.checkedAt, at)
      || at - state.checkedAt >= (state.error ? RETRY_FAILED_MS : DAY_MS);
  });
  if (!due.length) return { checked: [], failed: [] };
  setChecking(true);
  try {
    const outcomes = await Promise.all(due.map(async (source) => {
      let result: OfficialPricingResult;
      try {
        const document = await fetchDocument(source);
        const asOf = dayOf(now());
        const parsed = PARSERS[source](document, asOf);
        if (!parsed.ok) result = parsed;
        else {
          // Settings can show supplementary standard tables and explicit
          // prompt tiers without changing historical usage billing. Until the
          // ledger accounts for prompt bands, Haiku 5.5 remains unpriced there.
          const ledger = source === "openai" ? parseOpenAIPricing(document, asOf)
            : source === "anthropic" ? { ...parsed, models: Object.fromEntries(Object.entries(parsed.models)
              .filter(([id, rate]) => !isLegacyClaudeId(id) && rate.longContextThresholdTokens === undefined)) } : parsed;
          result = ledger.ok ? { ...ledger, catalogModels: parsed.models } : ledger;
        }
        if (shrankSuspiciously(source, result)) result = { ok: false, error: "Far fewer models than the last check; keeping the previous rates" };
      } catch (error) {
        result = { ok: false, error: describeFetchError(error) };
      }
      recordOfficialPricingResult(source, result, now());
      return result.ok;
    }));
    return { checked: due, failed: due.filter((_, index) => !outcomes[index]) };
  } finally {
    setChecking(false);
  }
}
