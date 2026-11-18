import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "../lib/flipRoster";

/**
 * A panel that grows open and shrinks closed instead of snapping.
 *
 * The height eases between `grid-template-rows: 0fr` and `1fr` (no measuring),
 * and the content fades and settles a few pixels. Closing keeps the content
 * on screen until the transition finishes; only then is it `hidden`. While it
 * is leaving it is already `inert`, so nothing inside can take focus or be
 * read out. Under reduced motion, or with `animate={false}` (a search result or
 * a hand-off that should land straight on the open panel), it switches at once.
 */
type Phase = "closed" | "opening" | "expanding" | "open" | "closing";

/** Upper bound for a transition that never reports its end (unsupported
    property, hidden window). A little longer than --lm-d-3 (240ms). */
const SETTLE_MS = 320;

export function SmoothDisclosure({
  open,
  animate = true,
  id,
  className,
  role,
  labelledBy,
  children,
}: {
  open: boolean;
  animate?: boolean;
  id?: string;
  className?: string;
  role?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const instant = !animate || prefersReducedMotion();
    setPhase((current) => {
      if (open) {
        if (instant) return "open";
        if (current === "closed") return "opening";
        return current === "closing" ? "expanding" : current;
      }
      if (instant || current === "closed") return "closed";
      return "closing";
    });
  }, [open, animate]);

  // The panel is in the layout at 0fr now. Read its size so the browser commits
  // that starting point, then let it grow (otherwise it would appear at 1fr).
  useLayoutEffect(() => {
    if (phase !== "opening") return;
    void ref.current?.offsetHeight;
    setPhase((current) => current === "opening" ? "expanding" : current);
  }, [phase]);

  useEffect(() => {
    if (phase !== "expanding" && phase !== "closing") return;
    const node = ref.current;
    const settle = () => setPhase((current) => {
      if (current !== phase) return current;
      return phase === "closing" ? "closed" : "open";
    });
    const onEnd = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === "grid-template-rows") settle();
    };
    node?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(settle, SETTLE_MS);
    return () => {
      node?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [phase]);

  const leaving = phase === "closing" || phase === "closed";
  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-labelledby={labelledBy}
      className={`smooth-disclosure${phase === "expanding" || phase === "open" ? " open" : ""}${phase === "open" ? " settled" : ""}${className ? ` ${className}` : ""}`}
      data-phase={phase}
      hidden={phase === "closed"}
      inert={leaving ? true : undefined}
    >
      <div className="smooth-disclosure-clip">{children}</div>
    </div>
  );
}
