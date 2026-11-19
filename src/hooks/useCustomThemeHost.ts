import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { THEMES, customThemeIdOf, DEFAULT_SETTINGS } from "../lib/appConfig";
import {
  getCustomTheme,
  headSpec,
  readBootGuard,
  registerThemeHost,
  setThemeDisabled,
  setThreadThemeFocus,
  settleBootGuard,
  themeSessionIdentity,
  undoCustomTheme,
  type CustomThemeRecord,
  type ThemeDisabledReason,
  type ThemeHost,
} from "../lib/customThemes/store";
import type { CustomThemeId, ThemeAuthor } from "../lib/customThemes/spec";
import { normalizeThemeInput } from "../lib/customThemes/validate";
import type { AppSettings, Project, Provider, ThemeId } from "../types";

export interface ThemeToastAction {
  label: string;
  run: () => void;
}

export interface CustomThemeHostOptions {
  settingsRef: MutableRefObject<AppSettings>;
  persistSettings: (update: (current: AppSettings) => AppSettings) => void;
  projectsRef: MutableRefObject<Project[]>;
  setProjects: (update: (current: Project[]) => Project[]) => void;
  /** The project a conversation belongs to, if any. */
  projectForThread: (threadId: string) => Project | undefined;
  /** The project open on screen, if any. */
  activeProjectId: string | null;
  /** The theme actually drawn, including a Settings preview. */
  paintedTheme: ThemeId;
  /** The custom theme drawn right now, if any. */
  appliedCustom: CustomThemeRecord | null;
  screenshotThreadId?: string;
  screenshotWorkspacePath: string;
  /** Settings is previewing a theme; a model's change replaces that preview. */
  setPreviewTheme: (update: (current: ThemeId | null) => ThemeId | null) => void;
  threadForSession: (sessionId: string) => string | undefined;
  threadModel: (threadId: string) => { provider?: Provider; model?: string };
  showToast: (message: string, options?: { actions?: ThemeToastAction[]; durationMs?: number; kind?: "success" | "info" }) => void;
  openCustomThemes: () => void;
  /** A theme switched off at launch by the boot guard (safe mode). */
  bootSafeModeThemeId: CustomThemeId | null;
}

/** How long after a theme change a view crash is blamed on the theme. */
const RENDER_ERROR_WINDOW_MS = 10_000;
/** A launch counts as clean once it has drawn with the theme for this long. */
const BOOT_SETTLE_MS = 4_000;

function themeLabel(theme: ThemeId): string {
  const custom = customThemeIdOf(theme);
  if (custom) {
    const record = getCustomTheme(custom);
    return record ? `“${headSpec(record).name}”` : "a deleted theme";
  }
  return THEMES.find((entry) => entry.id === theme)?.name ?? theme;
}

const SAFE_MODE_TOAST: Record<ThemeDisabledReason, (name: string) => string> = {
  "boot-failure": (name) => `“${name}” was turned off because Mythra Code didn't start cleanly with it.`,
  "render-error": (name) => `“${name}” was turned off after part of the app failed to draw with it.`,
  invalid: (name) => `“${name}” no longer passes the theme checks in this version, so Mythra Code is using its base theme.`,
};

/**
 * Connects the custom theme library to the running app: the host the theme
 * tools call (apply, wait, look up threads), safe mode (boot guard, view
 * crashes, specs that stopped validating) and the reset escape hatch.
 */
export function useCustomThemeHost(options: CustomThemeHostOptions): {
  resetTheme: (reason?: "shortcut" | "palette" | "tray") => void;
  reportRenderError: (failedTheme?: Pick<CustomThemeRecord, "id" | "head">) => void;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const appliedAtRef = useRef(0);
  const renderedRef = useRef({ theme: options.paintedTheme, revision: options.appliedCustom?.head ?? null });
  const screenshotView = useRef({ threadId: options.screenshotThreadId, workspace: options.screenshotWorkspacePath });
  const waitersRef = useRef(new Set<{ theme: ThemeId; revision?: number; resolve: (shell: HTMLElement | null) => void }>());

  const isThemePainted = useCallback((theme: ThemeId, revision?: number) => {
    const rendered = renderedRef.current;
    return rendered.theme === theme && (revision === undefined || revision === rendered.revision);
  }, []);

  const resolvePaintedShell = useCallback((waiter: { theme: ThemeId; revision?: number; resolve: (shell: HTMLElement | null) => void }) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      waiter.resolve(isThemePainted(waiter.theme, waiter.revision) ? document.querySelector<HTMLElement>(".app-shell") : null);
    }));
  }, [isThemePainted]);

  const switchOff = useCallback((id: CustomThemeId, reason: ThemeDisabledReason) => {
    const record = getCustomTheme(id);
    if (!record || record.disabledReason) return;
    setThemeDisabled(id, reason);
    optionsRef.current.showToast(SAFE_MODE_TOAST[reason](headSpec(record).name), {
      kind: "info",
      durationMs: 10_000,
      actions: [{ label: "Open in Settings", run: () => optionsRef.current.openCustomThemes() }],
    });
  }, []);

  // ---- What is on screen, for waitForApplied and the boot guard ----
  const appliedId = options.appliedCustom?.id ?? null;
  const appliedRevision = options.appliedCustom?.head ?? null;
  useLayoutEffect(() => {
    renderedRef.current = { theme: optionsRef.current.paintedTheme, revision: appliedRevision };
    appliedAtRef.current = Date.now();
    const startupTheme = readBootGuard();
    if (startupTheme?.state !== "applying") return;
    if (!appliedId || startupTheme.themeId !== appliedId || startupTheme.revision !== appliedRevision) {
      settleBootGuard();
      return;
    }
    const timer = window.setTimeout(() => settleBootGuard(startupTheme.themeId, startupTheme.revision), BOOT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [appliedId, appliedRevision, options.paintedTheme]);
  useLayoutEffect(() => {
    if (screenshotView.current.threadId !== options.screenshotThreadId || screenshotView.current.workspace !== options.screenshotWorkspacePath) {
      screenshotView.current = { threadId: options.screenshotThreadId, workspace: options.screenshotWorkspacePath };
    }
    for (const waiter of [...waitersRef.current]) {
      if (!isThemePainted(waiter.theme, waiter.revision)) continue;
      waitersRef.current.delete(waiter);
      // The theme's <style> lands in an effect; give it two frames to paint.
      resolvePaintedShell(waiter);
    }
  });

  // ---- A stored theme that no longer passes the engine's checks ----
  useEffect(() => {
    if (!appliedId) return;
    const record = getCustomTheme(appliedId);
    if (!record) return;
    let result;
    try { result = normalizeThemeInput(headSpec(record)); } catch { return; /* an engine failure is not the theme's fault */ }
    if (!result.ok) switchOff(appliedId, "invalid");
  }, [appliedId, appliedRevision, switchOff]);

  // ---- Safe mode after a launch that never settled ----
  useEffect(() => {
    const id = options.bootSafeModeThemeId;
    if (!id) return;
    const record = getCustomTheme(id);
    if (!record) return;
    options.showToast(SAFE_MODE_TOAST["boot-failure"](headSpec(record).name), {
      kind: "info",
      durationMs: 12_000,
      actions: [{ label: "Open in Settings", run: () => optionsRef.current.openCustomThemes() }],
    });
    // Once, at launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reportRenderError = useCallback((failedTheme?: Pick<CustomThemeRecord, "id" | "head">) => {
    if (failedTheme) {
      if (getCustomTheme(failedTheme.id)?.head === failedTheme.head) switchOff(failedTheme.id, "render-error");
      return;
    }
    const custom = customThemeIdOf(renderedRef.current.theme);
    if (!custom || Date.now() - appliedAtRef.current > RENDER_ERROR_WINDOW_MS) return;
    switchOff(custom, "render-error");
  }, [switchOff]);

  // ---- Applying a theme where it belongs: the thread's project, or the app ----
  const setThemeFor = useCallback((theme: ThemeId, threadId?: string): "app" | "project" => {
    const current = optionsRef.current;
    const project = threadId ? current.projectForThread(threadId) : current.projectsRef.current.find((entry) => entry.id === current.activeProjectId);
    const projectTheme = project?.overrides?.defaults?.theme;
    const projectThemeLive = projectTheme && (!customThemeIdOf(projectTheme) || getCustomTheme(customThemeIdOf(projectTheme)!));
    if (project && projectThemeLive) {
      current.setProjects((projects) => projects.map((entry) => {
        const defaults = entry.overrides?.defaults;
        if (entry.id !== project.id || !defaults) return entry;
        return { ...entry, overrides: { ...(entry.overrides ?? {}), defaults: { ...defaults, theme } } };
      }));
      if (project.id === current.activeProjectId) current.setPreviewTheme((preview) => preview === null ? null : theme);
      return "project";
    }
    current.persistSettings((settings) => settings.theme === theme ? settings : { ...settings, theme });
    current.setPreviewTheme((preview) => preview === null ? null : theme);
    return "app";
  }, []);

  const themeInEffect = useCallback((threadId?: string): ThemeId => {
    const current = optionsRef.current;
    const project = threadId ? current.projectForThread(threadId) : current.projectsRef.current.find((entry) => entry.id === current.activeProjectId);
    const projectTheme = project?.overrides?.defaults?.theme;
    if (projectTheme && (!customThemeIdOf(projectTheme) || getCustomTheme(customThemeIdOf(projectTheme)!))) return projectTheme;
    return current.settingsRef.current.theme;
  }, []);

  const resetTheme = useCallback((reason: "shortcut" | "palette" | "tray" = "shortcut") => {
    const current = optionsRef.current;
    const previous = themeInEffect();
    const fallback = DEFAULT_SETTINGS.theme;
    const project = current.projectsRef.current.find((entry) => entry.id === current.activeProjectId);
    const projectTheme = project?.overrides?.defaults?.theme;
    const previousApp = current.settingsRef.current.theme;
    // A project override would otherwise keep the global default from showing.
    if (project && projectTheme) {
      current.setProjects((projects) => projects.map((entry) => {
        const defaults = entry.overrides?.defaults;
        if (entry.id !== project.id || !defaults) return entry;
        const { theme: _removed, ...rest } = defaults;
        return { ...entry, overrides: { ...(entry.overrides ?? {}), defaults: rest } };
      }));
    }
    current.persistSettings((settings) => settings.theme === fallback ? settings : { ...settings, theme: fallback });
    current.setPreviewTheme((preview) => preview === null ? null : fallback);
    if (previous === fallback && previousApp === fallback) {
      if (reason !== "tray") current.showToast("You're already using Mythra, the default theme.", { kind: "info" });
      return;
    }
    current.showToast(`Switched to Mythra, the default theme.`, {
      kind: "info",
      durationMs: 8_000,
      actions: [{ label: "Undo", run: () => {
        if (project && projectTheme) {
          optionsRef.current.setProjects((projects) => projects.map((entry) => {
            const defaults = entry.overrides?.defaults;
            if (entry.id !== project.id || !defaults) return entry;
            return { ...entry, overrides: { ...(entry.overrides ?? {}), defaults: { ...defaults, theme: projectTheme } } };
          }));
        }
        optionsRef.current.persistSettings((settings) => ({ ...settings, theme: previousApp }));
      } }],
    });
  }, [themeInEffect]);

  // ---- The host the theme tools call ----
  useEffect(() => {
    const host: ThemeHost = {
      toolsEnabled: () => optionsRef.current.settingsRef.current.customThemeTools !== false,
      screenshotsEnabled: () => optionsRef.current.settingsRef.current.customThemeScreenshots !== false,
      beginScreenshot: (threadId) => {
        const view = screenshotView.current;
        if (!threadId || view.threadId !== threadId) return null;
        const surface = document.querySelector(".local-machine-surface");
        if (!surface) return null;
        const stillVisible = () => {
          return screenshotView.current === view && surface.isConnected
            && !surface.closest("[inert]") && !surface.hasAttribute("data-covered");
        };
        return stillVisible() ? stillVisible : null;
      },
      activeThemeId: (threadId) => themeInEffect(threadId),
      applyTheme: (theme, ctx) => {
        const before = themeInEffect(ctx.threadId);
        const appliedTo = setThemeFor(theme, ctx.threadId);
        const custom = customThemeIdOf(theme);
        if (custom && ctx.threadId) setThreadThemeFocus(ctx.threadId, custom);
        if (ctx.by.kind === "model") announceModelChange(theme, before, ctx);
        return { appliedTo };
      },
      threadForSession: (sessionId) => {
        const session = themeSessionIdentity(sessionId);
        const threadId = session?.threadId ?? optionsRef.current.threadForSession(sessionId);
        if (!threadId) return {};
        const current = optionsRef.current.threadModel(threadId);
        return { threadId, provider: current.provider, model: session?.model ?? current.model, supportsImageInput: session?.supportsImageInput };
      },
      waitForApplied: (theme, revision) => new Promise((resolve) => {
        const waiter = { theme, revision, resolve: (shell: HTMLElement | null) => {
          window.clearTimeout(timer);
          waitersRef.current.delete(waiter);
          resolve(shell);
        } };
        const timer = window.setTimeout(() => {
          waiter.resolve(null);
        }, 2_000);
        waitersRef.current.add(waiter);
        if (isThemePainted(theme, revision)) {
          waitersRef.current.delete(waiter);
          resolvePaintedShell(waiter);
        }
      }),
      isThemePainted,
      motionState: () => ({
        paused: optionsRef.current.settingsRef.current.themeMotion === "paused",
        reducedMotion: Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
      }),
    };
    return registerThemeHost(host);

    /** "Applied “Nebula” (r7) · Undo · Open in Settings": the receipt for a model's change. */
    function announceModelChange(theme: ThemeId, before: ThemeId, ctx: { threadId?: string; by: ThemeAuthor; previous?: { theme: ThemeId; revision?: { id: CustomThemeId; n: number } } }) {
      const custom = customThemeIdOf(theme);
      const record = custom ? getCustomTheme(custom) : undefined;
      const message = record ? `Applied “${headSpec(record).name}” (r${record.head})` : `Switched to ${themeLabel(theme)}`;
      const previousTheme = ctx.previous?.theme ?? before;
      const previousRevision = ctx.previous?.revision;
      optionsRef.current.showToast(message, {
        kind: "success",
        durationMs: 6_000,
        actions: [
          { label: "Undo", run: () => {
            if (previousRevision) {
              const now = getCustomTheme(previousRevision.id);
              if (now && now.head !== previousRevision.n) {
                const changed = now.revisions.find((revision) => revision.n === now.head)?.summary ?? "the last change";
                undoCustomTheme(previousRevision.id, { by: { kind: "user" }, toRevision: previousRevision.n, summary: `Undo: ${changed.charAt(0).toLowerCase()}${changed.slice(1)}`.slice(0, 120) });
              }
            }
            if (previousTheme !== theme) setThemeFor(previousTheme, ctx.threadId);
          } },
          { label: "Open in Settings", run: () => optionsRef.current.openCustomThemes() },
        ],
      });
    }
  }, [isThemePainted, resolvePaintedShell, setThemeFor, themeInEffect]);

  // ---- The tray's "Use default theme" (native menus ignore any CSS) ----
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen("custom-theme-reset", () => resetTheme("tray"))).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, [resetTheme]);

  return { resetTheme, reportRenderError };
}
