import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import type { AppSettings, Provider } from "../types";

export type OnboardingSettingsDraft = {
  provider?: Provider;
  appearance?: Pick<AppSettings, "theme" | "chatFont" | "effortSlider">;
};

/** Match the default-provider cards in Settings, including their model reset. */
export function settingsWithDefaultProvider(settings: AppSettings, provider: Provider, firstLmStudioModel = ""): AppSettings {
  const sameProvider = provider === settings.provider;
  const model = provider === "openai" ? (sameProvider && settings.model ? settings.model : DEFAULT_OPENAI_MODEL)
    : provider === "claude" ? (sameProvider && settings.model ? settings.model : DEFAULT_CLAUDE_MODEL)
      : provider === "cursor" ? (sameProvider ? settings.model : DEFAULT_CURSOR_MODEL)
        : provider === "lmstudio" ? (sameProvider ? settings.model : firstLmStudioModel)
          : (sameProvider ? settings.model : "");
  return { ...settings, provider, model, ultra: false };
}

export function settingsWithOnboardingDraft(settings: AppSettings, draft: OnboardingSettingsDraft | undefined, firstLmStudioModel = ""): AppSettings {
  if (!draft) return settings;
  const providerSettings = draft.provider && draft.provider !== settings.provider
    ? settingsWithDefaultProvider(settings, draft.provider, firstLmStudioModel)
    : settings;
  return { ...providerSettings, ...draft.appearance };
}
