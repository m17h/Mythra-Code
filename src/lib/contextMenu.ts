import { dismissSpellingMenu, dismissSpellingMenuForScroll, requestSpellingMenu, useSpellingMenu } from "./spelling";

/** Keep the browser menu disabled; editable misspellings get our own menu. */
export function installContextMenuBlocker(target: Document = document): () => void {
  const context = (event: MouseEvent) => {
    event.preventDefault();
    requestSpellingMenu(event);
  };
  const dismiss = () => dismissSpellingMenu();
  const scroll = (event: Event) => dismissSpellingMenuForScroll(event.target);
  const pointer = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest(".spelling-menu")) dismiss();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestSpellingMenu({ target: event.target, clientX: 0, clientY: 0 });
      return;
    }
    if (event.key === "Escape" && useSpellingMenu.getState().menu) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismissSpellingMenu(true);
    } else if (event.key === "Escape") {
      // A late dictionary response must not reopen a menu after Escape.
      dismiss();
    }
  };
  target.addEventListener("contextmenu", context, true);
  target.addEventListener("pointerdown", pointer, true);
  target.addEventListener("input", dismiss, true);
  target.addEventListener("scroll", scroll, true);
  target.addEventListener("keydown", key, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
  return () => {
    dismiss();
    target.removeEventListener("contextmenu", context, true);
    target.removeEventListener("pointerdown", pointer, true);
    target.removeEventListener("input", dismiss, true);
    target.removeEventListener("scroll", scroll, true);
    target.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("resize", dismiss);
  };
}
