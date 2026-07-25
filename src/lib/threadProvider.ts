import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import type { Provider, Thread } from "../types";

export function providerFromThread(thread: Pick<Thread, "modelProvider"> | null | undefined, fallback: Provider): Provider {
  const provider = thread?.modelProvider?.toLowerCase();
  if (provider === "claude" || provider === "openrouter" || provider === "openai") return provider;
  return fallback;
}

export function modelForProvider(provider: Provider, model: string | null | undefined): string {
  const candidate = model?.trim() ?? "";
  if (provider === "claude") return candidate.startsWith("claude-") ? candidate : DEFAULT_CLAUDE_MODEL;
  if (provider === "openrouter") return candidate.includes("/") ? candidate : "";
  return candidate && !candidate.includes("/") && !candidate.startsWith("claude-") ? candidate : DEFAULT_OPENAI_MODEL;
}
