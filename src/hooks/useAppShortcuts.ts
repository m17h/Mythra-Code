import { useEffect, useRef } from "react";
import { primaryModifierPressed } from "../lib/platform";
import { formatShortcut } from "../lib/shortcuts";
import { isVoiceInputLocked } from "../lib/voiceInputLock";

export interface AppShortcutContext {
  modalOpen: boolean;
  commandPaletteOpen: boolean;
  threadOpen: boolean;
  running: boolean;
  /** Off unless explicitly enabled, including callers without a saved value. */
  escapeStopsRun?: boolean;
  /** Whether the Tools panel dock is currently open and can be toggled. */
  workspaceOpen: boolean;
  workspaceAvailable: boolean;
  toggleCommandPalette: () => void;
  openConversationSearch: () => void;
  newThread: () => void;
  openSettings: () => void;
  toggleWorkspace: () => void;
  closeWorkspace: () => void;
  stopTurn: () => void;
  /** Optional so older callers keep compiling; each key is ignored when absent. */
  toggleSidebar?: () => void;
  focusComposer?: () => void;
  openModelPicker?: () => void;
  stepThread?: (direction: -1 | 1) => void;
  /** 1-based position in the Tools panel rail. */
  openWorkspaceTab?: (position: number) => void;
  openShortcuts?: () => void;
  /** Moves focus to the active thread's approval card. Never answers it. */
  focusApproval?: () => void;
  /** The escape hatch from an unreadable custom theme. Works inside dialogs too. */
  resetTheme?: () => void;
}

/** ⌘⌥⇧T / Ctrl+Alt+Shift+T. Option changes `event.key` on macOS, so the physical key is read. */
export function isResetThemeChord(event: Pick<KeyboardEvent, "code" | "key" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey">, platform?: string): boolean {
  return primaryModifierPressed(event as KeyboardEvent, platform) && event.altKey && event.shiftKey
    && (event.code === "KeyT" || event.key.toLowerCase() === "t");
}

/** Shown next to the Tools panel control so the shortcut is discoverable. */
export function workspaceShortcutLabel(platform?: string): string {
  return formatShortcut("toggleWorkspace", platform);
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

/** Option changes `event.key` on macOS ("1" becomes "¡"), so digits are read from the physical key. */
function digitFromCode(code: string): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!match) return null;
  // 0 is the tenth tab, as on a keyboard's number row.
  return match[1] === "0" ? 10 : Number(match[1]);
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
    // The theme reset listens in the capture phase, before any menu, dialog or
    // field can take the key, so an unreadable theme can always be escaped.
    const onResetTheme = (event: KeyboardEvent) => {
      if (!isResetThemeChord(event) || !contextRef.current.resetTheme) return;
      event.preventDefault();
      event.stopPropagation();
      contextRef.current.resetTheme();
    };
    document.addEventListener("keydown", onResetTheme, true);
    return () => document.removeEventListener("keydown", onResetTheme, true);
  }, []);

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
      // Stop is the one key that must always work, including from the
      // composer and while a menu or the palette is open.
      if (shortcutModifier && !event.shiftKey && !event.altKey && event.key === "." && current.running) {
        event.preventDefault();
        current.stopTurn();
        return;
      }
      if (shortcutModifier && !event.altKey && key === "k" && (!current.modalOpen || current.commandPaletteOpen)) {
        event.preventDefault();
        current.toggleCommandPalette();
        return;
      }
      if (current.modalOpen) return;
      if (shortcutModifier && event.shiftKey && !event.altKey && event.code === "KeyA" && current.focusApproval) {
        event.preventDefault();
        current.focusApproval();
        return;
      }
      if (shortcutModifier && !event.shiftKey && !event.altKey && (event.key === "/" || event.code === "Slash") && current.openShortcuts) {
        event.preventDefault();
        current.openShortcuts();
        return;
      }
      if (shortcutModifier && key === "f" && !event.shiftKey && current.threadOpen) {
        event.preventDefault();
        current.openConversationSearch();
        return;
      }
      if (shortcutModifier && key === "n" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        current.newThread();
        return;
      }
      if (shortcutModifier && event.key === ",") {
        event.preventDefault();
        current.openSettings();
        return;
      }
      if (shortcutModifier && (event.key === "\\" || event.code === "Backslash") && !event.shiftKey && current.toggleSidebar) {
        event.preventDefault();
        current.toggleSidebar();
        return;
      }
      // ⌘B, plus ⌥⌘B for people with VS Code's right-pane habit.
      if (shortcutModifier && (key === "b" || event.code === "KeyB") && !event.shiftKey && current.workspaceAvailable) {
        event.preventDefault();
        current.toggleWorkspace();
        return;
      }
      if (shortcutModifier && (key === "l" || event.code === "KeyL") && !event.shiftKey && !event.altKey && current.focusComposer) {
        event.preventDefault();
        current.focusComposer();
        return;
      }
      if (shortcutModifier && event.shiftKey && !event.altKey && event.code === "KeyM" && current.openModelPicker) {
        event.preventDefault();
        current.openModelPicker();
        return;
      }
      if (shortcutModifier && event.shiftKey && !event.altKey && (event.code === "BracketLeft" || event.code === "BracketRight") && current.stepThread) {
        event.preventDefault();
        current.stepThread(event.code === "BracketLeft" ? -1 : 1);
        return;
      }
      if (shortcutModifier && event.altKey && !event.shiftKey && current.openWorkspaceTab && current.workspaceAvailable) {
        const digit = digitFromCode(event.code);
        if (digit !== null) {
          event.preventDefault();
          current.openWorkspaceTab(digit);
          return;
        }
      }
      if (event.key === "Escape" && !isEditableShortcutTarget(event.target)) {
        // When enabled, stopping takes priority over dismissing the Tools panel dock.
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
