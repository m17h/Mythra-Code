// The eight custom-theme bridge tools, as pure logic over injected engine,
// store and app-host functions (see toolHandlers.ts for the real binding).
// Kept dependency-free so it is unit-testable without a DOM or Tauri.
//
// Flow per mutating call: resolve the conversation and target theme →
// validate with the engine (P1) → save a revision in the store (P2) → record
// the conversation's focus → apply through the app host (P2) → probe the
// real screen for readability → measure the layout (which selectors matched
// which regions, whether decorations and effects can be seen) → answer the
// model with what changed. capture_app_screenshot adds a picture of the
// window when the user allows it.

import type { Provider, ThemeName } from "../../types";
import type { ContrastAdjustment, CustomThemeId, NormalizeResult, ThemeAuthor, ThemeId, ThemeSpec, ValidationIssue } from "./spec";
import type { CommitMeta, CreateMeta, CustomThemeLibrary, CustomThemeRecord, CustomThemeRevision, StoreResult, ThemeHost, UndoOptions, UndoResult } from "./store";
import { THEME_DESIGN_GUIDE } from "./designGuide";

export const THEME_TOOLS = [
  "get_theme_design_kit",
  "list_custom_themes",
  "get_custom_theme",
  "create_custom_theme",
  "update_custom_theme",
  "undo_custom_theme",
  "apply_custom_theme",
  "capture_app_screenshot",
] as const;
export type ThemeTool = (typeof THEME_TOOLS)[number];

export function isThemeTool(tool: string): tool is ThemeTool {
  return (THEME_TOOLS as readonly string[]).includes(tool);
}

/** What the handler needs to know about the bridge request. */
export interface ThemeToolRequest {
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** App-supplied provider of the bridge registration (never a model value). */
  provider?: Provider;
}

/** Renderer facts the bridge request itself does not carry. */
export interface ThemeToolContext {
  /** Root thread of the session's registered policy, when already known. */
  policyThreadId?: string;
}

export interface ProbeOutcome {
  ok: boolean;
  failures: Array<{ landmark: string; ratio: number; fg: string; bg: string; selectorHint?: string; causedByCustomCss?: boolean }>;
  /** At least one failure goes away without customCss (absent: unknown). */
  customCssCulprit?: boolean;
}

/** A picture of the app window from the native webview (PNG, already downscaled). */
export type CaptureOutcome =
  | { ok: true; data: string; mimeType: "image/png"; width: number; height: number }
  | { ok: false; error: string; unavailable?: boolean };

/**
 * Runtimes that hand an MCP image result to the model: Claude Code, and Codex
 * (ChatGPT, OpenRouter and LM Studio chats run on it; it strips images itself
 * for text-only models). Cursor's agent does not reliably pass tool images on,
 * so it gets the text report instead of a picture.
 */
export function providerTakesImages(provider: Provider | undefined): boolean {
  return provider !== "cursor";
}

export interface ThemeToolDeps {
  normalize(input: unknown): NormalizeResult;
  applyPatch(current: ThemeSpec, patch: unknown): NormalizeResult;
  diff(before: ThemeSpec, after: ThemeSpec): string[];
  designKit(): unknown;
  probe(shell: HTMLElement): Promise<ProbeOutcome>;
  library(): CustomThemeLibrary;
  create(spec: ThemeSpec, meta: CreateMeta): StoreResult;
  commit(id: CustomThemeId, spec: ThemeSpec, meta: CommitMeta): StoreResult;
  undo(id: CustomThemeId, options: UndoOptions): UndoResult;
  setFocus(threadId: string, id: CustomThemeId): void;
  focus(threadId: string): CustomThemeId | undefined;
  sessionThread(sessionId: string): string | undefined;
  host(): ThemeHost | null;
  builtInThemes: ReadonlyArray<{ id: ThemeName; name: string; description?: string }>;
  /** How long to wait for the applied theme to paint before probing (ms). */
  applyWaitMs?: number;
  /** The `layout` report for the window as drawn now (null: could not measure). */
  inspect?(shell: HTMLElement, theme: { id: CustomThemeId; spec: ThemeSpec } | null, motion: { paused: boolean; reducedMotion: boolean }): Record<string, unknown> | null;
  /** A PNG of the app window, natively from the webview (no screen-recording permission). */
  capture?(): Promise<CaptureOutcome>;
  /** How long a capture may take (ms). */
  captureWaitMs?: number;
}

const LIGHT_BUILT_INS: readonly string[] = ["light-mythra", "daylight", "atari"];
const DELETE_NOTE = "Only the user can delete themes, in Settings > Appearance > Custom themes.";
const MAX_LISTED_ISSUES = 24;

/** A refusal the model should read and act on (delivered as a tool error). */
export class ThemeToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeToolRefusal";
  }
}

const refuse = (message: string): never => {
  throw new ThemeToolRefusal(message);
};

const quoted = (name: string) => `“${name}”`;

function headRevision(record: CustomThemeRecord): CustomThemeRevision {
  return record.revisions.find((revision) => revision.n === record.head) ?? record.revisions[record.revisions.length - 1]!;
}

function findRecord(library: CustomThemeLibrary, id: string): CustomThemeRecord | undefined {
  return library.themes.find((theme) => theme.id === id);
}

function customId(theme: ThemeId): CustomThemeId | undefined {
  return theme.startsWith("custom:") ? theme.slice(7) as CustomThemeId : undefined;
}

function author(by: ThemeAuthor): string {
  if (by.kind === "user") return "you (the user)";
  const names: Record<Provider, string> = { openai: "Codex", openrouter: "OpenRouter", lmstudio: "LM Studio", claude: "Claude", cursor: "Cursor" };
  return by.model ? `${names[by.provider] ?? by.provider} (${by.model})` : names[by.provider] ?? by.provider;
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function issuesText(intro: string, issues: ValidationIssue[]): string {
  const lines = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `- ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  if (issues.length > MAX_LISTED_ISSUES) lines.push(`- …and ${issues.length - MAX_LISTED_ISSUES} more.`);
  return `${intro}\n${lines.join("\n")}`;
}

function storeFailure(result: StoreResult): never {
  if (result.ok) throw new Error("unreachable");
  if (result.issues?.length) return refuse(issuesText(result.error, result.issues));
  return refuse(result.error);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

interface Conversation {
  threadId?: string;
  by: ThemeAuthor;
}

export function createThemeToolHandler(deps: ThemeToolDeps) {
  const applyWaitMs = deps.applyWaitMs ?? 4_000;

  function conversation(request: ThemeToolRequest, context: ThemeToolContext, host: ThemeHost): Conversation {
    const hosted = host.threadForSession(request.sessionId) ?? {};
    const threadId = context.policyThreadId || deps.sessionThread(request.sessionId) || hosted.threadId || undefined;
    const provider = request.provider ?? hosted.provider;
    const by: ThemeAuthor = provider
      ? { kind: "model", provider, ...(hosted.model ? { model: hosted.model } : {}), ...(threadId ? { threadId } : {}) }
      // Unknown provider (an older backend that did not relay it): still a
      // model change, credited to the host's best knowledge.
      : { kind: "model", provider: "openai", ...(threadId ? { threadId } : {}) };
    return { threadId, by };
  }

  function activeTheme(host: ThemeHost, threadId?: string): ThemeId {
    return host.activeThemeId(threadId);
  }

  /** themeId argument, else this conversation's theme, else the active custom theme. */
  function targetTheme(argument: unknown, threadId: string | undefined, host: ThemeHost): CustomThemeRecord {
    const library = deps.library();
    if (typeof argument === "string") {
      return findRecord(library, argument)
        ?? refuse(`No custom theme ${argument} exists; the user may have deleted it. Call list_custom_themes.`);
    }
    const focused = threadId ? deps.focus(threadId) : undefined;
    const focusedRecord = focused ? findRecord(library, focused) : undefined;
    if (focusedRecord) return focusedRecord;
    const active = activeTheme(host, threadId);
    const activeId = customId(active);
    const activeRecord = activeId ? findRecord(library, activeId) : undefined;
    if (activeRecord) return activeRecord;
    const builtIn = deps.builtInThemes.find((theme) => theme.id === active)?.name ?? active;
    return refuse(`Which theme? No theme is focused in this conversation and the active theme is built-in (${builtIn}). Call list_custom_themes, or create_custom_theme for a new one.`);
  }

  function remember(threadId: string | undefined, id: CustomThemeId) {
    if (threadId) deps.setFocus(threadId, id);
  }

  /**
   * Apply, wait for the new look to paint, and probe real landmarks. A
   * stylesheet that makes text unreadable is switched off with an undoable
   * revision; token and effect choices are kept.
   */
  async function applyAndProbe(record: CustomThemeRecord, revision: number, conversationInfo: Conversation, host: ThemeHost, previous: { theme: ThemeId; revision?: { id: CustomThemeId; n: number } }) {
    const theme: ThemeId = `custom:${record.id}`;
    const { appliedTo } = host.applyTheme(theme, { threadId: conversationInfo.threadId, by: conversationInfo.by, previous });
    const warnings: string[] = [];
    let finalRevision = revision;
    const shell = await withTimeout(host.waitForApplied(theme, revision), applyWaitMs);
    if (!shell) {
      warnings.push("The theme was saved and selected, but it isn't on screen right now (for example another project is open), so on-screen readability and layout were not checked.");
      return { appliedTo, warnings, revision: finalRevision, customCssDisabled: false };
    }
    const spec = headRevision(record).spec;
    const measure = (target: HTMLElement, measured: ThemeSpec) => measureLayout(target, { id: record.id, spec: measured }, host);
    const probe = await deps.probe(shell).catch(() => null);
    if (!probe || probe.ok) return { appliedTo, warnings, revision: finalRevision, customCssDisabled: false, layout: measure(shell, spec) };
    const describe = (list: ProbeOutcome["failures"]) => list.slice(0, 6).map((failure) =>
      `${failure.selectorHint ?? failure.landmark} color resolves to ${failure.fg} on ${failure.bg} (${failure.ratio.toFixed(1)}:1)`);
    const cssFailures = probe.failures.filter((failure) => failure.causedByCustomCss !== false);
    const failures = describe(cssFailures.length ? cssFailures : probe.failures);
    if (spec.customCss.trim() && probe.customCssCulprit !== false) {
      const stripped = deps.commit(record.id, { ...spec, customCss: "" }, {
        by: conversationInfo.by,
        kind: "edit",
        summary: "Turned off custom CSS that made text hard to read",
        expectedRevision: revision,
      });
      if (stripped.ok) {
        finalRevision = stripped.revision.n;
        host.applyTheme(theme, { threadId: conversationInfo.threadId, by: conversationInfo.by, previous: { theme, revision: { id: record.id, n: revision } } });
        warnings.push(`customCss disabled: ${failures.join("; ")}. Saved as revision ${finalRevision} without customCss; tokens and effects were kept. Fix the rule (use var(--text)/var(--muted) colours) and send customCss again if the user wants it.`);
        const redrawn = await withTimeout(host.waitForApplied(theme, finalRevision), applyWaitMs);
        return { appliedTo, warnings, revision: finalRevision, customCssDisabled: true, layout: redrawn ? measure(redrawn, { ...spec, customCss: "" }) : null };
      }
    }
    warnings.push(`Some text may be hard to read on screen: ${describe(probe.failures).join("; ")}. Adjust the related tokens (text, muted and their surfaces).`);
    return { appliedTo, warnings, revision: finalRevision, customCssDisabled: false, layout: measure(shell, spec) };
  }

  function measureLayout(shell: HTMLElement, theme: { id: CustomThemeId; spec: ThemeSpec } | null, host: ThemeHost): Record<string, unknown> | null {
    if (!deps.inspect) return null;
    try { return deps.inspect(shell, theme, host.motionState()); } catch { return null; }
  }

  function motionNotes(spec: ThemeSpec, host: ThemeHost): string[] {
    if (!Object.keys(spec.effects ?? {}).length || spec.motion?.enabled === false) return [];
    const motion = host.motionState();
    if (motion.reducedMotion) return ["The user's system asks apps to reduce motion, so this theme's animations stay still for them."];
    if (motion.paused) return ["The user has paused theme animations in Mythra Code, so they will see this theme still until they resume them."];
    return [];
  }

  function mutationResult(record: CustomThemeRecord, revision: number, extra: {
    applied: boolean; appliedTo?: "app" | "project"; changed: string[]; adjustments?: ContrastAdjustment[]; warnings: string[]; note: string; layout?: Record<string, unknown> | null; [key: string]: unknown;
  }): Record<string, unknown> {
    const { applied, appliedTo, changed, adjustments, warnings, note, layout, ...rest } = extra;
    return {
      themeId: record.id,
      name: headRevision(record).spec.name,
      revision,
      applied,
      ...(appliedTo ? { appliedTo } : {}),
      changed,
      adjustments: adjustments ?? [],
      warnings,
      ...rest,
      ...(layout ? { layout } : {}),
      note,
    };
  }

  const handlers: Record<ThemeTool, (request: ThemeToolRequest, context: ThemeToolContext, host: ThemeHost) => Promise<Record<string, unknown>>> = {
    async get_theme_design_kit() {
      const kit = deps.designKit();
      return {
        ...(kit && typeof kit === "object" && !Array.isArray(kit) ? kit as Record<string, unknown> : { kit }),
        guide: THEME_DESIGN_GUIDE,
      };
    },

    async list_custom_themes(request, context, host) {
      const { threadId } = conversation(request, context, host);
      const library = deps.library();
      const active = activeTheme(host, threadId);
      const focused = threadId ? deps.focus(threadId) : undefined;
      return {
        activeTheme: active,
        focusedInThisConversation: focused ?? null,
        custom: library.themes.map((record) => {
          const head = headRevision(record);
          return {
            themeId: record.id,
            name: head.spec.name,
            description: head.spec.description,
            base: head.spec.base,
            scheme: LIGHT_BUILT_INS.includes(head.spec.base) ? "light" : "dark",
            revision: record.head,
            updatedAt: iso(record.updatedAt),
            effects: Object.keys(head.spec.effects ?? {}),
            madeBy: author(record.createdBy),
            ...(active === `custom:${record.id}` ? { active: true } : {}),
            ...(focused === record.id ? { focusedInThisConversation: true } : {}),
            ...(record.disabledReason ? { turnedOff: record.disabledReason } : {}),
          };
        }),
        builtIn: deps.builtInThemes.map((theme) => ({
          builtInTheme: theme.id,
          name: theme.name,
          scheme: LIGHT_BUILT_INS.includes(theme.id) ? "light" : "dark",
          ...(active === theme.id ? { active: true } : {}),
        })),
        note: DELETE_NOTE,
      };
    },

    async get_custom_theme(request, context, host) {
      const { threadId } = conversation(request, context, host);
      const record = targetTheme(request.arguments.themeId, threadId, host);
      const head = headRevision(record);
      const history = request.arguments.includeHistory === true;
      const oldest = record.revisions[0]?.n ?? record.head;
      return {
        themeId: record.id,
        name: head.spec.name,
        revision: record.head,
        active: activeTheme(host, threadId) === `custom:${record.id}`,
        ...(record.disabledReason ? { turnedOff: record.disabledReason } : {}),
        spec: head.spec,
        canUndo: head.prev !== null,
        ...(history ? {
          history: [...record.revisions].reverse().map((revision) => ({
            revision: revision.n,
            kind: revision.kind,
            summary: revision.summary,
            by: author(revision.by),
            at: iso(revision.at),
            ...(revision.restoredFrom ? { restoredFrom: revision.restoredFrom } : {}),
            ...(revision.n === record.head ? { current: true } : {}),
          })),
          oldestRetainedRevision: oldest,
        } : {}),
        note: "Change it with update_custom_theme (send only what changes).",
      };
    },

    async create_custom_theme(request, context, host) {
      const info = conversation(request, context, host);
      const { summary, apply, asNewTheme, ...fields } = request.arguments;
      const focused = info.threadId ? deps.focus(info.threadId) : undefined;
      const focusedRecord = focused ? findRecord(deps.library(), focused) : undefined;
      if (focusedRecord && asNewTheme !== true) {
        refuse(`This conversation already made ${quoted(headRevision(focusedRecord).spec.name)} (${focusedRecord.id}). To change it, call update_custom_theme. If the user explicitly asked for a separate new theme, call create_custom_theme again with asNewTheme: true.`);
      }
      const normalized = deps.normalize({ schema: "mythra.theme/1", ...fields });
      if (!normalized.ok) refuse(issuesText("The theme was not saved. Fix these and call create_custom_theme again:", normalized.errors));
      const ok = normalized as Extract<NormalizeResult, { ok: true }>;
      const previous = activeTheme(host, info.threadId);
      const created = deps.create(ok.spec, {
        by: info.by,
        ...(typeof summary === "string" && summary.trim() ? { summary } : {}),
        ...(ok.adjustments.length ? { adjustments: ok.adjustments } : {}),
      });
      if (!created.ok) storeFailure(created);
      const saved = created as Extract<StoreResult, { ok: true }>;
      remember(info.threadId, saved.record.id);
      const warnings = [...ok.warnings];
      let revision = saved.revision.n;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      const shouldApply = bool(apply, true);
      if (shouldApply) {
        const outcome = await applyAndProbe(saved.record, revision, info, host, { theme: previous });
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(ok.spec, host));
      const name = ok.spec.name;
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed: ["created"],
        adjustments: ok.adjustments,
        warnings,
        layout,
        note: `Saved ${quoted(name)} as revision ${revision}${shouldApply ? " and applied it" : ""}. The user can undo from the toast or in Settings. Adjust it later with update_custom_theme.`,
      });
    },

    async update_custom_theme(request, context, host) {
      const info = conversation(request, context, host);
      const record = targetTheme(request.arguments.themeId, info.threadId, host);
      const expectedRevision = positiveInt(request.arguments.expectedRevision);
      if (expectedRevision !== undefined && expectedRevision !== record.head) {
        const head = headRevision(record);
        refuse(`${quoted(head.spec.name)} changed since you read it (now r${record.head}: “${head.summary}” by ${author(head.by)}). Call get_custom_theme and apply your change again.`);
      }
      const current = headRevision(record).spec;
      const patched = deps.applyPatch(current, request.arguments.patch);
      if (!patched.ok) refuse(issuesText(`${quoted(current.name)} was not changed. Fix these and call update_custom_theme again:`, patched.errors));
      const ok = patched as Extract<NormalizeResult, { ok: true }>;
      const changed = deps.diff(current, ok.spec);
      const shouldApply = bool(request.arguments.apply, true);
      if (!changed.length) {
        remember(info.threadId, record.id);
        let appliedTo: "app" | "project" | undefined;
        if (shouldApply && activeTheme(host, info.threadId) !== `custom:${record.id}`) {
          appliedTo = host.applyTheme(`custom:${record.id}`, { threadId: info.threadId, by: info.by, previous: { theme: activeTheme(host, info.threadId) } }).appliedTo;
        }
        return mutationResult(record, record.head, {
          applied: Boolean(appliedTo), appliedTo, changed: [], adjustments: ok.adjustments, warnings: ok.warnings, unchanged: true,
          note: `Nothing changed: the patch matches ${quoted(current.name)} r${record.head} after normalization. No revision was saved.`,
        });
      }
      const previousTheme = activeTheme(host, info.threadId);
      const committed = deps.commit(record.id, ok.spec, {
        by: info.by,
        kind: "edit",
        summary: String(request.arguments.summary ?? "").trim() || "Adjusted",
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(ok.adjustments.length ? { adjustments: ok.adjustments } : {}),
      });
      if (!committed.ok) storeFailure(committed);
      const saved = committed as Extract<StoreResult, { ok: true }>;
      remember(info.threadId, record.id);
      const warnings = [...ok.warnings];
      let revision = saved.revision.n;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      if (shouldApply) {
        const previous = previousTheme === `custom:${record.id}`
          ? { theme: previousTheme, revision: { id: record.id, n: record.head } }
          : { theme: previousTheme };
        const outcome = await applyAndProbe(saved.record, revision, info, host, previous);
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(ok.spec, host));
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed,
        adjustments: ok.adjustments,
        warnings,
        layout,
        note: `Saved as revision ${revision} of ${quoted(ok.spec.name)}. The user can undo it from the toast or in Settings; you can with undo_custom_theme.`,
      });
    },

    async undo_custom_theme(request, context, host) {
      const info = conversation(request, context, host);
      const record = targetTheme(request.arguments.themeId, info.threadId, host);
      const before = record.head;
      const steps = positiveInt(request.arguments.steps);
      const toRevision = positiveInt(request.arguments.toRevision);
      const expectedRevision = positiveInt(request.arguments.expectedRevision);
      const previousTheme = activeTheme(host, info.threadId);
      const undone = deps.undo(record.id, {
        by: info.by,
        ...(toRevision !== undefined ? { toRevision } : { steps: steps ?? 1 }),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      });
      if (!undone.ok) storeFailure(undone);
      const saved = undone as Extract<UndoResult, { ok: true }>;
      remember(info.threadId, record.id);
      const spec = saved.revision.spec;
      const changed = deps.diff(headRevision(record).spec, spec);
      const warnings: string[] = [];
      let revision = saved.revision.n;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      const shouldApply = bool(request.arguments.apply, true);
      if (shouldApply) {
        const previous = previousTheme === `custom:${record.id}`
          ? { theme: previousTheme, revision: { id: record.id, n: before } }
          : { theme: previousTheme };
        const outcome = await applyAndProbe(saved.record, revision, info, host, previous);
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(spec, host));
      const restoredFrom = saved.restoredFrom ?? saved.revision.restoredFrom;
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed,
        warnings,
        layout,
        ...(restoredFrom ? { restoredFrom } : {}),
        ...(saved.undone?.length ? { undone: saved.undone } : {}),
        note: `${quoted(spec.name)} ${restoredFrom ? `now looks like r${restoredFrom} again` : "was reverted"}, saved as revision ${revision}. Nothing was deleted: undo_custom_theme with toRevision ${before} brings the previous look back.`,
      });
    },

    async apply_custom_theme(request, context, host) {
      const info = conversation(request, context, host);
      const previous = activeTheme(host, info.threadId);
      const builtIn = request.arguments.builtInTheme;
      if (typeof builtIn === "string") {
        const theme = deps.builtInThemes.find((entry) => entry.id === builtIn)
          ?? refuse(`${builtIn} is not a built-in theme. Use one of ${deps.builtInThemes.map((entry) => entry.id).join(", ")}.`);
        const previousId = customId(previous);
        const record = previousId ? findRecord(deps.library(), previousId) : undefined;
        const { appliedTo } = host.applyTheme(theme.id, {
          threadId: info.threadId, by: info.by,
          previous: record ? { theme: previous, revision: { id: record.id, n: record.head } } : { theme: previous },
        });
        return { theme: theme.id, name: theme.name, applied: true, appliedTo, note: `${theme.name} is now the active theme. The user can undo from the toast.` };
      }
      const record = targetTheme(request.arguments.themeId, info.threadId, host);
      if (record.disabledReason) {
        const why = record.disabledReason === "boot-failure" ? "Mythra Code didn't start cleanly with it"
          : record.disabledReason === "render-error" ? "part of the app failed to draw with it" : "it no longer passes the theme checks";
        refuse(`${quoted(headRevision(record).spec.name)} is turned off because ${why}. Fix it with update_custom_theme (which saves a new revision), or ask the user to turn it back on in Settings > Appearance > Custom themes.`);
      }
      remember(info.threadId, record.id);
      const outcome = await applyAndProbe(record, record.head, info, host, { theme: previous });
      const warnings = [...outcome.warnings, ...motionNotes(headRevision(record).spec, host)];
      const latest = findRecord(deps.library(), record.id) ?? record;
      return mutationResult(latest, outcome.revision, {
        applied: true,
        appliedTo: outcome.appliedTo,
        changed: [],
        warnings,
        layout: outcome.layout,
        note: `${quoted(headRevision(latest).spec.name)} is now the active theme. The user can undo from the toast.`,
      });
    },

    async capture_app_screenshot(request, context, host) {
      if (host.screenshotsEnabled && !host.screenshotsEnabled()) {
        refuse("The user turned off “Let models see the app” in Settings > Appearance > Custom themes, so no picture was taken. Use the `layout` report from your last theme change instead.");
      }
      const info = conversation(request, context, host);
      const active = activeTheme(host, info.threadId);
      const activeId = customId(active);
      const record = activeId ? findRecord(deps.library(), activeId) : undefined;
      const shell = await withTimeout(host.waitForApplied(active), Math.min(applyWaitMs, 1_500));
      const layout = shell ? measureLayout(shell, record ? { id: record.id, spec: headRevision(record).spec } : null, host) : null;
      const base = {
        theme: active,
        ...(record ? { themeId: record.id, name: headRevision(record).spec.name, revision: record.head } : {}),
        ...(layout ? { layout } : {}),
      };
      const provider = request.provider ?? host.threadForSession(request.sessionId).provider;
      if (!providerTakesImages(provider)) {
        return { ...base, captured: false, note: "This runtime does not pass pictures from tools to the model, so no picture was taken. Use the layout report above." };
      }
      if (!deps.capture) return { ...base, captured: false, note: "Screenshots are not available here. Use the layout report above." };
      const shot = await withTimeout(deps.capture(), deps.captureWaitMs ?? 10_000);
      if (!shot || !shot.ok) {
        const why = !shot ? "The window did not answer in time." : shot.unavailable ? "Screenshots are not available on this system." : `The picture could not be taken (${shot.error}).`;
        return { ...base, captured: false, note: `${why} Use the layout report above.` };
      }
      return {
        ...base,
        captured: true,
        width: shot.width,
        height: shot.height,
        image: { data: shot.data, mimeType: shot.mimeType },
        note: "The attached picture is this Mythra Code window as the user sees it now, downscaled; the layout report uses window CSS pixels. Use it only to check the theme: don't repeat what it shows of the user's conversations or files. If no picture is attached, your runtime dropped it; rely on the layout report.",
      };
    },
  };

  /** Throws ThemeToolRefusal (or Error) with a message for the model on refusal. */
  return async function handleThemeTool(request: ThemeToolRequest, context: ThemeToolContext = {}): Promise<Record<string, unknown>> {
    if (!isThemeTool(request.tool)) throw new ThemeToolRefusal(`\`${request.tool}\` is not a theme tool.`);
    const host = deps.host();
    if (!host) throw new ThemeToolRefusal("Mythra Code isn't ready to change themes yet. Try again in a moment.");
    if (!host.toolsEnabled()) throw new ThemeToolRefusal("The user turned off theme tools in Settings > Appearance > Custom themes.");
    const args = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments) ? request.arguments : {};
    return handlers[request.tool]({ ...request, arguments: args }, context, host);
  };
}
