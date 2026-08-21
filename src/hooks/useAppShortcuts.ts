import { useEffect, useRef } from "react";
import { primaryModifierPressed } from "../lib/platform";

export interface AppShortcutContext {
  modalOpen: boolean;
  commandPaletteOpen: boolean;
  threadOpen: boolean;
  running: boolean;
  toggleCommandPalette: () => void;
  openConversationSearch: () => void;
  newThread: () => void;
  openSettings: () => void;
  stopTurn: () => void;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(
    element
    && (element.tagName === "INPUT"
      || element.tagName === "TEXTAREA"
      || element.tagName === "SELECT"
      || element.isContentEditable),
  );
}

/**
 * The single app-level keyboard layer. Components may own local menu/dialog
 * keys in capture phase; once one of those handlers prevents a key, this
 * layer leaves it alone. Fresh context is read through a ref so the document
 * listener is installed exactly once and never drops a key during rerenders.
 */
export function useAppShortcuts(context: AppShortcutContext): void {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const current = contextRef.current;
      const shortcutModifier = primaryModifierPressed(event);
      const key = event.key.toLowerCase();
      if (shortcutModifier && key === "k" && (!current.modalOpen || current.commandPaletteOpen)) {
        event.preventDefault();
        current.toggleCommandPalette();
        return;
      }
      if (current.modalOpen) return;
      if (shortcutModifier && key === "f" && current.threadOpen) {
        event.preventDefault();
        current.openConversationSearch();
        return;
      }
      if (shortcutModifier && key === "n") {
        event.preventDefault();
        current.newThread();
        return;
      }
      if (shortcutModifier && event.key === ",") {
        event.preventDefault();
        current.openSettings();
        return;
      }
      if (
        event.key === "Escape"
        && current.running
        && !isEditableShortcutTarget(event.target)
      ) {
        event.preventDefault();
        current.stopTurn();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
