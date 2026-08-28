/**
 * FLIP geometry for a grid whose items change place and size.
 *
 * CSS can transition a box's own size, but it cannot transition an item's
 * *position* in a grid: the moment a tile claims a different column span the
 * whole track layout is recomputed and every sibling is simply somewhere else
 * on the next frame. Animating the boxes themselves would fight the layout, so
 * this measures the old and new layouts instead and hands back the inverse
 * offsets an animation can play from — the F(irst) L(ast) I(nvert) half of
 * FLIP, with P(lay) left to {@link useRosterFlip}.
 *
 * Everything here is pure so the arithmetic that decides "did this move?" can
 * be tested without a layout engine.
 */

/** A measured box, in viewport pixels. */
export interface FlipBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The measured layout of one roster, keyed by `data-flip-key`. */
export type FlipSnapshot = Map<string, FlipBox>;

/** One item's inverse offset: where it *was*, relative to where it now is. */
export interface FlipMove {
  key: string;
  /** Horizontal offset that puts the item back at its old position. */
  dx: number;
  /** Vertical offset that puts the item back at its old position. */
  dy: number;
  from: FlipBox;
  to: FlipBox;
  /** The box itself changed size, so its geometry has to animate too. */
  resized: boolean;
}

/**
 * Sub-pixel drift from fractional track sizing is not movement. Animating it
 * would promote every tile in the roster on every render for nothing.
 */
export const FLIP_EPSILON = 0.5;

/** Index the animatable children of a container by their `data-flip-key`. */
export function collectFlipElements(container: Element | null | undefined): Map<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  if (!container) return elements;
  for (const element of container.querySelectorAll<HTMLElement>("[data-flip-key]")) {
    const key = element.dataset.flipKey;
    // Keys are a roster's own identities, so a duplicate would be a bug
    // elsewhere; first-wins keeps this measurement deterministic either way.
    if (key && !elements.has(key)) elements.set(key, element);
  }
  return elements;
}

/**
 * Measure every indexed element. Call once per layout, never per element.
 *
 * Offsets rather than client rects, because this compares *layouts*: the
 * roster lives inside a scrollable popover that plays its own entrance
 * transform, and either of those would otherwise show up as movement the grid
 * never actually made.
 */
export function readFlipSnapshot(elements: Map<string, HTMLElement>): FlipSnapshot {
  const snapshot: FlipSnapshot = new Map();
  for (const [key, element] of elements) {
    snapshot.set(key, {
      top: element.offsetTop,
      left: element.offsetLeft,
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
  }
  return snapshot;
}

/**
 * The inverse offsets that would put `last` back on top of `first`.
 *
 * Items that only exist in one of the two layouts are skipped: a tile that was
 * just added has no previous position to travel from, and one that was removed
 * has no element left to animate.
 */
export function planFlipMoves(first: FlipSnapshot, last: FlipSnapshot): FlipMove[] {
  const moves: FlipMove[] = [];
  for (const [key, to] of last) {
    const from = first.get(key);
    if (!from) continue;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const resized = Math.abs(from.width - to.width) > FLIP_EPSILON
      || Math.abs(from.height - to.height) > FLIP_EPSILON;
    if (!resized && Math.abs(dx) <= FLIP_EPSILON && Math.abs(dy) <= FLIP_EPSILON) continue;
    moves.push({ key, dx, dy, from, to, resized });
  }
  return moves;
}

/**
 * The keyframes one move plays.
 *
 * Every move stays on `transform`, including the tile whose box changed size.
 * Animating its real width/height would make CSS Grid recalculate every track
 * on every frame; siblings would briefly jump to those intermediate layouts
 * before their own inverse transforms caught up. Scaling the committed final
 * box keeps the grid completely still while the compositor plays the visual
 * transition.
 */
export function flipKeyframes(move: FlipMove): Keyframe[] {
  if (!move.resized) {
    return [
      { transform: `translate(${move.dx}px, ${move.dy}px)` },
      { transform: "translate(0px, 0px)" },
    ];
  }
  const scaleX = move.to.width > 0 ? move.from.width / move.to.width : 1;
  const scaleY = move.to.height > 0 ? move.from.height / move.to.height : 1;
  return [
    {
      transform: `translate(${move.dx}px, ${move.dy}px) scale(${scaleX}, ${scaleY})`,
      transformOrigin: "top left",
    },
    {
      transform: "translate(0px, 0px) scale(1, 1)",
      transformOrigin: "top left",
    },
  ];
}

/** Honour the OS motion preference; missing `matchMedia` means "animate". */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // Some embedded webviews reject unknown media features rather than
    // reporting no match. An unreadable preference is not a stated one.
    return false;
  }
}
