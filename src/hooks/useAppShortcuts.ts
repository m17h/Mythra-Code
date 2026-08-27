import { useEffect, useRef } from "react";
import { primaryModifierLabel, primaryModifierPressed } from "../lib/platform";

export interface AppShortcutContext {
  modalOpen: boolean;
  commandPaletteOpen: boolean;
  threadOpen: boolean;
  running: boolean;
  /** Whether the Workspace dock is currently open and can be toggled. */
  workspaceOpen: boolean;
  workspaceAvailable: boolean;
  toggleCommandPalette: () => void;
  openConversationSearch: () => void;
  newThread: () => void;
  openSettings: () => void;
  toggleWorkspace: () => void;
  closeWorkspace: () => void;
  stopTurn: () => void;
}

/** Shown next to the Workspace control so the shortcut is discoverable. */
export function workspaceShortcutLabel(platform?: string): string {
  return `${primaryModifierLabel(platform)}+B`;
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
      if (shortcutModifier && key === "b" && current.workspaceAvailable) {
        event.preventDefault();
        current.toggleWorkspace();
        return;
      }
      if (event.key === "Escape" && !isEditableShortcutTarget(event.target)) {
        // Stopping a run stays the first meaning of Escape — it is the only
        // way to interrupt from the keyboard. With nothing running, Escape
        // dismisses the Workspace dock like any other transient surface.
        if (current.running) {
          event.preventDefault();
          current.stopTurn();
          return;
        }
        if (current.workspaceOpen) {
          event.preventDefault();
          current.closeWorkspace();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
