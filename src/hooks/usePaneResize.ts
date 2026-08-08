import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
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
  dock: { min: 340, max: 680 },
};

/**
 * The panes are sized off these custom properties rather than off inline
 * React styles. A drag can then move the edge by writing one property on the
 * shell — no render, and no risk of a render that happens to land mid-drag
 * (a streaming token, a status tick) stomping the live position back to the
 * last committed value.
 */
const PANE_VARIABLE: Record<PaneKey, string> = {
  sidebar: "--sidebar-width",
  dock: "--dock-width",
};

const KEYBOARD_STEP = 16;

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

function writePaneVariable(shell: HTMLElement | null, pane: PaneKey, size: number): void {
  shell?.style.setProperty(PANE_VARIABLE[pane], `${size}px`);
}

export interface PaneResizeApi {
  paneSizes: PaneSizes;
  /** Attach to the app shell: it owns the pane width custom properties. */
  shellRef: RefObject<HTMLDivElement | null>;
  startPaneResize: (pane: PaneKey) => (event: ReactPointerEvent) => void;
  resizePaneWithKeyboard: (pane: PaneKey) => (event: ReactKeyboardEvent) => void;
}

export function usePaneResize(uiScale: number): PaneResizeApi {
  const [paneSizes, setPaneSizes] = useState<PaneSizes>(() =>
    normalizePaneSizes(loadStored("kiwi.paneSizes", DEFAULT_PANE_SIZES)),
  );
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;

  const shellRef = useRef<HTMLDivElement | null>(null);
  // Cancellation of the gesture currently in flight, if any. Held so a new
  // drag — or an unmount — both detaches the previous listeners and restores
  // its last committed width.
  const cancelDragRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  // The committed size reaches the DOM here and nowhere else, so React only
  // writes the property when the value actually changed (drag end, keyboard,
  // first paint). During a drag this effect does not run at all.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    writePaneVariable(shell, "sidebar", paneSizes.sidebar);
    writePaneVariable(shell, "dock", paneSizes.dock);
  }, [paneSizes]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelDragRef.current?.();
    };
  }, []);

  const commitPaneSize = useCallback((pane: PaneKey, size: number) => {
    const current = paneSizesRef.current;
    // A press with no movement, or a drag that only pushed further past a
    // clamp, has nothing to commit — and nothing to write to storage.
    if (current[pane] === size) return;
    const next = { ...current, [pane]: size };
    paneSizesRef.current = next;
    if (mountedRef.current) setPaneSizes(next);
    storeValue("kiwi.paneSizes", next);
  }, []);

  const startPaneResize = useCallback(
    (pane: PaneKey) => (event: ReactPointerEvent) => {
      if (event.button > 0) return;
      event.preventDefault();
      cancelDragRef.current?.();

      // React clears `currentTarget` once the handler returns, so both nodes
      // are read out synchronously and kept by value.
      const handle: Element | null = event.currentTarget;
      const shell = shellRef.current;
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
      const startX = event.clientX;
      const startSize = paneSizesRef.current[pane];
      let latest = startSize;
      let captured = false;

      const belongsToGesture = (candidate: PointerEvent) =>
        pointerId === null
        || !Number.isFinite(candidate.pointerId)
        || candidate.pointerId === pointerId;

      const paint = (size: number) => {
        writePaneVariable(shell, pane, size);
        handle?.setAttribute("aria-valuenow", String(Math.round(size)));
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
        const next = clampPaneSize(pane, pane === "sidebar" ? startSize + delta : startSize - delta);
        if (next === latest) return;
        latest = next;
        paint(next);
      };

      const onEnd = (endEvent: PointerEvent) => {
        if (!belongsToGesture(endEvent)) return;
        teardown();
        commitPaneSize(pane, latest);
      };

      cancelGesture = () => {
        teardown();
        if (latest !== startSize) paint(startSize);
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
      const { min, max } = PANE_BOUNDS[pane];
      const current = paneSizesRef.current[pane];
      // The sidebar grows rightwards and the dock leftwards, so each arrow
      // moves the edge the way the pointer would.
      const step = pane === "sidebar" ? KEYBOARD_STEP : -KEYBOARD_STEP;
      let next: number;
      switch (event.key) {
        case "ArrowLeft":
          next = clampPaneSize(pane, current - step);
          break;
        case "ArrowRight":
          next = clampPaneSize(pane, current + step);
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
      commitPaneSize(pane, next);
    },
    [commitPaneSize],
  );

  return { paneSizes, shellRef, startPaneResize, resizePaneWithKeyboard };
}
