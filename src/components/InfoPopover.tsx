import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { effectiveZoom, supportsTopLayer } from "../lib/floatingLayer";
import "./InfoPopover.css";

const HOVER_GRACE_MS = 140;
const EDGE = 8;
const GAP = 6;
const MAX_WIDTH = 320;
const MAX_HEIGHT = 280;

interface Box { left: number; top: number; right: number; bottom: number }

function intersect(first: Box, second: Box): Box {
  return { left: Math.max(first.left, second.left), top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right), bottom: Math.min(first.bottom, second.bottom) };
}

/** Establishes a containing block for fixed descendants (so they move and
 * clip with it) — the case transformed modal sheets create. */
function containsFixed(style: CSSStyleDeclaration): boolean {
  const backdrop = style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter");
  return style.transform !== "none" || style.perspective !== "none" || style.filter !== "none"
    || (Boolean(backdrop) && backdrop !== "none") || /paint|layout|strict|content/.test(style.contain || "")
    || /transform|perspective|filter/.test(style.willChange || "");
}

function clips(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== "visible" || style.overflowY !== "visible";
}

/** Viewport box an element's padding box shows its content in. */
function innerBox(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
  const left = rect.left + element.clientLeft * scaleX;
  const top = rect.top + element.clientTop * scaleY;
  return { left, top, right: left + element.clientWidth * scaleX, bottom: top + element.clientHeight * scaleY };
}

/**
 * The visible area a fixed panel can occupy. In the top layer that is the
 * viewport. Without it, a transformed ancestor (an animating dialog or sheet)
 * becomes the panel's containing block, and it and any clipping ancestors up
 * to the next fixed or modal layer bound what stays visible.
 */
function availableBox(panel: HTMLElement, topLayer: boolean): Box {
  let box: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (topLayer) return box;
  let containing = false;
  for (let node = panel.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!containing && containsFixed(style)) containing = true;
    if (containing && clips(style)) box = intersect(box, innerBox(node));
    // A fixed or modal layer is not clipped by anything above it.
    // (`:modal` is avoided: older WebKit, which takes this path, rejects it.)
    if (containing && (style.position === "fixed" || (node.tagName === "DIALOG" && node.hasAttribute("open")))) break;
  }
  return box;
}

/**
 * A small trigger whose read-only details open on hover, keyboard focus or
 * click. In the top layer the panel stays a DOM descendant of its owner, so
 * inside a modal <dialog> it renders above that dialog instead of a body
 * portal behind it. Engines without popovers portal it to the open owner
 * dialog, or Settings' backdrop, and clamp it to what that owner can show.
 * The first Escape closes only this panel, never its owning window.
 */
export function InfoPopover({ label, className, triggerClassName, children, trigger }: {
  /** Accessible name of the trigger, e.g. "Requirements for Web app testing". */
  label: string;
  className?: string;
  triggerClassName?: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const panelId = useId();
  const topLayer = useState(supportsTopLayer)[0];
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const open = !dismissed && (hover || focus || pinned);

  const inside = useCallback((target: EventTarget | null) => target instanceof Node
    && Boolean(rootRef.current?.contains(target) || panelRef.current?.contains(target)), []);
  const cancelLeave = () => { window.clearTimeout(leaveTimer.current); };
  const enter = () => { cancelLeave(); setHover(true); setDismissed(false); };
  const leave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setHover(false), HOVER_GRACE_MS);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // Without a top layer, escape the owner's inner clipping: render into the
  // open native dialog itself, or Settings' backdrop above its moving sheet.
  useLayoutEffect(() => {
    if (topLayer || !open) return;
    const root = rootRef.current;
    setHost(root?.closest<HTMLElement>("dialog[open]") ?? root?.closest<HTMLElement>(".settings-backdrop") ?? null);
  }, [open, topLayer]);

  const position = useCallback(() => {
    const panel = panelRef.current;
    const anchor = triggerRef.current;
    if (!panel || !anchor || !anchor.isConnected) return;
    const scrollTop = panel.scrollTop;
    const scrollLeft = panel.scrollLeft;
    const zoom = effectiveZoom(panel);
    // Measure where this panel's containing block puts left/top zero.
    panel.style.left = "0px";
    panel.style.top = "0px";
    const origin = panel.getBoundingClientRect();
    const area = availableBox(panel, topLayer);
    const bounds = anchor.getBoundingClientRect();
    const areaWidth = Math.max(1, area.right - area.left - EDGE * 2);
    panel.style.maxWidth = `${Math.min(MAX_WIDTH * zoom, areaWidth) / zoom}px`;
    // Never cover the trigger: open on the side that fits, or else the roomier
    // side with the content shortened to scroll within it.
    const spaceBelow = area.bottom - EDGE - bounds.bottom - GAP;
    const spaceAbove = bounds.top - GAP - (area.top + EDGE);
    panel.style.maxHeight = `${Math.min(MAX_HEIGHT * zoom, Math.max(1, area.bottom - area.top - EDGE * 2)) / zoom}px`;
    const natural = panel.offsetHeight * zoom;
    const below = natural <= spaceBelow || (natural > spaceAbove && spaceBelow >= spaceAbove);
    const room = Math.max(1, Math.min(MAX_HEIGHT * zoom, below ? spaceBelow : spaceAbove));
    panel.style.maxHeight = `${room / zoom}px`;
    const width = panel.offsetWidth * zoom;
    const height = panel.offsetHeight * zoom;
    const top = below ? bounds.bottom + GAP : bounds.top - GAP - height;
    const left = Math.max(area.left + EDGE, Math.min(bounds.left, area.right - width - EDGE));
    panel.style.left = `${(left - origin.left) / zoom}px`;
    panel.style.top = `${(top - origin.top) / zoom}px`;
    // Measuring the natural box temporarily enlarges the scroll viewport.
    // Restore the reader's position after applying the final size limits.
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  }, [topLayer]);

  // Follow the trigger and the content only while open: content and anchor
  // size, theme or zoom changes, nested scrolling and window resizes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    const anchor = triggerRef.current;
    if (!open || !panel || !content || !anchor) return;
    if (topLayer && !panel.matches(":popover-open")) panel.showPopover();
    position();
    // Observer-driven moves wait one frame: re-placing changes the panel's
    // size limits, which must not re-enter the observer in the same frame.
    let pending = 0;
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(() => { pending = 0; position(); });
    };
    // The content wrapper is observed rather than the panel: the panel's own
    // box is clamped by max-height, so growing content would not resize it.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(content);
    resize?.observe(anchor);
    const shell = anchor.closest(".app-shell");
    const mutation = shell ? new MutationObserver(schedule) : null;
    if (shell) mutation?.observe(shell, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-color-scheme"] });
    const scroll = (event: Event) => {
      // The panel's own list scrolling does not move its trigger. Replacing
      // its size limits during that scroll would disturb the reading position.
      if (event.target instanceof Node && panel.contains(event.target)) return;
      position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      cancelAnimationFrame(pending);
      resize?.disconnect();
      mutation?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      if (topLayer && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [open, topLayer, position, host]);

  // A click elsewhere releases a pinned panel; the panel may be portaled.
  useEffect(() => {
    if (!pinned) return;
    const outside = (event: PointerEvent) => { if (!inside(event.target)) setPinned(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [pinned, inside]);

  // While open, the first Escape dismisses only this panel, even when it was
  // opened by hover and focus fell to <body>. Window capture runs before the
  // owning window's document guards (Activity, Settings, app shortcuts), and
  // preventDefault stops a native dialog's cancel. Keys aimed at an unrelated
  // surface outside this panel's owner are left alone.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const owner = rootRef.current?.closest("dialog, [role='dialog'], [aria-modal='true']");
      const target = event.target;
      const fallen = target === document.body || target === document.documentElement || target === document;
      if (!fallen && !inside(target) && owner && !(target instanceof Node && owner.contains(target))) return;
      event.preventDefault();
      event.stopPropagation();
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
      setPinned(false);
      setDismissed(true);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, inside]);

  const panel = <div
    ref={panelRef}
    id={panelId}
    role="tooltip"
    className="info-popover-panel"
    popover={topLayer ? "manual" : undefined}
    hidden={!topLayer && !open ? true : undefined}
    tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const anchor = triggerRef.current;
      if (!anchor) return;
      const owner = rootRef.current?.closest("dialog, [role='dialog'], [aria-modal='true']");
      // A mouse-focused fallback panel can be outside its owner's physical
      // DOM tree. Continue from its trigger's place in the owner's tab order,
      // so Settings' element-local focus trap is not bypassed by the portal.
      const controls = owner ? Array.from(owner.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]",
      )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0) : [];
      const index = controls.indexOf(anchor);
      const next = index < 0 ? anchor : controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
      event.preventDefault();
      event.stopPropagation();
      next?.focus({ preventScroll: true });
      setPinned(false);
      setDismissed(true);
    }}
    onPointerEnter={enter}
    onPointerLeave={leave}
    onBlur={(event) => {
      if (inside(event.relatedTarget)) return;
      setFocus(false);
      setPinned(false);
    }}
  ><div ref={contentRef} className="info-popover-content">{children}</div></div>;

  return <span ref={rootRef} className={`info-popover${className ? ` ${className}` : ""}`}>
    <button
      ref={triggerRef}
      type="button"
      className={triggerClassName}
      aria-label={label}
      aria-expanded={open}
      aria-controls={panelId}
      aria-describedby={open ? panelId : undefined}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") enter(); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") leave(); }}
      onFocus={() => { setFocus(true); setDismissed(false); }}
      onBlur={(event) => {
        if (inside(event.relatedTarget)) return;
        setFocus(false);
        setPinned(false);
        setDismissed(false);
      }}
      onClick={() => {
        if (open && pinned) { setPinned(false); setDismissed(true); }
        else { setPinned(true); setDismissed(false); }
      }}
    >{trigger}</button>
    {!topLayer && host ? createPortal(panel, host) : panel}
  </span>;
}
