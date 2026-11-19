// Entry of the hidden theme preview window (theme-preview.html), opened by
// src-tauri/src/theme_preview.rs for one request and destroyed after it.
//
// It takes its job once, draws the app's real views with sample content and
// the job's exact theme revision, measures the layout and reports once, so
// the native side may photograph this window. It reads no saved state
// (hiddenPage.ts) and may call only the preview commands.

import { installFixtureStorage, installLayoutFrames } from "./hiddenPage";
import "../lib/appStyles";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { markDocumentPlatform } from "../lib/platform";
import { readBaseTokens } from "../lib/customThemes/baseTokens";
import { compileThemeCss } from "../lib/customThemes/compile";
import { inspectLayout } from "../lib/customThemes/inspect";
import { parsePreviewHandoff, type PreviewJob } from "../lib/customThemes/previewJob";
import { CUSTOM_CSS_STYLE_ID, CUSTOM_THEME_STYLE_ID } from "../lib/customThemes/probe";
import { customCssScope } from "../lib/customThemes/sanitizeCss";
import { isBuiltInTheme, SPEC_KEYS } from "../lib/customThemes/spec";
import { normalizeThemeInput } from "../lib/customThemes/validate";

/** CSS animations and canvas effects are both stilled at this moment: entrances have finished and staggered loops keep their offsets. */
const STILL_AT_MS = 2_400;

async function beforeTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), 4_000);
  });
  try { return await Promise.race([work, timeout]); }
  finally { window.clearTimeout(timer); }
}

function checkedTheme(job: PreviewJob, platform: ReturnType<typeof markDocumentPlatform>) {
  const custom = job.theme.custom;
  if (!custom) return null;
  const checked = normalizeThemeInput(custom.spec);
  if (custom.spec.base !== job.theme.base || !checked.ok) {
    throw new Error(`r${custom.revision} no longer passes the theme checks`);
  }
  // The live app renders a complete revision as saved. For older revisions
  // missing fields, use the defaults already supplied by theme validation.
  const partial = SPEC_KEYS.some((key) => custom.spec[key] == null)
    || custom.spec.motion.enabled === undefined || custom.spec.surfaces.translucency === undefined;
  const spec = partial ? checked.spec : custom.spec;
  try {
    const styles = compileThemeCss(spec, {
      id: custom.id, scope: "app", platform, forcedColors: window.matchMedia("(forced-colors: active)").matches,
    });
    return { spec, styles };
  } catch {
    throw new Error(`r${custom.revision}'s styles could not be built`);
  }
}

function styleIsApplied(id: string, css: string, theme: NonNullable<PreviewJob["theme"]["custom"]>): boolean {
  const element = document.getElementById(id);
  if (!css) return element === null;
  return element instanceof HTMLStyleElement && Boolean(element.sheet?.cssRules.length)
    && element.dataset.themeId === theme.id && element.dataset.revision === String(theme.revision)
    && element.textContent === css;
}

const nextLayoutFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Let layout request the active fonts, then give observers a turn after resources finish. */
async function settle(shell: HTMLElement): Promise<void> {
  shell.getBoundingClientRect();
  freezeCss();
  const images = Array.from(document.images).map((image) => image.decode());
  await beforeTimeout(Promise.all([document.fonts?.ready, ...images]), "the preview resources did not finish loading");
  await nextLayoutFrame();
  await nextLayoutFrame();
}

/** Capture CSS at the same instant used by the particle renderer. */
function freezeCss(): void {
  if (typeof document.getAnimations === "function") {
    for (const animation of document.getAnimations()) {
      try {
        animation.pause();
        animation.currentTime = STILL_AT_MS;
      } catch { /* finished or detached */ }
    }
  }
}

async function run(): Promise<void> {
  let handoff: ReturnType<typeof parsePreviewHandoff>;
  try {
    handoff = parsePreviewHandoff(await invoke<unknown>("theme_preview_job"));
  } catch {
    return; // Not a preview session (or it already ended): nothing to draw. The native side times out.
  }
  if (!handoff) return;
  const { nonce, job } = handoff;
  try {
    installFixtureStorage();
    installLayoutFrames();
    const platform = markDocumentPlatform();
    if (!isBuiltInTheme(job.theme.base)) throw new Error("unknown base theme");
    const baseTokens = readBaseTokens(job.theme.base);
    if (!baseTokens["--bg"] || !baseTokens["--text"]) throw new Error("the app styles did not load");
    const theme = checkedTheme(job, platform);
    const custom = job.theme.custom;
    const spec = theme?.spec ?? null;
    // The view graph can read settings at module initialization. Only load it
    // once the preview has the native job and its own empty storage.
    const [{ PreviewSurface }, { preparePreviewGrain }] = await Promise.all([
      import("./PreviewSurface"), import("../components/ThemeEffectsLayer"),
    ]);
    const grainUrl = await beforeTimeout(preparePreviewGrain(spec), "the grain texture did not finish loading");
    const container = document.getElementById("root");
    if (!container) throw new Error("the preview page is incomplete");
    const failure: { error?: unknown } = {};
    const root = createRoot(container, {
      onUncaughtError: (error) => { failure.error = error; },
      onCaughtError: (error) => { failure.error = error; },
    });
    flushSync(() => root.render(<PreviewSurface job={job} spec={spec} snapshot={{ time: STILL_AT_MS, grainUrl }} />));
    const shell = container.querySelector<HTMLElement>(".app-shell");
    if (shell?.dataset.theme !== job.theme.base) throw new Error("the app did not draw the requested theme");
    await settle(shell);
    freezeCss();
    await nextLayoutFrame();
    if (failure.error !== undefined) throw failure.error instanceof Error ? failure.error : new Error("part of the app failed to draw with this theme");
    if (!shell.isConnected) throw new Error("the app did not finish drawing");
    if (custom && theme && (shell.dataset.customTheme !== custom.id
      || !styleIsApplied(CUSTOM_THEME_STYLE_ID, theme.styles.tokenCss, custom)
      || !styleIsApplied(CUSTOM_CSS_STYLE_ID, theme.styles.customCss, custom))) {
      throw new Error(`r${custom.revision}'s styles did not reach the page`);
    }
    const layout = inspectLayout(shell, {
      spec,
      ...(custom ? { scopes: [customCssScope(custom.id, true), customCssScope(custom.id)], queryScope: customCssScope(custom.id) } : {}),
      // What the person sees: their own pause and reduced-motion choices.
      motion: { paused: job.motion.paused, reducedMotion: job.motion.reducedMotion },
    });
    await invoke("theme_preview_rendered", { nonce, layout, viewport: { width: window.innerWidth, height: window.innerHeight } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    await invoke("theme_preview_failed", { nonce, message: message.slice(0, 200) }).catch(() => undefined);
  }
}

void run();
