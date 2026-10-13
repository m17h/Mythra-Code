import { useLayoutEffect, useRef, type RefObject } from "react";

export const SETTINGS_SHEET_RESIZE_MS = 320;
export const SETTINGS_SHEET_RESIZE_EASING = "cubic-bezier(.2,.86,.24,1)";

interface SheetSize { width: number; height: number }
interface SheetRun { animation: Animation; cancel: () => void }

// Computed styles use the sheet's own CSS pixels under the shell's UI zoom,
// and with border-box sizing they are the same box the keyframes set.
function sheetSize(element: HTMLElement): SheetSize {
  const style = getComputedStyle(element);
  return { width: parseFloat(style.width), height: parseFloat(style.height) };
}

/**
 * Resize the Settings sheet when `sizeKey` changes (reading size <-> the Usage
 * and Pricing dashboard size) without re-laying out or repainting the pane body
 * on every frame.
 *
 * CSS switches the sheet to its destination at once. The new pane is laid out
 * a single time there, then its scrolling body is held at that destination size
 * on its own layer (`data-sheet-resizing`) while only the sheet's frame,
 * navigation, header and footer follow the animated box. Text never scales.
 *
 * The previous size is held through the frame that mounts and paints the new
 * pane, and the animation starts on the frame after it, so a heavy mount
 * cannot swallow the opening frames of the motion.
 */
export function useSettingsSheetResize(
  dialogRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  sizeKey: string,
  open: boolean,
): void {
  // Once the class changes CSS already reports the destination, so the size
  // being left is remembered whenever the sheet settles.
  const settledRef = useRef<SheetSize | null>(null);
  const runningRef = useRef<SheetRun | null>(null);
  const sizeKeyRef = useRef(sizeKey);
  const openRef = useRef(open);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // The first observation records the initial size without forcing a
    // layout while the app mounts.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!runningRef.current) settledRef.current = sheetSize(dialog);
    });
    observer?.observe(dialog);
    return () => {
      observer?.disconnect();
      runningRef.current?.cancel();
      runningRef.current = null;
    };
  }, [dialogRef]);

  useLayoutEffect(() => {
    const wasOpen = openRef.current;
    const previousKey = sizeKeyRef.current;
    openRef.current = open;
    sizeKeyRef.current = sizeKey;
    const dialog = dialogRef.current;
    const content = contentRef.current;
    // Closing alone leaves a running resize to finish behind the exit.
    if (previousKey === sizeKey || !dialog || !content) return;

    // A reversal starts from the painted size of the interrupted run.
    const running = runningRef.current;
    const from = running ? sheetSize(dialog) : settledRef.current;
    running?.cancel();
    runningRef.current = null;
    const to = sheetSize(dialog);
    settledRef.current = to;

    // Opening straight into another size is covered by the entrance.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (
      !open || !wasOpen || !from || !reduced || reduced.matches || typeof dialog.animate !== "function"
      || (Math.abs(from.width - to.width) < 0.5 && Math.abs(from.height - to.height) < 0.5)
    ) return;

    dialog.style.setProperty("--settings-content-hold", `${parseFloat(getComputedStyle(content).height)}px`);
    dialog.dataset.sheetResizing = "";
    const animation = dialog.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: SETTINGS_SHEET_RESIZE_MS, easing: SETTINGS_SHEET_RESIZE_EASING },
    );
    animation.pause();
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        animation.play();
      });
    });

    const onMotionChange = () => { if (reduced.matches) animation.finish(); };
    // The keyframes are measured pixels; a window resize settles at once on
    // the live, clamped CSS size instead.
    const onResize = () => animation.finish();
    const release = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      animation.onfinish = null;
      reduced.removeEventListener?.("change", onMotionChange);
      window.removeEventListener("resize", onResize);
      delete dialog.dataset.sheetResizing;
      dialog.style.removeProperty("--settings-content-hold");
    };
    const finish = () => {
      // WebKit can deliver an older finish after a rapid reversal.
      if (runningRef.current?.animation !== animation) return;
      release();
      runningRef.current = null;
    };
    runningRef.current = { animation, cancel: () => { release(); animation.cancel(); } };
    animation.onfinish = finish;
    void animation.finished.then(finish, () => {});
    reduced.addEventListener?.("change", onMotionChange);
    window.addEventListener("resize", onResize);
  }, [dialogRef, contentRef, sizeKey, open]);
}
