import type { ClaudeRuntimeStatus } from "./claude";
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
    openRouterReady: boolean;
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
  if (provider === "openrouter") {
    return {
      label: "OpenRouter usage",
      summary: options.openRouterReady ? "Pay as you go · tracked spend appears below" : "Add an OpenRouter API key to track spend",
    };
  }
  return { label: "OpenAI subscription", summary: options.openAiRateSummary || "Sign in to view live limits" };
}
