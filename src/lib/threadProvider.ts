import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import { isLmStudioProviderId, runtimeModelProviderId } from "./providerIds";
import type { Provider, Thread } from "../types";

export const codexModelProviderId = runtimeModelProviderId;

export function providerFromThread(thread: Pick<Thread, "modelProvider"> | null | undefined, fallback: Provider): Provider {
  const provider = thread?.modelProvider?.toLowerCase();
  if (isLmStudioProviderId(provider)) return "lmstudio";
  if (provider === "claude" || provider === "cursor" || provider === "openrouter" || provider === "openai") return provider;
  return fallback;
}

export function isClaudeThread(thread: Pick<Thread, "modelProvider"> | null | undefined): boolean {
  return thread?.modelProvider?.toLowerCase() === "claude";
}

export function isCursorThread(thread: Pick<Thread, "modelProvider"> | null | undefined): boolean {
  return thread?.modelProvider?.toLowerCase() === "cursor";
}

export function isLocalSubscriptionThread(thread: Pick<Thread, "modelProvider"> | null | undefined): boolean {
  return isClaudeThread(thread) || isCursorThread(thread);
}

export function modelForProvider(provider: Provider, model: string | null | undefined): string {
  const candidate = model?.trim() ?? "";
  // Claude Code's live catalog includes account-scoped aliases such as
  // `default`, `sonnet`, and `opus[1m]` alongside concrete `claude-*` ids.
  // Reject obvious cross-provider values while preserving every Claude alias
  // the CLI can return instead of silently rewriting it to the default.
  if (provider === "claude") {
    return candidate && !candidate.includes("/") && !candidate.startsWith("gpt-")
      ? candidate
      : DEFAULT_CLAUDE_MODEL;
  }
  if (provider === "cursor") return candidate || DEFAULT_CURSOR_MODEL;
  if (provider === "openrouter") return candidate.includes("/") ? candidate : "";
  if (provider === "lmstudio") return candidate;
  return candidate && !candidate.includes("/") && !candidate.startsWith("claude-") ? candidate : DEFAULT_OPENAI_MODEL;
}
