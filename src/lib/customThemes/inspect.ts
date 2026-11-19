// The `layout` report a model reads after every theme change: the app's
// visible regions with their on-screen boxes, what each customCss selector
// matched (and a "did you mean" for the ones that matched nothing), and
// whether each decoration and effect can actually be seen.
//
// Two halves: pure helpers and the report builder (unit-tested in node), and
// a DOM collector that measures the live window (checked in the browser
// harness). The report carries only selectors, class names and numbers, never
// chat text, thread titles or file names.

import { parseColor } from "./color";
import { EFFECTS } from "./effects";
import { CUSTOM_CSS_STYLE_ID } from "./probe";

// ---- Regions -----------------------------------------------------------------

export interface RegionDef { name: string; selector: string }

/**
 * The app's main regions, innermost first: an element belongs to the first
 * region in this list that contains it. Every selector was checked against
 * the real markup (App.tsx, StudioDock.tsx, ChatTimeline.tsx, SettingsModal.tsx).
 */
export const REGIONS: readonly RegionDef[] = [
  { name: "composer", selector: ".composer" },
  { name: "composer area (band under the messages)", selector: ".composer-zone" },
  { name: "messages", selector: ".timeline-shell" },
  { name: "new-chat screen", selector: ".thread-empty-state" },
  { name: "welcome screen", selector: ".welcome-screen" },
  { name: "chat stage (messages + composer)", selector: ".conversation" },
  { name: "top bar", selector: ".topbar" },
  { name: "Tools panel (right)", selector: ".studio-dock.open" },
  { name: "Settings", selector: ".settings-pane" },
  { name: "sidebar (left navigator)", selector: ".sidebar" },
  { name: "main panel (everything right of the sidebar)", selector: ".main-panel" },
  { name: "app shell (whole window)", selector: ".app-shell" },
];

/** Words a model reaches for, mapped to the real region selector. */
const REGION_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/^(chat|stage|chatstage|chat-area|chat-view|conversation|thread|thread-view|chat-panel)$/, ".conversation"],
  [/^(main|content|main-content|app-main|workspace-main|center|centre|pane|panel-main)$/, ".main-panel"],
  [/^(messages|message-list|transcript|timeline|history|feed|log|scroll|scroller)$/, ".timeline-shell"],
  [/^(composer|input|prompt|chat-input|input-bar|editor|textbox|message-input|footer|bottom)$/, ".composer"],
  [/^(composer-area|input-area|composer-wrap|composer-zone|dock-bottom)$/, ".composer-zone"],
  [/^(header|topbar|top-bar|toolbar|titlebar|title-bar|navbar|nav-bar|appbar|app-bar)$/, ".topbar"],
  [/^(sidebar|side-bar|nav|navigator|left|leftbar|left-panel|threads|thread-list|aside)$/, ".sidebar"],
  [/^(tools|tool-panel|tools-panel|right|right-panel|inspector|dock|workspace|drawer)$/, ".studio-dock"],
  [/^(message|bubble|assistant|markdown|prose|reply|response)$/, ".rich-markdown"],
  [/^(landing|empty|empty-state|home|hero|welcome|start)$/, ".thread-empty-state"],
  [/^(app|root|shell|window|body|html|background|bg)$/, ".app-shell"],
  [/^(settings|preferences|prefs)$/, ".settings-pane"],
  [/^(card|thread-row|row|list-item|item)$/, ".thread-card"],
];

// ---- Pure helpers ----------------------------------------------------------------

/** Split a selector list on top-level commas (not inside (), [] or quotes). */
export function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

const DYNAMIC = /:(hover|focus-within|focus-visible|focus|active|visited|target)(?![\w-])/g;

export interface QueryableSelector {
  /** Selector for querySelectorAll: pseudo-element and interaction states removed. */
  base: string;
  pseudo?: "before" | "after" | "other";
  /** Interaction states the selector needs (":hover"), if any. */
  states: string[];
}

/** Turn a style-rule selector into one that can be queried now. */
export function queryableSelector(selector: string): QueryableSelector {
  let base = selector.trim();
  let pseudo: QueryableSelector["pseudo"];
  const match = /::?(before|after)\s*$/i.exec(base) ?? /::([a-z-]+)(\([^)]*\))?\s*$/i.exec(base);
  if (match) {
    const name = match[1].toLowerCase();
    pseudo = name === "before" || name === "after" ? name : "other";
    base = base.slice(0, match.index).trim();
  }
  const states = Array.from(new Set(Array.from(base.matchAll(DYNAMIC), (m) => `:${m[1]}`)));
  // Only strip states outside :not(...), where removing them keeps a valid selector.
  if (states.length && !/:not\(/i.test(base)) base = base.replace(DYNAMIC, "");
  base = base.trim();
  if (!base || /[>+~]$/.test(base)) base = `${base} *`.trim();
  return { base, ...(pseudo ? { pseudo } : {}), states };
}

/** The model's own selector: the scope prefix the sanitizer added is removed. */
export function displaySelector(full: string, scopes: readonly string[]): string {
  let text = full.trim();
  for (const scope of [...scopes].sort((a, b) => b.length - a.length)) {
    if (text.startsWith(scope)) { text = text.slice(scope.length).trim(); break; }
  }
  return text || ".app-shell";
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = temp;
    }
  }
  return row[b.length];
}

const SAFE_CLASS = /^[a-z][a-z0-9_-]{0,47}$/i;

/** Class names a selector mentions (`.chat-stage > .x:hover` → chat-stage, x). */
export function classesIn(selector: string): string[] {
  return Array.from(selector.matchAll(/\.(-?[a-z_][a-z0-9_-]*)/gi), (m) => m[1]);
}

/**
 * Up to three real selectors close to one that matched nothing: region words
 * first ("chat-stage" → .conversation), then the nearest real class names.
 */
export function suggestSelectors(selector: string, knownClasses: readonly string[], limit = 3): string[] {
  const out: string[] = [];
  const add = (value: string) => { if (!out.includes(value) && out.length < limit) out.push(value); };
  const known = new Set(knownClasses.filter((name) => SAFE_CLASS.test(name)));
  const missing = classesIn(selector).filter((name) => !known.has(name));
  const words = missing.length ? missing : classesIn(selector);
  const tagWords = words.length ? [] : (selector.match(/^[a-z]+/i) ?? []).map((tag) => tag.toLowerCase());
  for (const word of [...words, ...tagWords]) {
    const lower = word.toLowerCase();
    const parts = [lower, ...lower.split(/[-_]/)];
    for (const part of parts) for (const [pattern, region] of REGION_WORDS) if (pattern.test(part)) add(region);
  }
  for (const word of words) {
    const lower = word.toLowerCase();
    const ranked = [...known]
      .map((name) => ({ name, score: editDistance(lower, name.toLowerCase()) - (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()) ? 2 : 0) }))
      .filter((entry) => entry.score <= Math.max(2, Math.floor(lower.length / 3)))
      .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    for (const entry of ranked) add(`.${entry.name}`);
  }
  return out;
}

export type Paint = "opaque" | "partial" | "clear";

/** How much an element's own background hides what is behind it. */
export function classifyBackground(backgroundColor: string, backgroundImage: string, opacity = 1): Paint {
  if (opacity < 0.5) return "clear";
  const color = parseColor(backgroundColor);
  const alpha = (color?.a ?? 0) * opacity;
  if (alpha >= 0.9) return "opaque";
  const stops = backgroundImage && backgroundImage !== "none"
    ? Array.from(backgroundImage.matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi), (m) => parseColor(m[0])?.a ?? 0)
    : [];
  if (/url\(/i.test(backgroundImage)) return alpha >= 0.5 ? "partial" : "clear";
  if (stops.length) {
    if (stops.every((a) => a * opacity >= 0.9)) return "opaque";
    if (stops.some((a) => a * opacity >= 0.6)) return "partial";
  }
  return alpha >= 0.5 ? "partial" : "clear";
}

/** Does this computed style start a stacking context (enough for theme CSS)? */
export function startsStackingContext(style: Pick<CSSStyleDeclaration, "position" | "zIndex" | "opacity" | "transform" | "filter" | "isolation" | "mixBlendMode"> & { contain?: string; willChange?: string }, parentIsFlexOrGrid = false): boolean {
  const z = style.zIndex !== "auto" && style.zIndex !== "";
  if (z && (style.position !== "static" || parentIsFlexOrGrid)) return true;
  if (style.position === "fixed" || style.position === "sticky") return true;
  if (Number(style.opacity) < 1) return true;
  if (style.transform && style.transform !== "none") return true;
  if (style.filter && style.filter !== "none") return true;
  if (style.isolation === "isolate") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  if (style.contain && /paint|layout|strict|content/.test(style.contain)) return true;
  if (style.willChange && /opacity|transform|filter/.test(style.willChange)) return true;
  return false;
}

// ---- Facts (collected from the DOM) and the report ----------------------------------

export interface Box { x: number; y: number; w: number; h: number }

export interface RegionFact { selector: string; name: string; box: Box }

export interface RuleFact {
  selector: string;
  /** Elements in the document matching it now (states and pseudo-element removed). */
  matched: number;
  /** Of those, how many have a visible box. */
  visible: number;
  regions: string[];
  states?: string[];
  pseudo?: "before" | "after" | "other";
  /** Only inside an @media/@supports block. */
  condition?: string;
  invalid?: boolean;
}

export interface DecorationFact {
  selector: string;
  pseudo: "before" | "after";
  host: string;
  hasContent: boolean;
  display: string;
  visibility: string;
  /** Own opacity times the host chain's. */
  opacity: number;
  /** Largest opacity its running animations reach (null: none animate opacity). */
  animatedOpacityMax: number | null;
  width: number;
  height: number;
  position: string;
  zIndex: string;
  hostPositioned: boolean;
  /** Absolute decoration placed against this outer element (host is static). */
  placedAgainst?: string;
  behindOwnBackground?: string;
  /** 0–1 share of sampled points hidden by something opaque painted above it. */
  covered: number;
  coveredBy: string[];
  /** Fully outside the window. */
  offscreen?: boolean;
}

export interface EffectFact {
  effect: string;
  kind: "backdrop" | "texture" | "accent";
  /** The layer or hook selector measured. */
  target?: string;
  rendered: boolean;
  reason?: "no-translucency" | "reduced-transparency" | "forced-colors" | "not-on-screen" | "not-rendered";
  opacity?: number;
  covered?: number;
  coveredBy?: string[];
  /** Backdrop: visible share per region (0–1). */
  byRegion?: Record<string, number>;
  /** Accent: regions where its targets are on screen. */
  on?: string[];
}

export interface LayoutFacts {
  window: { w: number; h: number };
  regions: RegionFact[];
  rules: RuleFact[];
  decorations: DecorationFact[];
  effects: EffectFact[];
  customCss: "none" | "on" | "off";
  motion?: { paused?: boolean; reducedMotion?: boolean };
}

export type Verdict = "yes" | "partly" | "sometimes" | "no";

export interface LayoutReport {
  window: { w: number; h: number };
  regions: Array<{ region: string; name: string; x: number; y: number; w: number; h: number }>;
  selectors?: Array<{ selector: string; matched: number; in?: string[]; didYouMean?: string[]; note?: string }>;
  decorations?: Array<{ selector: string; visible: Verdict; why?: string; fix?: string }>;
  effects?: Array<{ effect: string; visible: Verdict; byRegion?: Record<string, number>; why?: string; fix?: string }>;
  notes?: string[];
  omitted?: number;
}

export const REPORT_LIMITS = { regions: 12, selectors: 16, decorations: 8, effects: 8, notes: 4, text: 140 } as const;

const clip = (text: string, max: number = REPORT_LIMITS.text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const pct = (share: number) => `${Math.round(share * 100)}%`;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Plain verdict and fix for one decoration. Pure. */
export function judgeDecoration(fact: DecorationFact): { visible: Verdict; why?: string; fix?: string } {
  const host = fact.host;
  if (!fact.hasContent) return { visible: "no", why: "it has no content, so the browser never draws it", fix: "add content: \"\"" };
  if (fact.display === "none") return { visible: "no", why: "display: none" };
  if (fact.visibility === "hidden") return { visible: "no", why: "visibility: hidden" };
  if (fact.offscreen) return { visible: "no", why: "it is placed outside the window", fix: "check its top/left/inset values" };
  if (fact.width < 1 || fact.height < 1) {
    return { visible: "no", why: `it has no size (${Math.round(fact.width)}×${Math.round(fact.height)})`, fix: fact.position === "static" ? "give it position: absolute; inset: 0 (or a width and height)" : "give it a width and height, or inset: 0" };
  }
  let sometimes = false;
  if (fact.opacity <= 0.01) {
    if (fact.animatedOpacityMax !== null && fact.animatedOpacityMax > 0.01) sometimes = true;
    else return { visible: "no", why: "its opacity is 0", fix: "raise opacity or animate it above 0" };
  }
  if (fact.behindOwnBackground) {
    return { visible: "no", why: `z-index ${fact.zIndex} puts it behind the opaque background of ${fact.behindOwnBackground}`, fix: `add isolation: isolate to ${host}, or use z-index: 0` };
  }
  const placed = fact.placedAgainst ? ` (${host} is position: static, so it is placed against ${fact.placedAgainst}; add position: relative to ${host})` : "";
  if (fact.covered >= 0.9) {
    return { visible: "no", why: `hidden behind ${fact.coveredBy.join(", ") || "opaque elements"} painted above it${placed}`, fix: "draw it on an element in front, or make that element's background see-through" };
  }
  if (fact.covered >= 0.25) {
    return { visible: "partly", why: `${pct(fact.covered)} is hidden behind ${fact.coveredBy.join(", ") || "opaque elements"}${placed}` };
  }
  if (sometimes) return { visible: "sometimes", why: "opacity 0 right now; its animation fades it in" };
  if (placed) return { visible: "yes", why: placed.trim().replace(/^\(|\)$/g, "") };
  return { visible: "yes" };
}

/** Plain verdict and fix for one effect. Pure. */
export function judgeEffect(fact: EffectFact): { visible: Verdict; why?: string; fix?: string } {
  switch (fact.reason) {
    case "no-translucency": return { visible: "no", why: "backdrop effects show only through see-through surfaces", fix: "set surfaces.translucency (0.2–0.5)" };
    case "reduced-transparency": return { visible: "no", why: "the user's system asks for reduced transparency, so surfaces stay solid (by design)" };
    case "forced-colors": return { visible: "no", why: "the system's high-contrast mode is on, so effects are off (by design)" };
    case "not-on-screen": return { visible: "no", why: `its targets (${fact.target ?? "?"}) are not on screen right now; it shows when they are` };
    case "not-rendered": return { visible: "no", why: "its layer is not in the window" };
    default: break;
  }
  if (fact.opacity !== undefined && fact.opacity <= 0.01) return { visible: "no", why: "its layer's opacity is 0", fix: "raise intensity/strength/opacity" };
  const covered = fact.covered ?? 0;
  const by = (fact.coveredBy ?? []).join(", ");
  if (covered >= 0.9) return { visible: "no", why: `hidden behind ${by || "opaque surfaces"}`, fix: "raise surfaces.translucency, or make those backgrounds see-through in customCss" };
  if (covered >= 0.25) return { visible: "partly", why: `${pct(covered)} of the window covers it${by ? `, mostly ${by}` : ""}` };
  return { visible: "yes" };
}

/** Compact, deterministic report from measured facts. Pure. */
export function buildLayoutReport(facts: LayoutFacts, knownClasses: readonly string[] = []): LayoutReport {
  let omitted = 0;
  const cap = <T,>(list: T[], max: number): T[] => { if (list.length > max) omitted += list.length - max; return list.slice(0, max); };
  const report: LayoutReport = {
    window: { w: Math.round(facts.window.w), h: Math.round(facts.window.h) },
    regions: cap(facts.regions, REPORT_LIMITS.regions).map((region) => ({
      region: region.selector, name: region.name,
      x: Math.round(region.box.x), y: Math.round(region.box.y), w: Math.round(region.box.w), h: Math.round(region.box.h),
    })),
  };
  if (facts.rules.length) {
    // Problems first (in source order), then the rest.
    const ordered = [...facts.rules.filter((rule) => rule.matched === 0 || rule.invalid), ...facts.rules.filter((rule) => rule.matched > 0 && !rule.invalid)];
    report.selectors = cap(ordered, REPORT_LIMITS.selectors).map((rule) => {
      const entry: NonNullable<LayoutReport["selectors"]>[number] = { selector: clip(rule.selector), matched: rule.matched };
      if (rule.invalid) entry.note = "the browser could not read this selector";
      else if (rule.matched === 0) {
        const suggestions = suggestSelectors(rule.selector, knownClasses);
        if (suggestions.length) entry.didYouMean = suggestions;
        entry.note = rule.condition ? `matches nothing right now (inside ${clip(rule.condition, 60)})` : "matches nothing in the app";
      } else {
        entry.in = rule.regions.slice(0, 4);
        if (rule.visible === 0) entry.note = "matched elements are hidden or have no size right now";
        else if (rule.states?.length) entry.note = `applies on ${rule.states.join(", ")}`;
      }
      return entry;
    });
  }
  if (facts.decorations.length) {
    report.decorations = cap(facts.decorations, REPORT_LIMITS.decorations).map((fact) => {
      const verdict = judgeDecoration(fact);
      return { selector: clip(fact.selector), visible: verdict.visible, ...(verdict.why ? { why: clip(verdict.why) } : {}), ...(verdict.fix ? { fix: clip(verdict.fix) } : {}) };
    });
  }
  if (facts.effects.length) {
    report.effects = cap(facts.effects, REPORT_LIMITS.effects).map((fact) => {
      const verdict = judgeEffect(fact);
      const byRegion = fact.byRegion && Object.keys(fact.byRegion).length
        ? Object.fromEntries(Object.entries(fact.byRegion).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, round2(value)]))
        : undefined;
      return {
        effect: fact.effect, visible: verdict.visible,
        ...(byRegion ? { byRegion } : {}),
        ...(fact.on?.length ? { on: fact.on.slice(0, 4) } : {}),
        ...(verdict.why ? { why: clip(verdict.why) } : {}),
        ...(verdict.fix ? { fix: clip(verdict.fix) } : {}),
      };
    });
  }
  const notes: string[] = [];
  if (facts.customCss === "off") notes.push("customCss is switched off for this theme right now, so its selectors were not checked.");
  if (facts.motion?.reducedMotion) notes.push("The user's system asks apps to reduce motion: animations are still for them.");
  else if (facts.motion?.paused) notes.push("The user paused theme animations: they see the first frame.");
  if (notes.length) report.notes = cap(notes, REPORT_LIMITS.notes);
  if (omitted) report.omitted = omitted;
  return report;
}

// ---- DOM collector ---------------------------------------------------------------------

/** Minimal theme facts the collector needs (a ThemeSpec fits). */
export interface InspectSpec {
  effects?: object;
  surfaces?: { translucency?: number };
  customCss?: string;
}

const BACKDROP_LAYERS: Readonly<Record<string, string>> = {
  aurora: ".ct-fx-aurora", mesh: ".ct-fx-mesh", starfield: ".ct-fx-stars", particles: ".ct-fx-particles", grid: ".ct-fx-grid", vignette: ".ct-fx-vignette",
};
const TEXTURE_LAYERS: Readonly<Record<string, string>> = { grain: ".ct-fx-grain", scanlines: ".ct-fx-scan" };
const ACCENT_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  glow: { focus: ".composer", primary: ".primary-button:not(:disabled)", send: ".send-button:not(:disabled)", selectionBar: ".thread-row-wrap.active > .thread-card" },
  shimmer: { activeTab: ".studio-tabs button.active", selectionBar: ".thread-row-wrap.active > .thread-card", primary: ".primary-button:not(:disabled)", landingTitle: ".thread-empty-state h1" },
  border: { composer: ".composer", focusedField: "input, textarea" },
  accentFlow: { send: ".send-button", primary: ".primary-button", switch: ".toggle-switch.on" },
};
const ACCENT_DEFAULT_TARGETS: Readonly<Record<string, readonly string[]>> = {
  glow: ["focus", "primary"], shimmer: ["selectionBar"], border: ["composer"], accentFlow: ["send", "primary", "switch"],
};

const MAX_RULES = 60;
const MAX_MATCH_SCAN = 60;

function boxOf(el: Element): Box {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function shown(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function regionOf(el: Element): string | null {
  for (const region of REGIONS) if (el.closest(region.selector)) return region.selector;
  return null;
}

/** A short, content-free name for an element: its most telling class, else its tag. */
function nameOf(el: Element): string {
  for (const region of REGIONS) if (el.matches(region.selector)) return region.selector;
  const classes = Array.from(el.classList).filter((name) => SAFE_CLASS.test(name) && !name.startsWith("ct-"));
  return classes.length ? `.${classes[0]}` : el.tagName.toLowerCase();
}

function knownClassNames(shell: Element): string[] {
  const names = new Set<string>();
  const all = shell.getElementsByTagName("*");
  for (let i = 0; i < all.length && names.size < 2_500; i++) {
    for (const name of Array.from(all[i].classList)) if (SAFE_CLASS.test(name)) names.add(name);
  }
  return [...names].sort();
}

function styleRules(sheet: CSSStyleSheet): Array<{ rule: CSSStyleRule; condition?: string }> {
  const out: Array<{ rule: CSSStyleRule; condition?: string }> = [];
  const walk = (rules: CSSRuleList, condition?: string) => {
    for (const rule of Array.from(rules)) {
      if (out.length >= MAX_RULES * 2) return;
      if (rule instanceof CSSStyleRule) out.push({ rule, ...(condition ? { condition } : {}) });
      else if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule) {
        // The motion half of every rule sits in prefers-reduced-motion: it is the same selector, not a condition worth naming.
        const text = rule.conditionText ?? rule.media.mediaText;
        walk(rule.cssRules, /prefers-reduced-motion/.test(text) ? condition : `@media ${text}`);
      } else if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) walk(rule.cssRules, condition);
    }
  };
  try { walk(sheet.cssRules); } catch { /* unreadable sheet */ }
  return out;
}

/** Temporarily make everything hit-testable so stacking can be read with elementsFromPoint. */
function withHitTesting<T>(run: () => T): T {
  const style = document.createElement("style");
  style.textContent = ".app-shell, .app-shell * { pointer-events: auto !important; }";
  document.head.appendChild(style);
  try { return run(); } finally { style.remove(); }
}

interface PaintCache { paint(el: Element): Paint; style(el: Element): CSSStyleDeclaration }

function paintCache(): PaintCache {
  const styles = new Map<Element, CSSStyleDeclaration>();
  const paints = new Map<Element, Paint>();
  const style = (el: Element) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  return {
    style,
    paint(el) {
      let p = paints.get(el);
      if (!p) {
        const s = style(el);
        p = el instanceof HTMLCanvasElement || el instanceof HTMLImageElement || el instanceof HTMLVideoElement
          ? "partial"
          : classifyBackground(s.backgroundColor, s.backgroundImage, Number(s.opacity));
        paints.set(el, p);
      }
      return p;
    },
  };
}

function samplePoints(box: Box, win: { w: number; h: number }, cols: number, rows: number): Array<[number, number]> {
  const left = Math.max(0, box.x), top = Math.max(0, box.y);
  const right = Math.min(win.w, box.x + box.w), bottom = Math.min(win.h, box.y + box.h);
  if (right - left < 1 || bottom - top < 1) return [];
  const points: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    points.push([left + ((c + 0.5) / cols) * (right - left), top + ((r + 0.5) / rows) * (bottom - top)]);
  }
  return points;
}

function innermostRegionAt(x: number, y: number, regions: RegionFact[]): string | null {
  let best: RegionFact | null = null;
  for (const region of regions) {
    const { box } = region;
    if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) continue;
    if (!best || box.w * box.h < best.box.w * best.box.h) best = region;
  }
  return best?.selector ?? null;
}

function topCoverers(counts: Map<string, number>, max = 3): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([name]) => name);
}

function pxValue(value: string): number | null {
  const number = parseFloat(value);
  return /px$/.test(value) && Number.isFinite(number) ? number : null;
}

function positionedAncestor(el: Element, cache: PaintCache): Element {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const s = cache.style(node);
    if (s.position !== "static" || (s.transform && s.transform !== "none")) return node;
  }
  return document.documentElement;
}

function decorationFact(selector: string, pseudo: "before" | "after", host: Element, win: { w: number; h: number }, cache: PaintCache): DecorationFact {
  const ps = getComputedStyle(host, `::${pseudo}`);
  const hostStyle = cache.style(host);
  const content = ps.content;
  const hasContent = Boolean(content) && content !== "none" && content !== "normal";
  let opacity = Number(ps.opacity);
  if (!Number.isFinite(opacity)) opacity = 1;
  for (let node: Element | null = host; node; node = node.parentElement) {
    const value = Number(cache.style(node).opacity);
    if (Number.isFinite(value)) opacity *= value;
    if (node.classList.contains("app-shell")) break;
  }
  let animatedOpacityMax: number | null = null;
  try {
    for (const animation of host.getAnimations?.({ subtree: true }) ?? []) {
      const effect = animation.effect as KeyframeEffect | null;
      if (!effect || effect.target !== host || effect.pseudoElement !== `::${pseudo}`) continue;
      for (const frame of effect.getKeyframes()) {
        const value = Number(frame.opacity);
        if (frame.opacity !== undefined && Number.isFinite(value)) animatedOpacityMax = Math.max(animatedOpacityMax ?? 0, value);
      }
    }
  } catch { /* no Web Animations */ }
  const position = ps.position;
  const hostPositioned = hostStyle.position !== "static";
  const width = pxValue(ps.width) ?? 0;
  const height = pxValue(ps.height) ?? 0;
  // Where the decoration sits: absolute boxes against their containing block.
  const hostBox = boxOf(host);
  let box: Box = { x: hostBox.x, y: hostBox.y, w: width, h: height };
  let placedAgainst: string | undefined;
  if (position === "absolute" || position === "fixed") {
    const block = position === "fixed" ? null : hostPositioned ? host : positionedAncestor(host, cache);
    if (block && block !== host) placedAgainst = block === document.documentElement ? "the window" : nameOf(block);
    const cb = block ? boxOf(block) : { x: 0, y: 0, w: win.w, h: win.h };
    const left = pxValue(ps.left), right = pxValue(ps.right), top = pxValue(ps.top), bottom = pxValue(ps.bottom);
    const x = left !== null ? cb.x + left : right !== null ? cb.x + cb.w - right - width : hostBox.x;
    const y = top !== null ? cb.y + top : bottom !== null ? cb.y + cb.h - bottom - height : hostBox.y;
    box = { x, y, w: width, h: height };
  }
  const offscreen = box.w > 0 && box.h > 0 && (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= win.w || box.y >= win.h);
  const z = ps.zIndex === "auto" ? 0 : parseInt(ps.zIndex, 10) || 0;
  // Behind the host's own background: negative z-index with no stacking context on the host.
  let behindOwnBackground: string | undefined;
  if (z < 0) {
    for (let node: Element | null = host; node; node = node.parentElement) {
      const s = cache.style(node);
      const parent = node.parentElement ? cache.style(node.parentElement).display : "";
      // The first stacking context up the chain is where it paints, above that element's own background.
      if (startsStackingContext(s, /flex|grid/.test(parent))) break;
      if (cache.paint(node) === "opaque") { behindOwnBackground = nameOf(node); break; }
      if (node.classList.contains("app-shell")) break;
    }
  }
  // Coverage: who paints above it at sampled points.
  let covered = 0;
  const counts = new Map<string, number>();
  const points = hasContent && width >= 1 && height >= 1 && !offscreen ? samplePoints(box, win, 5, 4) : [];
  for (const [x, y] of points) {
    const stack = document.elementsFromPoint(x, y);
    let anchor = stack.indexOf(host);
    if (anchor < 0) anchor = stack.findIndex((el) => el.contains(host));
    if (anchor < 0) continue;
    let hit: Paint = "clear";
    let by = "";
    for (let i = 0; i < anchor; i++) {
      const el = stack[i];
      if (el.closest(".ct-fx-layer")) continue;
      if (host.contains(el) && !coversDecoration(el, host, z, pseudo, cache)) continue;
      const paint = cache.paint(el);
      if (paint === "opaque") { hit = "opaque"; by = nameOf(el); break; }
      if (paint === "partial" && hit === "clear") { hit = "partial"; by = nameOf(el); }
    }
    if (hit !== "clear") {
      covered += hit === "opaque" ? 1 : 0.5;
      counts.set(by, (counts.get(by) ?? 0) + 1);
    }
  }
  return {
    selector, pseudo, host: nameOf(host), hasContent, display: ps.display, visibility: ps.visibility,
    opacity, animatedOpacityMax, width, height, position, zIndex: ps.zIndex, hostPositioned,
    ...(placedAgainst ? { placedAgainst } : {}),
    ...(behindOwnBackground ? { behindOwnBackground } : {}),
    covered: points.length ? covered / points.length : 0,
    coveredBy: topCoverers(counts),
    ...(offscreen ? { offscreen } : {}),
  };
}

/** Does a descendant of the host paint above the host's ::before/::after? (Approximate CSS painting order.) */
function coversDecoration(el: Element, host: Element, z: number, pseudo: "before" | "after", cache: PaintCache): boolean {
  if (z < 0) return true;
  for (let node: Element | null = el; node && node !== host; node = node.parentElement) {
    const s = cache.style(node);
    const nodeZ = s.zIndex === "auto" ? null : parseInt(s.zIndex, 10);
    const positioned = s.position !== "static";
    if (nodeZ !== null && positioned) return nodeZ > z || (nodeZ === z && pseudo === "before");
    if (positioned && z === 0) return pseudo === "before";
  }
  return false;
}

function effectFacts(shell: HTMLElement, spec: InspectSpec, regions: RegionFact[], win: { w: number; h: number }, cache: PaintCache): EffectFact[] {
  const effects = (spec.effects ?? {}) as Record<string, unknown>;
  const types = Object.keys(effects).sort();
  if (!types.length) return [];
  const forced = typeof matchMedia === "function" && matchMedia("(forced-colors: active)").matches;
  const reducedTransparency = typeof matchMedia === "function" && matchMedia("(prefers-reduced-transparency: reduce)").matches;
  const translucency = Number(spec.surfaces?.translucency ?? 0);
  const out: EffectFact[] = [];
  let backdropSample: { covered: number; coveredBy: string[]; byRegion: Record<string, number> } | null = null;
  const sampleBackdrop = (layer: Element) => {
    if (backdropSample) return backdropSample;
    const points = samplePoints({ x: 0, y: 0, w: win.w, h: win.h }, win, 12, 8);
    const seen = new Map<string, { total: number; visible: number }>();
    const counts = new Map<string, number>();
    let covered = 0;
    let measured = 0;
    for (const [x, y] of points) {
      const stack = document.elementsFromPoint(x, y);
      const index = stack.findIndex((el) => el === layer || layer.contains(el));
      let hidden = 0;
      let by = "";
      const above = index < 0 ? stack : stack.slice(0, index);
      for (const el of above) {
        if (el.closest(".ct-fx-layer") || el === shell) continue;
        const paint = cache.paint(el);
        if (paint === "opaque") { hidden = 1; by = nameOf(el); break; }
        if (paint === "partial" && !hidden) { hidden = 0.5; by = nameOf(el); }
      }
      // Outside the layer's own area (an effect limited to the chat or the sidebar).
      if (index < 0) continue;
      measured += 1;
      covered += hidden;
      if (by) counts.set(by, (counts.get(by) ?? 0) + 1);
      const region = innermostRegionAt(x, y, regions);
      if (region) {
        const entry = seen.get(region) ?? { total: 0, visible: 0 };
        entry.total += 1;
        entry.visible += 1 - hidden;
        seen.set(region, entry);
      }
    }
    backdropSample = {
      covered: measured ? covered / measured : 1,
      coveredBy: topCoverers(counts),
      byRegion: Object.fromEntries([...seen.entries()].map(([region, entry]) => [region, entry.visible / entry.total])),
    };
    return backdropSample;
  };
  const layerOpacity = (el: Element) => {
    let opacity = 1;
    for (let node: Element | null = el; node && node !== shell; node = node.parentElement) {
      const value = Number(cache.style(node).opacity);
      if (Number.isFinite(value)) opacity *= value;
    }
    return opacity;
  };
  const kebab = (type: string) => type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const groupOf = (type: string) => (EFFECTS as Record<string, { group?: string } | undefined>)[type]?.group;
  for (const type of types) {
    const group = groupOf(type);
    if (BACKDROP_LAYERS[type] || (group === "backdrop" && !ACCENT_TARGETS[type])) {
      const target = BACKDROP_LAYERS[type] ?? `.ct-fx-${kebab(type)}`;
      if (forced) { out.push({ effect: type, kind: "backdrop", target, rendered: false, reason: "forced-colors" }); continue; }
      if (!(translucency > 0)) { out.push({ effect: type, kind: "backdrop", target, rendered: false, reason: "no-translucency" }); continue; }
      if (reducedTransparency) { out.push({ effect: type, kind: "backdrop", target, rendered: true, reason: "reduced-transparency" }); continue; }
      const layer = shell.querySelector(target);
      if (!layer) { out.push({ effect: type, kind: "backdrop", target, rendered: false, reason: "not-rendered" }); continue; }
      const sample = sampleBackdrop(layer.closest(".ct-fx-back") ?? layer);
      out.push({ effect: type, kind: "backdrop", target, rendered: true, opacity: layerOpacity(layer), covered: sample.covered, coveredBy: sample.coveredBy, byRegion: sample.byRegion });
    } else if (TEXTURE_LAYERS[type] || (group === "texture" && type !== "vignette")) {
      const target = TEXTURE_LAYERS[type] ?? `.ct-fx-${kebab(type)}`;
      if (forced) { out.push({ effect: type, kind: "texture", target, rendered: false, reason: "forced-colors" }); continue; }
      const layer = shell.querySelector(target);
      if (!layer) { out.push({ effect: type, kind: "texture", target, rendered: false, reason: "not-rendered" }); continue; }
      out.push({ effect: type, kind: "texture", target, rendered: true, opacity: layerOpacity(layer), covered: 0 });
    } else if (ACCENT_TARGETS[type]) {
      const params = effects[type] && typeof effects[type] === "object" ? effects[type] as Record<string, unknown> : {};
      const wanted = Array.isArray(params.targets) ? params.targets.filter((t): t is string => typeof t === "string") : [...ACCENT_DEFAULT_TARGETS[type] ?? []];
      const selectors = wanted.map((t) => ACCENT_TARGETS[type][t]).filter(Boolean);
      const on = new Set<string>();
      for (const selector of selectors) {
        for (const el of Array.from(shell.querySelectorAll(selector)).slice(0, 20)) {
          if (!shown(el)) continue;
          const region = regionOf(el);
          if (region) on.add(region);
        }
      }
      const target = selectors.join(", ");
      out.push(on.size
        ? { effect: type, kind: "accent", target, rendered: true, on: [...on].sort() }
        : { effect: type, kind: "accent", target, rendered: false, reason: "not-on-screen" });
    }
  }
  return out;
}

export interface InspectOptions {
  spec?: InspectSpec | null;
  /** Selector prefixes the sanitizer adds (customCssScope, plain and motion); stripped for display. */
  scopes?: readonly string[];
  /** The plain scope: a motion-only selector is also counted without the motion gate, so paused animations don't read as "matches nothing". */
  queryScope?: string;
  motion?: { paused?: boolean; reducedMotion?: boolean };
}

/** Measure the live window and build the `layout` report. Never throws. */
export function inspectLayout(shell: HTMLElement, options: InspectOptions = {}): LayoutReport | null {
  try {
    const win = { w: window.innerWidth, h: window.innerHeight };
    const cache = paintCache();
    const regions: RegionFact[] = [];
    for (const region of REGIONS) {
      const el = (shell.matches(region.selector) ? [shell] : Array.from(shell.querySelectorAll(region.selector))).find(shown);
      if (el) regions.push({ selector: region.selector, name: region.name, box: boxOf(el) });
    }
    const known = knownClassNames(shell);
    const spec = options.spec ?? null;
    const styleEl = document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null;
    const sheet = styleEl?.sheet ?? null;
    const customCss: LayoutFacts["customCss"] = !spec?.customCss?.trim() ? "none" : sheet && !sheet.disabled && styleEl?.textContent?.trim() ? "on" : "off";
    const rules: RuleFact[] = [];
    const decorations: DecorationFact[] = [];
    return withHitTesting(() => {
      if (customCss === "on" && sheet) {
        const seen = new Set<string>();
        for (const { rule, condition } of styleRules(sheet)) {
          for (const full of splitSelectorList(rule.selectorText)) {
            const selector = displaySelector(full, options.scopes ?? []);
            if (seen.has(selector) || rules.length >= MAX_RULES) continue;
            seen.add(selector);
            const scope = (options.scopes ?? []).find((prefix) => full.startsWith(prefix));
            const query = queryableSelector(options.queryScope && scope ? `${options.queryScope}${full.slice(scope.length)}` : full);
            let matches: Element[] = [];
            let invalid = false;
            try { matches = Array.from(document.querySelectorAll(query.base)); } catch { invalid = true; }
            const scanned = matches.slice(0, MAX_MATCH_SCAN);
            const visible = scanned.filter(shown);
            const regionSet = new Set<string>();
            for (const el of visible.length ? visible : scanned) { const region = regionOf(el); if (region) regionSet.add(region); }
            rules.push({
              selector, matched: matches.length, visible: visible.length,
              regions: REGIONS.map((r) => r.selector).filter((s) => regionSet.has(s)),
              ...(query.states.length ? { states: query.states } : {}),
              ...(query.pseudo ? { pseudo: query.pseudo } : {}),
              ...(condition ? { condition } : {}),
              ...(invalid ? { invalid } : {}),
            });
            if ((query.pseudo === "before" || query.pseudo === "after") && !query.states.length && decorations.length < REPORT_LIMITS.decorations) {
              const host = visible[0] ?? scanned[0];
              if (host) decorations.push(decorationFact(selector, query.pseudo, host, win, cache));
            }
          }
        }
      }
      const effects = spec ? effectFacts(shell, spec, regions, win, cache) : [];
      return buildLayoutReport({ window: win, regions, rules, decorations, effects, customCss, motion: options.motion }, known);
    });
  } catch {
    return null;
  }
}
