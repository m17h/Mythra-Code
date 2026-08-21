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
