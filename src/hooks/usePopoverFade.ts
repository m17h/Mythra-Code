import { useLayoutEffect, useRef, useState } from "react";

/** Shared usage-style fade; callers keep exit content mounted and inert. */
export function usePopoverFade(open: boolean) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(false);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) setPresent(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    const cancel = () => {
      if (animation) { animation.onfinish = null; animation.cancel(); }
      reduced?.removeEventListener?.("change", onMotionChange);
    };
    const finish = () => {
      panel.style.opacity = open ? "1" : "0";
      cancel();
      if (!open) setPresent(false);
    };
    const onMotionChange = () => { if (reduced?.matches) finish(); };
    if (!reduced || reduced.matches || !panel.animate) { finish(); return; }
    try {
      animation = panel.animate([{ opacity: getComputedStyle(panel).opacity }, { opacity: open ? 1 : 0 }], {
        duration: open ? 220 : 180, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards",
      });
      animation.onfinish = finish;
      reduced.addEventListener?.("change", onMotionChange);
    } catch { finish(); }
    return () => {
      // Freeze the painted opacity BEFORE cancelling so a quick reversal
      // continues from that point instead of flashing fully on/off.
      if (panel.isConnected) panel.style.opacity = getComputedStyle(panel).opacity;
      cancel();
    };
  }, [open]);

  return { ref: panelRef, present: open || present };
}
