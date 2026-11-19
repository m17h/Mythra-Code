// The webview half of the eight custom-theme bridge tools. The bridge relays
// each call here (useChildAgents.handleRequest); this binds the pure handler
// logic to the real engine (P1), library store and app host (P2).

import { invoke } from "@tauri-apps/api/core";
import { isChildAgentRequestActive, type ChildAgentRequest } from "../agentBridge";
import { THEMES } from "../appConfig";
import { hasProviderStopIntent } from "../providerStopIntent";
import { parentRunStopEpoch, useTaskStore } from "../taskStore";
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
  themeSessionIdentity,
  threadThemeFocus,
  undoCustomTheme,
} from "./store";
import { applyThemePatch, diffThemeSpecs, normalizeThemeInput } from "./validate";
import { parsePreviewResult, type PreviewJob, type PreviewOutcome } from "./previewJob";
import { createThemeToolHandler, ThemeToolRefusal, type ThemeToolContext } from "./toolHandlerCore";

/**
 * Draw a job in the hidden preview window (src-tauri/src/theme_preview.rs).
 * Its picture is a native snapshot of that window only (WKWebView / WebView2,
 * no screen-recording permission); the app window is never captured.
 */
async function renderHiddenPreview(job: PreviewJob, signal: AbortSignal): Promise<PreviewOutcome> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return { ok: false, unavailable: true, error: "previews need the Mythra Code desktop app" };
  }
  const cancelled: PreviewOutcome = { ok: false, error: "the preview was canceled" };
  if (signal.aborted) return cancelled;
  try {
    const requestId = crypto.randomUUID();
    const cancel = () => { void invoke("theme_preview_cancel", { requestId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const answer = await invoke<unknown>("theme_preview_capture", { requestId, request: job });
      if (signal.aborted) return cancelled;
      const result = parsePreviewResult(answer);
      return result ? { ok: true, result } : { ok: false, error: "the preview returned nothing usable" };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
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
  preview: renderHiddenPreview,
});

/**
 * Answer one relayed theme tool call. Resolves to the tool result; throws an
 * Error whose message is the refusal the model should read.
 */
export async function handleThemeToolRequest(request: ChildAgentRequest, context: ThemeToolContext = {}): Promise<Record<string, unknown>> {
  const identity = themeSessionIdentity(request.sessionId);
  if (!identity) throw new ThemeToolRefusal("Theme tools are available only during a turn started on this device.");
  const stillAuthorized = () => themeSessionIdentity(request.sessionId) === identity && context.stillAuthorized?.() !== false;
  let authority: ThemeToolContext = { ...context, stillAuthorized };
  const previewHost = request.tool === "capture_app_screenshot" ? themeHost() : null;
  if (request.tool === "capture_app_screenshot") {
    const { threadId } = identity;
    const task = useTaskStore.getState().tasks[threadId];
    const stopEpoch = parentRunStopEpoch(threadId);
    let turnId = task?.activeTurnId;
    authority = {
      ...authority,
      stillAuthorized: () => {
        if (!stillAuthorized() || parentRunStopEpoch(threadId) !== stopEpoch) return false;
        const current = useTaskStore.getState().tasks[threadId];
        if (!current || current.agentRunId !== task?.agentRunId
          || (current.status !== "running" && current.status !== "starting")) return false;
        turnId ??= current.activeTurnId;
        return !turnId || (current.activeTurnId === turnId && !hasProviderStopIntent(threadId, turnId));
      },
      watchAuthorization: (check) => {
        identity.signal.addEventListener("abort", check, { once: true });
        const unsubscribe = useTaskStore.subscribe(check);
        return () => {
          identity.signal.removeEventListener("abort", check);
          unsubscribe();
        };
      },
      checkAuthorization: () => isChildAgentRequestActive(request).catch(() => false),
    };
  }
  const result = await handleThemeTool({
    sessionId: request.sessionId,
    tool: request.tool,
    arguments: request.arguments,
    ...(request.provider ? { provider: request.provider } : {}),
  }, authority);
  if (authority.stillAuthorized?.() === false) throw new ThemeToolRefusal("The conversation changed while using theme tools. Send a new message from this device to use them again.");
  if (previewHost && (themeHost() !== previewHost || !previewHost.toolsEnabled() || !previewHost.screenshotsEnabled())) {
    throw new ThemeToolRefusal("The user turned off theme tools or app previews.");
  }
  return result;
}
