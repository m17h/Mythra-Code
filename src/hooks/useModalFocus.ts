import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Focus containment for always-mounted dialogs (Settings, Onboarding).
 *
 * On open: moves focus to the dialog's `[data-autofocus]` element, or its
 * first focusable control. While open: keeps Tab cycling inside the dialog.
 * On close: restores focus to the element that was focused before opening.
 *
 * The Tab handler is attached to the dialog element itself — not `document` —
 * so it only acts while focus is inside the dialog and cannot compete with
 * the document-level trap of the ApprovalCenter modal, which stacks above
 * these dialogs and must win when present.
 */
export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      restoreRef.current = null;
      // Restore only if focus is still inside the (now closing) dialog or was
      // lost to the body — never steal focus the user moved elsewhere.
      const active = document.activeElement;
      if (
        restore &&
        document.contains(restore) &&
        (active === null || active === document.body || dialog.contains(active))
      ) {
        restore.focus();
      }
    };
  }, [dialogRef, open]);
}
