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
}
export type OfficialPricingResult = { ok: true; models: Record<string, OfficialRate>; skipped?: number } | { ok: false; error: string };
interface SourceState {
  /** Last attempt, successful or not. */
  checkedAt?: number;
  /** Last attempt whose page parsed and validated. */
  verifiedAt?: number;
  /** Count from the last successfully parsed page, including same-day removals. */
  lastModelCount?: number;
  /** Why the last attempt failed; cleared by a successful one. */
  error?: string;
}
export interface OfficialPricingStatus extends SourceState {
  source: OfficialPricingSource;
  checking: boolean;
  /** Models the page listed at its last successful check. */
  models: number;
}

/** Stored rates are keyed the way the ledger looks them up. */
const PROVIDER_KEY: Record<OfficialPricingSource, string> = { openai: "openai", anthropic: "claude", cursor: "cursor" };
const MAX_MODELS_PER_SOURCE = 300;
const CURSOR_NOTE = "Cursor list price. Cursor doesn’t report cache writes, and plan token fees aren’t included.";
let checking = false;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** The stored snapshot, re-validated: rates through the ledger's own catalog
 * validator (the same one it prices from), source states field by field. */
function readStore(): { models: Record<string, ModelPricingCatalogEntry>; sources: Partial<Record<OfficialPricingSource, SourceState>>; epochs: Record<string, RateEpoch[]> } {
  const raw = loadStored<{ sources?: Record<string, Record<string, unknown>>; epochs?: unknown } | null>(OFFICIAL_PRICING_KEY, null);
  const sources: Partial<Record<OfficialPricingSource, SourceState>> = {};
  for (const source of OFFICIAL_PRICING_SOURCES) {
    const state = raw?.sources?.[source];
    if (!state || typeof state !== "object") continue;
    sources[source] = {
      checkedAt: timestamp(state.checkedAt),
      verifiedAt: timestamp(state.verifiedAt),
      ...(typeof state.lastModelCount === "number" && Number.isSafeInteger(state.lastModelCount)
        && state.lastModelCount >= 0 && state.lastModelCount <= MAX_ROWS ? { lastModelCount: state.lastModelCount } : {}),
      ...(typeof state.error === "string" ? { error: state.error.slice(0, 240) } : {}),
    };
  }
  return { models: parseModelPricingCatalog(raw, true)?.models ?? {}, sources, epochs: parseRateEpochs(raw?.epochs) };
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
  return Object.entries(store.models).filter(([key, entry]) => key.startsWith(prefix) && entry.asOf === day).length;
}

export function officialPricingStatus(): OfficialPricingStatus[] {
  const store = readStore();
  return OFFICIAL_PRICING_SOURCES.map((source) => {
    const state = store.sources[source];
    return { source, checking, checkedAt: state?.checkedAt, verifiedAt: state?.verifiedAt, error: state?.error, models: modelsSeenAtLastCheck(source, store) };
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
    epochs = observeRates(epochs, prefix, result.models, now);
    for (const [model, rate] of Object.entries(result.models)) {
      models[`${prefix}${model}`] = {
        inputPerMillion: rate.input, outputPerMillion: rate.output,
        ...(rate.cacheRead !== undefined ? { cachedInputPerMillion: rate.cacheRead } : {}),
        ...(rate.cacheWrite !== undefined ? { cacheWriteInputPerMillion: rate.cacheWrite } : {}),
        ...(rate.cacheWrite1h !== undefined ? { cacheWrite1hInputPerMillion: rate.cacheWrite1h } : {}),
        asOf: rate.asOf,
        ...(rate.status ? { status: rate.status } : {}),
        ...(source === "cursor" ? { note: CURSOR_NOTE } : {}),
      } as ModelPricingCatalogEntry;
    }
    const own = Object.entries(models).filter(([key]) => key.startsWith(prefix)).sort((left, right) => right[1].asOf.localeCompare(left[1].asOf));
    for (const [key] of own.slice(MAX_MODELS_PER_SOURCE)) delete models[key];
    for (const key of Object.keys(epochs)) if (!(key in models)) delete epochs[key];
  }
  const state: SourceState = result.ok
    ? { checkedAt: now, verifiedAt: now, lastModelCount: Object.keys(result.models).length }
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
 * guessed. Batch, Flex, Fast and long-context columns are never read.
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

/** OpenAI's Standard tier, short-context columns only. */
export function parseOpenAIPricing(markdown: string, asOf: string): Parsed {
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
  }
  return finish(models, skipped);
}

const ANTHROPIC_ANCHOR = "The following table shows pricing for all Claude models:";
const ANTHROPIC_HEADER = [
  "model", /^base input( tokens)?$/, /^5m cache writes?$/, /^1h cache writes?$/, /^cache (hits|reads)( and refreshes)?$/, /^output( tokens)?$/,
];
const CLAUDE_NAME = /^Claude ([A-Z][a-z]+) (\d+)(?:\.(\d+))?(?: \(([^()]*)\))?$/;

/** Maps a published display name to the API id scheme used since Claude 4
 * (`Claude Opus 5.5` → `claude-opus-5-5`). Earlier generations used a
 * different id order, and an unrecognised annotation could mean a different
 * price tier, so both are skipped. */
export function claudeModelId(name: string): { id: string; status?: OfficialRate["status"] } | null {
  const match = CLAUDE_NAME.exec(name);
  if (!match || Number(match[2]) < 4) return null;
  const note = match[4]?.toLowerCase();
  const status = note === undefined ? undefined : note.startsWith("retired") ? "retired" : note.startsWith("limited") ? "limited" : null;
  if (status === null) return null;
  return { id: `claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ""}`, ...(status ? { status } : {}) };
}

/** Claude's base rates, with both cache-write durations: Claude Code reports
 * how many cache-write tokens used the 1-hour cache. */
export function parseAnthropicPricing(markdown: string, asOf: string): Parsed {
  const table = tableAfter(markdown.split(/\r?\n/), ANTHROPIC_ANCHOR, true);
  if (typeof table === "string") return fail(table);
  if (!headerMatches(table.header, ANTHROPIC_HEADER)) return fail("Claude's model pricing columns changed");
  const models: Record<string, OfficialRate> = {};
  let skipped = 0;
  for (const row of table.rows) {
    const name = plainText(row[0]);
    const model = claudeModelId(name);
    if (!model) { skipped += 1; continue; }
    const error = addModel(models, model.id, { input: row[1], cacheWrite: row[2], cacheWrite1h: row[3], cacheRead: row[4], output: row[5] }, {
      asOf, name: name.replace(/ \(.*\)$/, ""), ...(model.status ? { status: model.status } : {}),
    });
    if (error === "skipped") skipped += 1;
    else if (error) return fail(error);
  }
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
  openai: parseOpenAIPricing,
  anthropic: parseAnthropicPricing,
  cursor: parseCursorPricing,
};

/** A page that suddenly lists far fewer models than last time is more likely
 * a truncated or restructured table than a mass retirement. */
function shrankSuspiciously(source: OfficialPricingSource, result: Parsed): boolean {
  if (!result.ok) return false;
  const before = modelsSeenAtLastCheck(source);
  return before >= 6 && Object.keys(result.models).length < before / 2;
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
    return !state?.checkedAt || now() - state.checkedAt >= (state.error ? RETRY_FAILED_MS : DAY_MS);
  });
  if (!due.length) return { checked: [], failed: [] };
  setChecking(true);
  try {
    const outcomes = await Promise.all(due.map(async (source) => {
      let result: OfficialPricingResult;
      try {
        const parsed = PARSERS[source](await fetchDocument(source), dayOf(now()));
        result = shrankSuspiciously(source, parsed) ? { ok: false, error: "Far fewer models than the last check; keeping the previous rates" } : parsed;
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
