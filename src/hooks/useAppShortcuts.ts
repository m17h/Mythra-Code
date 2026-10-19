import { useEffect, useRef } from "react";
import { primaryModifierLabel, primaryModifierPressed } from "../lib/platform";
import { isVoiceInputLocked } from "../lib/voiceInputLock";

export interface AppShortcutContext {
  modalOpen: boolean;
  commandPaletteOpen: boolean;
  threadOpen: boolean;
  running: boolean;
  /** Off unless explicitly enabled, including callers without a saved value. */
  escapeStopsRun?: boolean;
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
      // Read synchronously: voice owns interaction before React can render its
      // modal, including the command-palette exception below. Native window
      // close/Quit shortcuts are left to the OS and the close guard.
      if (isVoiceInputLocked()) return;
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
        // When enabled, stopping takes priority over dismissing the Workspace.
        // Disabling this shortcut leaves Escape available to transient surfaces.
        if (current.running && current.escapeStopsRun === true) {
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
