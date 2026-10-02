import { useId } from "react";
import "./MythraMarkColors.css";

// Geometry copied verbatim from public/mythra-code-glyph.svg (the official
// static glyph); only the colour wiring differs, see MythraMarkColors.css.
const FOLD = "M495 344 685 229q15-9 30 0l119 71-195 127Z";
const RIGHT = "M704 385 834 300v329q0 17-15 26l-111 67q-20 12-20-12V408Z";
const MID = "M414 405 610 522v217q0 15-13 23l-149 89q-23 14-23-14V454Z";
const LEFT = "M190 159q15-9 30 0l395 235q23 14 6 34l-68 78q-12 14-28 4L329 393v316q0 20-17 30-12 7-24 0l-107-64q-17-10-17-30V184q0-17 14-25 6-4 12 0Z";
const CARET = "M463 560 548 638 463 716v-56l24-22-24-22Z";

interface MythraMarkProps {
  className?: string;
  /** Rendered size in CSS pixels; omit to size it with CSS. */
  size?: number;
  /** An accessible name. Without one the mark is decorative (aria-hidden). */
  title?: string;
}

/**
 * The static Mythra Code mark as inline SVG, so its colours follow the active
 * theme through CSS (MythraMarkColors.css) wherever it is shown in the app:
 * the sidebar brand, onboarding and other in-app branding. Gradient and mask
 * ids are instance-unique, so any number of marks can share a page.
 */
export function MythraMark({ className, size, title }: MythraMarkProps) {
  const ids = `mythra-mark-${useId().replace(/[^\w-]/g, "")}`;
  const url = (name: string) => `url(#${ids}-${name})`;
  return (
    <svg
      className={className ? `mythra-mark ${className}` : "mythra-mark"}
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${ids}-cyan`} x1="170" y1="180" x2="620" y2="700" gradientUnits="userSpaceOnUse">
          <stop className="mythra-mark-stop--cyan-a" stopColor="#35E7F2" />
          <stop className="mythra-mark-stop--cyan-b" offset="1" stopColor="#08AEEA" />
        </linearGradient>
        <linearGradient id={`${ids}-blue`} x1="430" y1="400" x2="610" y2="840" gradientUnits="userSpaceOnUse">
          <stop className="mythra-mark-stop--blue-a" stopColor="#148EFF" />
          <stop className="mythra-mark-stop--blue-b" offset="1" stopColor="#1644E8" />
        </linearGradient>
        <linearGradient id={`${ids}-fold`} x1="500" y1="230" x2="820" y2="430" gradientUnits="userSpaceOnUse">
          <stop className="mythra-mark-stop--fold-a" stopColor="#176BFA" />
          <stop className="mythra-mark-stop--fold-b" offset="1" stopColor="#1247D9" />
        </linearGradient>
        <mask id={`${ids}-caret`}>
          <rect width="1024" height="1024" fill="#fff" />
          <path d={CARET} fill="#000" />
        </mask>
      </defs>
      <path d={FOLD} fill={url("fold")} />
      <path d={RIGHT} fill={url("cyan")} />
      <path d={MID} fill={url("blue")} mask={url("caret")} />
      <path d={LEFT} fill={url("cyan")} />
    </svg>
  );
}
