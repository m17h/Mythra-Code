import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TriangleAlert } from "lucide-react";
import { settleConfirm, useConfirmStore, type ConfirmRequest } from "../lib/confirmDialog";
import { useModalFocus } from "../hooks/useModalFocus";

/**
 * Mythra Code's own confirmation dialog, replacing the OS-native window that
 * Tauri's confirm() shows. Messages follow the app-wide convention of
 * "Question?\n\nConsequences." — the first paragraph becomes the heading.
 */
export function ConfirmDialogModal() {
  const request = useConfirmStore((state) => state.queue[0] ?? null);
  return request ? <ConfirmDialogContents key={request.id} request={request} /> : null;
}

function ConfirmDialogContents({ request }: { request: ConfirmRequest }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [linkError, setLinkError] = useState("");
  useModalFocus(dialogRef, true);

  useEffect(() => {
    // Capture phase + stopPropagation: Escape answers this dialog and never
    // reaches the app-level handler that stops the running turn.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settleConfirm(request.id, false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [request]);

  const [title, ...body] = request.message.split("\n\n");
  const destructive = /delete|remove|revert|discard|archive/i.test(request.message);
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) settleConfirm(request.id, false);
      }}
    >
      <div className={`confirm-dialog ${request.footer ? "confirm-dialog-detailed" : ""}`} role="alertdialog" aria-modal="true" aria-label={title} aria-describedby={body.length ? `confirm-body-${request.id}` : undefined} ref={dialogRef}>
        <div className={`confirm-dialog-icon ${destructive ? "danger" : ""}`}><TriangleAlert size={17} /></div>
        <h2>{title}</h2>
        {body.length > 0 && <p id={`confirm-body-${request.id}`}>{body.join("\n\n")}</p>}
        {request.links?.length ? <nav className="confirm-dialog-links" aria-label="Learn about reasoning effort">
          {request.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (!("__TAURI_INTERNALS__" in window)) return;
            event.preventDefault();
            void openUrl(link.url).catch(() => setLinkError("Could not open the link in your browser. Please try again."));
          }}>{link.label} ↗</a>)}
        </nav> : null}
        {linkError && <p className="confirm-dialog-footnote" role="status">{linkError}</p>}
        <div className="confirm-dialog-actions">
          <button className="secondary-button" data-autofocus onClick={() => settleConfirm(request.id, false)}>
            {request.cancelLabel}
          </button>
          <button
            className={`primary-button ${destructive ? "confirm-danger" : ""}`}
            onClick={() => settleConfirm(request.id, true)}
          >
            {request.confirmLabel}
          </button>
        </div>
        {request.footer && <p className="confirm-dialog-footnote">{request.footer}</p>}
      </div>
    </div>
  );
}
