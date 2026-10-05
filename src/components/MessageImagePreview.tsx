import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { ImageIcon, X } from "lucide-react";
import { adoptPortalTheme, effectiveZoom } from "../lib/floatingLayer";
import { useModalFocus } from "../hooks/useModalFocus";
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

function supportsModalDialog(): boolean {
  return typeof HTMLDialogElement !== "undefined"
    && typeof HTMLDialogElement.prototype.showModal === "function"
    && typeof HTMLDialogElement.prototype.close === "function";
}

/** Safari 13 has neither native modal dialogs nor inert. Keep the overlay out
 * of transcript clipping and contain background interactions without either. */
function ImagePreviewFallback({ name, sourceRef, onClose, children }: {
  name: string;
  sourceRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef, true);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const source = sourceRef.current;
    if (!layer || !source) return;
    const sync = () => {
      adoptPortalTheme(layer, source);
      const zoom = effectiveZoom(layer);
      layer.style.setProperty("--ui-scale", String(zoom));
      layer.style.width = `${window.innerWidth / zoom}px`;
      layer.style.height = `${window.innerHeight / zoom}px`;
    };
    sync();
    const themeObserver = new MutationObserver(sync);
    const shell = source.closest(".app-shell");
    if (shell) themeObserver.observe(shell, { attributes: true });
    window.addEventListener("resize", sync);
    return () => {
      themeObserver.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [sourceRef]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // useModalFocus has moved focus into the viewer before hiding the rest
    // of the page from assistive technology.
    const hidden = new Map<Element, string | null>();
    const hideBackground = () => {
      for (const sibling of document.body.children) {
        if (sibling === layer || hidden.has(sibling)) continue;
        hidden.set(sibling, sibling.getAttribute("aria-hidden"));
        sibling.setAttribute("aria-hidden", "true");
      }
    };
    hideBackground();
    const bodyObserver = new MutationObserver(hideBackground);
    bodyObserver.observe(document.body, { childList: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const inside = (target: EventTarget | null) => target instanceof Node && layer.contains(target);
    const retainFocus = (event: FocusEvent) => {
      if (!inside(event.target)) modalRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    };
    const blockBackground = (event: Event) => {
      if (inside(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const outsideKey = (event: KeyboardEvent) => {
      if (inside(event.target)) return;
      blockBackground(event);
      if (event.key === "Escape") onClose();
    };
    const pointerEvents = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "touchstart"] as const;
    for (const type of pointerEvents) document.addEventListener(type, blockBackground, { capture: true, passive: false });
    document.addEventListener("focusin", retainFocus, true);
    document.addEventListener("keydown", outsideKey, true);
    return () => {
      bodyObserver.disconnect();
      for (const type of pointerEvents) document.removeEventListener(type, blockBackground, true);
      document.removeEventListener("focusin", retainFocus, true);
      document.removeEventListener("keydown", outsideKey, true);
      for (const [element, value] of hidden) {
        if (value === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", value);
      }
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(<div ref={layerRef} className="message-image-fallback" onClick={(event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={modalRef} className="message-image-dialog message-image-dialog-fallback" role="dialog" aria-modal="true" aria-label={`Image preview: ${name}`} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }}>
      {children}
    </div>
  </div>, document.body);
}

export function MessageImagePreview({ path, name }: { path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(() => needsNativePermission(path) ? "" : imagePreviewUrl(path));
  const [expanded, setExpanded] = useState(false);
  const [expandedFailed, setExpandedFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nativeDialog = supportsModalDialog();
  const dismiss = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.close === "function") dialog.close();
    else setExpanded(false);
  }, []);

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
    if (expanded && typeof dialog.showModal === "function") dialog.showModal();
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); };
  }, [expanded, source]);

  if (failed) {
    return <span className="message-image-preview unavailable" title={name}>
      <ImageIcon size={16} aria-hidden="true" />
      <span>{name}</span>
    </span>;
  }
  if (!source) return <span className="message-image-preview loading" role="img" aria-label={`Loading attached image: ${name}`} />;

  const contents = <>
    <div className="message-image-dialog-header">
      <span title={name}>{name}</span>
      <button type="button" aria-label="Close image preview" autoFocus={nativeDialog} data-autofocus onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </div>
    <div className="message-image-dialog-content">
      {expandedFailed
        ? <p role="status">This image is no longer available.</p>
        : <img src={source} alt={`Expanded image: ${name}`} draggable={false} onError={() => setExpandedFailed(true)} />}
    </div>
  </>;

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
    {nativeDialog ? <dialog
      ref={dialogRef}
      className="message-image-dialog"
      aria-label={`Image preview: ${name}`}
      onClose={() => {
        setExpanded(false);
        triggerRef.current?.focus({ preventScroll: true });
      }}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onKeyDown={(event) => {
        // App shortcuts include Escape to stop a running turn. Image viewing
        // owns keys while modal so dismissing a photo never interrupts a run.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
      }}
    >
      {expanded && contents}
    </dialog> : expanded && <ImagePreviewFallback name={name} sourceRef={triggerRef} onClose={dismiss}>{contents}</ImagePreviewFallback>}
  </>;
}
