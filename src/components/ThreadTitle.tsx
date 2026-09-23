import { useEffect, useState } from "react";
import "./ThreadTitle.css";

/** Long enough for the last staggered puff to finish blowing away; after this
 *  the fog is unmounted, so nothing keeps animating behind a settled title. */
export const THREAD_TITLE_REVEAL_MS = 820;

const PUFFS = ["a", "b", "c", "d"] as const;
const GHOSTS = ["a", "b", "c"] as const;

interface ThreadTitleProps {
  title: string;
  /** While true the title is still being generated: `title` is never
   *  rendered (it is usually the raw prompt) and fog stands in for it. */
  pending: boolean;
  className?: string;
}

type ThreadTitleState = "pending" | "revealing" | "settled";

/**
 * A thread's name, or the fog it condenses out of while one is generated.
 *
 * Only a pending → settled change plays the reveal. A title that mounts
 * already settled, or is renamed later, simply renders — there is nothing
 * to reveal.
 */
export function ThreadTitle({ title, pending, className }: ThreadTitleProps) {
  // Tracked during render, not in an effect, so the frame that drops `pending`
  // already paints the reveal instead of one frame of bare title first.
  const [seenPending, setSeenPending] = useState(pending);
  const [revealing, setRevealing] = useState(false);
  if (pending !== seenPending) {
    setSeenPending(pending);
    setRevealing(!pending);
  }

  useEffect(() => {
    if (!revealing) return;
    const timer = window.setTimeout(() => setRevealing(false), THREAD_TITLE_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealing]);

  const state: ThreadTitleState = pending ? "pending" : revealing ? "revealing" : "settled";
  return (
    <span
      className={className ? `thread-title ${className}` : "thread-title"}
      data-state={state}
      aria-busy={pending || undefined}
    >
      {/* A no-break space holds the line box while pending: same height as a
          title, and nothing a person or a screen reader could read. */}
      <span className="thread-title-text" aria-hidden={pending || undefined}>{pending ? " " : title}</span>
      {state !== "settled" && (
        <span className="thread-title-fog" aria-hidden="true">
          {GHOSTS.map((ghost) => <span key={ghost} className={`thread-title-ghost ${ghost}`} />)}
          {PUFFS.map((puff) => <span key={puff} className={`thread-title-puff ${puff}`} />)}
        </span>
      )}
      {pending && <span className="sr-only">Generating title</span>}
    </span>
  );
}
