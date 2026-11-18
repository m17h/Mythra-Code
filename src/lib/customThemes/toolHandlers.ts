// The webview half of the seven custom-theme bridge tools. The bridge relays
// each call here (useChildAgents.handleRequest); this binds the pure handler
// logic to the real engine (P1), library store and app host (P2).

import type { ChildAgentRequest } from "../agentBridge";
import { THEMES } from "../appConfig";
import { buildDesignKit } from "./designKit";
import { probeReadability } from "./probe";
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
import { createThemeToolHandler, type ThemeToolContext } from "./toolHandlerCore";

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
