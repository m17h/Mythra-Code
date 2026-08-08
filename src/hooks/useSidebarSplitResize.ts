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

const DEFAULT_SPLIT_RATIO = 0.3;
const MIN_PROJECTS_HEIGHT = 104;
const MIN_THREADS_HEIGHT = 148;
const KEYBOARD_STEP = 0.035;

/**
 * The Projects/Threads split is sized off this custom property rather than an
 * inline React style, so a drag can move the divider by writing one property
 * on the container — no render, and no chance of an unrelated render landing
 * mid-drag and snapping the divider back to the last committed ratio.
 */
const SPLIT_VARIABLE = "--sidebar-split";

function ratioBounds(height: number): { min: number; max: number } {
  if (!Number.isFinite(height) || height <= 0) return { min: 0.15, max: 0.75 };
  const min = Math.min(0.45, MIN_PROJECTS_HEIGHT / height);
  const max = Math.max(min, Math.min(0.8, 1 - MIN_THREADS_HEIGHT / height));
  return { min, max };
}

export function clampSidebarSplitRatio(value: number, height: number): number {
  const { min, max } = ratioBounds(height);
  const normalized = Number.isFinite(value) ? value : DEFAULT_SPLIT_RATIO;
  return Math.min(max, Math.max(min, normalized));
}

/**
 * Two decimal places of a percentage is well under a tenth of a pixel in a
 * sidebar this size, and it keeps binary-fraction noise
 * (`55.00000000000001%`) out of the declaration.
 */
export function splitPercentage(ratio: number): string {
  return `${Math.round(ratio * 10000) / 100}%`;
}

function writeSplitVariable(container: HTMLElement | null, ratio: number): void {
  container?.style.setProperty(SPLIT_VARIABLE, splitPercentage(ratio));
}

export interface SidebarSplitResizeApi {
  splitRatio: number;
  /** Attach to `.sidebar-sections`: it owns the split custom property. */
  sidebarSectionsRef: RefObject<HTMLDivElement | null>;
  startSidebarSplitResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeSidebarSplitWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * `uiScale` is the shell's `zoom` factor. Client rects come back in viewport
 * pixels, but the section minimums are CSS pixels inside the scaled shell, so
 * the measured height is unscaled before the bounds are derived. The ratio
 * itself is scale-free.
 */
export function useSidebarSplitResize(uiScale = 1): SidebarSplitResizeApi {
  const [splitRatio, setSplitRatio] = useState(() =>
    clampSidebarSplitRatio(loadStored<number>("kiwi.sidebarSplitRatio", DEFAULT_SPLIT_RATIO), Number.POSITIVE_INFINITY),
  );
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;

  const sidebarSectionsRef = useRef<HTMLDivElement | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    writeSplitVariable(sidebarSectionsRef.current, splitRatio);
  }, [splitRatio]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelDragRef.current?.();
    };
  }, []);

  const commitSplitRatio = useCallback((ratio: number) => {
    if (splitRatioRef.current === ratio) return;
    splitRatioRef.current = ratio;
    if (mountedRef.current) setSplitRatio(ratio);
    storeValue("kiwi.sidebarSplitRatio", ratio);
  }, []);

  const startSidebarSplitResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button > 0) return;
    event.preventDefault();
    cancelDragRef.current?.();

    // React clears `currentTarget` once the handler returns, so the nodes are
    // read out synchronously and kept by value.
    const handle = event.currentTarget as HTMLElement | null;
    const container = sidebarSectionsRef.current ?? handle?.parentElement ?? null;
    if (!container) return;
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
    // The container's box is fixed for the duration of the drag — only the
    // split inside it moves — so it is measured once here. Re-measuring per
    // pointer event forced a synchronous layout right after the previous
    // write had dirtied it: the classic read-after-write layout thrash.
    const bounds = container.getBoundingClientRect();
    const boundsHeight = bounds.height / (uiScaleRef.current || 1);
    const startRatio = splitRatioRef.current;
    let latest = startRatio;
    let captured = false;

    const belongsToGesture = (candidate: PointerEvent) =>
      pointerId === null
      || !Number.isFinite(candidate.pointerId)
      || candidate.pointerId === pointerId;

    const paint = (ratio: number) => {
      writeSplitVariable(container, ratio);
      handle?.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
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
          // Pointer capture may already be released by the platform.
        }
      }
      document.body.removeAttribute("data-split-resizing");
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!belongsToGesture(moveEvent)) return;
      // A press with no movement is not a resize: the separator has height,
      // so deriving a ratio from the press position alone would nudge the
      // split. Only real moves reach this point.
      const next = clampSidebarSplitRatio((moveEvent.clientY - bounds.top) / bounds.height, boundsHeight);
      if (next === latest) return;
      latest = next;
      paint(next);
    };

    const onEnd = (endEvent: PointerEvent) => {
      if (!belongsToGesture(endEvent)) return;
      teardown();
      commitSplitRatio(latest);
    };

    cancelGesture = () => {
      teardown();
      if (latest !== startRatio) paint(startRatio);
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
        // Window listeners still drive an ordinary in-window drag.
      }
    }
    document.body.setAttribute("data-split-resizing", "true");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
  }, [commitSplitRatio]);

  const resizeSidebarSplitWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A committed ratio would re-run the layout effect and fight the pointer
    // for the same property, so the keyboard stands down while a drag runs.
    if (cancelDragRef.current) return;
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const container = sidebarSectionsRef.current ?? event.currentTarget.parentElement;
    const containerHeight = (container?.getBoundingClientRect().height ?? 0) / (uiScaleRef.current || 1);
    const { min, max } = ratioBounds(containerHeight);
    const next = event.key === "Home"
      ? min
      : event.key === "End"
        ? max
        : clampSidebarSplitRatio(
            splitRatioRef.current + (event.key === "ArrowUp" ? -KEYBOARD_STEP : KEYBOARD_STEP),
            containerHeight,
          );
    commitSplitRatio(next);
  }, [commitSplitRatio]);

  return { splitRatio, sidebarSectionsRef, startSidebarSplitResize, resizeSidebarSplitWithKeyboard };
}
