// Entry of the hidden theme preview window (theme-preview.html), opened by
// src-tauri/src/theme_preview.rs for one request and destroyed after it.
//
// It takes its job once, draws the job's scene (previewScenes.ts) from the
// app's real views with sample content and the job's exact theme revision,
// measures the layout, optionally draws one control in a mirrored hover,
// focus or press state (interactionStates.ts), and reports once, so the
// native side may photograph this window. It reads no saved state
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
import { PREVIEW_SCENES, SIDEBAR_CONTROLS } from "../lib/customThemes/previewScenes";
import { CUSTOM_CSS_STYLE_ID, CUSTOM_THEME_STYLE_ID } from "../lib/customThemes/probe";
import { customCssScope } from "../lib/customThemes/sanitizeCss";
import { isBuiltInTheme, SPEC_KEYS } from "../lib/customThemes/spec";
import { normalizeThemeInput } from "../lib/customThemes/validate";

/** CSS animations and canvas effects are both stilled at this moment: entrances have finished and staggered loops keep their offsets. */
const STILL_AT_MS = 2_400;
/** Earlier in the logo's own idle sequence, while the blinking caret is lit. */
const LOGO_IDLE_AT_MS = 1_850;
const RESOURCE_TIMEOUT_MS = 4_000;

async function beforeTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), RESOURCE_TIMEOUT_MS);
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

/** Finish transitions and freeze CSS animation phases. */
function freezeCss(): void {
  if (typeof document.getAnimations === "function") {
    for (const animation of document.getAnimations()) {
      try {
        const transitionEnd = "transitionProperty" in animation && animation.effect?.getComputedTiming().endTime;
        const logoIdle = typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation
          && animation.animationName.startsWith("mythra-logo-");
        animation.pause();
        animation.currentTime = typeof transitionEnd === "number" && Number.isFinite(transitionEnd) ? transitionEnd
          : logoIdle ? LOGO_IDLE_AT_MS : STILL_AT_MS;
      } catch { /* finished or detached */ }
    }
  }
}

/** Files read asynchronously and xterm writes after the lazy panel mounts. */
async function waitForScene(read: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + RESOURCE_TIMEOUT_MS;
  while (!read()) {
    if (performance.now() >= deadline) throw new Error(`the sample ${label} did not finish drawing`);
    await nextLayoutFrame();
  }
}

async function run(): Promise<void> {
  let payload: unknown;
  try {
    payload = await invoke<unknown>("theme_preview_job");
  } catch {
    return; // Not a preview session (or it already ended): nothing to draw. The native side times out.
  }
  const handoff = parsePreviewHandoff(payload);
  if (!handoff) {
    if (payload && typeof payload === "object" && "nonce" in payload && typeof payload.nonce === "string" && payload.nonce) {
      await invoke("theme_preview_failed", { nonce: payload.nonce, message: "the preview job could not be read" }).catch(() => undefined);
    }
    return;
  }
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
    const scene = PREVIEW_SCENES[job.view];
    const [{ PreviewSurface }, { preparePreviewGrain }, { seedComposerDraft }, { SAMPLE_DRAFT, SAMPLE_TERMINAL_RESULT }, { applyInteraction, measureLandmarks, mirrorInteractionRules }, overlay] = await Promise.all([
      import("./PreviewSurface"), import("../components/ThemeEffectsLayer"), import("../components/Composer"), import("./fixtures"),
      import("./interactionStates"),
      // Settings is a large bundle: only its own scene loads it, before the first render.
      scene.overlay === "settings-appearance" ? import("./SettingsScene") : Promise.resolve(null),
    ]);
    const composerKey = `theme-preview-${job.view}`;
    const interaction = job.interaction ?? null;
    // Send is disabled on an empty composer, so a Send state is shown with sample text typed.
    if (interaction?.control === "send") seedComposerDraft(composerKey, SAMPLE_DRAFT);
    const showSidebar = Boolean(interaction && SIDEBAR_CONTROLS.includes(interaction.control));
    const grainUrl = await beforeTimeout(preparePreviewGrain(spec), "the grain texture did not finish loading");
    const container = document.getElementById("root");
    if (!container) throw new Error("the preview page is incomplete");
    const failure: { error?: unknown } = {};
    const root = createRoot(container, {
      onUncaughtError: (error) => { failure.error = error; },
      onCaughtError: (error) => { failure.error = error; },
    });
    flushSync(() => root.render(<PreviewSurface job={job} spec={spec} snapshot={{ time: STILL_AT_MS, grainUrl }} Overlay={overlay?.SettingsScene} composerKey={composerKey} showSidebar={showSidebar} />));
    const shell = container.querySelector<HTMLElement>(".app-shell");
    if (shell?.dataset.theme !== job.theme.base) throw new Error("the app did not draw the requested theme");
    await settle(shell);
    if (scene.tools === "files") {
      await waitForScene(() => Boolean(shell.querySelector(".file-results [data-file-row]")), "file list");
    }
    if (scene.tools === "terminal") {
      await waitForScene(() => Boolean(shell.querySelector(".terminal-screen .xterm-rows")?.textContent?.includes(SAMPLE_TERMINAL_RESULT)), "terminal output");
    }
    if ((scene.stage === "new-thread" || scene.stage === "new-chat") && !shell.querySelector(".thread-empty-state .mythra-logo__svg")) {
      throw new Error("the landing logo did not draw");
    }
    freezeCss();
    await nextLayoutFrame();
    if (failure.error !== undefined) throw failure.error instanceof Error ? failure.error : new Error("part of the app failed to draw with this theme");
    if (!shell.isConnected) throw new Error("the app did not finish drawing");
    if (custom && theme && (shell.dataset.customTheme !== custom.id
      || !styleIsApplied(CUSTOM_THEME_STYLE_ID, theme.styles.tokenCss, custom)
      || !styleIsApplied(CUSTOM_CSS_STYLE_ID, theme.styles.customCss, custom))) {
      throw new Error(`r${custom.revision}'s styles did not reach the page`);
    }
    // Measured at rest, before any interaction state is mirrored in.
    const layout = inspectLayout(shell, {
      spec,
      fixture: true,
      ...(custom ? { scopes: [customCssScope(custom.id, true), customCssScope(custom.id)], queryScope: customCssScope(custom.id) } : {}),
      // What the person sees: their own pause and reduced-motion choices.
      motion: { paused: job.motion.paused, reducedMotion: job.motion.reducedMotion },
    });
    let state: ReturnType<typeof applyInteraction> | null = null;
    if (interaction) {
      if (interaction.state !== "rest") mirrorInteractionRules();
      state = applyInteraction(shell, interaction.control, interaction.state, freezeCss, Boolean(scene.overlay));
      await nextLayoutFrame();
      freezeCss();
      if (failure.error !== undefined) throw failure.error instanceof Error ? failure.error : new Error("part of the app failed to draw in this state");
    }
    // Facts about what was drawn travel with the layout report (one bounded object).
    const landmarks = measureLandmarks(shell);
    const report = {
      ...(layout ?? {}),
      preview: {
        scene: job.view,
        ...(landmarks.length ? { landmarks } : {}),
        ...(shell.querySelector(".sidebar.peek") ? { sidebar: "The sidebar is open over the conversation to show the requested control." }
          : showSidebar && job.panes.sidebarOpen === false ? { sidebar: "The sidebar is open to show the requested control." } : {}),
        ...(state ? { interaction: state } : {}),
        ...(interaction?.control === "send" ? { fixture: "Sample text is typed in the composer so Send is enabled." } : {}),
      },
    };
    await invoke("theme_preview_rendered", { nonce, layout: report, viewport: { width: window.innerWidth, height: window.innerHeight } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    await invoke("theme_preview_failed", { nonce, message: message.slice(0, 200) }).catch(() => undefined);
  }
}

void run();
