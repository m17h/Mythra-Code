import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL, LM_STUDIO_CODEX_PROVIDER_ID } from "./appConfig";
import type { Provider, Thread } from "../types";

/**
 * The provider id the generated Codex config uses, or undefined for threads
 * that run on Codex's own default provider. Only LM Studio is renamed: Codex
 * treats `lmstudio` as a reserved built-in, so OpenKiwi registers its own
 * destination under {@link LM_STUDIO_CODEX_PROVIDER_ID}.
 */
export function codexModelProviderId(provider: Provider): string | undefined {
  if (provider === "lmstudio") return LM_STUDIO_CODEX_PROVIDER_ID;
  if (provider === "openrouter") return "openrouter";
  return undefined;
}

export function providerFromThread(thread: Pick<Thread, "modelProvider"> | null | undefined, fallback: Provider): Provider {
  const provider = thread?.modelProvider?.toLowerCase();
  // Threads started by the runtime report the Codex-side id; threads persisted
  // before the rename still carry the bare `lmstudio`. Both are LM Studio.
  if (provider === LM_STUDIO_CODEX_PROVIDER_ID) return "lmstudio";
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
  if (provider === "lmstudio") return candidate;
  return candidate && !candidate.includes("/") && !candidate.startsWith("claude-") ? candidate : DEFAULT_OPENAI_MODEL;
}
