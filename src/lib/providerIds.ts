import type { Provider } from "../types";

/**
 * Codex reserves `lmstudio` as a built-in provider ID. OpenKiwi needs its own
 * provider entry so it can honor the server URL and optional credential saved
 * in Settings without attempting to override that built-in definition.
 */
export const LM_STUDIO_RUNTIME_PROVIDER_ID = "openkiwi-lmstudio";

/** Provider ID sent to the Codex App Server for custom provider routes. */
export function runtimeModelProviderId(provider: Provider): string | undefined {
  if (provider === "openrouter") return "openrouter";
  if (provider === "lmstudio") return LM_STUDIO_RUNTIME_PROVIDER_ID;
  return undefined;
}
