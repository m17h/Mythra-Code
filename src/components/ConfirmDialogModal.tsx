import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { settleConfirm, useConfirmStore } from "../lib/confirmDialog";
import { useModalFocus } from "../hooks/useModalFocus";

/**
 * Mythra Code's own confirmation dialog, replacing the OS-native window that
 * Tauri's confirm() shows. Messages follow the app-wide convention of
 * "Question?\n\nConsequences." — the first paragraph becomes the heading.
 */
export function ConfirmDialogModal() {
  const request = useConfirmStore((state) => state.queue[0] ?? null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, Boolean(request));

  useEffect(() => {
    if (!request) return;
    // Capture phase + stopPropagation: Escape answers this dialog and never
    // reaches the app-level handler that stops the running turn.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        settleConfirm(request.id, false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [request]);

  if (!request) return null;
  const [title, ...body] = request.message.split("\n\n");
  const destructive = /delete|remove|revert|discard|archive/i.test(request.message);
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) settleConfirm(request.id, false);
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <div className={`confirm-dialog-icon ${destructive ? "danger" : ""}`}><TriangleAlert size={17} /></div>
        <h2>{title}</h2>
        {body.length > 0 && <p>{body.join("\n\n")}</p>}
        <div className="confirm-dialog-actions">
          <button className="secondary-button" data-autofocus onClick={() => settleConfirm(request.id, false)}>
            Cancel
          </button>
          <button
            className={`primary-button ${destructive ? "confirm-danger" : ""}`}
            onClick={() => settleConfirm(request.id, true)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
