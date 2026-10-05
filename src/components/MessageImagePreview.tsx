import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { ImageIcon, X } from "lucide-react";
import "./MessageImagePreview.css";

function imagePreviewUrl(path: string): string {
  if (/^(?:asset:|https?:|data:|blob:)/i.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    // Browser development has no native asset bridge.
    return path;
  }
}

function needsNativePermission(path: string): boolean {
  return !/^(?:asset:|https?:|data:|blob:)/i.test(path) && isTauri();
}

export function MessageImagePreview({ path, name }: { path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(() => needsNativePermission(path) ? "" : imagePreviewUrl(path));
  const [expanded, setExpanded] = useState(false);
  const [expandedFailed, setExpandedFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    setFailed(false);
    setExpanded(false);
    if (!needsNativePermission(path)) {
      setSource(imagePreviewUrl(path));
      return () => { current = false; };
    }
    setSource("");
    void invoke("prepare_image_preview", { path })
      .then(() => {
        if (current) setSource(imagePreviewUrl(path));
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => { current = false; };
  }, [path]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // The native top layer escapes transcript clipping and provides modal
    // focus containment and focus restoration without a second focus trap.
    if (expanded) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [expanded, source]);

  if (failed) {
    return <span className="message-image-preview unavailable" title={name}>
      <ImageIcon size={16} aria-hidden="true" />
      <span>{name}</span>
    </span>;
  }
  if (!source) return <span className="message-image-preview loading" role="img" aria-label={`Loading attached image: ${name}`} />;

  return <>
    <button
      type="button"
      ref={triggerRef}
      className="message-image-preview-button"
      aria-label={`Expand attached image: ${name}`}
      aria-haspopup="dialog"
      title={`Expand ${name}`}
      onClick={(event) => {
        // WebKit does not focus buttons on pointer activation. Give the
        // dialog a consistent return target for pointer and keyboard users.
        event.currentTarget.focus({ preventScroll: true });
        setExpandedFailed(false);
        setExpanded(true);
      }}
    >
      <img className="message-image-preview" src={source} alt={`Attached image: ${name}`} loading="lazy" draggable={false} onError={() => { setExpanded(false); setFailed(true); }} />
    </button>
    <dialog
      ref={dialogRef}
      className="message-image-dialog"
      aria-label={`Image preview: ${name}`}
      onClose={() => {
        setExpanded(false);
        triggerRef.current?.focus({ preventScroll: true });
      }}
      onCancel={(event) => { event.preventDefault(); dialogRef.current?.close(); }}
      onKeyDown={(event) => {
        // App shortcuts include Escape to stop a running turn. Image viewing
        // owns keys while modal so dismissing a photo never interrupts a run.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          dialogRef.current?.close();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialogRef.current?.close();
      }}
    >
      {expanded && <>
        <div className="message-image-dialog-header">
          <span title={name}>{name}</span>
          <button type="button" aria-label="Close image preview" autoFocus onClick={() => dialogRef.current?.close()}><X size={20} aria-hidden="true" /></button>
        </div>
        <div className="message-image-dialog-content">
          {expandedFailed
            ? <p role="status">This image is no longer available.</p>
            : <img src={source} alt={`Expanded image: ${name}`} draggable={false} onError={() => setExpandedFailed(true)} />}
        </div>
      </>}
    </dialog>
  </>;
}
