import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * One color identity per reasoning-effort step, cool → inferno. Shared by
 * every provider's effort slider so "how hard is it thinking" reads the same
 * everywhere: blue is chill, green is cruising, amber is focused, orange is
 * pushing, red is maximum burn.
 */
export const EFFORT_COLORS = ["#4db6ff", "#43d97c", "#ffc531", "#ff8a2b", "#ff4655"];
const PIXEL_EFFORT_COLORS = ["#33d17a", "#33d17a", "#f6d32d", "#f6d32d", "#f66151"];
const AURORA_EFFORT_COLORS = ["#6ee7d8", "#7aa5ff", "#9d8cff", "#b98cff", "#ff8cd1"];
/** Tide: ocean blue rising into bright seafoam. */
const TIDE_EFFORT_COLORS = ["#4f7cff", "#3e99f5", "#2db6eb", "#2ed2dc", "#55ead2"];
/** Dart: deep racing emerald accelerating to acid lime. */
const DART_EFFORT_COLORS = ["#0e9b73", "#1cb46b", "#43cb5c", "#7ee04a", "#c2f23c"];
/** Coil: a cord under load, indigo winding up into magenta. */
const COIL_EFFORT_COLORS = ["#6a4fe0", "#8a4ce6", "#ab48e0", "#d144cf", "#f43fae"];

export function effortHeat(index: number, count: number): number {
  return count > 1 ? index / (count - 1) : 1;
}

function paletteColorAt(palette: string[], heat: number): string {
  return palette[Math.min(palette.length - 1, Math.round(heat * (palette.length - 1)))];
}

/** CSS variables the effort-slider flair styles and their gauge icons key off. */
export function effortFlairStyle(index: number, count: number): CSSProperties {
  const heat = effortHeat(index, count);
  return {
    "--effort-heat": String(heat),
    "--effort-color": paletteColorAt(EFFORT_COLORS, heat),
    "--pixel-effort-color": paletteColorAt(PIXEL_EFFORT_COLORS, heat),
    "--aurora-effort-color": paletteColorAt(AURORA_EFFORT_COLORS, heat),
    "--tide-effort-color": paletteColorAt(TIDE_EFFORT_COLORS, heat),
    "--dart-effort-color": paletteColorAt(DART_EFFORT_COLORS, heat),
    "--coil-effort-color": paletteColorAt(COIL_EFFORT_COLORS, heat),
  } as CSSProperties;
}

/** Particle burst at the slider thumb, replayed by keyed remount. */
export function EffortSparks({ fill }: { fill: number }) {
  return (
    <span className="effort-sparks" style={{ left: `${fill}%` }} aria-hidden="true">
      <i /><i /><i /><i /><i /><i /><i /><i />
    </span>
  );
}

function clampIndex(value: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.round(value)));
}

/**
 * The shared effort rail. The native range input stays for keyboard and
 * assistive tech, but pointer input is handled on the rail itself so the
 * thumb can move continuously under the pointer and snap to the nearest
 * level on release, while a plain click glides the thumb to its target
 * instead of teleporting. `index` is the committed level; the visual
 * position tweens toward it whenever it changes.
 */
export function EffortSlider({
  variant,
  index,
  count,
  ariaLabel,
  valueText,
  disabled,
  onIndex,
}: {
  variant: "codex" | "router";
  index: number;
  count: number;
  ariaLabel: string;
  valueText: string;
  disabled?: boolean;
  onIndex: (index: number) => void;
}) {
  const [visual, setVisual] = useState(index);
  const [dragging, setDragging] = useState(false);
  const visualRef = useRef(index);
  const railRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null);
  const interactedRef = useRef(false);
  const pendingInteractionIndexRef = useRef<number | null>(null);

  const setVisualNow = (value: number) => {
    visualRef.current = value;
    setVisual(value);
  };

  const tweenTo = (target: number) => {
    cancelAnimationFrame(frameRef.current);
    const from = visualRef.current;
    if (Math.abs(target - from) < 0.005) {
      setVisualNow(target);
      return;
    }
    const duration = Math.min(420, 150 + Math.abs(target - from) * 80);
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setVisualNow(from + (target - from) * eased);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  };

  // A local click/keyboard change glides to its committed level. External
  // changes (for example switching threads) snap immediately so the native
  // input and its accessible value never expose a stale in-between effort.
  useEffect(() => {
    if (dragRef.current) return;
    if (pendingInteractionIndexRef.current === index) {
      pendingInteractionIndexRef.current = null;
      tweenTo(index);
    } else {
      pendingInteractionIndexRef.current = null;
      cancelAnimationFrame(frameRef.current);
      setVisualNow(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const floatFromClientX = (clientX: number): number => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 16) return visualRef.current;
    const pad = 8; // half the thumb, so the extremes are reachable
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - pad) / (rect.width - pad * 2)));
    return ratio * (count - 1);
  };

  const commit = (target: number) => {
    interactedRef.current = true;
    if (target !== index) {
      pendingInteractionIndexRef.current = target;
      onIndex(target);
    }
    else tweenTo(target);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    railRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
    cancelAnimationFrame(frameRef.current);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    setVisualNow(floatFromClientX(event.clientX));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    // A drag snaps from where the thumb was left; a plain click glides the
    // thumb from its current position to the clicked level.
    const target = clampIndex(drag.moved ? visualRef.current : floatFromClientX(event.clientX), count);
    commit(target);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    setDragging(false);
    tweenTo(index);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") target = Math.min(count - 1, index + 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = Math.max(0, index - 1);
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = count - 1;
    if (target === null) return;
    event.preventDefault();
    commit(target);
  };

  const heat = effortHeat(visual, count);
  const fill = heat * 100;
  const railClass = variant === "codex" ? "reasoning-rail" : "openrouter-reasoning-rail";
  const ticksClass = variant === "codex" ? "reasoning-ticks" : "openrouter-reasoning-ticks";

  return (
    <div
      ref={railRef}
      className={`${railClass} ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
      style={{ "--reasoning-fill": `${fill}%`, "--effort-heat": String(heat), "--effort-color": paletteColorAt(EFFORT_COLORS, heat) } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <input
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        type="range"
        min={0}
        max={count - 1}
        step="any"
        value={visual}
        disabled={disabled}
        onKeyDown={onKeyDown}
        // Pointer input never reaches the native control (the rail handles
        // it), but assistive tech and tests still drive it through change
        // events — snap those straight to the nearest level.
        onChange={(event) => commit(clampIndex(Number(event.target.value), count))}
      />
      <div className={ticksClass} aria-hidden="true">
        {Array.from({ length: count }, (_, tick) => (
          <i key={tick} className={tick <= visual + 0.001 ? "reached" : ""} />
        ))}
      </div>
      {interactedRef.current && <EffortSparks key={index} fill={effortHeat(index, count) * 100} />}
    </div>
  );
}
