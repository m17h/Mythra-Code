export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function primaryModifierPressed(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
  platform?: string,
): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function primaryModifierLabel(platform?: string): "⌘" | "Ctrl" {
  return isMacPlatform(platform) ? "⌘" : "Ctrl";
}

export function isWindowsPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^Win/i.test(platform);
}

/**
 * Platform-specific tuning in CSS (for example Windows' heavier text
 * rendering on dark themes, see lumen/tokens.css) keys off this marker. The
 * app and the hidden theme preview both set it the same way.
 */
export function markDocumentPlatform(): "windows" | "mac" | "other" {
  const platform = isWindowsPlatform() ? "windows" : isMacPlatform() ? "mac" : "other";
  document.documentElement.setAttribute("data-platform", platform);
  return platform;
}
