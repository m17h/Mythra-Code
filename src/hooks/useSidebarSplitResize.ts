import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { loadStored, storeValue } from "../lib/storage";

const DEFAULT_SPLIT_RATIO = 0.3;
const MIN_PROJECTS_HEIGHT = 104;
const MIN_THREADS_HEIGHT = 148;

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

export function useSidebarSplitResize() {
  const [splitRatio, setSplitRatio] = useState(() =>
    clampSidebarSplitRatio(loadStored<number>("kiwi.sidebarSplitRatio", DEFAULT_SPLIT_RATIO), Number.POSITIVE_INFINITY),
  );
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;

  const startSidebarSplitResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    // The container's box is fixed for the duration of the drag — only the split
    // inside it moves — so it is measured once here. Re-measuring per pointer
    // event forced a synchronous layout right after the previous commit had
    // dirtied it, which is the classic read-after-write layout thrash.
    const bounds = container.getBoundingClientRect();
    // Held-and-committed once per frame for the same reason as the pane
    // resizer: the ratio feeds the whole App tree, and pointer events outpace
    // painted frames.
    let latestY = event.clientY;
    let moved = false;
    let frame: number | null = null;

    const commit = () => {
      frame = null;
      // A press with no movement is not a resize: the separator has height, so
      // deriving a ratio from the press position alone would nudge the split.
      if (!moved) return;
      const next = clampSidebarSplitRatio((latestY - bounds.top) / bounds.height, bounds.height);
      // Once the pointer is beyond a clamped limit, further moves in the same
      // direction should not keep re-rendering the App with an identical ratio.
      if (splitRatioRef.current === next) return;
      splitRatioRef.current = next;
      setSplitRatio(next);
    };

    const onMove = (moveEvent: PointerEvent) => {
      latestY = moveEvent.clientY;
      moved = true;
      if (frame === null) frame = requestAnimationFrame(commit);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (frame !== null) cancelAnimationFrame(frame);
      commit();
      storeValue("kiwi.sidebarSplitRatio", splitRatioRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }, []);

  const resizeSidebarSplitWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const containerHeight = event.currentTarget.parentElement?.getBoundingClientRect().height ?? 0;
    const { min, max } = ratioBounds(containerHeight);
    const next = event.key === "Home"
      ? min
      : event.key === "End"
        ? max
        : clampSidebarSplitRatio(splitRatioRef.current + (event.key === "ArrowUp" ? -0.035 : 0.035), containerHeight);
    splitRatioRef.current = next;
    setSplitRatio(next);
    storeValue("kiwi.sidebarSplitRatio", next);
  }, []);

  return { splitRatio, startSidebarSplitResize, resizeSidebarSplitWithKeyboard };
}
