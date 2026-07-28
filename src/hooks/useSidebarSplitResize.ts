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

  const updateFromClientY = useCallback((clientY: number, separator: HTMLElement, persist: boolean) => {
    const container = separator.parentElement;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const next = clampSidebarSplitRatio((clientY - bounds.top) / bounds.height, bounds.height);
    splitRatioRef.current = next;
    setSplitRatio(next);
    if (persist) storeValue("kiwi.sidebarSplitRatio", next);
  }, []);

  const startSidebarSplitResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const separator = event.currentTarget;

    const onMove = (moveEvent: PointerEvent) => {
      updateFromClientY(moveEvent.clientY, separator, false);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      storeValue("kiwi.sidebarSplitRatio", splitRatioRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }, [updateFromClientY]);

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
