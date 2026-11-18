/**
 * The one on/off switch (pro-ui: accent track when on, recessed neutral track
 * when off, a knob that slides; never a native checkbox).
 *
 * Two shapes share one look: the `.toggle-switch` style that Settings'
 * `Switch` (SettingsBits.tsx) also uses, plus the size and track variants in
 * `src/styles/lumen/primitives.css`:
 *
 * - `<Switch>` is the control itself, for rows that keep their own label
 *   outside it. Give it `label` (or `labelledBy`) so it has a name.
 * - `<SwitchTrack>` is only the picture. Use it when a whole row is the
 *   control (`<button role="switch" aria-checked>` wrapping an icon, a title,
 *   a description and the track), which gives a much larger hit target.
 *
 * `size="sm"` (28×16) is for menus and dense lists; `md` (34×20) is the
 * default for Settings-style rows.
 */
export type SwitchSize = "sm" | "md";

export function SwitchTrack({ on, size = "md", className = "" }: { on: boolean; size?: SwitchSize; className?: string }) {
  return <span className={`toggle-switch lm-switch lm-switch-${size}${on ? " on" : ""}${className ? ` ${className}` : ""}`} aria-hidden="true"><span /></span>;
}

export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
  unavailable,
  onUnavailable,
  size = "md",
  className = "",
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name when there is no visible label to point at. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  /** Focusable but inert: announces `aria-disabled` and calls `onUnavailable` instead. */
  unavailable?: boolean;
  onUnavailable?: () => void;
  size?: SwitchSize;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={unavailable || undefined}
      disabled={disabled}
      title={title}
      className={`toggle-switch lm-switch lm-switch-${size}${checked ? " on" : ""}${unavailable ? " unavailable" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => {
        if (unavailable) { onUnavailable?.(); return; }
        onChange(!checked);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
