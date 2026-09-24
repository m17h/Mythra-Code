import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { FileDiff, ListChecks, MessageSquareText, TriangleAlert } from "lucide-react";
import { usePopoverFade } from "../hooks/usePopoverFade";
import { MAX_FEEDBACK_COMMENT_CHARS, type FeedbackAnchor } from "../lib/reviewFeedback";
import "./Feedback.css";

/** A viewport rectangle captured once; floats never track live DOM. */
export interface FeedbackRect { top: number; bottom: number; left: number; right: number }

export function toFeedbackRect(rect: Pick<DOMRect, "top" | "bottom" | "left" | "right">): FeedbackRect {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

const VIEWPORT_MARGIN = 8;
const FLOAT_GAP = 8;

function effectiveZoom(element: HTMLElement): number {
  const current = (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === "number" && Number.isFinite(current) && current > 0) return current;
  // WebKit versions without currentCSSZoom still expose each ancestor's zoom.
  let zoom = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).zoom;
    const factor = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  return zoom;
}

function supportsTopLayer(): boolean {
  return typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
}

/** Places a fixed float beside `rect`, flipping and clamping inside the viewport. */
function placeFloat(element: HTMLElement, rect: FeedbackRect, placement: "above" | "below", align: "start" | "end") {
  // Selection and viewport rectangles are visual pixels. offsetWidth/Height
  // and fixed CSS offsets are layout pixels, which diverge under app zoom.
  const zoom = effectiveZoom(element);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  element.style.maxWidth = `${Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2) / zoom}px`;
  const width = element.offsetWidth * zoom;
  const height = element.offsetHeight * zoom;
  const below = rect.bottom + FLOAT_GAP;
  const above = rect.top - FLOAT_GAP - height;
  const fitsBelow = below + height <= viewportHeight - VIEWPORT_MARGIN;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  let top = placement === "below"
    ? (!fitsBelow && fitsAbove ? above : below)
    : (!fitsAbove && fitsBelow ? below : above);
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN));
  const preferredLeft = align === "start" ? rect.left : rect.right - width;
  const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));
  element.style.top = `${top / zoom}px`;
  element.style.left = `${left / zoom}px`;
  // The entrance grows out of the side facing the selection.
  element.dataset.side = top + height <= rect.top + 1 ? "above" : "below";
}

/**
 * One fixed float in the native top layer (the AppSelectMenu pattern), so it
 * clears scroll containers while still inheriting the app theme from its DOM
 * parent. Exit content stays mounted and inert until the fade finishes.
 */
export function FeedbackFloat({ open, rect, placement, align, className = "", role, label, children }: {
  open: boolean;
  rect: FeedbackRect | null | undefined;
  placement: "above" | "below";
  align: "start" | "end";
  className?: string;
  role?: "dialog";
  label?: string;
  children: ReactNode;
}) {
  const { ref, present } = usePopoverFade(open);
  const topLayer = supportsTopLayer();
  const visible = present && Boolean(rect);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !rect) return;
    if (topLayer) {
      try { if (!element.matches(":popover-open")) element.showPopover(); } catch { /* Already shown or unsupported. */ }
    }
    placeFloat(element, rect, placement, align);
    // Content can change height (an error line, a growing note); keep it placed.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => placeFloat(element, rect, placement, align));
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [visible, rect, placement, align, topLayer, ref]);

  if (!visible) return null;
  return (
    <div
      ref={ref}
      className={`feedback-float ${className}`}
      data-open={open || undefined}
      popover={topLayer ? "manual" : undefined}
      role={role}
      aria-label={label}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      style={{ opacity: 0 }}
    >
      {children}
    </div>
  );
}

/**
 * Escape, outside pointer and outside scroll handling for a float. Escape is
 * captured so it closes only the float, never the app-level stop-turn handler.
 */
export function useFloatDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: (reason: "escape" | "outside" | "scroll") => void,
) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; });
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(containerRef.current?.contains(target));
    let scrollIntentAt = Number.NEGATIVE_INFINITY;
    const markScrollIntent = () => { scrollIntentAt = performance.now(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!inside(event.target) && ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "].includes(event.key)) markScrollIntent();
      if (event.key !== "Escape") return;
      if (document.querySelector("[data-app-select-open]")) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current("escape");
    };
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) dismissRef.current("outside"); };
    // Layout changes, focusing an input and opening a nested native popover can
    // emit scroll events without a user scroll. Keep the float open for those.
    const onScroll = (event: Event) => {
      if (!inside(event.target) && performance.now() - scrollIntentAt < 250) dismissRef.current("scroll");
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("wheel", markScrollIntent, true);
    document.addEventListener("touchmove", markScrollIntent, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("wheel", markScrollIntent, true);
      document.removeEventListener("touchmove", markScrollIntent, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, containerRef]);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Compact, human wording for where a note points. */
export function feedbackAnchorSummary(anchor: FeedbackAnchor): { place: string; detail?: string; title: string; code: boolean } {
  if (anchor.kind === "assistant") {
    return { place: "Reply", title: "Selected assistant reply", code: false };
  }
  if (anchor.kind === "diff") {
    const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
    const count = anchor.quote.split("\n").length;
    const multiline = count > 1;
    const place = `${basename(anchor.path)}${line === undefined ? "" : `:${line}`}`;
    return {
      place,
      detail: multiline ? `${count} lines` : anchor.side === "old" ? "removed" : undefined,
      title: `${anchor.path}${line === undefined ? "" : `:${line}`} · ${multiline ? "patch starting here" : anchor.side === "old" ? "removed code" : "current code"}`,
      code: true,
    };
  }
  return {
    place: "Checks",
    detail: anchor.exitCode === null ? "status unavailable" : `exit ${anchor.exitCode}`,
    title: `${anchor.command} · ${anchor.cwd}`,
    code: true,
  };
}

export function FeedbackAnchorIcon({ anchor, size = 12 }: { anchor: FeedbackAnchor; size?: number }) {
  if (anchor.kind === "diff") return <FileDiff size={size} aria-hidden="true" />;
  if (anchor.kind === "check") return <ListChecks size={size} aria-hidden="true" />;
  return <MessageSquareText size={size} aria-hidden="true" />;
}

/** The note editor shared by new selections and tray edits. */
export function FeedbackNoteCard({ anchor, comment, submitLabel, error, stale, onComment, onSubmit, onCancel, onRemove }: {
  anchor: FeedbackAnchor;
  comment: string;
  submitLabel: string;
  error?: string;
  stale?: boolean;
  onComment: (comment: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const summary = feedbackAnchorSummary(anchor);
  const quote = anchor.kind === "check" ? anchor.output.trim().split("\n").slice(-4).join("\n") : anchor.quote;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }, [comment]);

  const ready = Boolean(comment.trim());
  return (
    <div className="feedback-card">
      <div className="feedback-card-head" title={summary.title}>
        <FeedbackAnchorIcon anchor={anchor} />
        <strong>{summary.place}</strong>
        {summary.detail && <small>{summary.detail}</small>}
      </div>
      {quote && <blockquote className={`feedback-card-quote ${summary.code ? "code" : ""}`}>{quote}</blockquote>}
      {stale && <p className="feedback-card-stale"><TriangleAlert size={11} aria-hidden="true" /> Changed since you noted this. It is sent as it was.</p>}
      <textarea
        ref={inputRef}
        value={comment}
        rows={2}
        maxLength={MAX_FEEDBACK_COMMENT_CHARS}
        placeholder="What should change?"
        aria-label="Feedback note"
        spellCheck
        onChange={(event) => onComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (ready) onSubmit();
          }
        }}
      />
      {error && <p className="feedback-card-error" role="alert">{error}</p>}
      <div className="feedback-card-actions">
        {onRemove && <button type="button" className="feedback-card-remove" onClick={onRemove}>Remove</button>}
        <button type="button" className="feedback-card-cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="feedback-card-submit" disabled={!ready} onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  );
}
