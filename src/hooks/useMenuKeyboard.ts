import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { isReachableFocusable } from "../lib/focusReach";
import { OPEN_MODEL_PICKER_EVENT } from "../lib/shortcuts";

/**
 * One keyboard contract for every pop-up menu in the composer, top bar and
 * sidebar (Access, provider, every model catalog, row menus). It matches the
 * menus that already behaved well (`AppActionMenu`, the OpenAI model picker):
 *
 * - ↓ / ↑ on the trigger opens the menu.
 * - Opening from the keyboard moves focus to the selected item, or the first.
 * - ↓ / ↑ move between items and wrap; Home and End jump to the ends;
 *   typing a letter jumps to the next item that starts with it.
 * - Escape closes and returns focus to the trigger. It never reaches the
 *   app-level handler that may stop a running turn.
 * - Tab closes, and focus continues from the trigger.
 * - Choosing an item should call `select` (or `close(true)`): the menu
 *   closes and focus returns to the trigger, even when choosing re-renders
 *   or replaces the trigger (a new model name, a different provider control).
 *
 * Search-first menus (Cursor, OpenRouter, LM Studio) pass `searchRef`:
 *
 * - Opening with the pointer focuses the search field; opening from the
 *   keyboard (↓ on the trigger or ⇧⌘M) focuses the selected model.
 * - ↓ in the search field moves into the list (to the selected model when it
 *   is visible, otherwise the first match); ↑ from the first item returns to
 *   the search field instead of wrapping.
 * - Typing a character while a row has focus sends it to the search field,
 *   so "type to filter" works from anywhere in the menu.
 * - Tab walks the menu in reading order instead of leaving it: search →
 *   the current (or first) model → the menu's own buttons (refresh, clear,
 *   show all). Past the last one, Tab closes and continues from the trigger;
 *   Shift+Tab from the search field closes back onto the trigger.
 *
 * Items are found by role inside `menuRef`, so rows can keep their own
 * markup. A model row's favourite star is reached with → and left with ←;
 * ↑/↓ skip it.
 */
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
/** The composer's model trigger(s); the first one on screen answers ⇧⌘M. */
const MODEL_TRIGGER_SELECTOR = '.composer-zone [aria-haspopup][aria-label*="model:"]';

export function visibleModelTrigger(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(MODEL_TRIGGER_SELECTOR)).find((trigger) => isReachableFocusable(trigger));
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => {
    if ((item as HTMLButtonElement).disabled) return false;
    if (item.closest("[hidden],[inert]")) return false;
    return item.getClientRects().length > 0;
  });
}

export function useMenuKeyboard({
  open,
  setOpen,
  menuRef,
  triggerRef,
  searchRef,
  initial = "selected",
  focusOnOpen = true,
  columns,
  answersModelShortcut = false,
  canOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  /** Search-first menus: the field that owns focus on pointer open. */
  searchRef?: RefObject<HTMLInputElement | null>;
  initial?: "selected" | "first";
  /** Menus that place focus themselves pass false. */
  focusOnOpen?: boolean;
  /** Grid menus: how many columns ↑/↓ step over (←/→ then move by one). */
  columns?: () => number;
  /** Open on ⇧⌘M (`mythra:open-model-picker`) when this is the composer's model trigger. */
  answersModelShortcut?: boolean;
  /** Return false to refuse opening (for example a signed-out provider). */
  canOpen?: () => boolean;
}) {
  const typeahead = useRef({ text: "", at: 0 });
  const openedFrom = useRef<"pointer" | "keyboard" | "last">("pointer");
  // A real pointer press on the trigger (Enter/Space clicks have none).
  const pointerOpened = useRef(false);
  const canOpenRef = useRef(canOpen);
  canOpenRef.current = canOpen;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (!returnFocus) return;
    triggerRef.current?.focus();
    // Choosing can re-render or replace the trigger (or make the focused row
    // inert) after this call; land on whichever trigger is current then.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest("[inert]") || !active.isConnected) triggerRef.current?.focus();
    });
  }, [setOpen, triggerRef]);

  /** Run a choice, then close the menu and give focus back to its trigger. */
  const select = useCallback((choose: () => void) => {
    choose();
    close(true);
  }, [close]);

  // Initial focus. Menus that stay mounted (and only fade) need one frame so
  // the visibility transition has started and the items are focusable.
  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const search = searchRef?.current;
      if (!menu) return;
      if (menu.contains(document.activeElement) || (search && document.activeElement === search)) return;
      const items = menuItems(menu);
      if (search && (openedFrom.current === "pointer" || !items.length)) { search.focus(); return; }
      if (!items.length) return;
      if (openedFrom.current === "last") { items[items.length - 1].focus(); return; }
      const selected = initial === "selected"
        ? items.find((item) => item.getAttribute("aria-checked") === "true")
        : undefined;
      (selected ?? items[0]).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusOnOpen, initial, menuRef, open, searchRef]);

  // Every close path resets how the next open was started.
  useEffect(() => { if (!open) { openedFrom.current = "pointer"; pointerOpened.current = false; } }, [open]);

  // Escape in the capture phase so it closes only this menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      const active = document.activeElement;
      const hadFocus = Boolean(menuRef.current?.contains(active))
        || active === triggerRef.current
        || (Boolean(searchRef?.current) && active === searchRef?.current);
      const byPointer = pointerOpened.current;
      close(hadFocus || active === document.body);
      // Like a native menu: Escape after a mouse-opened menu returns focus
      // without drawing a keyboard ring on the trigger. The next key press
      // switches rings back on (useInputModality).
      if (byPointer) requestAnimationFrame(() => document.documentElement.setAttribute("data-input-modality", "pointer"));
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [close, menuRef, open, searchRef, triggerRef]);

  // ⇧⌘M: the first model trigger in the composer opens itself with focus on
  // the selected model, and tells the app it handled the request.
  useEffect(() => {
    if (!answersModelShortcut) return;
    const onRequest = (event: Event) => {
      const trigger = triggerRef.current;
      if (!trigger || event.defaultPrevented) return;
      if (visibleModelTrigger() !== trigger) return;
      event.preventDefault();
      trigger.focus();
      if (canOpenRef.current && !canOpenRef.current()) return;
      openedFrom.current = "keyboard";
      if (!open) setOpen(true);
      else {
        const items = menuItems(menuRef.current);
        (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
      }
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
  }, [answersModelShortcut, menuRef, open, setOpen, triggerRef]);

  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (canOpenRef.current && !canOpenRef.current()) return;
    openedFrom.current = event.key === "ArrowUp" ? "last" : "keyboard";
    pointerOpened.current = false;
    if (!open) setOpen(true);
    else {
      const items = menuItems(menuRef.current);
      (event.key === "ArrowUp" ? items[items.length - 1] : items[0])?.focus();
    }
  }, [menuRef, open, setOpen]);

  const onTriggerPointerDown = useCallback(() => { openedFrom.current = "pointer"; pointerOpened.current = true; }, []);

  /** Attach to the element that wraps the search field and the item list. */
  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const items = menuItems(menuRef.current);
    const search = searchRef?.current ?? null;
    const target = event.target as HTMLElement;
    const inSearch = Boolean(search) && target === search;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (event.key === "Tab") {
      if (!search) { close(true); return; }
      // Search-first menus: search → current model → the menu's own buttons.
      const root = event.currentTarget as HTMLElement;
      const current = items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
      const auxiliary = Array.from(root.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")).filter((element) =>
        element !== search && !element.matches(ITEM_SELECTOR) && !element.closest(".model-star") && !(element as HTMLButtonElement).disabled
        && !element.closest("[hidden],[inert]") && element.getClientRects().length > 0);
      const order = [search, ...(current ? [current] : []), ...auxiliary];
      const active = document.activeElement as HTMLElement | null;
      const starRow = active?.closest(".model-row")?.querySelector<HTMLElement>(ITEM_SELECTOR) ?? null;
      const position = order.indexOf(items.includes(active as HTMLElement) || starRow ? current : active as HTMLElement);
      const next = position + (event.shiftKey ? -1 : 1);
      if (position < 0 || next >= order.length) { close(true); return; }
      event.preventDefault();
      if (next < 0) { close(true); return; }
      order[next]?.focus();
      return;
    }
    if (!items.length) return;
    const active = document.activeElement as HTMLElement | null;
    // A focused favourite star counts as its row's item, so ↑/↓ continue
    // from that row and ← returns to the model it belongs to.
    const star = active?.closest<HTMLElement>(".model-star") ?? null;
    const rowItem = (element: HTMLElement | null) => element?.closest(".model-row")?.querySelector<HTMLElement>(ITEM_SELECTOR) ?? null;
    const current = items.indexOf((star ? rowItem(star) : active) as HTMLElement);
    const rowStar = current >= 0 && !star ? items[current].closest(".model-row")?.querySelector<HTMLElement>(".model-star") ?? null : null;
    const step = Math.max(1, columns?.() ?? 1);
    const focusAt = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };

    if (inSearch) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        // With a query the best match leads; without one, start at the current model.
        const selected = search?.value.trim() ? undefined : items.find((item) => item.getAttribute("aria-checked") === "true");
        (selected ?? items[0]).focus();
      } else if (event.key === "ArrowUp") {
        focusAt(items.length - 1);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        if (current < 0) { focusAt(0); return; }
        if (step > 1) { event.preventDefault(); items[Math.min(items.length - 1, current + step)]?.focus(); return; }
        focusAt(current + 1); return;
      case "ArrowUp":
        if (current < 0) { focusAt(items.length - 1); return; }
        if (search && current - step < 0) { event.preventDefault(); search.focus(); return; }
        if (step > 1) { event.preventDefault(); items[Math.max(0, current - step)]?.focus(); return; }
        focusAt(current - 1); return;
      case "ArrowRight":
        // → reaches the row's favourite star, then (in a grid) the next model.
        if (rowStar) { event.preventDefault(); rowStar.focus(); return; }
        if (step > 1 && current >= 0) { event.preventDefault(); items[Math.min(items.length - 1, current + 1)]?.focus(); }
        return;
      case "ArrowLeft":
        if (star && current >= 0) { event.preventDefault(); items[current].focus(); return; }
        if (step > 1 && current > 0) {
          event.preventDefault();
          const previous = items[current - 1];
          (previous.closest(".model-row")?.querySelector<HTMLElement>(".model-star") ?? previous).focus();
        }
        return;
      case "Home": if (!inField) focusAt(0); return;
      case "End": if (!inField) focusAt(items.length - 1); return;
      default: break;
    }
    if (inField || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1 || !/\S/.test(event.key)) return;
    // Search-first menus: typing on a row filters instead of jumping. Moving
    // focus during keydown lets the browser insert the character there.
    if (search) { search.focus(); return; }
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > 700 ? event.key.toLowerCase() : state.text + event.key.toLowerCase();
    state.at = now;
    const label = (item: HTMLElement) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim().toLowerCase();
    const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
    const match = ordered.find((item) => label(item).startsWith(state.text))
      ?? (state.text.length > 1 ? undefined : ordered.find((item) => label(item).startsWith(event.key.toLowerCase())));
    if (match) { event.preventDefault(); match.focus(); }
  }, [close, columns, menuRef, searchRef]);

  return { onTriggerKeyDown, onTriggerPointerDown, onMenuKeyDown, close, select };
}
