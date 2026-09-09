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
  // Model ids belong to the provider catalog, not to Mythra Code. Preserve
  // every non-flag value Claude Code advertises, including aliases, decorated
  // ids, and any future name that does not follow today's vendor prefixes.
  if (provider === "claude") {
    return candidate && !candidate.startsWith("-") ? candidate : DEFAULT_CLAUDE_MODEL;
  }
  if (provider === "cursor") return candidate || DEFAULT_CURSOR_MODEL;
  if (provider === "openrouter") return candidate.includes("/") ? candidate : "";
  if (provider === "lmstudio") return candidate;
  // Namespaced ids select a routed/local provider in the shared app-server;
  // all other ids are owned by the signed-in OpenAI catalog regardless of
  // how they happen to be named.
  return candidate && !candidate.includes("/") ? candidate : DEFAULT_OPENAI_MODEL;
}
