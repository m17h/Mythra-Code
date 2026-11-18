import { useLayoutEffect, useState, type RefObject } from "react";
import { topbarShedTarget, TOPBAR_SHED_MAX } from "../lib/topbarFit";

/**
 * B06: the top bar sheds chrome by the width it actually has, not by a fixed
 * container breakpoint. On every resize or content change it resets to the
 * full bar and steps through `TOPBAR_SHED` (stage.css reads `data-shed~="N"`)
 * until the thread title has room and nothing overflows. Status words are
 * never shed; they only switch to their short form at the last step.
 *
 * Returns the settled level so React can move shed items (idle usage, the
 * empty Pull requests chip) into the "…" menu.
 */
/**
 * Untruncated width of the heading's widest line. Ellipsized children report
 * their clipped width as scrollWidth when the text sits in a nested span, so
 * measure the laid-out text with a Range instead.
 */
function naturalWidth(heading: HTMLElement): number {
  let widest = 0;
  for (const child of Array.from(heading.children)) {
    const range = document.createRange();
    range.selectNodeContents(child);
    widest = Math.max(widest, range.getBoundingClientRect().width, (child as HTMLElement).scrollWidth);
  }
  return Math.ceil(widest);
}

export function useTopbarFit(topbarRef: RefObject<HTMLElement | null>): number {
  const [level, setLevel] = useState(0);

  useLayoutEffect(() => {
    const bar = topbarRef.current;
    if (!bar) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const heading = bar.querySelector<HTMLElement>(".project-heading");
      let next = 0;
      // Cumulative: level 3 writes "1 2 3", so CSS reads `[data-shed~="3"]`
      // as "at least level 3".
      bar.dataset.shed = "";
      while (next < TOPBAR_SHED_MAX) {
        const fits = topbarShedTarget({
          barClient: bar.clientWidth,
          barScroll: bar.scrollWidth,
          headingClient: heading?.clientWidth ?? 0,
          headingNatural: heading ? naturalWidth(heading) : 0,
        });
        if (fits) break;
        next += 1;
        bar.dataset.shed = Array.from({ length: next }, (_, index) => index + 1).join(" ");
      }
      setLevel(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resize?.observe(bar);
    // Content changes (status word, PR chip, usage figure, title) re-fit.
    // Attributes are not observed: `data-shed` itself must not retrigger.
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    mutation?.observe(bar, { childList: true, subtree: true, characterData: true });
    // Font loading changes text widths after first paint.
    void (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready?.then(schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [topbarRef]);

  return level;
}
