// The eight custom-theme bridge tools, as pure logic over injected engine,
// store and app-host functions (see toolHandlers.ts for the real binding).
// Kept dependency-free so it is unit-testable without a DOM or Tauri.
//
// Flow per mutating call: resolve the conversation and target theme →
// validate with the engine (P1) → save a revision in the store (P2) → record
// the conversation's focus → apply through the app host (P2) → probe the
// real screen for readability → measure the layout (which selectors matched
// which regions, whether decorations and effects can be seen) → answer the
// model with what changed. Every result says where its layout came from:
// the user's own window (live, whatever is on screen) or, when the theme is
// not on screen, a layout-only hidden preview. capture_app_screenshot draws
// one exact theme revision in a hidden preview of a fixed scene with sample
// content (never the user's window), optionally with one control in a
// mirrored hover/focus/press state, and returns its picture and layout when
// the user allows it.

import type { Provider, ThemeName } from "../../types";
import { SPEC_KEYS, type ContrastAdjustment, type CustomThemeId, type NormalizeResult, type ThemeAuthor, type ThemeId, type ThemeSpec, type ValidationIssue } from "./spec";
import type { CommitMeta, CreateMeta, CustomThemeLibrary, CustomThemeRecord, CustomThemeRevision, StoreResult, ThemeHost, UndoOptions, UndoResult } from "./store";
import { THEME_DESIGN_GUIDE } from "./designGuide";
import type { PreviewInteractionRequest, PreviewJob, PreviewOutcome } from "./previewJob";
import { customCssMoves } from "./sanitizeCss";
import {
  CONTROL_TARGET_IDS, controlTarget, isControlTargetId, isPreviewInteraction, isPreviewScene, PREVIEW_INTERACTIONS,
  PREVIEW_SCENE_IDS, PREVIEW_SCENES, type ControlTargetId, type PreviewInteraction,
} from "./previewScenes";

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
  /** The dispatched turn still owns local theme authority. */
  stillAuthorized?(): boolean;
  /** Notifies an in-flight preview when its turn or local authority changes. */
  watchAuthorization?(check: () => void): () => void;
  /** The bridge still owns this exact relay before a preview reaches its model. */
  checkAuthorization?(): Promise<boolean>;
  /**
   * The turn-level authority a hidden preview needs when a theme change asks
   * for one (a layout-only fallback). Absent: the fields above are used.
   */
  previewAuthority?: Pick<ThemeToolContext, "stillAuthorized" | "watchAuthorization" | "checkAuthorization">;
}

export interface ProbeOutcome {
  ok: boolean;
  failures: Array<{ landmark: string; ratio: number; fg: string; bg: string; selectorHint?: string; causedByCustomCss?: boolean }>;
  checked?: number;
  /** At least one failure goes away without customCss (absent: unknown). */
  customCssCulprit?: boolean;
}

/**
 * Codex filters image content according to its model descriptor. For models
 * from third-party endpoints the runtime's fallback descriptor assumes image
 * support, so require the endpoint's own capability metadata first.
 */
export function providerTakesImages(provider: Provider | undefined, supportsImageInput?: boolean): boolean {
  return provider === "claude" || provider === "openai"
    || ((provider === "openrouter" || provider === "lmstudio") && supportsImageInput === true);
}

export interface ThemeToolDeps {
  normalize(input: unknown): NormalizeResult;
  applyPatch(current: ThemeSpec, patch: unknown): NormalizeResult;
  diff(before: ThemeSpec, after: ThemeSpec): string[];
  designKit(): unknown;
  probe(shell: HTMLElement, signal: AbortSignal, isCurrent: () => boolean): Promise<ProbeOutcome | null>;
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
  /**
   * Draw a job in the hidden preview window: its layout report and, when the
   * job asks, a native PNG of that window (never of the app window).
   */
  preview?(job: PreviewJob, signal: AbortSignal): Promise<PreviewOutcome>;
  /** How long a preview may take (ms). */
  previewWaitMs?: number;
  /** How long a theme change waits for a layout-only hidden preview (ms). */
  layoutPreviewWaitMs?: number;
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

// ---- Where a result's layout came from (layoutFrom) -------------------------------

const SCENE_HINT = "capture_app_screenshot draws any listed scene (new thread, new chat, welcome, Tools tabs, Settings > Appearance, command palette) and control hover/focus/press states from sample data, without the user navigating.";

/** Measured in the user's own window, after the live readability check. */
function liveLayoutSource(readability: string): Record<string, unknown> {
  return {
    source: "live-window",
    shows: "the user's own window as it is right now: only the thread, project or screen they have open, so regions and selectors for other screens can show 0 matches",
    readabilityCheck: readability,
    note: SCENE_HINT,
  };
}

export function noLayoutSource(why: string): Record<string, unknown> {
  return { source: "none", why, note: SCENE_HINT };
}

const NOT_APPLIED = noLayoutSource("the revision was saved without applying it");

/** The preview page's report: its layout, plus what it drew under `preview`. */
function splitPreviewLayout(value: Record<string, unknown> | null): { layout: Record<string, unknown> | null; drawn: Record<string, unknown> | null } {
  if (!value) return { layout: null, drawn: null };
  const { preview, ...layout } = value;
  const drawn = preview && typeof preview === "object" && !Array.isArray(preview) ? preview as Record<string, unknown> : null;
  return { layout: Object.keys(layout).length ? layout : null, drawn };
}

async function drawPreview(
  render: NonNullable<ThemeToolDeps["preview"]>,
  job: PreviewJob,
  timeoutMs: number,
  outer: ThemeToolContext,
  host: ThemeHost,
): Promise<PreviewOutcome | null> {
  const context = outer.previewAuthority ?? outer;
  const controller = new AbortController();
  const { signal } = controller;
  let refusal: string | undefined;
  const revoke = (message: string) => {
    if (signal.aborted) return;
    refusal = message;
    controller.abort();
  };
  const conversationEnded = "The requesting turn ended while preparing the preview.";
  const check = () => {
    if (!host.toolsEnabled() || !host.screenshotsEnabled()) {
      revoke("The user turned off theme tools or app previews. Use the layout report from your last theme change.");
    } else if (context.stillAuthorized?.() === false) {
      revoke(conversationEnded);
    }
  };
  const unwatchAccess = host.watchPreviewAccess?.(check);
  const unwatchAuthority = context.watchAuthorization?.(check);
  try {
    check();
    if (refusal) return refuse(refusal);
    const aborted = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
    const draw = async () => {
      if (context.checkAuthorization && !await context.checkAuthorization()) revoke(conversationEnded);
      check();
      if (signal.aborted) return null;
      const outcome = await render(job, signal);
      check();
      if (signal.aborted) return null;
      if (outcome.ok && context.checkAuthorization && !await context.checkAuthorization()) revoke(conversationEnded);
      check();
      return signal.aborted ? null : outcome;
    };
    const outcome = await withTimeout(Promise.race([draw(), aborted]), timeoutMs);
    check();
    if (refusal) return refuse(refusal);
    return outcome;
  } finally {
    controller.abort();
    unwatchAuthority?.();
    unwatchAccess?.();
  }
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
   * revision; token and effect choices are kept. `applied` is the exact
   * revision being applied: a hidden fallback draws that object (or the
   * stripped one), never whatever the library holds after an await.
   */
  async function applyAndProbe(record: CustomThemeRecord, applied: CustomThemeRevision, conversationInfo: Conversation, host: ThemeHost, previous: { theme: ThemeId; revision?: { id: CustomThemeId; n: number } }, context: ThemeToolContext) {
    const revision = applied.n;
    const theme: ThemeId = `custom:${record.id}`;
    const { appliedTo } = host.applyTheme(theme, { threadId: conversationInfo.threadId, by: conversationInfo.by, previous });
    const warnings: string[] = [];
    const provider: Provider = conversationInfo.by.kind === "model" ? conversationInfo.by.provider : "openai";
    const done = (revision: CustomThemeRevision, layout: Record<string, unknown> | null, layoutFrom: Record<string, unknown>) => ({ appliedTo, warnings, revision, layout, layoutFrom });
    /** The live window could not be measured: the same bounded hidden preview, of exactly `shown`. */
    const fallback = async (shown: CustomThemeRevision, readability: string) => {
      const hidden = await hiddenLayout(record.id, shown, provider, host, context, readability);
      return done(shown, hidden.layout, hidden.from);
    };
    /** A live measurement, labelled live only when there is one. */
    const live = async (target: HTMLElement, shown: CustomThemeRevision, readability: string) => {
      if (target.isConnected === false || !host.isThemePainted(theme, shown.n)) {
        return fallback(shown, readability);
      }
      const layout = measureLayout(target, { id: record.id, spec: shown.spec }, host);
      return layout ? done(shown, layout, liveLayoutSource(readability)) : fallback(shown, readability);
    };
    const shell = await withTimeout(host.waitForApplied(theme, revision), applyWaitMs);
    if (!shell) {
      warnings.push("The theme was selected for this conversation. Its revision did not paint in the visible window before the readability check, which can happen when another project is open.");
      return fallback(applied, "not run (the requested revision did not paint in the visible window)");
    }
    const spec = applied.spec;
    const isCurrent = () => shell.isConnected !== false && host.isThemePainted(theme, revision);
    const probeController = new AbortController();
    const probe = await withTimeout(deps.probe(shell, probeController.signal, isCurrent), applyWaitMs);
    probeController.abort();
    if (!isCurrent()) {
      warnings.push("The requested revision stopped being visible during the readability check.");
      return fallback(applied, "interrupted (the requested revision stopped being visible)");
    }
    if (!probe) return fallback(applied, "the live readability check did not finish");
    if (probe.ok) return live(shell, applied, probe.checked === 0
      ? "no visible text landmarks were available for the live readability check"
      : "passed on the user's screen");
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
        const strippedRevision = stripped.revision;
        host.applyTheme(theme, { threadId: conversationInfo.threadId, by: conversationInfo.by, previous: { theme, revision: { id: record.id, n: revision } } });
        warnings.push(`customCss disabled: ${failures.join("; ")}. Saved as revision ${strippedRevision.n} without customCss; tokens and effects were kept. Fix the rule (use var(--text)/var(--muted) colours) and send customCss again if the user wants it.`);
        const redrawn = await withTimeout(host.waitForApplied(theme, strippedRevision.n), applyWaitMs);
        const readability = `r${revision} failed the live check. Custom CSS was disabled in r${strippedRevision.n}.`;
        return redrawn ? live(redrawn, strippedRevision, readability) : fallback(strippedRevision, readability);
      }
    }
    warnings.push(`Some text may be hard to read on screen: ${describe(probe.failures).join("; ")}. Adjust the related tokens (text, muted and their surfaces).`);
    return live(shell, applied, "failed on the user's screen");
  }

  /**
   * A layout-only hidden preview of one exact revision (the conversation
   * scene, no picture), for a change the user's window can't show. Bounded
   * by layoutPreviewWaitMs, and only with previews allowed and the turn's
   * native call still authorized, checked before it starts and again when
   * it returns; otherwise it says why there is no layout.
   */
  async function hiddenLayout(id: CustomThemeId, revision: CustomThemeRevision, provider: Provider, host: ThemeHost, context: ThemeToolContext, readability: string): Promise<{ layout: Record<string, unknown> | null; from: Record<string, unknown> }> {
    const noLayout = (why: string) => ({ layout: null, from: { ...noLayoutSource(why), readabilityCheck: readability } });
    if (!deps.preview) return noLayout("Hidden previews are unavailable here.");
    const authority = context.previewAuthority ?? context;
    const allowed = () => host.toolsEnabled() && host.screenshotsEnabled();
    const consentOff = noLayout("Theme tools or “Let models see theme previews” are turned off.");
    if (!allowed()) return consentOff;
    const ended = noLayout("The requesting turn ended before the hidden layout could be returned.");
    if (authority.stillAuthorized?.() === false) return ended;
    let outcome: PreviewOutcome | null;
    try {
      const spec = savedPreviewSpec(revision);
      if (!spec) return noLayout(`r${revision.n} no longer passes the theme checks.`);
      const job: PreviewJob = {
        ...host.previewEnvironment(), version: 1, view: "conversation", capture: false, provider,
        theme: { base: spec.base, custom: { id, revision: revision.n, spec } },
      };
      outcome = await drawPreview(deps.preview, job, deps.layoutPreviewWaitMs ?? 8_000, context, host);
    } catch (reason) {
      return noLayout(reason instanceof ThemeToolRefusal ? reason.message : "The hidden preview could not be prepared.");
    }
    if (!allowed()) return consentOff;
    if (authority.stillAuthorized?.() === false) return ended;
    if (!outcome || !outcome.ok) return noLayout(outcome ? outcome.error : "The hidden preview did not answer in time.");
    const { layout } = splitPreviewLayout(outcome.result.layout);
    if (!layout) return noLayout("The hidden preview did not return a layout report.");
    return {
      layout,
      from: {
        source: "hidden-preview", scene: "conversation", shows: PREVIEW_SCENES.conversation.shows, revision: revision.n,
        readabilityCheck: readability,
        note: "Measured in a hidden copy of the app with bundled sample content. Use capture_app_screenshot for other scenes or a picture.",
      },
    };
  }

  function measureLayout(shell: HTMLElement, theme: { id: CustomThemeId; spec: ThemeSpec } | null, host: ThemeHost): Record<string, unknown> | null {
    if (!deps.inspect) return null;
    try { return deps.inspect(shell, theme, host.motionState()); } catch { return null; }
  }

  function motionNotes(spec: ThemeSpec, host: ThemeHost): string[] {
    const hasEffects = Boolean(Object.keys(spec.effects ?? {}).length) && spec.motion?.enabled !== false;
    if (!hasEffects && !customCssMoves(spec.customCss ?? "")) return [];
    const motion = host.motionState();
    if (motion.reducedMotion) return ["The user's system asks apps to reduce motion, so this theme's animations stay still for them."];
    if (motion.paused) return ["The user has paused theme animations in Mythra Code, so they will see this theme still until they resume them."];
    return [];
  }

  /** Pass only engine fields from this immutable saved revision. */
  function savedPreviewSpec(revision: CustomThemeRevision): ThemeSpec | null {
    const saved = Object.fromEntries(SPEC_KEYS.map((key) => [key, revision.spec[key]]));
    return deps.normalize(saved).ok ? structuredClone(saved) as unknown as ThemeSpec : null;
  }

  /**
   * What a preview draws: themeId's revision, else this conversation's theme,
   * else the theme in effect for it (custom or built-in). Default: the head.
   */
  function previewTarget(args: Record<string, unknown>, threadId: string | undefined, host: ThemeHost): { theme: PreviewJob["theme"]; facts: Record<string, unknown> } {
    const library = deps.library();
    const requested = positiveInt(args.revision);
    if (args.revision !== undefined && (requested === undefined || requested > 100_000)) {
      return refuse("`revision` must be a whole number from 1 to 100000.");
    }
    if (args.themeId !== undefined && typeof args.themeId !== "string") {
      return refuse("`themeId` must be a custom theme id. Call list_custom_themes.");
    }
    let record: CustomThemeRecord | undefined;
    let source: "themeId" | "conversation" | "active" = "themeId";
    if (typeof args.themeId === "string") {
      record = findRecord(library, args.themeId)
        ?? refuse(`No custom theme ${args.themeId} exists; the user may have deleted it. Call list_custom_themes.`);
    } else {
      const focused = threadId ? deps.focus(threadId) : undefined;
      record = focused ? findRecord(library, focused) : undefined;
      source = "conversation";
      if (!record) {
        const active = activeTheme(host, threadId);
        const activeId = customId(active);
        record = activeId ? findRecord(library, activeId) : undefined;
        source = "active";
        if (!record) {
          if (requested !== undefined) refuse("`revision` needs a custom theme. Pass themeId, or leave out revision to preview the built-in theme in use.");
          const builtIn = deps.builtInThemes.find((theme) => theme.id === active);
          const base = builtIn?.id ?? "mythra";
          return { theme: { base, custom: null }, facts: { theme: base, name: builtIn?.name ?? base, source } };
        }
      }
    }
    const found = record;
    const number = requested ?? found.head;
    const revision = found.revisions.find((entry) => entry.n === number);
    if (!revision) {
      const name = headRevision(found).spec.name;
      return refuse(number > found.head
        ? `${quoted(name)} has no r${number}. Its newest revision is r${found.head}.`
        : `r${number} of ${quoted(name)} is no longer in its saved history. Use get_custom_theme with includeHistory to see the available revisions.`);
    }
    // Pass the exact saved fields accepted by the engine. The preview page
    // uses the same compiler as the app and supplies defaults for older specs.
    const spec = savedPreviewSpec(revision);
    if (!spec) {
      return refuse(`r${revision.n} of ${quoted(revision.spec.name)} no longer passes the theme checks. Preview another revision or fix it with update_custom_theme.`);
    }
    return {
      theme: { base: spec.base, custom: { id: found.id, revision: revision.n, spec } },
      facts: {
        theme: `custom:${found.id}`, themeId: found.id, name: spec.name, revision: revision.n, newestRevision: found.head, source,
        ...(found.disabledReason ? { turnedOff: found.disabledReason } : {}),
      },
    };
  }

  function mutationResult(record: CustomThemeRecord, revision: CustomThemeRevision, extra: {
    applied: boolean; appliedTo?: "app" | "project"; changed: string[]; adjustments?: ContrastAdjustment[]; warnings: string[]; note: string; layout?: Record<string, unknown> | null; [key: string]: unknown;
  }): Record<string, unknown> {
    const { applied, appliedTo, changed, adjustments, warnings, note, layout, ...rest } = extra;
    return {
      themeId: record.id,
      name: revision.spec.name,
      revision: revision.n,
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
      let revision = saved.revision;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      let layoutFrom: Record<string, unknown> | undefined;
      const shouldApply = bool(apply, true);
      if (shouldApply) {
        const outcome = await applyAndProbe(saved.record, saved.revision, info, host, { theme: previous }, context);
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        layoutFrom = outcome.layoutFrom;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(revision.spec, host));
      const name = revision.spec.name;
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed: ["created"],
        adjustments: ok.adjustments,
        warnings,
        layout,
        layoutFrom: layoutFrom ?? NOT_APPLIED,
        note: `Saved ${quoted(name)} as revision ${revision.n}${shouldApply ? " and applied it" : ""}. The user can undo from the toast or in Settings. Adjust it later with update_custom_theme.`,
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
        return mutationResult(record, headRevision(record), {
          applied: Boolean(appliedTo), appliedTo, changed: [], adjustments: ok.adjustments, warnings: ok.warnings, unchanged: true,
          layoutFrom: noLayoutSource("The patch matched the saved revision, so there was no new measurement."),
          note: `The patch matches ${quoted(current.name)} r${record.head} after normalization. ${appliedTo ? "Selected the existing revision." : "No revision was saved."}`,
        });
      }
      const previousTheme = activeTheme(host, info.threadId);
      const editedTheme: ThemeId = `custom:${record.id}`;
      if (!shouldApply && (previousTheme === editedTheme || activeTheme(host) === editedTheme || host.isThemePainted(editedTheme))) {
        refuse("This theme is active, so saving a revision would change the app immediately. Switch to another theme first, or allow the revision to apply.");
      }
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
      let revision = saved.revision;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      let layoutFrom: Record<string, unknown> | undefined;
      if (shouldApply) {
        const previous = previousTheme === `custom:${record.id}`
          ? { theme: previousTheme, revision: { id: record.id, n: record.head } }
          : { theme: previousTheme };
        const outcome = await applyAndProbe(saved.record, saved.revision, info, host, previous, context);
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        layoutFrom = outcome.layoutFrom;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(revision.spec, host));
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed,
        adjustments: ok.adjustments,
        warnings,
        layout,
        layoutFrom: layoutFrom ?? NOT_APPLIED,
        note: `Saved as revision ${revision.n} of ${quoted(revision.spec.name)}. The user can undo it from the toast or in Settings. Models can use undo_custom_theme.`,
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
      const shouldApply = bool(request.arguments.apply, true);
      const editedTheme: ThemeId = `custom:${record.id}`;
      if (!shouldApply && (previousTheme === editedTheme || activeTheme(host) === editedTheme || host.isThemePainted(editedTheme))) {
        refuse("This theme is active, so restoring a revision would change the app immediately. Switch to another theme first, or allow the revision to apply.");
      }
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
      let revision = saved.revision;
      let appliedTo: "app" | "project" | undefined;
      let layout: Record<string, unknown> | null | undefined;
      let layoutFrom: Record<string, unknown> | undefined;
      if (shouldApply) {
        const previous = previousTheme === `custom:${record.id}`
          ? { theme: previousTheme, revision: { id: record.id, n: before } }
          : { theme: previousTheme };
        const outcome = await applyAndProbe(saved.record, saved.revision, info, host, previous, context);
        appliedTo = outcome.appliedTo;
        revision = outcome.revision;
        layout = outcome.layout;
        layoutFrom = outcome.layoutFrom;
        warnings.push(...outcome.warnings);
      }
      warnings.push(...motionNotes(revision.spec, host));
      const restoredFrom = saved.restoredFrom ?? saved.revision.restoredFrom;
      return mutationResult(saved.record, revision, {
        applied: shouldApply,
        appliedTo,
        changed,
        warnings,
        layout,
        layoutFrom: layoutFrom ?? NOT_APPLIED,
        ...(restoredFrom ? { restoredFrom } : {}),
        ...(saved.undone?.length ? { undone: saved.undone } : {}),
        note: `${quoted(revision.spec.name)} ${restoredFrom ? `was restored from r${restoredFrom}` : "was reverted"}, saved as revision ${revision.n}. Use undo_custom_theme with toRevision ${before} to restore the previous look.`,
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
        return {
          theme: theme.id, name: theme.name, applied: true, appliedTo,
          layoutFrom: noLayoutSource("A built-in theme was selected."),
          note: `${theme.name} is now the active theme. The user can undo from the toast.`,
        };
      }
      const record = targetTheme(request.arguments.themeId, info.threadId, host);
      if (record.disabledReason) {
        const why = record.disabledReason === "boot-failure" ? "Mythra Code didn't start cleanly with it"
          : record.disabledReason === "render-error" ? "part of the app failed to draw with it" : "it no longer passes the theme checks";
        refuse(`${quoted(headRevision(record).spec.name)} is turned off because ${why}. Fix it with update_custom_theme (which saves a new revision), or ask the user to turn it back on in Settings > Appearance > Custom themes.`);
      }
      remember(info.threadId, record.id);
      const outcome = await applyAndProbe(record, headRevision(record), info, host, { theme: previous }, context);
      const warnings = [...outcome.warnings, ...motionNotes(outcome.revision.spec, host)];
      return mutationResult(record, outcome.revision, {
        applied: true,
        appliedTo: outcome.appliedTo,
        changed: [],
        warnings,
        layout: outcome.layout,
        layoutFrom: outcome.layoutFrom,
        note: `Selected r${outcome.revision.n} of ${quoted(outcome.revision.spec.name)} for this conversation. The user can undo from the toast.`,
      });
    },

    async capture_app_screenshot(request, context, host) {
      if (!host.screenshotsEnabled()) {
        refuse("The user turned off “Let models see theme previews” in Settings > Appearance > Custom themes, so no preview was drawn. Use the layout report from your last theme change.");
      }
      const info = conversation(request, context, host);
      const { provider: hostedProvider, supportsImageInput } = host.threadForSession(request.sessionId);
      const provider = request.provider ?? hostedProvider;
      // The scene and state come from fixed lists, never from the user's
      // window: what is on their screen doesn't change what this draws.
      const { view = "conversation", control, interaction: state } = request.arguments;
      if (!isPreviewScene(view)) return refuse(`\`view\` must be one of ${PREVIEW_SCENE_IDS.join(", ")}.`);
      if (control !== undefined && !isControlTargetId(control)) return refuse(`\`control\` must be one of ${CONTROL_TARGET_IDS.join(", ")}.`);
      if (state !== undefined && !isPreviewInteraction(state)) return refuse(`\`interaction\` must be one of ${PREVIEW_INTERACTIONS.join(", ")}.`);
      const scene = PREVIEW_SCENES[view];
      let interaction: PreviewInteractionRequest | null = null;
      if (control !== undefined || state !== undefined) {
        const chosen: ControlTargetId | undefined = (control as ControlTargetId | undefined) ?? scene.controls[0];
        if (!chosen) return refuse(`The ${view} scene has no listed controls to put in a state. Leave out control and interaction, or pick a scene from get_theme_design_kit's preview.scenes.`);
        if (!scene.controls.includes(chosen)) {
          const scenes = PREVIEW_SCENE_IDS.filter((id) => PREVIEW_SCENES[id].controls.includes(chosen));
          return refuse(`${controlTarget(chosen)!.label} (${chosen}) is not drawn in the ${view} scene. Controls there: ${scene.controls.join(", ") || "none"}. Scenes with ${chosen}: ${scenes.join(", ")}.`);
        }
        interaction = { control: chosen, state: (state as PreviewInteraction | undefined) ?? "hover" };
      }
      // The revision is fixed now: later edits, theme switches or navigation
      // in the user's window don't change what this preview draws.
      const target = previewTarget(request.arguments, info.threadId, host);
      const details = {
        ...target.facts,
        scenario: {
          view, shows: scene.shows, content: "bundled sample content only (never the user's projects, threads or screen)",
          ...(interaction ? { control: interaction.control, interaction: interaction.state, controlSelector: controlTarget(interaction.control)!.selector } : {}),
        },
      };
      if (!deps.preview) {
        return { ...details, captured: false, layoutAvailable: false, layoutFrom: noLayoutSource("Previews are not available here."), note: "Previews are not available here. Use the layout report from your last theme change." };
      }
      // A model picker can change during the turn. Only the provider carried
      // by its bridge registration can authorize an image.
      const wantsImage = providerTakesImages(request.provider, supportsImageInput);
      const job: PreviewJob = { ...host.previewEnvironment(), version: 1, view, interaction, capture: wantsImage, provider: provider ?? "openai", theme: target.theme };
      const outcome = await drawPreview(deps.preview, job, deps.previewWaitMs ?? 25_000, context, host);
      if (!host.toolsEnabled() || !host.screenshotsEnabled()) return refuse("The user turned off theme tools or app previews.");
      if (context.stillAuthorized?.() === false) return refuse("The requesting turn ended while preparing the preview.");
      if (!outcome || !outcome.ok) {
        const why = !outcome ? "The hidden preview did not answer in time." : outcome.unavailable ? "Previews are not available on this system." : `The hidden preview could not be drawn (${outcome.error}).`;
        return { ...details, captured: false, layoutAvailable: false, layoutFrom: noLayoutSource(why), note: `${why} Use the layout report from your last theme change.` };
      }
      const { viewport, imageError } = outcome.result;
      const { layout, drawn } = splitPreviewLayout(outcome.result.layout);
      const image = wantsImage ? outcome.result.image : undefined;
      const drawnState = drawn?.scene === view && drawn.interaction && typeof drawn.interaction === "object"
        ? drawn.interaction as Record<string, unknown> : null;
      let stateFacts: Record<string, unknown> | undefined;
      let stateLine = "";
      if (interaction) {
        stateFacts = drawnState?.control === interaction.control && drawnState.state === interaction.state && typeof drawnState.drawn === "boolean"
          ? drawnState
          : { ...interaction, drawn: false, why: "The preview did not report this control's state." };
        const label = controlTarget(interaction.control)!.label;
        stateLine = stateFacts.drawn === false
          ? ` ${String(stateFacts.why ?? `The requested state for ${label} was unavailable.`)}`
          : ` ${label} is shown ${String(stateFacts.how ?? (interaction.state === "rest" ? "at rest" : `in its ${interaction.state} state`))}.`;
        if (stateFacts.drawn && interaction.state !== "rest") stateLine += " See interaction.changed for the measured differences.";
      }
      // The window as actually drawn; a size outside the preview's bounds is
      // clamped natively, and that is said rather than hidden.
      const adjusted = viewport && (viewport.width !== job.viewport.width || viewport.height !== job.viewport.height);
      const measured = {
        ...details,
        dimensions: {
          window: viewport ?? "unknown",
          uiScale: job.uiScale,
          ...(adjusted ? { requestedWindow: job.viewport, adjusted: "Layout and picture use the actual preview window size above." } : {}),
          ...(image ? { picture: { width: image.width, height: image.height } } : {}),
        },
        ...(stateFacts ? { interaction: stateFacts } : {}),
        ...(typeof drawn?.fixture === "string" ? { fixture: drawn.fixture } : {}),
        ...(typeof drawn?.sidebar === "string" ? { sidebar: drawn.sidebar } : {}),
        // The landings' marks (the animated logo's visible square, the welcome mark).
        ...(Array.isArray(drawn?.landmarks) ? { landmarks: drawn.landmarks } : {}),
        layoutAvailable: Boolean(layout),
        layoutFrom: layout ? {
          source: "hidden-preview", scene: view,
          ...(job.theme.custom ? { revision: job.theme.custom.revision } : {}),
          state: "all controls at rest",
        } : noLayoutSource("The hidden preview did not return a layout report."),
        ...(layout ? { layout } : {}),
      };
      const layoutLine = `${layout ? "Use the layout report above." : "The preview layout could not be measured. Use the layout report from your last theme change."}${stateLine}`;
      if (!wantsImage) {
        const note = provider === "cursor"
          ? `This runtime supports text results from the preview. ${layoutLine}`
          : `Image input is unavailable or unconfirmed for this model. ${layoutLine}`;
        return { ...measured, captured: false, note };
      }
      if (!image) {
        return { ...measured, captured: false, note: `The preview picture was unavailable (${imageError ?? "no picture returned"}). ${layoutLine}` };
      }
      return {
        ...measured,
        captured: true,
        width: image.width,
        height: image.height,
        image: { data: image.data, mimeType: image.mimeType },
        note: `The attached picture shows a hidden preview of Mythra Code's ${view} scene with sample content and ${"revision" in target.facts ? `r${String(target.facts.revision)} of ` : ""}${String(target.facts.name)}. Animations and particles show one still moment. ${layout ? "The layout report uses the preview's CSS pixels." : "The preview's layout could not be measured."}${stateLine}`,
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
