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

/**
 * The model a new-thread draft starts with when the user switches to a
 * provider. OpenAI returns "" ("not chosen yet"), so the draft follows the
 * newest Sol in the account's live catalog (see latestSolModel) instead of a
 * fixed id. Every other provider keeps its usual default.
 */
export function draftModelForProvider(provider: Provider): string {
  return provider === "openai" ? "" : modelForProvider(provider, "");
}

/**
 * Morgan (2026-11-01): new OpenAI threads default to the latest Sol, not a
 * pinned "gpt-5.6-sol". Picks the plain `gpt-<version>-sol` id with the
 * highest version number in the live catalog (so gpt-5.10-sol beats
 * gpt-5.9-sol). Suffixed variants such as previews are skipped. Falls back
 * to the built-in default while the catalog is empty or has no Sol.
 */
export function latestSolModel(runtimeModels: ReadonlyArray<{ id?: string; model?: string }>): string {
  let best: { id: string; version: number[] } | null = null;
  for (const entry of runtimeModels) {
    const id = (entry.model || entry.id || "").trim();
    const match = /^gpt-(\d+(?:\.\d+)*)-sol$/.exec(id);
    if (!match) continue;
    const version = match[1].split(".").map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { id, version };
  }
  return best?.id ?? DEFAULT_OPENAI_MODEL;
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
