import { fetchModelLifecycleDocument, fetchPricingDocument } from "./pricingDocuments";
import { loadStored, storedRevision, storeValue } from "./storage";
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
  /** The pricing page explicitly identifies `cacheWrite` as OpenAI's 30-minute rate. */
  cacheWrite30m?: true;
  /** OpenAI's optional 12-hour cache write; `cacheWrite` is its default rate. */
  cacheWrite12h?: number;
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
export interface OfficialPricingBoundary {
  name?: string;
  longContext?: true;
  longContextThresholdTokens?: number;
}
export type OfficialPricingResult = { ok: true; models: Record<string, OfficialRate>; catalogModels?: Record<string, OfficialRate>; catalogError?: string; pricingPageModels?: Record<string, OfficialRate>; skipped?: number } | { ok: false; error: string };
interface SourceState {
  /** Last attempt, successful or not. */
  checkedAt?: number;
  /** Last attempt whose page parsed and validated. */
  verifiedAt?: number;
  /** Count from the last successfully parsed page, including same-day removals. */
  lastModelCount?: number;
  /** Why the last attempt failed; cleared by a successful one. */
  error?: string;
  /** Exact last successful listing for Settings. Kept when either document fails. */
  catalog?: Record<string, OfficialRate>;
  catalogVerifiedAt?: number;
  catalogError?: string;
  /** Compact context-price coverage from the pricing page, independent of model lifecycle. */
  pricingBoundaries?: Record<string, OfficialPricingBoundary>;
}
export interface OfficialPricingStatus extends Pick<SourceState, "checkedAt" | "verifiedAt" | "error" | "catalogVerifiedAt" | "catalogError"> {
  source: OfficialPricingSource;
  checking: boolean;
  /** Saved provenance stays intact when the clock moves backward. These
   * flags prevent future timestamps from attesting present freshness. */
  verificationTimeUncertain: boolean;
  catalogVerificationTimeUncertain: boolean;
  checkedTimeUncertain: boolean;
  /** Models the page listed at its last successful check. */
  models: number;
}

/** Stored rates are keyed the way the ledger looks them up. */
const PROVIDER_KEY: Record<OfficialPricingSource, string> = { openai: "openai", anthropic: "claude", cursor: "cursor" };
const MAX_MODELS_PER_SOURCE = 300;
const CURSOR_NOTE = "Cursor list price. Cursor doesn’t report cache writes, and plan token fees aren’t included.";
let checking = false;
const NO_RATES: Readonly<Record<string, OfficialRate>> = Object.freeze({});
const NO_BOUNDARIES: Readonly<Record<string, OfficialPricingBoundary>> = Object.freeze({});

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

function validCatalogId(source: OfficialPricingSource, id: string): boolean {
  return source === "openai" ? /^[a-z0-9][a-z0-9.-]{0,79}(?:@(fast|flex|batch|ultrafast))?$/.test(id)
    : source === "anthropic" ? isAnthropicPricingModelId(id) : true;
}

function pricingBoundaries(models: Record<string, OfficialRate>): Record<string, OfficialPricingBoundary> {
  return Object.fromEntries(Object.entries(models).filter(([id]) => !id.includes("@")).map(([id, rate]) => [id, {
    ...(rate.name !== undefined ? { name: rate.name } : {}),
    ...(rate.longContext ? { longContext: true as const, longContextThresholdTokens: rate.longContextThresholdTokens } : {}),
  }]));
}

function validatedPricingBoundaries(source: OfficialPricingSource, value: unknown): Record<string, OfficialPricingBoundary> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rows = Object.entries(value);
  if (rows.length > MAX_ROWS) return undefined;
  const boundaries: Record<string, OfficialPricingBoundary> = {};
  for (const [id, rate] of rows) {
    if (id.length > 160 || !validCatalogId(source, id) || id.includes("@") || !rate || typeof rate !== "object" || Array.isArray(rate)) return undefined;
    const { name, longContext, longContextThresholdTokens } = rate as Record<string, unknown>;
    if (name !== undefined && (typeof name !== "string" || name.length > 120)) return undefined;
    if (longContext !== undefined && longContext !== true) return undefined;
    if (longContextThresholdTokens !== undefined && (longContext !== true || !validContextThreshold(longContextThresholdTokens))) return undefined;
    boundaries[id] = { name, longContext, longContextThresholdTokens };
  }
  return boundaries;
}

function validContextThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_000_000;
}

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
    const catalogVerifiedAt = timestamp(state.catalogVerifiedAt);
    const catalogAt = catalogVerifiedAt ?? verifiedAt;
    const parsedCatalog = catalogAt ? validatedRateSnapshot(state.catalog, dayOf(catalogAt)) : undefined;
    const catalog = parsedCatalog && Object.keys(parsedCatalog).length && Object.entries(parsedCatalog).every(([id, rate]) =>
      validCatalogId(source, id) && (source === "cursor" || !catalogVerifiedAt || (!id.includes("@") && rate.status !== "retired")))
      ? parsedCatalog : undefined;
    // Before lifecycle verification, the stored listing was the unfiltered
    // pricing page. Its context evidence remains useful during migration.
    const boundaries = source === "cursor" || !verifiedAt ? undefined : state.pricingBoundaries !== undefined
      ? validatedPricingBoundaries(source, state.pricingBoundaries)
      : !catalogVerifiedAt && catalog ? pricingBoundaries(catalog) : undefined;
    sources[source] = {
      checkedAt: timestamp(state.checkedAt),
      verifiedAt,
      ...(typeof state.lastModelCount === "number" && Number.isSafeInteger(state.lastModelCount)
        && state.lastModelCount >= 0 && state.lastModelCount <= MAX_ROWS ? { lastModelCount: state.lastModelCount } : {}),
      ...(typeof state.error === "string" ? { error: state.error.slice(0, 240) } : {}),
      ...(catalog && (source === "cursor" || catalogVerifiedAt) ? { catalog, catalogVerifiedAt } : {}),
      ...(typeof state.catalogError === "string" ? { catalogError: state.catalogError.slice(0, 240) } : {}),
      ...(catalogVerifiedAt && !catalog ? { catalogError: "Stored pricing listing is invalid; refresh to read the official prices." } : {}),
      ...(boundaries ? { pricingBoundaries: boundaries } : {}),
    };
  }
  return { models: parseModelPricingCatalog(raw, true)?.models ?? {}, sources, epochs: parseRateEpochs(raw?.epochs) };
}

type StoredListings = Pick<ReturnType<typeof readStore>, "models" | "sources">;
type RateListing = Readonly<Record<string, Readonly<OfficialRate>>>;
let displayStoreCache: StoredListings & { revision: number } | null = null;

/** Bounded validated listings for repeated display reads, reused until storage
 * observes a value change. `readStore` is a pure function of that value, and nothing
 * derived from the clock or `checking` belongs here. Epochs are not retained:
 * only the write path reads them, and it always parses the current value. */
function displayStore(): NonNullable<typeof displayStoreCache> {
  if (displayStoreCache?.revision === storedRevision(OFFICIAL_PRICING_KEY)) return displayStoreCache;
  const { models, sources } = readStore();
  // Reading can itself advance the revision when it detects an external change.
  const store = { revision: storedRevision(OFFICIAL_PRICING_KEY), models, sources };
  // An unreadable cache also reads as empty; retrying matches an uncached read
  // instead of hiding saved rates until the next write.
  // Restored snapshots can exceed the writer's per-source retention limit.
  // Keep them fully readable without retaining an unbounded display copy.
  displayStoreCache = Object.keys(sources).length
    && Object.keys(models).length <= MAX_MODELS_PER_SOURCE * OFFICIAL_PRICING_SOURCES.length ? store : null;
  return store;
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
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "cacheWrite12h"] as const) {
      const amount = rate[field];
      if (amount === undefined && field !== "input" && field !== "output") continue;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_RATE) return undefined;
      numeric[field] = amount;
    }
    if ((numeric.cacheRead !== undefined && numeric.cacheRead > numeric.input)
      || (numeric.cacheWrite !== undefined && numeric.cacheWrite < numeric.input)
      || (numeric.cacheWrite1h !== undefined && numeric.cacheWrite1h < (numeric.cacheWrite ?? numeric.input))
      || (numeric.cacheWrite12h !== undefined && numeric.cacheWrite12h < (numeric.cacheWrite ?? numeric.input))) return undefined;
    const long = rate.longContext === undefined ? undefined : validatedRateSnapshot({ [id]: rate.longContext }, observedDay, depth + 1);
    if (rate.longContext !== undefined && !long) return undefined;
    models[id] = {
      ...numeric, asOf: rate.asOf,
      ...(typeof rate.name === "string" && rate.name.length <= 120 ? { name: rate.name } : {}),
      ...(typeof rate.serviceTier === "string" && ["standard", "fast", "flex", "batch", "ultrafast"].includes(rate.serviceTier) ? { serviceTier: rate.serviceTier } : {}),
      ...(rate.cacheWrite30m === true && numeric.cacheWrite !== undefined ? { cacheWrite30m: true } : {}),
      ...(rate.status === "retired" || rate.status === "limited" ? { status: rate.status } : {}),
      ...(long ? { longContext: long[id] } : {}),
      ...(validContextThreshold(rate.longContextThresholdTokens)
        ? { longContextThresholdTokens: rate.longContextThresholdTokens } : {}),
    } as OfficialRate;
  }
  return models;
}

/** Observed official catalog only: no bundled prices or inferred freshness.
 * Cacheable results are shared until storage observes a value change. */
export function officialPricingSnapshot(source: OfficialPricingSource): RateListing {
  const state = displayStore().sources[source];
  return state?.catalog ?? NO_RATES;
}

/** Pricing-page context evidence for model controls, independent of Settings' active list. */
export function officialPricingPageSnapshot(source: "openai" | "anthropic"): Readonly<Record<string, Readonly<OfficialPricingBoundary>>> {
  return displayStore().sources[source]?.pricingBoundaries ?? NO_BOUNDARIES;
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

function modelsSeenAtLastCheck(source: OfficialPricingSource, store: StoredListings = readStore()): number {
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
  const store = displayStore();
  return OFFICIAL_PRICING_SOURCES.map((source) => {
    const state = store.sources[source];
    return {
      source, checking, checkedAt: state?.checkedAt, verifiedAt: state?.verifiedAt, error: state?.error,
      catalogVerifiedAt: state?.catalogVerifiedAt, catalogError: state?.catalogError,
      verificationTimeUncertain: timestampAhead(state?.verifiedAt, now),
      catalogVerificationTimeUncertain: timestampAhead(state?.catalogVerifiedAt, now),
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
export function recordOfficialPricingResult(source: OfficialPricingSource, result: OfficialPricingResult, now = Date.now(), checkedAt = now): void {
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
  const state: SourceState = { ...store.sources[source], checkedAt };
  if (result.ok) {
    const pageModels = result.pricingPageModels ?? result.models;
    state.verifiedAt = now;
    state.lastModelCount = standardModelCount(pageModels);
    delete state.error;
    if (source !== "cursor") state.pricingBoundaries = pricingBoundaries(pageModels);
    if (result.catalogError) state.catalogError = result.catalogError.slice(0, 240);
    else if (result.catalogModels || source === "cursor") {
      state.catalog = result.catalogModels ?? result.models;
      state.catalogVerifiedAt = now;
      delete state.catalogError;
    }
  } else {
    state.error = result.error.slice(0, 240);
    if (source !== "cursor") state.catalogError = state.error;
  }
  storeValue(OFFICIAL_PRICING_KEY, { schemaVersion: 1, updatedAt: new Date(checkedAt).toISOString(), models, sources: { ...store.sources, [source]: state }, epochs });
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
 * never during startup rendering. Each parser reads the tables it recognizes,
 * checks their columns, and fails the source on ambiguous input such as
 * an unsupported column layout, a row with the wrong
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
  const tables = tablesAfter(lines, anchor, required, false);
  return typeof tables === "string" ? tables : tables[0];
}

function tablesAfter(lines: string[], anchor: string, required: boolean, consecutive = true, stopAt?: (line: string) => boolean): Table[] | string {
  const matches = lines.flatMap((line, index) => line.trim() === anchor ? [index] : []);
  if (matches.length === 0) return required ? `“${anchor}” not found` : "missing";
  if (matches.length > 1) return `“${anchor}” appears more than once`;
  let index = matches[0] + 1;
  while (index < lines.length && !lines[index].trim().startsWith("|")) {
    const line = lines[index].trim();
    if (/^#{1,6}\s/.test(line) || stopAt?.(line)) return `No table under “${anchor}”`;
    index += 1;
  }
  const tables: Table[] = [];
  do {
    const read = tableAt(lines, index, anchor);
    if (typeof read === "string") return read;
    tables.push(read.table);
    index = read.next;
    while (index < lines.length && !lines[index].trim()) index += 1;
  } while (consecutive && lines[index]?.trim().startsWith("|"));
  return tables;
}

function tableAt(lines: string[], index: number, anchor: string): { table: Table; next: number } | string {
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
  return rows.length ? { table: { header, rows }, next: index } : `Empty table under “${anchor}”`;
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

interface RowRates { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cacheWrite12h?: number; output?: number }
type RawRates = Partial<Record<keyof RowRates, string>>;

/** Adds one model, rejecting unreadable or implausible rates and conflicting
 * duplicates. Returns an error, or null when the row was accepted or skipped. */
function addModel(
  models: Record<string, OfficialRate>, key: string,
  raw: RawRates, extra: Partial<OfficialRate>,
): string | null | "skipped" {
  const rates: RowRates = {};
  for (const component of ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "cacheWrite12h", "output"] as const) {
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
    || (rates.cacheWrite1h !== undefined && rates.cacheWrite1h < (rates.cacheWrite ?? rates.input))
    || (rates.cacheWrite12h !== undefined && rates.cacheWrite12h < (rates.cacheWrite ?? rates.input))) return `Unexpected cache rates for ${key}`;
  const rate: OfficialRate = {
    input: rates.input, output: rates.output,
    ...(rates.cacheRead !== undefined ? { cacheRead: rates.cacheRead } : {}),
    ...(rates.cacheWrite !== undefined ? { cacheWrite: rates.cacheWrite } : {}),
    ...(rates.cacheWrite1h !== undefined ? { cacheWrite1h: rates.cacheWrite1h } : {}),
    ...(rates.cacheWrite12h !== undefined ? { cacheWrite12h: rates.cacheWrite12h } : {}),
    ...extra,
  } as OfficialRate;
  const existing = models[key];
  if (existing && (existing.input !== rate.input || existing.output !== rate.output
    || existing.cacheRead !== rate.cacheRead || existing.cacheWrite !== rate.cacheWrite
    || existing.cacheWrite1h !== rate.cacheWrite1h || existing.cacheWrite12h !== rate.cacheWrite12h)) return `Conflicting rates for ${key}`;
  models[key] = existing ?? rate;
  return null;
}

function finish(models: Record<string, OfficialRate>, skipped: number): Parsed {
  return Object.keys(models).length ? { ok: true, models, skipped } : fail("No priced models found");
}

const OPENAI_MODEL = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const OPENAI_CONTEXT_NOTE = /\s*\(<\s*\d+K context length\)$/i;
const OPENAI_SECTIONS = ["Flagship models", "Cyber models", "Life sciences models", "Legal model configurations", "Multimodal models", "Specialized models", "Fine-tuning", "Cloud platforms"];
const OPENAI_OTHER_TIERS = /^(Batch|Flex|Fast|Ultrafast)$/;
const OPENAI_TIER_LABEL = /^(Standard|Batch|Flex|Fast|Ultrafast)$/;
const OPENAI_SIMPLE_COLUMNS = ["model", "input", "output", "cached input"];
const OPENAI_CONTEXT_COLUMNS = ["input", "output", "cached input"];

function pricingSection(lines: string[], label: string): string[] | string | undefined {
  const starts = lines.flatMap((line, index) => line.trim() === label ? [index] : []);
  if (starts.length > 1) return `OpenAI's ${label} section appears more than once`;
  if (!starts.length) return undefined;
  const [start] = starts;
  const end = lines.findIndex((line, index) => index > start && (OPENAI_SECTIONS.includes(line.trim()) || /^#{1,2}\s/.test(line.trim())));
  return lines.slice(start, end < 0 ? undefined : end);
}

function openAIHasTokenUnits(lines: string[], required: boolean): boolean {
  const units = lines.map((line) => line.trim()).filter((line) => /^prices per\b/i.test(line));
  return (!required || units.length > 0) && units.every((line) => line === "Prices per 1M tokens.");
}

function openAIContextThreshold(lines: string[]): number | undefined {
  const notes = lines.map((line) => /^Short context: ≤(\d+)K input tokens\. Long context: >(\d+)K input tokens\.$/.exec(line.trim())).filter(Boolean);
  const note = notes[0];
  if (notes.length !== 1 || !note || note[1] !== note[2]) return undefined;
  const threshold = Number(note[1]) * 1_000;
  return threshold > 0 && threshold <= 2_000_000 ? threshold : undefined;
}

function openAITableLayout(header: string[]) {
  const columns = header.map(normalizedHeader);
  const hasColumns = (expected: string[]) => columns.length === expected.length && expected.every((label) => columns.includes(label));
  const wideColumns = (write: string[]) => ["model", ...["short", "long"].flatMap((context) =>
    [...OPENAI_CONTEXT_COLUMNS, ...write].map((label) => `${context} context ${label}`))];
  const timed = hasColumns(wideColumns(["30m write", "12h write"]));
  const wide = timed || hasColumns(wideColumns(["cache writes"]));
  const categorized = hasColumns(["category", ...OPENAI_SIMPLE_COLUMNS]);
  if (!wide && !categorized && !hasColumns(OPENAI_SIMPLE_COLUMNS)) return null;
  return {
    wide, timed, category: columns.indexOf("category"), model: columns.indexOf("model"),
    rates(row: string[], context = "short"): RawRates {
      const cell = (label: string) => row[columns.indexOf(wide ? `${context} context ${label}` : label)];
      return { input: cell("input"), output: cell("output"), cacheRead: cell("cached input"),
        cacheWrite: cell(timed ? "30m write" : "cache writes"), cacheWrite12h: cell("12h write") };
    },
  };
}

/** Explicitly scoped standard and service-tier tables. Each table must match a
 * supported schema, and its rates are read by label so ordering cannot affect costs. */
export function parseOpenAIPricing(markdown: string, asOf: string, options: { includeLongContext?: boolean; includeCatalogDetails?: boolean } = {}): Parsed {
  const lines = markdown.split(/\r?\n/);
  const flagshipSection = pricingSection(lines, "Flagship models");
  if (typeof flagshipSection === "string") return fail(flagshipSection);
  // The legacy layout has no Flagship label. Its Standard table must still
  // appear before any named section.
  const firstSection = lines.findIndex((line) => OPENAI_SECTIONS.includes(line.trim()));
  const flagship = flagshipSection ?? lines.slice(0, firstSection < 0 ? undefined : firstSection);
  if (!openAIHasTokenUnits(flagship, flagshipSection !== undefined)) return fail("OpenAI's Flagship models units changed");
  const models: Record<string, OfficialRate> = {};
  let skipped = 0;

  const read = (scoped: string[], anchor: string, required: boolean, serviceTier?: string, status?: OfficialRate["status"], threshold?: number): string | null => {
    const tables = tablesAfter(scoped, anchor, required, true, (line) => OPENAI_TIER_LABEL.test(line));
    if (tables === "missing") return null;
    if (typeof tables === "string") return tables;
    for (const table of tables) {
      const layout = openAITableLayout(table.header);
      if (!layout) return `OpenAI's columns changed under “${anchor}”`;
      for (const row of table.rows) {
        if (layout.category >= 0 && ["Embedding", "Moderation"].includes(plainText(row[layout.category]))) continue;
        const id = plainText(row[layout.model]).replace(OPENAI_CONTEXT_NOTE, "");
        if (!OPENAI_MODEL.test(id)) { skipped += 1; continue; }
        const key = serviceTier ? `${id}@${serviceTier}` : id;
        const extra = { asOf, ...(serviceTier ? { serviceTier } : {}), ...(status ? { status } : {}) };
        const error = addModel(models, key, layout.rates(row), extra);
        if (error === "skipped") { skipped += 1; continue; }
        if (error) return error;
        if (layout.timed && models[key].cacheWrite !== undefined) models[key].cacheWrite30m = true;
        if (layout.wide && options.includeLongContext && !serviceTier) {
          const raw = layout.rates(row, "long");
          const long = models[key].longContext ? { [key]: models[key].longContext } : {};
          const longError = addModel(long, key, raw, { asOf });
          if (longError && longError !== "skipped") return longError;
          if (longError === "skipped" && Object.values(raw).some((cell) => cell !== undefined && !MISSING.has(plainText(cell)))) {
            return `Incomplete long-context rates for ${key}`;
          }
          if (longError === "skipped") continue;
          if (layout.timed && long[key].cacheWrite !== undefined) long[key].cacheWrite30m = true;
          models[key].longContext = long[key];
          if (threshold !== undefined) {
            const existing = models[key].longContextThresholdTokens;
            if (existing !== undefined && existing !== threshold) return `Conflicting long-context thresholds for ${key}`;
            models[key].longContextThresholdTokens = threshold;
          }
        }
      }
    }
    return null;
  };

  const standard = read(flagship, "### Standard pricing data", true, undefined, undefined, openAIContextThreshold(flagship));
  if (standard) return fail(standard);
  if (!Object.keys(models).length) return fail("No priced models under “### Standard pricing data”");
  const batchHeading = flagship.findIndex((line) => line.trim() === "### Batch pricing data");
  const batchEnd = flagship.findIndex((line, index) => index > batchHeading && /^#{1,3}\s/.test(line.trim()));
  const batchSection = batchHeading < 0 ? [] : flagship.slice(batchHeading + 1, batchEnd < 0 ? undefined : batchEnd);
  const nestedBatch = batchSection.some((line) => /^#### (Batch|Flex)$/.test(line.trim()));
  if (nestedBatch && flagship.slice(batchHeading + 1).some((line) => /^(### Batch pricing data|### Flex pricing data)$/.test(line.trim()))) {
    return fail("OpenAI's Batch and Flex pricing sections are ambiguous");
  }
  for (const [tier, anchor, scoped, required] of [
    ["batch", nestedBatch ? "#### Batch" : "### Batch pricing data", nestedBatch ? batchSection : flagship, nestedBatch],
    ["flex", nestedBatch ? "#### Flex" : "### Flex pricing data", nestedBatch ? batchSection : flagship, false],
    ["fast", "### Fast pricing data", flagship, false],
    ["ultrafast", "### Ultrafast pricing data", flagship, false],
  ] as const) {
    const error = read(scoped, anchor, required, tier);
    if (error) return fail(error);
  }

  if (options.includeCatalogDetails) {
    for (const label of ["Cyber models", "Life sciences models", "Specialized models"]) {
      let scoped = pricingSection(lines, label);
      if (typeof scoped === "string") return fail(scoped);
      if (!scoped) continue;
      if (!openAIHasTokenUnits(scoped, true)) return fail(`OpenAI's ${label} units changed`);
      const threshold = openAIContextThreshold(scoped);
      let anchor = scoped.some((line) => line.trim() === "### Standard pricing data") ? "### Standard pricing data" : "### Grouped Pricing Table data";
      if (label === "Specialized models") {
        const start = scoped.findIndex((line) => line.trim() === "Standard");
        if (start < 0) return fail("OpenAI's Specialized models Standard label changed");
        const end = scoped.findIndex((line, index) => index > start && OPENAI_TIER_LABEL.test(line.trim()));
        if (end >= 0 && scoped.slice(end).some((line) => line.trim() === "Standard")) return fail("OpenAI's Specialized models Standard label appears more than once");
        scoped = scoped.slice(start, end < 0 ? undefined : end);
        anchor = "### Grouped Pricing Table data";
      }
      const heading = scoped.findIndex((line) => line.trim() === anchor);
      if (heading >= 0 && scoped.slice(0, heading).some((line) => OPENAI_OTHER_TIERS.test(line.trim()))) {
        return fail(`OpenAI's ${label} Standard label changed`);
      }
      const error = read(scoped, anchor, true, undefined, label === "Life sciences models" ? "limited" : undefined, threshold);
      if (error) return fail(error);
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

const OPENAI_DEPRECATION_COLUMNS = new Set(["model / system", "model family / snapshot", "model snapshot", "deprecated model", "legacy model", "system"]);

function anthropicActiveModelIds(lines: string[]): Set<string> {
  const status = lines.indexOf("## Model status");
  const history = lines.indexOf("## Deprecation history");
  const table = history > status && status >= 0 ? tableAfter(lines.slice(0, history), "## Model status", true) : "missing";
  if (typeof table === "string" || normalizedHeader(table.header[0]) !== "api model name"
    || normalizedHeader(table.header[1] ?? "") !== "current state") throw new Error("Claude's model status table changed.");

  const states = new Map<string, string>();
  for (const row of table.rows) {
    const id = plainText(row[0]);
    const state = plainText(row[1]).toLowerCase();
    if (!/^claude-[a-z0-9][a-z0-9.-]{0,72}$/.test(id) || !["active", "legacy", "deprecated", "retired"].includes(state)
      || (states.has(id) && states.get(id) !== state)) throw new Error("Claude's model status table contains an unrecognized entry.");
    states.set(id, state);
  }
  const ids = new Set<string>();
  for (const [id, state] of states) {
    const family = id.replace(/-\d{8}$/, "");
    if (state === "active" && (states.get(family) ?? state) === "active") ids.add(family);
  }
  return ids;
}

function openAINoticeModelIds(target: string, title: string): string[] {
  // These notices cover endpoints, API versions, or new training jobs. The
  // training notice explicitly says inference with existing models is unaffected.
  if (/^(?:`?\/v\d+\/|OpenAI-Beta: |[\w ]+ API$|New fine-tuning training on )/.test(target)) return [];

  const namedFamily = /^([\w.-]+(?: [\w.-]+)*) \((`[^)]+)\)$/.exec(target);
  const subjects = namedFamily?.[2] ?? target.replace(/ \(including (.+), which point to this snapshot\)$/, " | $1");
  const ids = subjects.split(/\s*\|\s*|,\s*|\s+and\s+/).map((id) => id.trim().replace(/^`([^`]+)`$/, "$1"));
  if (ids.some((id) => !OPENAI_MODEL.test(id))) throw new Error("OpenAI's deprecation notice contains an unrecognized model entry.");

  // A displayed family applies only when the notice explicitly names it and
  // the listed dated snapshots identify the same family.
  if (namedFamily) {
    const family = namedFamily[1].toLowerCase().replaceAll(" ", "-");
    if (ids.every((id) => id !== family && id.replace(/-\d{4}-\d{2}-\d{2}$/, "") === family)) ids.push(family);
  }
  // This notice calls the preview GPT-5.5-Cyber, the name used on the pricing page.
  if (title === "2026-11-05: GPT-5.5-Cyber" && ids.includes("gpt-5.5-cyber-preview")) ids.push("gpt-5.5-cyber");
  return ids;
}

function openAIDeprecationIds(lines: string[]): Set<string> {
  const title = lines.indexOf("# Deprecations");
  const upcoming = lines.indexOf("## Upcoming deprecations");
  const past = lines.indexOf("## Past deprecations");
  if (title < 0 || upcoming <= title || past <= upcoming
    || upcoming !== lines.lastIndexOf("## Upcoming deprecations") || past !== lines.lastIndexOf("## Past deprecations")) {
    throw new Error("OpenAI's model deprecations page changed.");
  }
  const ids = new Set<string>();
  for (const [start, end] of [[upcoming + 1, past], [past + 1, lines.length]]) {
    let notice = "";
    let awaitingTable = false;
    let sawTable = false;
    let sawModelNotice = false;
    const section = lines.slice(start, end);
    for (let index = 0; index < section.length; index += 1) {
      const line = section[index];
      if (line.startsWith("### ")) {
        if (awaitingTable) throw new Error("An OpenAI deprecation notice is missing its table.");
        notice = line.slice(4);
        awaitingTable = /^\d{4}-\d{2}-\d{2}: /.test(notice);
      }
      if (!line.startsWith("|")) continue;
      const read = tableAt(section, index, "OpenAI model deprecations");
      if (typeof read === "string") throw new Error(read);
      index = read.next - 1;
      sawTable = true;
      awaitingTable = false;
      const header = read.table.header.map(normalizedHeader);
      if (header.length === 2 && header[0] === "date" && header[1] === "update") continue;
      if (header[0] !== "shutdown date" || !OPENAI_DEPRECATION_COLUMNS.has(header[1])) throw new Error("OpenAI's model deprecations columns changed.");
      for (const row of read.table.rows) {
        const models = openAINoticeModelIds(row[1], notice);
        if (models.length) sawModelNotice = true;
        for (const id of models) ids.add(id);
      }
    }
    const isUpcoming = end === past;
    const noUpcoming = isUpcoming && section.some((line) => /^(?:there are )?no upcoming deprecations\.?$/i.test(plainText(line)));
    if (awaitingTable || (isUpcoming ? !sawTable && !noUpcoming : !sawModelNotice)) {
      throw new Error("OpenAI's model deprecations page is incomplete.");
    }
  }
  return ids;
}

function activePricingCatalog(source: "openai" | "anthropic", markdown: string, models: Record<string, OfficialRate>): Record<string, OfficialRate> {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const ids = source === "openai" ? openAIDeprecationIds(lines) : anthropicActiveModelIds(lines);
  if (!ids.size) throw new Error("The provider's model lifecycle page listed no recognizable models.");
  const catalog = Object.fromEntries(Object.entries(models).filter(([id, rate]) =>
    !id.includes("@") && rate.status !== "retired" && (source === "openai" ? !ids.has(id) : ids.has(id))));
  if (!Object.keys(catalog).length) throw new Error("No current models matched the provider's published pricing.");
  return catalog;
}

/** Lifecycle pages decide only the settings listing. If one can't be verified,
 * usage rates still refresh and the last verified listing stays on screen. */
function activeListing(source: "openai" | "anthropic", lifecycle: string | Error, models: Record<string, OfficialRate>): { catalogModels: Record<string, OfficialRate> } | { catalogError: string } {
  try {
    if (lifecycle instanceof Error) throw lifecycle;
    return { catalogModels: activePricingCatalog(source, lifecycle, models) };
  } catch (error) {
    return { catalogError: `Couldn’t verify which models are active. ${describeFetchError(error)}` };
  }
}

const standardModelCount = (models: Record<string, OfficialRate>) => Object.keys(models).filter((model) => !model.includes("@")).length;

/** A page that suddenly lists far fewer models than last time is more likely
 * a truncated or restructured table than a mass retirement. */
function shrankSuspiciously(source: OfficialPricingSource, result: OfficialPricingResult): boolean {
  if (!result.ok) return false;
  const before = modelsSeenAtLastCheck(source);
  return before >= 6 && standardModelCount(result.pricingPageModels ?? result.models) < before / 2;
}

export type PricingDocumentFetcher = (source: OfficialPricingSource) => Promise<string>;

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
      const refresh = () => refreshOfficialPricing(options);
      forcedAfterRoutine ??= inFlight.then(refresh, refresh).finally(() => { forcedAfterRoutine = null; });
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
    // A legacy verified pricing page says nothing about lifecycle status.
    const needsFirstCatalog = source !== "cursor" && state?.verifiedAt && !state.catalogVerifiedAt && !state.catalogError;
    return needsFirstCatalog || !state?.checkedAt || timestampAhead(state.checkedAt, at)
      || at - state.checkedAt >= (state.error || state.catalogError ? RETRY_FAILED_MS : DAY_MS);
  });
  if (!due.length) return { checked: [], failed: [] };
  setChecking(true);
  try {
    const outcomes = await Promise.all(due.map(async (source) => {
      let result: OfficialPricingResult;
      let observedAt: number | undefined;
      try {
        const [document, lifecycle] = await Promise.all([
          fetchDocument(source).then((document) => { observedAt = now(); return document; }),
          source === "cursor" ? undefined : Promise.resolve().then(() => fetchModelLifecycleDocument(source))
            .catch((error: unknown) => new Error(describeFetchError(error))),
        ]);
        const asOf = dayOf(observedAt ?? now());
        const parsed = PARSERS[source](document, asOf);
        if (!parsed.ok) result = parsed;
        else {
          // Settings can show supplementary standard tables and explicit
          // prompt tiers without changing historical usage billing. Until the
          // ledger accounts for prompt bands, Haiku 5.5 remains unpriced there.
          const ledger = source === "openai" ? parseOpenAIPricing(document, asOf)
            : source === "anthropic" ? { ...parsed, models: Object.fromEntries(Object.entries(parsed.models)
              .filter(([id, rate]) => !isLegacyClaudeId(id) && rate.longContextThresholdTokens === undefined)) } : parsed;
          result = !ledger.ok ? ledger : source === "cursor" ? ledger : {
            ...ledger, ...activeListing(source, lifecycle ?? "", parsed.models), pricingPageModels: parsed.models,
          };
        }
        if (shrankSuspiciously(source, result)) result = { ok: false, error: "Far fewer models than the last check; keeping the previous rates" };
      } catch (error) {
        result = { ok: false, error: describeFetchError(error) };
      }
      const checkedAt = now();
      recordOfficialPricingResult(source, result, observedAt ?? checkedAt, checkedAt);
      return result.ok;
    }));
    return { checked: due, failed: due.filter((_, index) => !outcomes[index]) };
  } finally {
    setChecking(false);
  }
}
