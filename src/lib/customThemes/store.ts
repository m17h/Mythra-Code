// The custom theme library: one source of truth for the Settings gallery and
// the models' theme tools (DESIGN §6). Every change is a new, append-only
// revision; nothing is ever edited in place, and only the user deletes.
//
// The library is a per-device kiwi.* value (localStorage cache plus the SQLite
// state db), read synchronously at startup so the active theme paints on the
// first frame. Specs arrive here already normalized by the theme engine
// (validate.ts); the store only records, prunes and publishes them.
//
// The pure `library*` functions take and return plain library objects so the
// revision rules can be tested without a webview. The wrappers below them hold
// the live copy, save it on every change and notify subscribers.

import { useSyncExternalStore } from "react";
import { loadStored, storeValue } from "../storage";
import type { Provider, ThemeId, ThemeName } from "../../types";
import {
  THEME_LIMITS,
  builtInScheme,
  isBuiltInTheme,
  isCustomThemeId,
  newCustomThemeId,
  type ContrastAdjustment,
  type CustomThemeId,
  type ThemeAuthor,
  type ThemeSpec,
  type ValidationIssue,
} from "./spec";

export const CUSTOM_THEMES_KEY = "kiwi.customThemes";
export const CUSTOM_THEME_BOOT_KEY = "kiwi.customThemeBoot";

export const STORE_LIMITS = {
  maxThemes: THEME_LIMITS.maxThemes,
  maxRevisions: THEME_LIMITS.maxRevisions,
  maxLibraryBytes: THEME_LIMITS.maxLibraryBytes,
  /** Pruning for space always keeps the head plus this many recent revisions. */
  keepRecent: 4,
  maxThreadFocus: 300,
  maxDesignerThreads: 300,
  summaryMax: 120,
  nameMax: 40,
} as const;

export type ThemeDisabledReason = "boot-failure" | "invalid" | "render-error";
export type RevisionKind = "create" | "edit" | "undo" | "restore" | "rename";

export interface CustomThemeRevision {
  /** 1, 2, 3… never reused. */
  n: number;
  at: number;
  by: ThemeAuthor;
  kind: RevisionKind;
  /** ≤ 120 chars, shown in History. */
  summary: string;
  /** The logical previous state, for undo. */
  prev: number | null;
  restoredFrom?: number;
  spec: ThemeSpec;
  adjustments?: ContrastAdjustment[];
}

export interface CustomThemeRecord {
  id: CustomThemeId;
  createdAt: number;
  updatedAt: number;
  createdBy: ThemeAuthor;
  /** The revision in effect; always the newest one. */
  head: number;
  /** Ascending by n; older ones may have been pruned for space. */
  revisions: CustomThemeRevision[];
  disabledReason?: ThemeDisabledReason;
}

/** A thread opened from "Design a theme with AI". */
export interface ThemeDesignerPurpose {
  targetThemeId?: CustomThemeId;
  at: number;
}

export interface CustomThemeLibrary {
  version: 1;
  /** ≤ 24, in creation order. */
  themes: CustomThemeRecord[];
  /** threadId → the theme that conversation last created, changed or applied. Oldest first (LRU). */
  threadFocus: Record<string, CustomThemeId>;
  /** threadId → designer purpose, for threads opened from Settings. Oldest first. */
  designerThreads?: Record<string, ThemeDesignerPurpose>;
}

export interface CustomThemeSummary {
  id: CustomThemeId;
  name: string;
  description: string;
  base: ThemeName;
  scheme: "light" | "dark";
  head: number;
  updatedAt: number;
  createdBy: ThemeAuthor;
  effects: string[];
  disabledReason?: ThemeDisabledReason;
}

export type StoreResult =
  | { ok: true; record: CustomThemeRecord; revision: CustomThemeRevision; unchanged?: boolean }
  | { ok: false; error: string; issues?: ValidationIssue[] };

export type UndoResult = StoreResult & { restoredFrom?: number; undone?: string[] };

export interface CreateMeta { by: ThemeAuthor; summary?: string; adjustments?: ContrastAdjustment[] }
export interface CommitMeta { by: ThemeAuthor; summary: string; kind: "edit" | "rename"; expectedRevision?: number; adjustments?: ContrastAdjustment[] }
export interface UndoOptions { by: ThemeAuthor; steps?: number; toRevision?: number; expectedRevision?: number; summary?: string }

export const EMPTY_LIBRARY: CustomThemeLibrary = Object.freeze({ version: 1, themes: [], threadFocus: {} }) as CustomThemeLibrary;

// ---- Small helpers ----------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text a model or person typed, made safe to show and to echo back to a model. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return [...text].length > max ? [...text].slice(0, max - 1).join("").trimEnd() + "…" : text;
}

function quoted(name: string): string {
  return `“${name}”`;
}

function headRevision(record: CustomThemeRecord): CustomThemeRevision {
  return record.revisions.find((revision) => revision.n === record.head) ?? record.revisions[record.revisions.length - 1]!;
}

export function headSpec(record: CustomThemeRecord): ThemeSpec {
  return headRevision(record).spec;
}

export function themeName(record: CustomThemeRecord): string {
  return headSpec(record).name;
}

function nextRevisionNumber(record: CustomThemeRecord): number {
  return record.revisions.reduce((max, revision) => Math.max(max, revision.n), record.head) + 1;
}

function sameSpec(a: ThemeSpec, b: ThemeSpec): boolean {
  return stableJson(a) === stableJson(b);
}

/** JSON with sorted object keys, so equal specs compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

function lowerFirst(text: string): string {
  return text && /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function authorLabel(by: ThemeAuthor): string {
  return by.kind === "user" ? "you" : providerName(by.provider);
}

export function providerName(provider: Provider): string {
  return provider === "openai" ? "OpenAI" : provider === "claude" ? "Claude" : provider === "cursor" ? "Cursor" : provider === "openrouter" ? "OpenRouter" : "LM Studio";
}

function withRecord(library: CustomThemeLibrary, record: CustomThemeRecord): CustomThemeLibrary {
  return { ...library, themes: library.themes.map((entry) => entry.id === record.id ? record : entry) };
}

function findRecord(library: CustomThemeLibrary, id: CustomThemeId): CustomThemeRecord | undefined {
  return library.themes.find((record) => record.id === id);
}

function missingTheme(id: string): StoreResult {
  return { ok: false, error: `No custom theme ${id} exists; it may have been deleted by the user. Call list_custom_themes.` };
}

function staleRevision(record: CustomThemeRecord, expected: number | undefined): StoreResult | null {
  if (expected === undefined || expected === record.head) return null;
  const head = headRevision(record);
  return { ok: false, error: `${quoted(themeName(record))} changed since you read it (now r${record.head}: ${quoted(head.summary)}). Call get_custom_theme and apply your change again.` };
}

/** Appends a revision, makes it the head and keeps the record within its revision cap. */
function appendRevision(record: CustomThemeRecord, revision: CustomThemeRevision): CustomThemeRecord {
  const next: CustomThemeRecord = { ...record, head: revision.n, updatedAt: revision.at, revisions: [...record.revisions, revision] };
  // A good change clears a safe-mode switch-off: the theme is in use again.
  delete next.disabledReason;
  return capRevisions(next, STORE_LIMITS.maxRevisions);
}

/** Keeps the head and the newest revisions up to `max`. */
function capRevisions(record: CustomThemeRecord, max: number): CustomThemeRecord {
  if (record.revisions.length <= max) return record;
  const keep = new Set(record.revisions.slice(-max).map((revision) => revision.n));
  keep.add(record.head);
  return { ...record, revisions: record.revisions.filter((revision) => keep.has(revision.n)) };
}

// ---- Sanitizing what was stored ---------------------------------------------

function sanitizeAuthor(value: unknown): ThemeAuthor {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "model") {
    const raw = value as { provider?: unknown; model?: unknown; threadId?: unknown };
    const provider = (["openai", "claude", "cursor", "openrouter", "lmstudio"] as const).find((entry) => entry === raw.provider);
    if (provider) {
      const author: ThemeAuthor = { kind: "model", provider };
      if (typeof raw.model === "string" && raw.model) author.model = raw.model.slice(0, 160);
      if (typeof raw.threadId === "string" && raw.threadId) author.threadId = raw.threadId.slice(0, 200);
      return author;
    }
  }
  return { kind: "user" };
}

/** Structural check only; the theme engine re-validates a spec before it is applied. */
function plausibleSpec(value: unknown): value is ThemeSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Partial<ThemeSpec>;
  return typeof spec.name === "string" && Boolean(spec.name.trim()) && isBuiltInTheme(spec.base)
    && Boolean(spec.tokens) && typeof spec.tokens === "object";
}

function sanitizeRevision(value: unknown): CustomThemeRevision | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CustomThemeRevision>;
  if (!Number.isSafeInteger(raw.n) || raw.n! < 1 || !plausibleSpec(raw.spec)) return null;
  const kinds: RevisionKind[] = ["create", "edit", "undo", "restore", "rename"];
  const revision: CustomThemeRevision = {
    n: raw.n!,
    at: Number.isFinite(raw.at) ? raw.at! : 0,
    by: sanitizeAuthor(raw.by),
    kind: kinds.includes(raw.kind as RevisionKind) ? raw.kind as RevisionKind : "edit",
    summary: cleanText(raw.summary, STORE_LIMITS.summaryMax),
    prev: Number.isSafeInteger(raw.prev) && raw.prev! >= 1 ? raw.prev! : null,
    spec: raw.spec,
  };
  if (Number.isSafeInteger(raw.restoredFrom) && raw.restoredFrom! >= 1) revision.restoredFrom = raw.restoredFrom;
  if (Array.isArray(raw.adjustments)) {
    revision.adjustments = raw.adjustments.filter((entry): entry is ContrastAdjustment => Boolean(entry) && typeof entry === "object"
      && typeof entry.token === "string" && typeof entry.from === "string" && typeof entry.to === "string" && typeof entry.reason === "string").slice(0, 40);
  }
  return revision;
}

function sanitizeRecord(value: unknown): CustomThemeRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CustomThemeRecord>;
  if (!isCustomThemeId(raw.id) || !Array.isArray(raw.revisions)) return null;
  const seen = new Set<number>();
  const revisions = raw.revisions.map(sanitizeRevision)
    .filter((revision): revision is CustomThemeRevision => Boolean(revision) && !seen.has(revision!.n) && Boolean(seen.add(revision!.n)))
    .sort((a, b) => a.n - b.n);
  if (!revisions.length) return null;
  const newest = revisions[revisions.length - 1]!;
  const record: CustomThemeRecord = {
    id: raw.id,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt! : newest.at,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt! : newest.at,
    createdBy: sanitizeAuthor(raw.createdBy),
    // The head is always the newest revision (every change appends).
    head: newest.n,
    revisions,
  };
  if (raw.disabledReason === "boot-failure" || raw.disabledReason === "invalid" || raw.disabledReason === "render-error") record.disabledReason = raw.disabledReason;
  return record;
}

export function sanitizeLibrary(value: unknown): CustomThemeLibrary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, themes: [], threadFocus: {} };
  const raw = value as Partial<CustomThemeLibrary>;
  const seen = new Set<string>();
  const themes = (Array.isArray(raw.themes) ? raw.themes : []).map(sanitizeRecord)
    .filter((record): record is CustomThemeRecord => Boolean(record) && !seen.has(record!.id) && Boolean(seen.add(record!.id)))
    .slice(0, STORE_LIMITS.maxThemes)
    .map((record) => capRevisions(record, STORE_LIMITS.maxRevisions));
  const ids = new Set(themes.map((record) => record.id));
  const threadFocus: Record<string, CustomThemeId> = {};
  if (raw.threadFocus && typeof raw.threadFocus === "object") {
    for (const [threadId, id] of Object.entries(raw.threadFocus).slice(-STORE_LIMITS.maxThreadFocus)) {
      if (threadId && isCustomThemeId(id) && ids.has(id)) threadFocus[threadId] = id;
    }
  }
  const library: CustomThemeLibrary = { version: 1, themes, threadFocus };
  if (raw.designerThreads && typeof raw.designerThreads === "object") {
    const designerThreads: Record<string, ThemeDesignerPurpose> = {};
    for (const [threadId, purpose] of Object.entries(raw.designerThreads).slice(-STORE_LIMITS.maxDesignerThreads)) {
      if (!threadId || !purpose || typeof purpose !== "object") continue;
      const entry: ThemeDesignerPurpose = { at: Number.isFinite(purpose.at) ? purpose.at : 0 };
      if (isCustomThemeId(purpose.targetThemeId)) entry.targetThemeId = purpose.targetThemeId;
      designerThreads[threadId] = entry;
    }
    if (Object.keys(designerThreads).length) library.designerThreads = designerThreads;
  }
  return library;
}

// ---- Pure library operations --------------------------------------------------

export function summarize(record: CustomThemeRecord): CustomThemeSummary {
  const spec = headSpec(record);
  const summary: CustomThemeSummary = {
    id: record.id,
    name: spec.name,
    description: spec.description ?? "",
    base: spec.base,
    scheme: builtInScheme(spec.base),
    head: record.head,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    effects: Object.keys(spec.effects ?? {}).filter((key) => (spec.effects as Record<string, unknown>)[key]),
  };
  if (record.disabledReason) summary.disabledReason = record.disabledReason;
  return summary;
}

export function libraryCreate(library: CustomThemeLibrary, spec: ThemeSpec, meta: CreateMeta, now: number, makeId: () => CustomThemeId = newCustomThemeId): { library: CustomThemeLibrary; result: StoreResult } {
  if (library.themes.length >= STORE_LIMITS.maxThemes) {
    return { library, result: { ok: false, error: `You have ${STORE_LIMITS.maxThemes} custom themes, the limit. Ask the user to delete one in Settings > Appearance > Custom themes, or update an existing theme.` } };
  }
  let id = makeId();
  for (let tries = 0; findRecord(library, id) && tries < 20; tries++) id = makeId();
  if (findRecord(library, id)) return { library, result: { ok: false, error: "Couldn't make a new theme id. Try again." } };
  const revision: CustomThemeRevision = {
    n: 1,
    at: now,
    by: meta.by,
    kind: "create",
    summary: cleanText(meta.summary, STORE_LIMITS.summaryMax) || `Created ${quoted(spec.name)}`,
    prev: null,
    spec,
  };
  if (meta.adjustments?.length) revision.adjustments = meta.adjustments;
  const record: CustomThemeRecord = { id, createdAt: now, updatedAt: now, createdBy: meta.by, head: 1, revisions: [revision] };
  const next = pruneLibrary({ ...library, themes: [...library.themes, record] });
  const stored = findRecord(next, id)!;
  return { library: next, result: { ok: true, record: stored, revision: headRevision(stored) } };
}

export function libraryCommit(library: CustomThemeLibrary, id: CustomThemeId, spec: ThemeSpec, meta: CommitMeta, now: number): { library: CustomThemeLibrary; result: StoreResult } {
  const record = findRecord(library, id);
  if (!record) return { library, result: missingTheme(id) };
  const stale = staleRevision(record, meta.expectedRevision);
  if (stale) return { library, result: stale };
  const head = headRevision(record);
  if (sameSpec(head.spec, spec)) return { library, result: { ok: true, record, revision: head, unchanged: true } };
  const revision: CustomThemeRevision = {
    n: nextRevisionNumber(record),
    at: now,
    by: meta.by,
    kind: meta.kind,
    summary: cleanText(meta.summary, STORE_LIMITS.summaryMax) || (meta.kind === "rename" ? `Renamed to ${quoted(spec.name)}` : "Changed the theme"),
    prev: record.head,
    spec,
  };
  if (meta.adjustments?.length) revision.adjustments = meta.adjustments;
  const next = pruneLibrary(withRecord(library, appendRevision(record, revision)));
  const stored = findRecord(next, id)!;
  return { library: next, result: { ok: true, record: stored, revision: headRevision(stored) } };
}

/** A rename is an ordinary, undoable revision with only the name changed. */
export function libraryRename(library: CustomThemeLibrary, id: CustomThemeId, name: string, by: ThemeAuthor, now: number): { library: CustomThemeLibrary; result: StoreResult } {
  const record = findRecord(library, id);
  if (!record) return { library, result: missingTheme(id) };
  const clean = cleanText(name, STORE_LIMITS.nameMax);
  if (!clean) return { library, result: { ok: false, error: "A theme needs a name." } };
  const spec = { ...headSpec(record), name: clean };
  return libraryCommit(library, id, spec, { by, kind: "rename", summary: `Renamed to ${quoted(clean)}${by.kind === "user" ? " by you" : ""}` }, now);
}

/** What a revision changed, as a phrase: an undo shows the change it took back. */
function changeLabel(record: CustomThemeRecord, revision: CustomThemeRevision, depth = 0): string {
  if (revision.kind === "undo" && revision.restoredFrom && depth < 40) {
    const original = record.revisions.find((entry) => entry.n === revision.restoredFrom);
    if (original) return changeLabel(record, original, depth + 1);
  }
  return revision.summary;
}

export function libraryUndo(library: CustomThemeLibrary, id: CustomThemeId, options: UndoOptions, now: number): { library: CustomThemeLibrary; result: UndoResult } {
  const record = findRecord(library, id);
  if (!record) return { library, result: missingTheme(id) };
  const stale = staleRevision(record, options.expectedRevision);
  if (stale) return { library, result: stale };
  const name = themeName(record);
  const oldest = record.revisions[0]!.n;
  const byNumber = new Map(record.revisions.map((revision) => [revision.n, revision]));
  const head = headRevision(record);

  if (options.toRevision !== undefined) {
    const target = byNumber.get(options.toRevision);
    if (!target) {
      return { library, result: { ok: false, error: options.toRevision > record.head
        ? `${quoted(name)} has no r${options.toRevision}; its newest version is r${record.head}.`
        : `r${options.toRevision} of ${quoted(name)} was cleared to save space. The oldest saved version is r${oldest}.` } };
    }
    if (target.n === record.head) return { library, result: { ok: false, error: `r${target.n} is already the current version of ${quoted(name)}.` } };
    const revision: CustomThemeRevision = {
      n: nextRevisionNumber(record),
      at: now,
      by: options.by,
      kind: "restore",
      summary: cleanText(options.summary, STORE_LIMITS.summaryMax) || cleanText(`Restored r${target.n}: ${lowerFirst(target.summary)}`, STORE_LIMITS.summaryMax),
      prev: record.head,
      restoredFrom: target.n,
      spec: target.spec,
    };
    const next = pruneLibrary(withRecord(library, appendRevision(record, revision)));
    const stored = findRecord(next, id)!;
    return { library: next, result: { ok: true, record: stored, revision: headRevision(stored), restoredFrom: target.n, undone: [] } };
  }

  const steps = Math.max(1, Math.min(10, Math.floor(options.steps ?? 1)));
  let current = head;
  const undone: string[] = [];
  for (let step = 0; step < steps; step++) {
    if (current.prev === null) {
      if (step === 0) return { library, result: { ok: false, error: `Nothing earlier to undo: r${current.restoredFrom ?? current.n} is how ${quoted(name)} was first created. Use toRevision to restore a specific version.` } };
      break;
    }
    const target = byNumber.get(current.prev);
    if (!target) {
      if (step === 0) return { library, result: { ok: false, error: `The version before this one (r${current.prev}) was cleared to save space. The oldest saved version of ${quoted(name)} is r${oldest}; use toRevision to restore it.` } };
      break;
    }
    undone.push(changeLabel(record, current));
    current = target;
  }
  const summary = cleanText(options.summary, STORE_LIMITS.summaryMax)
    || (undone.length === 1 ? cleanText(`Undo: ${lowerFirst(undone[0]!)}`, STORE_LIMITS.summaryMax) : `Undo ${undone.length} changes`);
  const revision: CustomThemeRevision = {
    n: nextRevisionNumber(record),
    at: now,
    by: options.by,
    kind: "undo",
    summary,
    // Undoing an undo keeps walking back through the logical states.
    prev: current.prev,
    restoredFrom: current.n,
    spec: current.spec,
  };
  const next = pruneLibrary(withRecord(library, appendRevision(record, revision)));
  const stored = findRecord(next, id)!;
  return { library: next, result: { ok: true, record: stored, revision: headRevision(stored), restoredFrom: current.n, undone } };
}

/** Whether "Undo last change" has an earlier state to go to. */
export function canUndo(record: CustomThemeRecord): { ok: true } | { ok: false; reason: string } {
  const head = headRevision(record);
  if (head.prev === null) return { ok: false, reason: "Nothing earlier to undo" };
  if (!record.revisions.some((revision) => revision.n === head.prev)) return { ok: false, reason: "The earlier version was cleared to save space" };
  return { ok: true };
}

export function librarySetDisabled(library: CustomThemeLibrary, id: CustomThemeId, reason: ThemeDisabledReason | null): CustomThemeLibrary {
  const record = findRecord(library, id);
  if (!record || (record.disabledReason ?? null) === reason) return library;
  const next: CustomThemeRecord = { ...record };
  if (reason) next.disabledReason = reason;
  else delete next.disabledReason;
  return withRecord(library, next);
}

export interface DeletedTheme {
  record: CustomThemeRecord;
  index: number;
  focus: Record<string, CustomThemeId>;
}

export function libraryDelete(library: CustomThemeLibrary, id: CustomThemeId): { library: CustomThemeLibrary; deleted: DeletedTheme | null } {
  const index = library.themes.findIndex((record) => record.id === id);
  if (index < 0) return { library, deleted: null };
  const focus: Record<string, CustomThemeId> = {};
  const threadFocus: Record<string, CustomThemeId> = {};
  for (const [threadId, focused] of Object.entries(library.threadFocus)) {
    if (focused === id) focus[threadId] = focused;
    else threadFocus[threadId] = focused;
  }
  const next: CustomThemeLibrary = { ...library, themes: library.themes.filter((record) => record.id !== id), threadFocus };
  if (library.designerThreads) {
    next.designerThreads = Object.fromEntries(Object.entries(library.designerThreads).map(([threadId, purpose]) => {
      if (purpose.targetThemeId !== id) return [threadId, purpose];
      const { targetThemeId: _removed, ...rest } = purpose;
      return [threadId, rest];
    }));
  }
  return { library: next, deleted: { record: library.themes[index]!, index, focus } };
}

/** Puts a just-deleted theme back where it was, with its history and focus. */
export function libraryRestoreDeleted(library: CustomThemeLibrary, deleted: DeletedTheme): { library: CustomThemeLibrary; restored: boolean } {
  if (findRecord(library, deleted.record.id) || library.themes.length >= STORE_LIMITS.maxThemes) return { library, restored: false };
  const themes = [...library.themes];
  themes.splice(Math.min(deleted.index, themes.length), 0, deleted.record);
  return { library: pruneLibrary({ ...library, themes, threadFocus: { ...library.threadFocus, ...deleted.focus } }), restored: true };
}

export function librarySetFocus(library: CustomThemeLibrary, threadId: string, id: CustomThemeId): CustomThemeLibrary {
  if (!threadId || !findRecord(library, id)) return library;
  if (library.threadFocus[threadId] === id && Object.keys(library.threadFocus).at(-1) === threadId) return library;
  const threadFocus = { ...library.threadFocus };
  // Re-insert so the most recent conversation is last; the oldest fall off.
  delete threadFocus[threadId];
  threadFocus[threadId] = id;
  const keys = Object.keys(threadFocus);
  for (const key of keys.slice(0, Math.max(0, keys.length - STORE_LIMITS.maxThreadFocus))) delete threadFocus[key];
  return { ...library, threadFocus };
}

export function librarySetDesigner(library: CustomThemeLibrary, threadId: string, purpose: ThemeDesignerPurpose): CustomThemeLibrary {
  if (!threadId) return library;
  const designerThreads = { ...(library.designerThreads ?? {}) };
  delete designerThreads[threadId];
  designerThreads[threadId] = purpose;
  const keys = Object.keys(designerThreads);
  for (const key of keys.slice(0, Math.max(0, keys.length - STORE_LIMITS.maxDesignerThreads))) delete designerThreads[key];
  return { ...library, designerThreads };
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

export function libraryBytes(library: CustomThemeLibrary): number {
  return byteLength(JSON.stringify(library));
}

/**
 * Keeps the library within its space budget. The oldest revisions that are
 * not a theme's head go first, across all themes, always keeping the head
 * plus the four newest per theme. Only if that is still too big does a theme
 * fall back to its head alone. A pruned revision's `prev` then dangles and
 * undo stops there with a clear message.
 */
export function pruneLibrary(library: CustomThemeLibrary, maxBytes: number = STORE_LIMITS.maxLibraryBytes): CustomThemeLibrary {
  let bytes = libraryBytes(library);
  if (bytes <= maxBytes) return library;
  let themes = library.themes;
  for (const keepRecent of [STORE_LIMITS.keepRecent, 0]) {
    const candidates: Array<{ id: CustomThemeId; n: number; at: number; bytes: number }> = [];
    for (const record of themes) {
      const protectedNumbers = new Set((keepRecent ? record.revisions.slice(-keepRecent) : []).map((revision) => revision.n));
      protectedNumbers.add(record.head);
      for (const revision of record.revisions) {
        if (!protectedNumbers.has(revision.n)) candidates.push({ id: record.id, n: revision.n, at: revision.at, bytes: byteLength(JSON.stringify(revision)) + 1 });
      }
    }
    candidates.sort((a, b) => a.at - b.at || a.n - b.n);
    const drop = new Map<CustomThemeId, Set<number>>();
    for (const candidate of candidates) {
      if (bytes <= maxBytes) break;
      if (!drop.has(candidate.id)) drop.set(candidate.id, new Set());
      drop.get(candidate.id)!.add(candidate.n);
      bytes -= candidate.bytes;
    }
    if (drop.size) {
      themes = themes.map((record) => {
        const gone = drop.get(record.id);
        return gone ? { ...record, revisions: record.revisions.filter((revision) => !gone.has(revision.n)) } : record;
      });
    }
    if (bytes <= maxBytes) break;
  }
  return { ...library, themes };
}

// ---- Live store -----------------------------------------------------------------

let library: CustomThemeLibrary | undefined;
const listeners = new Set<() => void>();
/** Sessions registered before their thread existed (the first turn of a new chat). */
const sessionThreads = new Map<string, string>();
/** "Design a theme with AI" opened a draft that has no thread yet. */
let pendingDesigner: ThemeDesignerPurpose | null = null;
let clock: () => number = () => Date.now();

function read(): CustomThemeLibrary {
  if (library) return library;
  library = sanitizeLibrary(loadStored<unknown>(CUSTOM_THEMES_KEY, null));
  return library;
}

function publish(next: CustomThemeLibrary): void {
  if (next === library) return;
  library = next;
  // Autosave: the cache now, SQLite on the queued state write. No Save button anywhere.
  try { storeValue(CUSTOM_THEMES_KEY, next); } catch { /* SQLite still receives the queued write. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeCustomThemes(listener: () => void): () => void {
  return subscribe(listener);
}

/** The whole library, re-rendering when it changes. */
export function useCustomThemes(): CustomThemeLibrary {
  return useSyncExternalStore(subscribe, read, () => EMPTY_LIBRARY);
}

export function getCustomThemeLibrary(): CustomThemeLibrary {
  return read();
}

export function getCustomTheme(id: CustomThemeId): CustomThemeRecord | undefined {
  return findRecord(read(), id);
}

/** The base theme a custom theme renders on, if it exists. */
export function customThemeBase(id: CustomThemeId): ThemeName | undefined {
  const record = getCustomTheme(id);
  return record ? headSpec(record).base : undefined;
}

export function customThemeSummaries(): CustomThemeSummary[] {
  return read().themes.map(summarize);
}

export function createCustomTheme(spec: ThemeSpec, meta: CreateMeta): StoreResult {
  const { library: next, result } = libraryCreate(read(), spec, meta, clock());
  publish(next);
  return result;
}

export function commitCustomThemeRevision(id: CustomThemeId, spec: ThemeSpec, meta: CommitMeta): StoreResult {
  const { library: next, result } = libraryCommit(read(), id, spec, meta, clock());
  publish(next);
  return result;
}

export function renameCustomTheme(id: CustomThemeId, name: string, by: ThemeAuthor = { kind: "user" }): StoreResult {
  const { library: next, result } = libraryRename(read(), id, name, by, clock());
  publish(next);
  return result;
}

export function undoCustomTheme(id: CustomThemeId, options: UndoOptions): UndoResult {
  const { library: next, result } = libraryUndo(read(), id, options, clock());
  publish(next);
  return result;
}

/**
 * User-only. Removes the theme, its history and its thread focus. The caller
 * switches away from it and offers Undo; `restore` puts it back as it was
 * while this page is open.
 */
export function deleteCustomTheme(id: CustomThemeId): { record: CustomThemeRecord | null; restore: () => boolean } {
  const { library: next, deleted } = libraryDelete(read(), id);
  publish(next);
  return {
    record: deleted?.record ?? null,
    restore: () => {
      if (!deleted) return false;
      const { library: restored, restored: ok } = libraryRestoreDeleted(read(), deleted);
      publish(restored);
      return ok;
    },
  };
}

export function setThreadThemeFocus(threadId: string, id: CustomThemeId): void {
  publish(librarySetFocus(read(), threadId, id));
}

export function threadThemeFocus(threadId: string): CustomThemeId | undefined {
  const current = read();
  const id = current.threadFocus[threadId];
  return id && findRecord(current, id) ? id : undefined;
}

export function bindSessionToThread(sessionId: string, threadId: string): void {
  if (!sessionId || !threadId) return;
  sessionThreads.delete(sessionId);
  sessionThreads.set(sessionId, threadId);
  while (sessionThreads.size > 200) sessionThreads.delete(sessionThreads.keys().next().value!);
}

export function sessionThread(sessionId: string): string | undefined {
  return sessionThreads.get(sessionId);
}

export function setThemeDisabled(id: CustomThemeId, reason: ThemeDisabledReason | null): void {
  publish(librarySetDisabled(read(), id, reason));
}

// ---- "Design a theme with AI" threads -----------------------------------------

/** Marks the open draft as a theme-designer conversation until it gets a thread. */
export function setPendingThemeDesigner(purpose: { targetThemeId?: CustomThemeId } | null): void {
  pendingDesigner = purpose ? { ...purpose, at: clock() } : null;
}

/** Called when the draft's first message creates its thread. */
export function claimPendingThemeDesigner(threadId: string): ThemeDesignerPurpose | null {
  const purpose = pendingDesigner;
  pendingDesigner = null;
  if (!purpose || !threadId) return null;
  let next = librarySetDesigner(read(), threadId, purpose);
  if (purpose.targetThemeId) next = librarySetFocus(next, threadId, purpose.targetThemeId);
  publish(next);
  return purpose;
}

/**
 * Whether a conversation is a theme-designer thread (it gets the designer
 * instructions every turn). With no thread id this answers for the open
 * draft, before its first message creates the thread.
 */
export function themeDesignerPurpose(threadId?: string | null): ThemeDesignerPurpose | null {
  if (!threadId) return pendingDesigner;
  return read().designerThreads?.[threadId] ?? null;
}

// ---- Boot guard ---------------------------------------------------------------

export interface CustomThemeBootGuard {
  themeId: CustomThemeId;
  revision: number;
  at: number;
  state: "applying" | "ok";
}

export function readBootGuard(): CustomThemeBootGuard | null {
  const raw = loadStored<unknown>(CUSTOM_THEME_BOOT_KEY, null);
  if (!raw || typeof raw !== "object") return null;
  const guard = raw as Partial<CustomThemeBootGuard>;
  if (!isCustomThemeId(guard.themeId) || !Number.isSafeInteger(guard.revision) || (guard.state !== "applying" && guard.state !== "ok")) return null;
  return { themeId: guard.themeId, revision: guard.revision!, at: Number.isFinite(guard.at) ? guard.at! : 0, state: guard.state };
}

/** Written synchronously before a custom theme first paints. */
export function armBootGuard(themeId: CustomThemeId, revision: number): void {
  const current = readBootGuard();
  if (current && current.themeId === themeId && current.revision === revision && current.state === "applying") return;
  try { storeValue(CUSTOM_THEME_BOOT_KEY, { themeId, revision, at: clock(), state: "applying" } satisfies CustomThemeBootGuard); } catch { /* best effort */ }
}

/** The theme drew cleanly; the next launch may use it again. With no theme
 * given, whatever was armed is settled (a built-in theme is on screen). */
export function settleBootGuard(themeId?: CustomThemeId, revision?: number): void {
  const current = readBootGuard();
  if (!current || current.state === "ok") return;
  if (themeId !== undefined && (current.themeId !== themeId || current.revision !== revision)) return;
  try { storeValue(CUSTOM_THEME_BOOT_KEY, { ...current, state: "ok" } satisfies CustomThemeBootGuard); } catch { /* best effort */ }
}

/**
 * Run once at launch, before the first render. If the last launch armed the
 * guard for a theme and never settled it, that theme is switched off (safe
 * mode) and its id is returned so the app can say why.
 */
export function checkBootGuard(): CustomThemeId | null {
  const guard = readBootGuard();
  if (!guard || guard.state !== "applying") return null;
  const record = getCustomTheme(guard.themeId);
  try { storeValue(CUSTOM_THEME_BOOT_KEY, { ...guard, state: "ok" } satisfies CustomThemeBootGuard); } catch { /* best effort */ }
  if (!record || record.head !== guard.revision) return null;
  setThemeDisabled(guard.themeId, "boot-failure");
  return guard.themeId;
}

// ---- Theme setting resolution ------------------------------------------------------

/** How a theme setting renders right now. */
export interface ResolvedThemeSetting {
  /** The setting asked for. */
  requested: ThemeId;
  /** The built-in theme on the shell (data-theme). */
  base: ThemeName;
  /** The custom theme drawn on top, when it exists and isn't switched off. */
  custom: CustomThemeRecord | null;
  /** A custom theme that was asked for but isn't drawn, and why. */
  fallback?: { id: CustomThemeId; reason: ThemeDisabledReason | "missing" };
}

export function resolveThemeSetting(theme: ThemeId, current: CustomThemeLibrary = read(), missingFallback: ThemeName = "mythra"): ResolvedThemeSetting {
  if (!theme.startsWith("custom:")) return { requested: theme, base: theme as ThemeName, custom: null };
  const id = theme.slice(7) as CustomThemeId;
  const record = findRecord(current, id);
  if (!record) return { requested: theme, base: missingFallback, custom: null, fallback: { id, reason: "missing" } };
  const base = headSpec(record).base;
  if (record.disabledReason) return { requested: theme, base, custom: null, fallback: { id, reason: record.disabledReason } };
  return { requested: theme, base, custom: record };
}

// ---- App host (registered by App.tsx; used by the theme tool handler) -------------

/** App registers this once; the theme tool handler calls it. All methods are synchronous or quick. */
export interface ThemeHost {
  /** settings.customThemeTools !== false */
  toolsEnabled(): boolean;
  /** The theme in effect for that thread's project. */
  activeThemeId(threadId?: string): ThemeId;
  applyTheme(theme: ThemeId, ctx: { threadId?: string; by: ThemeAuthor; previous?: { theme: ThemeId; revision?: { id: CustomThemeId; n: number } } }): { appliedTo: "app" | "project" };
  threadForSession(sessionId: string): { threadId?: string; provider?: Provider; model?: string };
  /** Resolves after the theme's <style> commits plus two frames; returns the shell. */
  waitForApplied(themeId: ThemeId, revision?: number): Promise<HTMLElement | null>;
  motionState(): { paused: boolean; reducedMotion: boolean };
}

let host: ThemeHost | null = null;

export function registerThemeHost(next: ThemeHost): () => void {
  host = next;
  return () => { if (host === next) host = null; };
}

export function themeHost(): ThemeHost | null {
  return host;
}

// ---- Test hooks -------------------------------------------------------------------

export function resetCustomThemeStoreForTests(options: { library?: CustomThemeLibrary; now?: () => number } = {}): void {
  library = options.library ? sanitizeLibrary(options.library) : { version: 1, themes: [], threadFocus: {} };
  sessionThreads.clear();
  pendingDesigner = null;
  host = null;
  clock = options.now ?? (() => Date.now());
  listeners.clear();
}

/** Who made a revision, in a few words ("Claude", "you"). */
export function revisionAuthor(revision: Pick<CustomThemeRevision, "by">): string {
  return authorLabel(revision.by);
}
