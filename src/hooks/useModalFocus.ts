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

/* The top dialog owns the inert boundary. A lower dialog may already have
   covered a mounted sibling, so holding both boundaries would block that
   sibling's controls as soon as it opens. */

const layers: { surface: HTMLElement; focusInitial: () => void }[] = [];
const holds = new Map<HTMLElement, boolean>();
const selfWrites = new WeakMap<Element, number>();
let watcher: MutationObserver | null = null;

function writeInert(element: HTMLElement, on: boolean): void {
  if (element.hasAttribute("inert") === on) return;
  if (watcher && document.body.contains(element)) selfWrites.set(element, (selfWrites.get(element) ?? 0) + 1);
  if (on) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function processInertRecords(records: MutationRecord[]): void {
  const changed = new Set<HTMLElement>();
  for (const record of records) {
    const element = record.target as HTMLElement;
    const pending = selfWrites.get(element) ?? 0;
    if (pending > 0) {
      selfWrites.set(element, pending - 1);
      continue;
    }
    if (holds.has(element)) changed.add(element);
  }
  for (const element of changed) {
    // Keep changes from React (e.g. an inactive backdrop becoming active)
    // even while this boundary holds the same element inert.
    holds.set(element, element.hasAttribute("inert"));
    writeInert(element, true);
  }
}

function syncModalBoundary(): void {
  const top = layers.at(-1)?.surface;
  if (top && !watcher && typeof MutationObserver === "function") {
    watcher = new MutationObserver(processInertRecords);
    watcher.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  }
  if (watcher) processInertRecords(watcher.takeRecords());

  const outside = new Set<HTMLElement>();
  for (let node = top; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      // Notifications keep actions such as Undo usable over dialogs.
      if (!sibling.hasAttribute("data-overlay-exempt")) outside.add(sibling);
    }
  }
  for (const [element, externallyInert] of holds) {
    if (outside.has(element)) continue;
    holds.delete(element);
    if (!externallyInert) writeInert(element, false);
  }
  for (const element of outside) {
    if (holds.has(element)) continue;
    holds.set(element, element.hasAttribute("inert"));
    writeInert(element, true);
  }

  if (!top && watcher) {
    processInertRecords(watcher.takeRecords());
    watcher.disconnect();
    watcher = null;
  }
}

export function hasModalLayer(): boolean {
  return layers.length > 0;
}

export function isTopModalLayer(surface: HTMLElement): boolean {
  return layers.at(-1)?.surface === surface;
}

function pushModalLayer(surface: HTMLElement, focusInitial: () => void): () => void {
  const layer = { surface, focusInitial };
  layers.push(layer);
  syncModalBoundary();
  return () => {
    const index = layers.lastIndexOf(layer);
    if (index < 0) return;
    layers.splice(index, 1);
    syncModalBoundary();
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
 * reach the top-most dialog. On close: restores the previous modal boundary and
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
    const focusInitial = () => {
      const initial =
        optionsRef.current?.initialFocus?.() ??
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        reachableFocusables(dialog)[0] ??
        dialog;
      initial.focus({ preventScroll: true });
    };
    const removeLayer = modal ? pushModalLayer(dialog, focusInitial) : () => undefined;
    if (!dialog.contains(document.activeElement)) focusInitial();

    const onKeyDown = (event: KeyboardEvent) => {
      if (modal && !isTopModalLayer(dialog)) return;
      if (event.key === "Tab") containTab(dialog, event);
      else if (event.key === "Escape" && optionsRef.current?.onEscape && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        optionsRef.current.onEscape();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    // A click on blank space leaves focus on <body>. Tab and Escape from
    // there belong to the top-most dialog, not to the inert app behind it.
    const onPageKeyDown = (event: KeyboardEvent) => {
      if (!modal || !isTopModalLayer(dialog) || event.defaultPrevented || event.isComposing || !targetsPage(event.target)) return;
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
        if (document.activeElement === requested) return;
      }
      // A dialog opened at launch (or whose opener has gone, like a menu item)
      // hands focus to the draft rather than leaving it on <body>. Wait a
      // frame: the surface that covered the draft may still be closing.
      requestAnimationFrame(() => {
        const current = document.activeElement;
        // Someone else already placed focus (and not inside this closed, still-mounted dialog).
        if (current instanceof HTMLElement && current !== document.body && !dialog.contains(current) && usable(current)) return;
        const top = layers.at(-1);
        if (top) top.focusInitial();
        else {
          const draft = document.querySelector<HTMLElement>(".composer textarea:not([disabled])");
          if (usable(draft)) draft.focus({ preventScroll: true });
        }
      });
    };
  }, [dialogRef, open]);
}
