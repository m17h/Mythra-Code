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
import { createThemeToolHandler, noLayoutSource, ThemeToolRefusal, type ThemeToolContext } from "./toolHandlerCore";

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

/** Theme changes that apply and may fall back to a layout-only hidden preview. */
const MUTATING_TOOLS = new Set(["create_custom_theme", "update_custom_theme", "undo_custom_theme", "apply_custom_theme"]);

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
  const isCapture = request.tool === "capture_app_screenshot";
  const previewHost = isCapture || MUTATING_TOOLS.has(request.tool) ? themeHost() : null;
  // A hidden preview needs the requesting turn itself to still be running,
  // whether it is a screenshot or the layout-only fallback of a theme change.
  const turnAuthority = (): NonNullable<ThemeToolContext["previewAuthority"]> => {
    const { threadId } = identity;
    const task = useTaskStore.getState().tasks[threadId];
    const stopEpoch = parentRunStopEpoch(threadId);
    let turnId = task?.activeTurnId;
    return {
      stillAuthorized: () => {
        if (!stillAuthorized() || parentRunStopEpoch(threadId) !== stopEpoch) return false;
        const current = useTaskStore.getState().tasks[threadId];
        if (!current || current.agentRunId !== task?.agentRunId || current.agentRunStartedAt !== task?.agentRunStartedAt
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
  };
  const previewAuthority = previewHost ? turnAuthority() : undefined;
  // The fallback preview needs the same authority as an explicit capture.
  // Keep the original mutation acknowledgement even if that preview is revoked.
  const authority: ThemeToolContext = {
    ...context,
    stillAuthorized,
    ...(previewAuthority ? (isCapture ? previewAuthority : { previewAuthority }) : {}),
  };
  const result = await handleThemeTool({
    sessionId: request.sessionId,
    tool: request.tool,
    arguments: request.arguments,
    ...(request.provider ? { provider: request.provider } : {}),
  }, authority);
  if (authority.stillAuthorized?.() === false) throw new ThemeToolRefusal("The conversation changed while using theme tools. Send a new message from this device to use them again.");
  const layoutFrom = result.layoutFrom as Record<string, unknown> | undefined;
  if (previewHost && (isCapture || layoutFrom?.source === "hidden-preview")) {
    const why = themeHost() !== previewHost || !previewHost.toolsEnabled() || !previewHost.screenshotsEnabled()
      ? "Theme tools or app previews are no longer available."
      : previewAuthority?.stillAuthorized?.() === false ? "The requesting turn ended before the preview could be returned." : null;
    if (why) {
      if (isCapture) throw new ThemeToolRefusal(why);
      delete result.layout;
      result.layoutFrom = { ...noLayoutSource(why), readabilityCheck: layoutFrom?.readabilityCheck };
    }
  }
  return result;
}
