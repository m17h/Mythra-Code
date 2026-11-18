// Base theme values, read from the real stylesheet. A hidden probe element
// <div class="app-shell" data-theme=BASE data-color-scheme=…> is measured
// with getComputedStyle, so nothing in tokens.css is duplicated in JS. The
// html[data-platform] rules (Windows ink easing) apply to the probe too.
//
// Outside a browser (node tests) a reader must be installed with
// setBaseTokenReader; the tests parse tokens.css for it.

import type { ThemeName } from "../../types";
import { DERIVED_ONLY_VARS, KIT_TOKENS, builtInScheme } from "./spec";

/** CSS variable -> computed value (e.g. "--bg" -> "#212226"). */
export type ResolvedTokens = Readonly<Record<string, string>>;
export type BaseTokenReader = (base: ThemeName, scheme: "light" | "dark") => ResolvedTokens;

/** Every variable the engine needs from a base theme. */
export const BASE_VARS: readonly string[] = Array.from(new Set([
  ...KIT_TOKENS.map((token) => token.cssVar).filter((name) => name !== "--ct-shadow-tint"),
  ...DERIVED_ONLY_VARS,
  "--font-sans", "--font-mono", "--font-display",
]));

let customReader: BaseTokenReader | null = null;
const cache = new Map<string, ResolvedTokens>();

/** Install a reader (tests, or a host that already knows the values). Clears the cache. */
export function setBaseTokenReader(reader: BaseTokenReader | null): void {
  customReader = reader;
  cache.clear();
}

/** Drop cached probe results (for example after the platform attribute changes). */
export function clearBaseTokenCache(): void {
  cache.clear();
}

function platformKey(): string {
  if (typeof document === "undefined") return "none";
  return document.documentElement.getAttribute("data-platform") ?? "other";
}

function probe(base: ThemeName, scheme: "light" | "dark"): ResolvedTokens {
  if (typeof document === "undefined" || !document.body) return {};
  const el = document.createElement("div");
  el.className = "app-shell";
  el.setAttribute("data-theme", base);
  el.setAttribute("data-color-scheme", scheme);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-ct-probe", "");
  el.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  try {
    const style = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const name of BASE_VARS) {
      const value = style.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return out;
  } finally {
    el.remove();
  }
}

/** Base values for a built-in theme on this platform (cached). */
export function readBaseTokens(base: ThemeName): ResolvedTokens {
  const scheme = builtInScheme(base);
  const key = `${base}|${platformKey()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const values = customReader ? customReader(base, scheme) : probe(base, scheme);
  // Only cache a usable read; a probe that ran before the stylesheet loaded is retried next time.
  if (values["--bg"] && values["--text"]) cache.set(key, values);
  return values;
}
