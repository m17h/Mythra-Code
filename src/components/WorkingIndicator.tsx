import "./WorkingIndicator.css";

/**
 * The one "working" mark (round 6, I5): a small calm arc in currentColor,
 * used wherever something is running — the transcript's running digest, the
 * sidebar thread row and the top bar status. Only the mark, never text.
 *
 * - `label` given: the mark is announced once, as an image with that name
 *   (role="img" + aria-label; no second visually-hidden copy, so screen
 *   readers don't read it twice). Omitted: the mark is decorative
 *   (aria-hidden) and the surrounding text carries the meaning.
 * - Reduced motion: the arc stays still (a three-quarter ring still reads as
 *   "in progress"; it never looks like a drag handle).
 */
export function WorkingIndicator(props: { size?: number; label?: string; className?: string }) {
  const size = props.size ?? 12;
  const labelled = Boolean(props.label);
  return (
    <span
      className={`working-indicator${props.className ? ` ${props.className}` : ""}`}
      style={{ width: size, height: size }}
      {...(labelled ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 16 16" width={size} height={size} focusable="false" aria-hidden="true">
        <circle className="working-indicator-track" cx="8" cy="8" r="6.25" />
        <circle className="working-indicator-arc" cx="8" cy="8" r="6.25" pathLength="100" />
      </svg>
    </span>
  );
}
