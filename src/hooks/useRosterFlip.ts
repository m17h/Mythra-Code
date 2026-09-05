import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  FLIP_EPSILON,
  collectFlipElements,
  flipKeyframes,
  planFlipMoves,
  prefersReducedMotion,
  readFlipSnapshot,
  type FlipSnapshot,
} from "../lib/flipRoster";

/**
 * Long enough to read as one movement, short enough that a second click never
 * feels queued behind the first.
 */
export const ROSTER_FLIP_MS = 240;
const ROSTER_FLIP_EASING = "cubic-bezier(.2,.7,.25,1)";

export interface RosterFlip {
  /** Attach to the grid whose items move. */
  gridRef: (node: HTMLElement | null) => void;
  /**
   * Optional. A surface the grid sits inside whose own height follows it — a
   * bottom-anchored popover, say, whose top edge would otherwise leap the
   * moment the content under it grows.
   */
  surfaceRef: (node: HTMLElement | null) => void;
}

/**
 * Animate a grid's items between two layouts.
 *
 * The DOM is always left in its final, settled layout — no class lingers past
 * the gesture and no timer decides when the layout is "really" done. Each
 * committed change compares the layout it replaced with the one it produced
 * and plays the difference. That makes expanding and collapsing the same
 * operation in opposite directions, and an item that was merely pushed aside
 * by a neighbour travels just as smoothly as the one the user clicked.
 *
 * `signature` is what tells the hook a layout-affecting change is being
 * committed; it should fold in every piece of state that can move an item.
 */
export function useRosterFlip(signature: string): RosterFlip {
  const gridNodeRef = useRef<HTMLElement | null>(null);
  const surfaceNodeRef = useRef<HTMLElement | null>(null);
  const firstRef = useRef<FlipSnapshot | null>(null);
  const surfaceHeightRef = useRef<number | null>(null);
  const measuredRef = useRef<string | null>(null);
  const runningRef = useRef<Array<{ animation: Animation; settle: () => void }>>([]);
  const ownersRef = useRef(new WeakMap<HTMLElement, Animation>());

  // Measured during render, while the DOM still holds the layout this commit
  // is about to replace — the "First" of FLIP. Taking it here rather than
  // caching it after the previous commit means it can never be stale: a
  // provider logo that finished loading, a live worker row that appeared, a
  // resized window, all of it is already in what this reads.
  if (measuredRef.current !== signature) {
    measuredRef.current = signature;
    const grid = gridNodeRef.current;
    firstRef.current = grid ? readFlipSnapshot(collectFlipElements(grid)) : null;
    surfaceHeightRef.current = surfaceNodeRef.current?.offsetHeight ?? null;
  }

  const stop = useCallback(() => {
    for (const { animation, settle } of runningRef.current) {
      animation.onfinish = null;
      animation.oncancel = null;
      settle();
      animation.cancel();
    }
    runningRef.current = [];
  }, []);

  const gridRef = useCallback((node: HTMLElement | null) => {
    stop();
    gridNodeRef.current = node;
    // A grid that just mounted has no earlier layout to travel from, and one
    // that just unmounted must not leave its last one behind for a re-open.
    if (!node) firstRef.current = null;
  }, [stop]);

  const surfaceRef = useCallback((node: HTMLElement | null) => {
    surfaceNodeRef.current = node;
    if (!node) surfaceHeightRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const container = gridNodeRef.current;
    const first = firstRef.current;
    if (!container) return;

    // An in-flight run is cancelled before anything is measured: its inverse
    // transforms belong to a layout that no longer exists.
    stop();
    if (!first || prefersReducedMotion()) return;

    const elements = collectFlipElements(container);
    const last = readFlipSnapshot(elements);
    const surface = surfaceNodeRef.current;
    const surfaceFrom = surfaceHeightRef.current;
    const surfaceTo = surface ? surface.offsetHeight : null;

    const animations: Array<{ animation: Animation; settle: () => void }> = [];
    const play = (element: HTMLElement, keyframes: Keyframe[], clip: boolean) => {
      // jsdom and other layout-less hosts have no Web Animations API. The
      // committed layout is already correct there, so skipping is harmless.
      if (typeof element.animate !== "function") return;
      // A box mid-resize is smaller than the content it already holds.
      // Clipping for the duration keeps that content from spilling over its
      // neighbours.
      if (clip) element.dataset.flipResizing = "true";
      const animation = element.animate(keyframes, { duration: ROSTER_FLIP_MS, easing: ROSTER_FLIP_EASING });
      const owners = ownersRef.current;
      if (clip) owners.set(element, animation);
      const settle = () => {
        if (owners.get(element) !== animation) return;
        owners.delete(element);
        delete element.dataset.flipResizing;
      };
      animation.onfinish = settle;
      animation.oncancel = settle;
      // WebKit may resolve finished before dispatching the finish event.
      // Both paths are safe, including delayed events from a replaced run.
      void animation.finished?.then(settle, settle);
      animations.push({ animation, settle });
    };

    // The surface first: it is what the moved items are positioned inside, so
    // growing it in step is what keeps the panel around them still. It is
    // deliberately not clipped — forcing `overflow: hidden` on a scrolling
    // popover would reset the reader's scroll position mid-gesture.
    if (surface && surfaceFrom !== null && surfaceTo !== null && Math.abs(surfaceFrom - surfaceTo) > FLIP_EPSILON) {
      play(surface, [{ height: `${surfaceFrom}px` }, { height: `${surfaceTo}px` }], false);
    }

    for (const move of planFlipMoves(first, last)) {
      const element = elements.get(move.key);
      if (element) play(element, flipKeyframes(move), move.resized);
    }
    runningRef.current = animations;
  }, [signature, stop]);

  useEffect(() => stop, [stop]);

  // Stable, so a caller can compose these into its own ref callbacks without
  // React detaching and re-attaching them on every render.
  return useMemo(() => ({ gridRef, surfaceRef }), [gridRef, surfaceRef]);
}
