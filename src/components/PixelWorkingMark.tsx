import type { CSSProperties } from "react";
import "./PixelWorkingMark.css";

// 3×3 grid, row-major. A comet head walks the eight border cells clockwise
// with a three-cell fading trail; the center pulses once per revolution.
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
const CENTER = 4;
const TRAIL = 4;
// The frame shown when motion is unavailable: head on the first cell.
const restOpacity = (position: number) => {
  const distance = (RING.length - position) % RING.length;
  return distance < TRAIL ? 1 - distance / TRAIL : 0;
};
const CELLS = Array.from({ length: 9 }, (_, cell) => {
  if (cell === CENTER) return { cell, className: "core", style: { "--pixel-rest": 0.75 } as CSSProperties };
  const position = RING.indexOf(cell);
  return { cell, className: undefined, style: { "--pixel-step": position, "--pixel-rest": restOpacity(position) } as CSSProperties };
});

/**
 * Small dot-matrix working indicator in the foreground color. While `live`,
 * CSS keyframes (no script timers) sweep the ring; otherwise, and under
 * reduced motion or forced colors, it holds one static frame. Decorative:
 * the surrounding control carries the accessible label.
 */
export function PixelWorkingMark({ live = true, className }: { live?: boolean; className?: string }) {
  return (
    <span className={`pixel-working-mark${live ? " live" : ""}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {CELLS.map(({ cell, className: cellClass, style }) => <i key={cell} className={cellClass} style={style} />)}
    </span>
  );
}
