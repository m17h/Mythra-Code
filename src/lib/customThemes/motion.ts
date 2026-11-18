// Theme motion gating (DESIGN §5.1).
//
// Durable state (the user's switch, the theme's own switch, the OS reduced
// motion setting) decides `motion: "on" | "paused"`, which the shell carries
// as data-theme-motion. It changes rarely.
//
// Transient pauses (window hidden, app in the background, a pane-resize drag)
// never touch an attribute: they pause the running `ct-` CSS animations via
// the Web Animations API and stop canvas effects, so no part of the app is
// restyled. New `ct-` animations that start while paused are paused too.

import { useEffect, useState } from "react";

export type PauseReason = "hidden" | "background" | "drag";

const reasons = new Set<PauseReason>();
const pausedByUs = new Set<Animation>();
const subscribers = new Set<(paused: boolean) => void>();
let startListener: ((event: Event) => void) | null = null;
let rescanQueued = false;

function themeAnimations(): Animation[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    const name = (animation as Animation & { animationName?: string }).animationName;
    return typeof name === "string" && name.startsWith("ct-");
  });
}

function pauseAll(): void {
  for (const animation of themeAnimations()) {
    if (animation.playState === "running") {
      try { animation.pause(); pausedByUs.add(animation); } catch { /* finished or detached */ }
    }
  }
}

function notify(): void {
  const paused = reasons.size > 0;
  for (const subscriber of subscribers) {
    try { subscriber(paused); } catch { /* a subscriber's problem is its own */ }
  }
}

/** Pause theme animations for a transient reason (refcounted by reason). */
export function pauseThemeAnimations(reason: PauseReason): void {
  if (reasons.has(reason)) return;
  const first = reasons.size === 0;
  reasons.add(reason);
  if (!first) return;
  pauseAll();
  if (typeof document !== "undefined" && !startListener) {
    startListener = (event: Event) => {
      const name = (event as AnimationEvent).animationName;
      if (!name || !name.startsWith("ct-") || rescanQueued) return;
      rescanQueued = true;
      requestAnimationFrame(() => { rescanQueued = false; if (reasons.size) pauseAll(); });
    };
    document.addEventListener("animationstart", startListener, true);
  }
  notify();
}

/** Lift a transient pause; animations resume when no reason is left. */
export function resumeThemeAnimations(reason: PauseReason): void {
  if (!reasons.delete(reason) || reasons.size > 0) return;
  if (startListener) { document.removeEventListener("animationstart", startListener, true); startListener = null; }
  for (const animation of pausedByUs) {
    try { if (animation.playState === "paused") animation.play(); } catch { /* removed meanwhile */ }
  }
  pausedByUs.clear();
  notify();
}

export function isThemeMotionTransientlyPaused(): boolean {
  return reasons.size > 0;
}

/** Canvas effects subscribe to stop their frame loop while paused. Returns an unsubscribe. */
export function subscribeThemeMotion(callback: (paused: boolean) => void): () => void {
  subscribers.add(callback);
  return () => { subscribers.delete(callback); };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The user's OS asks apps to reduce motion (live). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/**
 * Motion state for the shell (data-theme-motion) plus the transient pauses.
 * Mount once (App). `motion` only changes with the user's switch, the theme's
 * switch or the OS setting; hidden/background/drag pauses go through the Web
 * Animations API instead.
 */
export function useThemeMotionGate(opts: { userPaused: boolean; themeMotion: boolean; pauseInBackground: boolean }): { motion: "on" | "paused"; reducedMotion: boolean } {
  const reducedMotion = useReducedMotion();
  const motion: "on" | "paused" = !opts.userPaused && opts.themeMotion && !reducedMotion ? "on" : "paused";

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => (document.hidden ? pauseThemeAnimations("hidden") : resumeThemeAnimations("hidden"));
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); resumeThemeAnimations("hidden"); };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !opts.pauseInBackground) { resumeThemeAnimations("background"); return; }
    const onBlur = () => pauseThemeAnimations("background");
    const onFocus = () => resumeThemeAnimations("background");
    if (typeof document !== "undefined" && typeof document.hasFocus === "function" && !document.hasFocus()) onBlur();
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("blur", onBlur); window.removeEventListener("focus", onFocus); resumeThemeAnimations("background"); };
  }, [opts.pauseInBackground]);

  useEffect(() => {
    // Pane-resize drags: pause while a .pane-resize handle is held, so the drag never competes with effects.
    if (typeof document === "undefined") return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".pane-resize")) pauseThemeAnimations("drag");
    };
    const onUp = () => resumeThemeAnimations("drag");
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      resumeThemeAnimations("drag");
    };
  }, []);

  return { motion, reducedMotion };
}
