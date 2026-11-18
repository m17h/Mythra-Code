import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import type { AppSettings, Provider } from "../types";

export type OnboardingAppearance = Pick<AppSettings, "theme" | "chatFont" | "effortSlider">;

/** What the tour hands to Settings. Neither field is an edit:
 * `account` only opens that provider's account row, and `appearance` is shown
 * as a labelled preview until the person explicitly applies it. */
export type OnboardingSettingsDraft = {
  account?: Provider;
  appearance?: OnboardingAppearance;
  /** A Settings row id (SETTINGS_ROWS) to bring into view, e.g. from a
   * Tools link. Like `account`, it only opens; it never edits. */
  row?: string;
};

/** Match the default-provider selector in Settings, including its model reset. */
export function settingsWithDefaultProvider(settings: AppSettings, provider: Provider, firstLmStudioModel = ""): AppSettings {
  const sameProvider = provider === settings.provider;
  const model = provider === "openai" ? (sameProvider && settings.model ? settings.model : DEFAULT_OPENAI_MODEL)
    : provider === "claude" ? (sameProvider && settings.model ? settings.model : DEFAULT_CLAUDE_MODEL)
      : provider === "cursor" ? (sameProvider ? settings.model : DEFAULT_CURSOR_MODEL)
        : provider === "lmstudio" ? (sameProvider ? settings.model : firstLmStudioModel)
          : (sameProvider ? settings.model : "");
  return { ...settings, provider, model, defaultModelExplicit: sameProvider ? settings.defaultModelExplicit : false, ultra: false };
}

/** True when the carried look differs from what is saved. */
export function appearanceDiffers(settings: AppSettings, appearance: OnboardingAppearance | undefined): appearance is OnboardingAppearance {
  return Boolean(appearance) && (
    appearance!.theme !== settings.theme
    || appearance!.chatFont !== settings.chatFont
    || appearance!.effortSlider !== settings.effortSlider
  );
}

/** Explicit "Apply this look". */
export function settingsWithAppearance(settings: AppSettings, appearance: OnboardingAppearance): AppSettings {
  return { ...settings, theme: appearance.theme, chatFont: appearance.chatFont, effortSlider: appearance.effortSlider };
}

export type OnboardingHandoff = {
  /** The editable draft Settings starts from: always the saved settings, unchanged. */
  local: AppSettings;
  /** Account row to show. */
  accountProvider: Provider;
  /** Open that row on arrival (only when the tour named one). */
  accountExpanded: boolean;
  /** A look to preview, or null when there is nothing different to show. */
  appearancePreview: OnboardingAppearance | null;
};

/** How Settings opens from the tour. Entering and leaving without an explicit
 * action must persist nothing, so the draft is the saved settings object itself. */
export function onboardingHandoff(settings: AppSettings, draft: OnboardingSettingsDraft | undefined): OnboardingHandoff {
  return {
    local: settings,
    accountProvider: draft?.account ?? settings.provider,
    accountExpanded: Boolean(draft?.account),
    appearancePreview: appearanceDiffers(settings, draft?.appearance) ? { ...draft!.appearance! } : null,
  };
}
