import { useEffect, useRef, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, containedTabTarget, isReachableFocusable } from "../lib/focusReach";

/**
 * Only controls a person can actually reach count as the trap's ends. Hidden
 * panes, inert reveals, collapsed <details> bodies, disabled fieldsets and
 * visibility:hidden popovers stay mounted inside dialogs; counting them let
 * Tab escape from the real last control (or land on nothing).
 */
export function reachableFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) =>
    isReachableFocusable(element, root),
  );
}

/**
 * Keeps Tab / Shift+Tab cycling inside `root`. Call it from a keydown handler
 * (element- or document-level). Returns true when it moved focus itself.
 *
 * Focus resting on the root, on a static element inside it (a dialog's title
 * focused on open), or anywhere outside it is moved to the next stop in the
 * direction of travel, wrapping at either end, so the first Shift+Tab from a
 * focused heading reaches the dialog's last control instead of the page.
 */
export function containTab(
  root: HTMLElement,
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "defaultPrevented">,
): boolean {
  if (event.key !== "Tab" || event.defaultPrevented) return false;
  const focusable = reachableFocusables(root);
  if (!focusable.length) {
    event.preventDefault();
    if (root.tabIndex >= 0 || root.hasAttribute("tabindex")) root.focus();
    return true;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  const activeIndex = inside ? focusable.indexOf(active as HTMLElement) : -1;
  const before = inside && activeIndex < 0
    // Stops that come before the focused element in document order.
    ? focusable.filter((element) => Boolean(element.compareDocumentPosition(active as Node) & Node.DOCUMENT_POSITION_FOLLOWING)).length
    : 0;
  const target = containedTabTarget({ count: focusable.length, activeIndex, before, inside, shift: event.shiftKey });
  if (target === null) return false;
  event.preventDefault();
  focusable[target].focus();
  return true;
}

/* ---- The overlay layer ----------------------------------------------------
   Every modal surface (dialogs, sheets, the palette, approvals, the sidebar
   peek) shares one contract: the app it covers is inert, Tab stays inside,
   keys that land on the page body still reach the top-most surface, and focus
   returns to the opener. `inert` is reference-counted so stacked surfaces
   (a confirmation over Settings, an approval over the palette) never undo
   each other, and attributes React also manages are left in React's hands. */

type InertHold = { count: number; /** Someone else (React, a closed backdrop) also wants it inert. */ external: boolean };
const holds = new Map<HTMLElement, InertHold>();
const selfWrites = new WeakMap<Element, number>();
let watcher: MutationObserver | null = null;

function writeInert(element: HTMLElement, on: boolean): void {
  if (element.hasAttribute("inert") === on) return;
  selfWrites.set(element, (selfWrites.get(element) ?? 0) + 1);
  if (on) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function processInertRecords(records: MutationRecord[]): void {
  for (const record of records) {
    const element = record.target as HTMLElement;
    const pending = selfWrites.get(element) ?? 0;
    if (pending > 0) {
      selfWrites.set(element, pending - 1);
      continue;
    }
    const hold = holds.get(element);
    if (!hold) continue;
    if (element.hasAttribute("inert")) {
      // Another owner (usually React) set it too: leave it to them on release.
      hold.external = true;
    } else {
      // Another owner let go while a surface still covers this: keep it inert.
      hold.external = false;
      writeInert(element, true);
    }
  }
}

function ensureWatcher(): void {
  if (watcher || typeof MutationObserver !== "function") return;
  watcher = new MutationObserver(processInertRecords);
  watcher.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
}

/**
 * Marks everything outside `keep` inert (siblings of it and of each ancestor up
 * to <body>) and returns a function that releases only this surface's share.
 */
export function holdInertOutside(keep: HTMLElement): () => void {
  if (typeof document === "undefined") return () => undefined;
  ensureWatcher();
  if (watcher) processInertRecords(watcher.takeRecords());
  const held: HTMLElement[] = [];
  let node: HTMLElement | null = keep;
  while (node && node !== document.body && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      // App notifications (the toast) float above every surface and keep their
      // actions, such as Undo, usable while a dialog is open.
      if (sibling.hasAttribute("data-overlay-exempt")) continue;
      const hold = holds.get(sibling);
      if (hold) hold.count += 1;
      else {
        holds.set(sibling, { count: 1, external: sibling.hasAttribute("inert") });
        writeInert(sibling, true);
      }
      held.push(sibling);
    }
    node = node.parentElement;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (watcher) processInertRecords(watcher.takeRecords());
    for (const element of held) {
      const hold = holds.get(element);
      if (!hold) continue;
      hold.count -= 1;
      if (hold.count > 0) continue;
      holds.delete(element);
      if (!hold.external) writeInert(element, false);
    }
    if (!holds.size && watcher) {
      processInertRecords(watcher.takeRecords());
      watcher.disconnect();
      watcher = null;
    }
  };
}

/** Open modal surfaces, bottom first. Only the last one answers page-level keys. */
const layers: HTMLElement[] = [];

/** True when `surface` is the top-most open modal surface. */
export function isTopModalLayer(surface: HTMLElement): boolean {
  return layers[layers.length - 1] === surface;
}

/** Registers a modal surface; returns its removal. Used by surfaces that don't use the hook (approvals, the peek). */
export function pushModalLayer(surface: HTMLElement): () => void {
  layers.push(surface);
  return () => {
    const index = layers.lastIndexOf(surface);
    if (index >= 0) layers.splice(index, 1);
  };
}

function targetsPage(target: EventTarget | null): boolean {
  return target === null || target === document.body || target === document.documentElement || target === document;
}

export type ModalFocusOptions = {
  /** Element to focus on open. Defaults to `[data-autofocus]`, then the first reachable control. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Element to return focus to on close. Defaults to whatever was focused when the dialog opened. */
  returnFocus?: () => HTMLElement | null | undefined;
  /**
   * Make everything outside the dialog inert while it is open. Defaults to
   * true for `aria-modal="true"` dialogs and false for non-modal ones.
   */
  inertOutside?: boolean;
  /** Escape closes the dialog (for dialogs without their own Escape handler). */
  onEscape?: () => void;
};

/**
 * Focus containment for dialogs and modal drawers.
 *
 * On open: makes the covered app inert (modal dialogs), registers the dialog
 * as the top-most layer and moves focus to `initialFocus()`, the dialog's
 * `[data-autofocus]` element, or its first reachable control. While open:
 * keeps Tab cycling inside the dialog (hidden, disabled, inert and collapsed
 * controls are skipped; a focused heading counts as a position, not an exit).
 * Keys whose target is the page itself (after a click on blank space) still
 * reach the top-most dialog. On close: releases its share of `inert` and
 * restores focus to `returnFocus()` or the element focused before opening.
 */
export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
  options?: ModalFocusOptions,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const opener = document.activeElement;
    restoreRef.current =
      opener instanceof HTMLElement && opener !== document.body && !dialog.contains(opener) ? opener : null;
    const modal = optionsRef.current?.inertOutside ?? dialog.getAttribute("aria-modal") === "true";
    const releaseInert = modal ? holdInertOutside(dialog) : () => undefined;
    const removeLayer = modal ? pushModalLayer(dialog) : () => undefined;
    if (!dialog.contains(document.activeElement)) {
      const initial =
        optionsRef.current?.initialFocus?.() ??
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        reachableFocusables(dialog)[0];
      initial?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") containTab(dialog, event);
      else if (event.key === "Escape" && optionsRef.current?.onEscape && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        optionsRef.current.onEscape();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    // A click on blank space leaves focus on <body>. Tab and Escape from
    // there belong to the top-most dialog, not to the inert app behind it.
    const onPageKeyDown = (event: KeyboardEvent) => {
      if (!modal || !isTopModalLayer(dialog) || event.defaultPrevented || !targetsPage(event.target)) return;
      if (event.key === "Tab") {
        containTab(dialog, event);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Replay it on the dialog so its own handler decides (clear a filter,
        // step back, or close), exactly as if focus had been inside.
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      }
    };
    document.addEventListener("keydown", onPageKeyDown, true);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onPageKeyDown, true);
      removeLayer();
      // Release before restoring: an inert opener can't take focus.
      releaseInert();
      const requested = optionsRef.current?.returnFocus?.() ?? restoreRef.current;
      restoreRef.current = null;
      // Restore only if focus is still inside the (now closing) dialog or was
      // lost to the body — never steal focus the user moved elsewhere.
      const active = document.activeElement;
      const lost = active === null || active === document.body || dialog.contains(active) || !document.contains(active);
      if (!lost) return;
      const usable = (element: HTMLElement | null | undefined): element is HTMLElement =>
        Boolean(element && document.contains(element) && !element.closest("[inert]"));
      if (usable(requested)) {
        requested.focus({ preventScroll: true });
        return;
      }
      // A dialog opened at launch (or whose opener has gone, like a menu item)
      // hands focus to the draft rather than leaving it on <body>. Wait a
      // frame: the surface that covered the draft may still be closing.
      requestAnimationFrame(() => {
        const current = document.activeElement;
        // Someone else already placed focus (and not inside this closed, still-mounted dialog).
        if (current instanceof HTMLElement && current !== document.body && !dialog.contains(current) && usable(current)) return;
        const draft = document.querySelector<HTMLElement>(".composer textarea:not([disabled])");
        if (usable(draft)) draft.focus({ preventScroll: true });
      });
    };
  }, [dialogRef, open]);
}
