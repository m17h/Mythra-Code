// The webview half of the eight custom-theme bridge tools. The bridge relays
// each call here (useChildAgents.handleRequest); this binds the pure handler
// logic to the real engine (P1), library store and app host (P2).

import type { ChildAgentRequest } from "../agentBridge";
import { THEMES } from "../appConfig";
import { buildDesignKit } from "./designKit";
import { inspectLayout } from "./inspect";
import { probeReadability } from "./probe";
import { customCssScope } from "./sanitizeCss";
import {
  commitCustomThemeRevision,
  createCustomTheme,
  getCustomThemeLibrary,
  sessionThread,
  setThreadThemeFocus,
  themeHost,
  threadThemeFocus,
  undoCustomTheme,
} from "./store";
import { applyThemePatch, diffThemeSpecs, normalizeThemeInput } from "./validate";
import { createThemeToolHandler, type CaptureOutcome, type ThemeToolContext } from "./toolHandlerCore";

/** Native picture of this window (WKWebView / WebView2 snapshot, no screen-recording permission). */
async function captureAppWindow(): Promise<CaptureOutcome> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return { ok: false, unavailable: true, error: "screenshots need the Mythra Code desktop app" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const shot = await invoke<{ data: string; mimeType: string; width: number; height: number }>("capture_app_window");
    if (!shot || typeof shot.data !== "string" || shot.mimeType !== "image/png") return { ok: false, error: "the window returned no picture" };
    return { ok: true, data: shot.data, mimeType: "image/png", width: shot.width, height: shot.height };
  } catch (reason) {
    const message = String(reason instanceof Error ? reason.message : reason).slice(0, 200);
    return { ok: false, error: message, ...(/not available/i.test(message) ? { unavailable: true } : {}) };
  }
}

export { THEME_TOOLS, isThemeTool, ThemeToolRefusal, type ThemeTool, type ThemeToolContext } from "./toolHandlerCore";

const handleThemeTool = createThemeToolHandler({
  normalize: (input) => normalizeThemeInput(input, { mode: "create" }),
  applyPatch: (current, patch) => applyThemePatch(current, patch),
  diff: diffThemeSpecs,
  designKit: buildDesignKit,
  probe: probeReadability,
  library: getCustomThemeLibrary,
  create: createCustomTheme,
  commit: commitCustomThemeRevision,
  undo: undoCustomTheme,
  setFocus: setThreadThemeFocus,
  focus: threadThemeFocus,
  sessionThread,
  host: themeHost,
  builtInThemes: THEMES,
  inspect: (shell, theme, motion) => inspectLayout(shell, {
    spec: theme?.spec ?? null,
    ...(theme ? { scopes: [customCssScope(theme.id, true), customCssScope(theme.id)], queryScope: customCssScope(theme.id) } : {}),
    motion,
  }) as Record<string, unknown> | null,
  capture: captureAppWindow,
});

/**
 * Answer one relayed theme tool call. Resolves to the tool result; throws an
 * Error whose message is the refusal the model should read.
 */
export function handleThemeToolRequest(request: ChildAgentRequest, context: ThemeToolContext = {}): Promise<Record<string, unknown>> {
  return handleThemeTool({
    sessionId: request.sessionId,
    tool: request.tool,
    arguments: request.arguments,
    ...(request.provider ? { provider: request.provider } : {}),
  }, context);
}
