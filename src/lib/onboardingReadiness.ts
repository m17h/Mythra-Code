import type { ClaudeRuntimeStatus } from "./claude";
import type { CodexRuntimeStatus } from "./codex";
import type { CursorRuntimeStatus } from "./cursor";
import type { Account, Provider } from "../types";

export type OnboardingProviderStatus = { ready: boolean; detail: string };

export function onboardingProviderReadiness(input: {
  runtimeStatus: Pick<CodexRuntimeStatus, "available" | "compatible"> | null;
  claudeStatus: Pick<ClaudeRuntimeStatus, "available" | "loggedIn"> | null;
  cursorStatus: Pick<CursorRuntimeStatus, "available" | "loggedIn"> | null;
  account: Pick<Account, "type"> | null;
  openRouterReady: boolean;
  lmStudioReady: boolean;
}): Record<Provider, OnboardingProviderStatus> {
  const codexIssue = !input.runtimeStatus
    ? "Checking Codex runtime…"
    : !input.runtimeStatus.available
      ? "Install Codex CLI"
      : !input.runtimeStatus.compatible
        ? "Update Codex runtime"
        : null;

  return {
    openai: codexIssue
      ? { ready: false, detail: codexIssue }
      : input.account?.type === "chatgpt"
        ? { ready: true, detail: "ChatGPT ready" }
        : { ready: false, detail: "Sign in to ChatGPT" },
    openrouter: codexIssue
      ? { ready: false, detail: codexIssue }
      : input.openRouterReady
        ? { ready: true, detail: "OpenRouter ready" }
        : { ready: false, detail: "Add an OpenRouter API key" },
    lmstudio: codexIssue
      ? { ready: false, detail: codexIssue }
      : input.lmStudioReady
        ? { ready: true, detail: "LM Studio ready" }
        : { ready: false, detail: "Connect your LM Studio server and load a model" },
    claude: !input.claudeStatus
      ? { ready: false, detail: "Checking Claude Code…" }
      : !input.claudeStatus.available
        ? { ready: false, detail: "Install Claude Code" }
        : input.claudeStatus.loggedIn
          ? { ready: true, detail: "Claude ready" }
          : { ready: false, detail: "Sign in to Claude" },
    cursor: !input.cursorStatus
      ? { ready: false, detail: "Checking Cursor Agent…" }
      : !input.cursorStatus.available
        ? { ready: false, detail: "Install Cursor Agent" }
        : input.cursorStatus.loggedIn
          ? { ready: true, detail: "Cursor ready" }
          : { ready: false, detail: "Sign in to Cursor" },
  };
}
