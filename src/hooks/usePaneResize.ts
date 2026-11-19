import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
} from "react";
import { loadStored, storeValue } from "../lib/storage";

export interface PaneSizes {
  sidebar: number;
  dock: number;
}

export type PaneKey = keyof PaneSizes;

const DEFAULT_PANE_SIZES: PaneSizes = { sidebar: 260, dock: 430 };

/** Exposed so the separators can publish honest `aria-valuemin`/`max`. */
export const PANE_BOUNDS: Record<PaneKey, { min: number; max: number }> = {
  sidebar: { min: 230, max: 420 },
  dock: { min: 340, max: 760 },
};

/**
 * The panes are sized off these custom properties rather than off inline
 * React styles. A drag can then move the edge by writing one property — no
 * render, and no risk of a render that happens to land mid-drag (a streaming
 * token, a status tick) stomping the live position back to the last committed
 * value.
 *
 * Each property lives on its own pane root and is registered non-inherited
 * (styles.css), keeping width-variable changes local to the pane instead of
 * propagating them through the app. Resizing still changes surrounding layout
 * and paint as the available space changes.
 */
const PANE_VARIABLE: Record<PaneKey, string> = {
  sidebar: "--sidebar-width",
  dock: "--dock-width",
};

const KEYBOARD_STEP = 16;

/* ---------------------------------------------------------------------------
 * Fitting saved widths to the window (Sol R5 B02). A width saved on a large
 * window, or at 100% UI scale, can leave the chat a sliver on a smaller window
 * or at 125%. The saved preference is kept; only the width drawn is clamped,
 * from the shell's real width (the window divided by the UI zoom) and the
 * sidebar beside it, so the chat column never drops below STAGE_MIN_WIDTH.
 * ------------------------------------------------------------------------- */

/** The narrowest chat column (shell pixels) the composer and transcript are laid out for. */
export const STAGE_MIN_WIDTH = 360;

/** Below this window width (CSS px) the Tools panel floats over the chat as a sheet. */
const DOCK_OVERLAY_MAX = 900;

export interface PaneFitInput {
  /** Window width in CSS pixels. */
  windowWidth: number;
  /** UI scale (the shell's zoom), 1 = 100%. */
  scale: number;
  /** The sidebar's width when it takes room in the layout; 0 when hidden, tucked or floating. */
  sidebarWidth: number;
}

function toolsNeedOverlay(windowWidth: number, scale: number): boolean {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return false;
  return windowWidth <= DOCK_OVERLAY_MAX || windowWidth / (scale > 0 ? scale : 1) < PANE_BOUNDS.dock.min + STAGE_MIN_WIDTH;
}

/** The widest the dock may be drawn so the chat keeps STAGE_MIN_WIDTH. */
export function dockFitMax({ windowWidth, scale, sidebarWidth }: PaneFitInput): number {
  const { min, max } = PANE_BOUNDS.dock;
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return max;
  const shell = windowWidth / (scale > 0 ? scale : 1);
  if (toolsNeedOverlay(windowWidth, scale)) return Math.max(min, Math.min(max, Math.floor(shell * 0.92)));
  return Math.max(min, Math.min(max, Math.floor(shell - sidebarWidth - STAGE_MIN_WIDTH)));
}

/** The width actually drawn for a saved dock width. */
export function fittedDockWidth(saved: number, input: PaneFitInput): number {
  return Math.min(clampPaneSize("dock", saved), dockFitMax(input));
}

/**
 * True when even the narrowest dock beside the sidebar would squeeze the chat
 * below its minimum: opening the Tools panel then tucks the sidebar away, as
 * the 901-1250px window range already does.
 */
export function sidebarCrowdsDock({ windowWidth, scale, sidebarWidth }: PaneFitInput): boolean {
  if (!Number.isFinite(windowWidth) || windowWidth <= DOCK_OVERLAY_MAX || sidebarWidth <= 0) return false;
  const shell = windowWidth / (scale > 0 ? scale : 1);
  return shell - sidebarWidth - PANE_BOUNDS.dock.min < STAGE_MIN_WIDTH;
}

/** How wide wide review's drawer is, and the strip of chat it leaves (shell pixels). */
export function reviewWideFit({ shellWidth, mainLeft, mainWidth }: { shellWidth: number; mainLeft: number; mainWidth: number }): { strip: number; width: number } {
  // A dimmed strip of the conversation stays visible (a click on it narrows).
  // It gives way on smaller windows so review gains real width there.
  const strip = Math.round(Math.min(240, Math.max(96, mainWidth * 0.22)));
  return { strip, width: Math.max(0, Math.min(1180, shellWidth - mainLeft - strip)) };
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function clampPaneSize(pane: PaneKey, value: number): number {
  const { min, max } = PANE_BOUNDS[pane];
  if (!Number.isFinite(value)) return DEFAULT_PANE_SIZES[pane];
  return Math.min(max, Math.max(min, value));
}

function normalizePaneSizes(sizes: Partial<PaneSizes> | null | undefined): PaneSizes {
  return {
    sidebar: clampPaneSize("sidebar", Number(sizes?.sidebar)),
    dock: clampPaneSize("dock", Number(sizes?.dock)),
  };
}

/**
 * Until someone resizes the Tools panel dock it follows the window: 30% of it,
 * from 420px up to 760px on very wide screens, so a diff gains from a big
 * display. The first drag or arrow key turns that into a remembered pixel
 * width (and a width saved earlier keeps winning).
 */
const AUTO_DOCK_WIDTH = "clamp(420px, 30vw, 760px)";

interface StoredPaneSizes extends Partial<PaneSizes> {
  /** Set once the dock has been resized by hand. */
  dockUserSized?: boolean;
}

function writePaneVariable(root: HTMLElement | null, pane: PaneKey, size: number, auto = false, fitMax = Infinity): void {
  // The automatic width follows the window too, but never past the fit.
  const value = auto
    ? fitMax < PANE_BOUNDS.dock.max ? `min(${AUTO_DOCK_WIDTH}, ${fitMax}px)` : AUTO_DOCK_WIDTH
    : `${Math.min(size, fitMax)}px`;
  root?.style.setProperty(PANE_VARIABLE[pane], value);
}

/** The width the dock is actually drawn at, in the shell's own pixels. */
function measuredPaneSize(root: HTMLElement | null, pane: PaneKey, fallback: number): number {
  if (!root) return fallback;
  const width = Number.parseFloat(window.getComputedStyle(root).width);
  return Number.isFinite(width) && width > 0 ? clampPaneSize(pane, Math.round(width)) : fallback;
}

export interface PaneResizeApi {
  /** The saved preferences (what a larger window gets back). */
  paneSizes: PaneSizes;
  /** The dock width drawn now: the saved width fitted to the window and UI scale. */
  dockWidth: number;
  /** The widest the dock may be dragged to right now. */
  dockMax: number;
  /** The window cannot fit both Tools and the conversation side by side. */
  dockOverlay: boolean;
  /** The sidebar must tuck away while the Tools panel is open, or the chat would be too narrow. */
  sidebarCrowded: boolean;
  /** Attach to each pane's root element: it owns that pane's width property. */
  paneRefs: Record<PaneKey, RefCallback<HTMLElement>>;
  startPaneResize: (pane: PaneKey) => (event: ReactPointerEvent) => void;
  resizePaneWithKeyboard: (pane: PaneKey) => (event: ReactKeyboardEvent) => void;
}

export interface PaneLayout {
  /** The sidebar is open (the preference), before any tucking. */
  sidebarOpen: boolean;
  /** Something else already tucks the sidebar while the Tools panel is open. */
  sidebarTucked: boolean;
  /** The Tools is open beside the chat. */
  dockOpen: boolean;
}

export function usePaneResize(uiScale: number, layout: PaneLayout = { sidebarOpen: true, sidebarTucked: false, dockOpen: false }): PaneResizeApi {
  const [storedSizes] = useState(() => loadStored<StoredPaneSizes | null>("kiwi.paneSizes", null));
  const [paneSizes, setPaneSizes] = useState<PaneSizes>(() => normalizePaneSizes(storedSizes ?? DEFAULT_PANE_SIZES));
  // Older saves have no flag: a dock width other than the old default was a
  // deliberate drag, and keeps winning over the automatic width.
  const autoDockRef = useRef(!(storedSizes?.dockUserSized
    ?? (typeof storedSizes?.dock === "number" && storedSizes.dock !== DEFAULT_PANE_SIZES.dock)));
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;
  const windowWidth = useWindowWidth();
  const sidebarCrowded = layout.dockOpen && layout.sidebarOpen && !layout.sidebarTucked
    && sidebarCrowdsDock({ windowWidth, scale: uiScale, sidebarWidth: paneSizes.sidebar });
  // Only a sidebar that takes room in the layout narrows what the dock may use.
  const sidebarInLayout = layout.sidebarOpen && !layout.sidebarTucked && !sidebarCrowded;
  const dockMax = dockFitMax({ windowWidth, scale: uiScale, sidebarWidth: sidebarInLayout ? paneSizes.sidebar : 0 });
  const dockMaxRef = useRef(dockMax);
  dockMaxRef.current = dockMax;
  const clampToFit = (pane: PaneKey, value: number) => pane === "dock" ? Math.min(clampPaneSize(pane, value), dockMaxRef.current) : clampPaneSize(pane, value);
  const clampToFitRef = useRef(clampToFit);
  clampToFitRef.current = clampToFit;

  const paneRootsRef = useRef<Record<PaneKey, HTMLElement | null>>({ sidebar: null, dock: null });
  // Stable for the hook's lifetime, so React only calls them when a pane root
  // actually mounts or unmounts. A root that mounts later (the lazily loaded
  // dock) receives the committed size before its first paint.
  const [paneRefs] = useState<Record<PaneKey, RefCallback<HTMLElement>>>(() => {
    const attach = (pane: PaneKey) => (root: HTMLElement | null) => {
      paneRootsRef.current[pane] = root;
      writePaneVariable(root, pane, paneSizesRef.current[pane], pane === "dock" && autoDockRef.current, pane === "dock" ? dockMaxRef.current : Infinity);
    };
    return { sidebar: attach("sidebar"), dock: attach("dock") };
  });
  // Cancellation of the gesture currently in flight, if any. Held so a new
  // drag — or an unmount — both detaches the previous listeners and restores
  // its last committed width.
  const cancelDragRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  // Synchronize committed size changes after drag end or keyboard input.
  // Mount callbacks seed newly attached roots; pointer moves write directly
  // without changing paneSizes, so this effect does not run during a drag.
  // The fit re-runs on window resize and UI scale changes, never mid-drag.
  useLayoutEffect(() => {
    writePaneVariable(paneRootsRef.current.sidebar, "sidebar", paneSizes.sidebar);
    if (cancelDragRef.current) return;
    writePaneVariable(paneRootsRef.current.dock, "dock", paneSizes.dock, autoDockRef.current, dockMax);
  }, [paneSizes, dockMax]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelDragRef.current?.();
    };
  }, []);

  const commitPaneSize = useCallback((pane: PaneKey, size: number) => {
    const current = paneSizesRef.current;
    if (current[pane] === size && (pane !== "dock" || !autoDockRef.current)) return;
    const next = { ...current, [pane]: size };
    if (pane === "dock") autoDockRef.current = false;
    paneSizesRef.current = next;
    if (mountedRef.current) setPaneSizes(next);
    storeValue("kiwi.paneSizes", { ...next, dockUserSized: !autoDockRef.current });
  }, []);

  const startPaneResize = useCallback(
    (pane: PaneKey) => (event: ReactPointerEvent) => {
      if (event.button > 0) return;
      event.preventDefault();
      cancelDragRef.current?.();

      // React clears `currentTarget` once the handler returns, and detaches
      // pane refs before an unmount cancels the gesture, so both nodes are
      // read out synchronously and kept by value.
      const handle: Element | null = event.currentTarget;
      const root = paneRootsRef.current[pane];
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
      const startX = event.clientX;
      const savedSize = paneSizesRef.current[pane];
      const size = pane === "dock" && autoDockRef.current ? measuredPaneSize(root, pane, savedSize) : savedSize;
      // A saved width wider than the window allows starts from what is drawn.
      const startSize = clampToFitRef.current(pane, size);
      let latest = startSize;
      let captured = false;

      const belongsToGesture = (candidate: PointerEvent) =>
        pointerId === null
        || !Number.isFinite(candidate.pointerId)
        || candidate.pointerId === pointerId;

      const paint = (size: number) => {
        writePaneVariable(root, pane, size);
        handle?.setAttribute("aria-valuenow", String(Math.round(size)));
      };
      const restoreDock = () => {
        writePaneVariable(root, pane, paneSizesRef.current.dock, autoDockRef.current, dockMaxRef.current);
        handle?.setAttribute("aria-valuenow", String(measuredPaneSize(root, pane, startSize)));
      };

      let cancelGesture: () => void;

      const teardown = () => {
        if (cancelDragRef.current !== cancelGesture) return;
        cancelDragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("keydown", onKeyDown, true);
        if (captured && pointerId !== null && handle) {
          try {
            handle.releasePointerCapture(pointerId);
          } catch {
            // Browsers may release capture before dispatching pointerup or
            // pointercancel. Window listeners are still the source of truth.
          }
        }
        document.body.removeAttribute("data-pane-resizing");
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (!belongsToGesture(moveEvent)) return;
        // Pointer coordinates are viewport pixels while pane widths live
        // inside the `zoom`-scaled shell, so unscale the movement delta.
        const delta = (moveEvent.clientX - startX) / (uiScaleRef.current || 1);
        const next = clampToFitRef.current(pane, pane === "sidebar" ? startSize + delta : startSize - delta);
        if (next === latest) return;
        latest = next;
        paint(next);
      };

      const onEnd = (endEvent: PointerEvent) => {
        if (!belongsToGesture(endEvent)) return;
        teardown();
        if (latest !== startSize) commitPaneSize(pane, latest);
        else if (pane === "dock") restoreDock();
      };

      cancelGesture = () => {
        teardown();
        if (pane === "dock") restoreDock();
        else if (latest !== startSize) paint(startSize);
      };

      const onPointerCancel = (cancelEvent: PointerEvent) => {
        if (belongsToGesture(cancelEvent)) cancelGesture();
      };

      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        cancelGesture();
      };

      cancelDragRef.current = cancelGesture;
      if (pointerId !== null && handle && typeof handle.setPointerCapture === "function") {
        try {
          handle.setPointerCapture(pointerId);
          captured = true;
        } catch {
          // Capture is an optimization. Window listeners still keep a normal
          // in-window drag live when the platform declines it.
        }
      }
      document.body.setAttribute("data-pane-resizing", pane);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown, true);
    },
    [commitPaneSize],
  );

  const resizePaneWithKeyboard = useCallback(
    (pane: PaneKey) => (event: ReactKeyboardEvent) => {
      // A committed size would re-run the layout effect and fight the pointer
      // for the same property, so the keyboard stands down while a drag runs.
      if (cancelDragRef.current) return;
      const { min } = PANE_BOUNDS[pane];
      const max = pane === "dock" ? Math.min(PANE_BOUNDS.dock.max, dockMaxRef.current) : PANE_BOUNDS[pane].max;
      const savedSize = paneSizesRef.current[pane];
      const size = pane === "dock" && autoDockRef.current ? measuredPaneSize(paneRootsRef.current.dock, pane, savedSize) : savedSize;
      const current = clampToFitRef.current(pane, size);
      // The sidebar grows rightwards and the dock leftwards, so each arrow
      // moves the edge the way the pointer would.
      const step = pane === "sidebar" ? KEYBOARD_STEP : -KEYBOARD_STEP;
      let next: number;
      switch (event.key) {
        case "ArrowLeft":
          next = clampToFitRef.current(pane, current - step);
          break;
        case "ArrowRight":
          next = clampToFitRef.current(pane, current + step);
          break;
        case "Home":
          next = min;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (next !== current) commitPaneSize(pane, next);
    },
    [commitPaneSize],
  );

  const desiredDockWidth = autoDockRef.current ? Math.max(420, windowWidth * 0.3) : paneSizes.dock;
  const dockWidth = Math.min(desiredDockWidth, dockMax);
  return { paneSizes, dockWidth, dockMax, dockOverlay: toolsNeedOverlay(windowWidth, uiScale), sidebarCrowded, paneRefs, startPaneResize, resizePaneWithKeyboard };
}
