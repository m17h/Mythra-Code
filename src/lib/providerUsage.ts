import type { ClaudeRuntimeStatus } from "./claude";
import type { CursorRuntimeStatus } from "./cursor";
import type { Provider } from "../types";

export interface AccountUsageView {
  label: string;
  summary: string;
}

export function providerAccountUsage(
  provider: Provider,
  options: {
    openAiRateSummary: string;
    claudeStatus: ClaudeRuntimeStatus | null;
    cursorStatus?: CursorRuntimeStatus | null;
    openRouterReady: boolean;
    lmStudioReady?: boolean;
  },
): AccountUsageView {
  if (provider === "claude") {
    if (!options.claudeStatus) return { label: "Claude subscription", summary: "Checking Claude Code…" };
    if (!options.claudeStatus.available) return { label: "Claude subscription", summary: "Install Claude Code to view this account" };
    if (!options.claudeStatus.loggedIn) return { label: "Claude subscription", summary: "Sign in to Claude Code to view this account" };
    const plan = options.claudeStatus.subscriptionType || options.claudeStatus.authMethod || "Claude";
    const planLabel = `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
    return { label: "Claude subscription", summary: `${planLabel} plan connected · live limits are managed by Claude Code` };
  }
  if (provider === "cursor") {
    if (!options.cursorStatus) return { label: "Cursor subscription", summary: "Checking Cursor Agent…" };
    if (!options.cursorStatus.available) return { label: "Cursor subscription", summary: "Install Cursor Agent to view this account" };
    if (!options.cursorStatus.loggedIn) return { label: "Cursor subscription", summary: "Sign in to Cursor Agent to view this account" };
    const plan = options.cursorStatus.subscriptionType || "Cursor";
    return { label: "Cursor subscription", summary: `${plan} connected · live usage and limits are managed by Cursor` };
  }
  if (provider === "openrouter") {
    return {
      label: "OpenRouter usage",
      summary: options.openRouterReady ? "Pay as you go · tracked spend appears below" : "Add an OpenRouter API key to track spend",
    };
  }
  if (provider === "lmstudio") {
    return {
      label: "LM Studio local inference",
      summary: options.lmStudioReady ? "Connected locally · no provider billing" : "Start the LM Studio local server to connect",
    };
  }
  return { label: "OpenAI subscription", summary: options.openAiRateSummary || "Sign in to view live limits" };
}
