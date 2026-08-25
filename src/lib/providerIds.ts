import type { Provider } from "../types";

/**
 * Codex reserves `lmstudio` as a built-in provider ID. Mythra Code registers its
 * configurable LM Studio destination under a private ID instead of shadowing
 * the built-in and invalidating the complete runtime configuration.
 */
export const LM_STUDIO_RUNTIME_PROVIDER_ID = "lmstudio_openkiwi";

/** IDs persisted by released Mythra Code builds before repository reunification. */
export const LM_STUDIO_PROVIDER_ALIASES = new Set([
  "lmstudio",
  "lmstudio_openkiwi",
  "openkiwi-lmstudio",
]);

export function isLmStudioProviderId(value: string | null | undefined): boolean {
  return Boolean(value && LM_STUDIO_PROVIDER_ALIASES.has(value.toLowerCase()));
}

/** Provider ID sent to the Codex App Server for custom provider routes. */
export function runtimeModelProviderId(provider: Provider): string | undefined {
  if (provider === "openrouter") return "openrouter";
  if (provider === "lmstudio") return LM_STUDIO_RUNTIME_PROVIDER_ID;
  return undefined;
}
