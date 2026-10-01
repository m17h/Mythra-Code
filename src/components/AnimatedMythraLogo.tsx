import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import "./AnimatedMythraLogo.css";

/** The website starts idling 1300ms after assembly begins: just after the last
 *  piece (0.36s delay + 0.9s) has landed. */
const ASSEMBLE_MS = 1300;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const FOLD = "M495 344 685 229q15-9 30 0l119 71-195 127Z";
const RIGHT = "M704 385 834 300v329q0 17-15 26l-111 67q-20 12-20-12V408Z";
const MID = "M414 405 610 522v217q0 15-13 23l-149 89q-23 14-23-14V454Z";
const LEFT = "M220 159l395 235q23 14 6 34l-68 78q-12 14-28 4L329 393v316q0 20-17 30-12 7-24 0l-107-64q-17-10-17-30V184C164 166 194 143.5 220 159Z";
const CARET = "M463 560 548 638 463 716v-56l24-22-24-22Z";
const SHEEN_POINTS = "-420,0 -260,0 -460,1024 -620,1024";

interface AnimatedMythraLogoProps {
  className?: string;
}

function setTilt(host: HTMLElement, rx: string, ry: string) {
  host.style.setProperty("--mythra-logo-rx", rx);
  host.style.setProperty("--mythra-logo-ry", ry);
}

/**
 * Plays the assembly (unless `assemble` is false) and keeps the idle effects
 * running only while the mark is on screen and the document is visible.
 * Returns a cleanup that leaves the mark assembled and still.
 */
function startMotion(host: HTMLElement, assemble: boolean) {
  let assembled = !assemble;
  let onScreen = true;
  let frame = 0;
  let timer = 0;
  const sync = () => {
    host.toggleAttribute("data-idle", assembled && onScreen && document.visibilityState === "visible");
  };

  if (assemble) {
    host.setAttribute("data-scattered", "");
    // Commit the scattered pose now, so dropping it next frame transitions
    // rather than snapping straight to the assembled mark.
    host.getBoundingClientRect();
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      host.removeAttribute("data-scattered");
      timer = window.setTimeout(() => {
        assembled = true;
        sync();
      }, ASSEMBLE_MS);
    });
  }

  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting;
        sync();
      })
    : null;
  observer?.observe(host);
  document.addEventListener("visibilitychange", sync);
  sync();

  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", sync);
    host.removeAttribute("data-scattered");
    host.removeAttribute("data-idle");
  };
}

/**
 * The Mythra.work hero mark: it assembles on mount, idles (breathes, glints,
 * blinks) while on screen, tilts toward the pointer, and comes apart on mouse
 * hover or on click, tap or keyboard activation.
 *
 * The markup renders the assembled mark, so it is visible before any effect
 * runs. With full motion a layout effect scatters it before first paint and
 * lets it assemble; with reduced motion it stays assembled and still.
 */
export function AnimatedMythraLogo({ className }: AnimatedMythraLogoProps) {
  // Instance-unique and reduced to characters that are safe inside url(#…).
  const ids = `mythra-logo-${useId().replace(/[^\w-]/g, "")}`;
  const url = (name: string) => `url(#${ids}-${name})`;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const reducedMotionRef = useRef(false);
  const tiltFrameRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [exploded, setExploded] = useState(false);

  useLayoutEffect(() => {
    const host = buttonRef.current;
    if (!host) return;
    const media = window.matchMedia(REDUCED_MOTION);
    let stopMotion: (() => void) | null = null;
    // Only the first run assembles; turning motion back on later just idles.
    let assemble = true;
    const apply = () => {
      stopMotion?.();
      stopMotion = null;
      reducedMotionRef.current = media.matches;
      if (media.matches) {
        window.cancelAnimationFrame(tiltFrameRef.current);
        tiltFrameRef.current = 0;
        setTilt(host, "0deg", "0deg");
      } else {
        stopMotion = startMotion(host, assemble);
      }
      assemble = false;
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      stopMotion?.();
      window.cancelAnimationFrame(tiltFrameRef.current);
      tiltFrameRef.current = 0;
    };
  }, []);

  const onPointerEnter = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") setExploded(true);
  };

  const onPointerLeave = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") setExploded(false);
    window.cancelAnimationFrame(tiltFrameRef.current);
    tiltFrameRef.current = 0;
    setTilt(event.currentTarget, "0deg", "0deg");
  };

  // Tilt writes CSS variables directly, at most once a frame; moves never render.
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (reducedMotionRef.current) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (tiltFrameRef.current) return;
    tiltFrameRef.current = window.requestAnimationFrame(() => {
      tiltFrameRef.current = 0;
      const host = buttonRef.current;
      if (!host || reducedMotionRef.current) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (pointerRef.current.x - rect.left) / rect.width - 0.5;
      const py = (pointerRef.current.y - rect.top) / rect.height - 0.5;
      setTilt(host, `${(-py * 12).toFixed(2)}deg`, `${(px * 16).toFixed(2)}deg`);
    });
  };

  const sheen = (
    <polygon className="mythra-logo__sheen" points={SHEEN_POINTS} fill={url("shine")} />
  );

  return (
    <div className={className ? `mythra-logo ${className}` : "mythra-logo"}>
      <button
        ref={buttonRef}
        type="button"
        className="mythra-logo__button"
        aria-label="Separate the Mythra Code logo pieces"
        aria-pressed={exploded}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onClick={() => setExploded((on) => !on)}
      >
        <svg className="mythra-logo__svg" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${ids}-cyan`} x1="170" y1="180" x2="620" y2="700" gradientUnits="userSpaceOnUse">
              <stop stopColor="#35E7F2" />
              <stop offset="1" stopColor="#08AEEA" />
            </linearGradient>
            <linearGradient id={`${ids}-blue`} x1="430" y1="400" x2="610" y2="840" gradientUnits="userSpaceOnUse">
              <stop stopColor="#148EFF" />
              <stop offset="1" stopColor="#1644E8" />
            </linearGradient>
            <linearGradient id={`${ids}-fold`} x1="500" y1="230" x2="820" y2="430" gradientUnits="userSpaceOnUse">
              <stop stopColor="#176BFA" />
              <stop offset="1" stopColor="#1247D9" />
            </linearGradient>
            <linearGradient id={`${ids}-shine`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${ids}-c-fold`}><use href={`#${ids}-p-fold`} /></clipPath>
            <clipPath id={`${ids}-c-right`}><use href={`#${ids}-p-right`} /></clipPath>
            <clipPath id={`${ids}-c-mid`}><use href={`#${ids}-p-mid`} /></clipPath>
            <clipPath id={`${ids}-c-left`}><use href={`#${ids}-p-left`} /></clipPath>
            <mask id={`${ids}-caret`}>
              <rect width="1024" height="1024" fill="#fff" />
              <path d={CARET} fill="#000" />
            </mask>
          </defs>
          <g className="mythra-logo__ghost">
            <path d={FOLD} />
            <path d={RIGHT} />
            <path d={MID} />
            <path d={LEFT} />
          </g>
          {/* Each piece: the outer g handles assemble/explode, the inner bob the idle breathing. */}
          <g className="mythra-logo__piece mythra-logo__piece--fold">
            <g className="mythra-logo__bob">
              <path id={`${ids}-p-fold`} d={FOLD} fill={url("fold")} />
              <g clipPath={url("c-fold")}>{sheen}</g>
            </g>
          </g>
          <g className="mythra-logo__piece mythra-logo__piece--right">
            <g className="mythra-logo__bob">
              <path id={`${ids}-p-right`} d={RIGHT} fill={url("cyan")} />
              <g clipPath={url("c-right")}>{sheen}</g>
            </g>
          </g>
          <g className="mythra-logo__piece mythra-logo__piece--mid">
            <g className="mythra-logo__bob">
              <path id={`${ids}-p-mid`} d={MID} fill={url("blue")} mask={url("caret")} />
              <g mask={url("caret")}>
                <g clipPath={url("c-mid")}>{sheen}</g>
              </g>
              <path className="mythra-logo__cursor" d={CARET} />
            </g>
          </g>
          <g className="mythra-logo__piece mythra-logo__piece--left">
            <g className="mythra-logo__bob">
              <path id={`${ids}-p-left`} d={LEFT} fill={url("cyan")} />
              <g clipPath={url("c-left")}>{sheen}</g>
            </g>
          </g>
        </svg>
      </button>
    </div>
  );
}
