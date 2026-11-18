// Small pieces shared by the Custom themes row in Settings and the Theme
// library window: relative times, tile captions, the author phrase and the
// system reduce-motion preference.

import { useEffect, useState } from "react";
import { headSpec, providerName, type CustomThemeRecord } from "../lib/customThemes/store";
import { builtInScheme, type EffectType } from "../lib/customThemes/spec";
import { effectMoves } from "../lib/customThemes/compile";

export const USER = { kind: "user" } as const;

/** "just now", "3 min ago", "2 h ago", "4 days ago", then a date. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function hasMotion(record: CustomThemeRecord): boolean {
  const spec = headSpec(record);
  // Only effects that actually move (static grain or a vignette is not "Animated").
  return Object.entries(spec.effects ?? {}).some(([type, params]) => Boolean(params) && effectMoves(type as EffectType, (params ?? {}) as Record<string, unknown>))
    || /animation/i.test(spec.customCss ?? "");
}

export function tileMeta(record: CustomThemeRecord): string {
  const spec = headSpec(record);
  const parts: string[] = [];
  if (record.disabledReason) parts.push("Turned off");
  else if (hasMotion(record) && spec.motion?.enabled !== false) parts.push("Animated");
  parts.push(builtInScheme(spec.base) === "light" ? "Light" : "Dark");
  return parts.join(" · ");
}

export function authorPhrase(record: CustomThemeRecord): string {
  return record.createdBy.kind === "user" ? "Made by you" : `Made by ${providerName(record.createdBy.provider)}`;
}

export function useReducedMotion(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(Boolean(query?.matches));
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [query]);
  return reduced;
}
