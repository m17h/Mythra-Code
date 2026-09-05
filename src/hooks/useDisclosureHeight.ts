import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export const DISCLOSURE_OPEN_MS = 200;
export const DISCLOSURE_CLOSE_MS = 180;
export const DISCLOSURE_EASING = "cubic-bezier(.2, .7, .3, 1)";

/** Animate an unpadded clipping wrapper; spacing belongs to its inner content.
 * Keep text at full opacity so the reveal starts visibly on the first frame. */
export function useDisclosureHeight<T extends HTMLElement>(open: boolean): {
  ref: RefObject<T | null>;
  present: boolean;
} {
  const ref = useRef<T>(null);
  const [present, setPresent] = useState(open);
  const previousOpenRef = useRef(open);
  const runningRef = useRef<{ animation: Animation; cancel: () => void } | null>(null);

  useLayoutEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open) setPresent(true);
    const element = ref.current;
    if (!element || wasOpen === open) return;

    // Capture the current painted height before cancelling a previous run.
    // Computed styles use CSS pixels even when the app has a UI zoom applied.
    const previous = runningRef.current;
    const fromHeight = previous || !open ? getComputedStyle(element).height : "0px";
    previous?.cancel();
    runningRef.current = null;
    element.style.height = "";
    const naturalHeight = element.offsetHeight;

    // Commit the destination before playing: the closing box stays at zero
    // between the final frame and React's unmount, with no flash of its rows.
    element.style.height = open ? "" : "0px";
    element.style.overflow = "hidden";
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (typeof element.animate !== "function" || !reduced || reduced.matches) {
      if (open) element.style.overflow = "";
      else setPresent(false);
      return;
    }

    const destination = open ? naturalHeight : 0;
    const distance = Math.abs(destination - parseFloat(fromHeight));
    const duration = (open ? DISCLOSURE_OPEN_MS : DISCLOSURE_CLOSE_MS)
      * Math.min(1, distance / Math.max(1, naturalHeight));
    const animation = element.animate(
      [{ height: fromHeight }, { height: `${destination}px` }],
      { duration, easing: DISCLOSURE_EASING, fill: "backwards" },
    );
    const onMotionChange = () => { if (reduced.matches) animation.finish(); };
    const release = () => {
      animation.onfinish = null;
      reduced.removeEventListener?.("change", onMotionChange);
    };
    const finish = () => {
      // WebKit can deliver an older finish after a rapid reversal. It must
      // neither unmount the reopened list nor release its clipping early.
      if (runningRef.current?.animation !== animation) return;
      release();
      runningRef.current = null;
      if (open) element.style.overflow = "";
      else setPresent(false);
    };
    runningRef.current = { animation, cancel: () => { release(); animation.cancel(); } };
    animation.onfinish = finish;
    void animation.finished.then(finish, () => {});
    reduced.addEventListener?.("change", onMotionChange);
  }, [open]);

  useLayoutEffect(() => () => {
    runningRef.current?.cancel();
    runningRef.current = null;
  }, []);

  return { ref, present: open || present };
}
