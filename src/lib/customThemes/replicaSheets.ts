// Stylesheets for the live theme previews' shadow roots (CustomThemePreview).
//
//   appSheet()    every app stylesheet in the document, once, as one
//                 constructed sheet shared by all previews (adoptedStyleSheets
//                 shares the parsed rules, so 24 previews cost one parse).
//   themeSheet()  one theme compiled for a replica (compile.ts, scope
//                 "preview"), cached per theme revision and shared by every
//                 preview of it.
// The live theme's own <style> tags are left out: whatever is on screen never
// reaches a preview. Browsers without constructable stylesheets get the same
// text in a <style> per shadow root.

import { compileThemeCss } from "./compile";
import { CUSTOM_CSS_STYLE_ID, CUSTOM_THEME_STYLE_ID } from "./probe";
import { REPLICA_SIZE, rootToHost, serializeReplicaRules, type RuleLike } from "./replicaCss";
import type { CustomThemeId, ThemeSpec } from "./spec";

export interface ReplicaSheet { sheet: CSSStyleSheet | null; text: string }

const SKIPPED_STYLE_IDS = new Set([CUSTOM_THEME_STYLE_ID, CUSTOM_CSS_STYLE_ID]);

/** The replica's own rules: never move while still, and nothing inside takes a pointer. */
const REPLICA_BASE = `:host { all: initial; display: block; position: absolute; inset: 0; overflow: hidden; pointer-events: none; contain: strict; }
.ct-replica-frame { position: absolute; left: 0; top: 0; width: ${REPLICA_SIZE.width}px; height: ${REPLICA_SIZE.height}px; transform-origin: 0 0; }
.app-shell[data-ct-replica] { width: ${REPLICA_SIZE.width}px; height: ${REPLICA_SIZE.height}px; pointer-events: none; user-select: none; }
.app-shell[data-ct-replica][data-ct-still], .app-shell[data-ct-replica][data-ct-still] *, .app-shell[data-ct-replica][data-ct-still] *::before, .app-shell[data-ct-replica][data-ct-still] *::after { animation: none !important; transition: none !important; }
.app-shell[data-ct-replica] *, .app-shell[data-ct-replica] *::before, .app-shell[data-ct-replica] *::after { transition: none !important; }
.app-shell[data-ct-replica] .timeline { overflow: hidden; }`;

export const constructable = (): boolean => {
  try {
    return typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype && typeof document !== "undefined" && "adoptedStyleSheets" in Document.prototype;
  } catch {
    return false;
  }
};

function makeSheet(text: string): ReplicaSheet {
  if (!constructable()) return { sheet: null, text };
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return { sheet, text };
  } catch {
    return { sheet: null, text };
  }
}

function appSheets(): CSSStyleSheet[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.styleSheets).filter((sheet) => {
    const owner = sheet.ownerNode;
    if (owner instanceof Element && SKIPPED_STYLE_IDS.has(owner.id)) return false;
    return !sheet.disabled;
  });
}

let appCache: { key: string; value: ReplicaSheet } | null = null;
/** Time the last app sheet build took (ms), for measuring. */
export let lastAppSheetBuildMs = 0;

/**
 * The app's stylesheets for a replica, rebuilt only when a stylesheet is added
 * or removed (a lazily loaded chunk, or a dev hot update).
 */
export function appSheet(): ReplicaSheet {
  const sheets = appSheets();
  const lengths = sheets.map((sheet) => { try { return sheet.cssRules.length; } catch { return -1; } });
  const key = lengths.join(",");
  if (appCache && appCache.key === key) return appCache.value;
  const started = typeof performance !== "undefined" ? performance.now() : 0;
  const parts: string[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; /* a cross-origin sheet: not ours */ }
    parts.push(serializeReplicaRules(rules as unknown as ArrayLike<RuleLike>));
  }
  const value = makeSheet(`${rootToHost(parts.join("\n"))}\n${REPLICA_BASE}`);
  appCache = { key, value };
  lastAppSheetBuildMs = typeof performance !== "undefined" ? performance.now() - started : 0;
  try { performance.measure?.("mythra:theme-preview-app-sheet", { start: started, duration: lastAppSheetBuildMs }); } catch { /* measuring is optional */ }
  return value;
}

function platform(): "mac" | "windows" | "other" {
  if (typeof document === "undefined") return "other";
  const value = document.documentElement.getAttribute("data-platform");
  return value === "windows" || value === "mac" ? value : "other";
}

const themeCache = new Map<string, ReplicaSheet & { hasMotion: boolean }>();
const THEME_CACHE_LIMIT = 64;

/** One theme compiled for a replica. Cached per revision; specs are immutable per revision. */
export function themeSheet(id: CustomThemeId, revision: number, spec: ThemeSpec, customCssEnabled: boolean): ReplicaSheet & { hasMotion: boolean } {
  const key = `${id}:${revision}:${customCssEnabled ? 1 : 0}:${platform()}`;
  const hit = themeCache.get(key);
  if (hit) {
    themeCache.delete(key);
    themeCache.set(key, hit);
    return hit;
  }
  let text = "";
  let hasMotion = false;
  try {
    const compiled = compileThemeCss(spec, { id, scope: "preview", platform: platform(), customCssEnabled });
    text = compiled.css;
    hasMotion = compiled.hasMotion;
  } catch {
    // A theme that can't compile previews as its base theme.
  }
  const value = { ...makeSheet(text), hasMotion };
  themeCache.set(key, value);
  while (themeCache.size > THEME_CACHE_LIMIT) themeCache.delete(themeCache.keys().next().value as string);
  return value;
}

/** Put the app sheet and a theme sheet on a shadow root (or <style> tags where sheets can't be shared). */
export function adoptReplicaSheets(root: ShadowRoot, sheets: ReplicaSheet[]): void {
  const shared = sheets.every((entry) => entry.sheet);
  if (shared && "adoptedStyleSheets" in root) {
    root.adoptedStyleSheets = sheets.map((entry) => entry.sheet!);
    for (const el of Array.from(root.querySelectorAll("style[data-ct-replica-style]"))) el.remove();
    return;
  }
  const existing = Array.from(root.querySelectorAll<HTMLStyleElement>("style[data-ct-replica-style]"));
  sheets.forEach((entry, index) => {
    let el = existing[index];
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-ct-replica-style", "");
      root.insertBefore(el, root.firstChild ? root.childNodes[index] ?? null : null);
    }
    if (el.textContent !== entry.text) el.textContent = entry.text;
  });
  for (const extra of existing.slice(sheets.length)) extra.remove();
}
