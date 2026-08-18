import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_LM_STUDIO_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import type { Provider, Thread } from "../types";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";

export function providerFromThread(thread: Pick<Thread, "modelProvider"> | null | undefined, fallback: Provider): Provider {
  const provider = thread?.modelProvider?.toLowerCase();
  if (provider === LM_STUDIO_RUNTIME_PROVIDER_ID) return "lmstudio";
  if (provider === "claude" || provider === "cursor" || provider === "openrouter" || provider === "lmstudio" || provider === "openai") return provider;
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
  if (provider === "claude") return candidate.startsWith("claude-") ? candidate : DEFAULT_CLAUDE_MODEL;
  if (provider === "cursor") return candidate || DEFAULT_CURSOR_MODEL;
  if (provider === "openrouter") return candidate.includes("/") ? candidate : "";
  if (provider === "lmstudio") return candidate || DEFAULT_LM_STUDIO_MODEL;
  return candidate && !candidate.includes("/") && !candidate.startsWith("claude-") ? candidate : DEFAULT_OPENAI_MODEL;
}
