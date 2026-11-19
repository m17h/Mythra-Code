// The curated effects library (DESIGN §5): a typed registry with parameter
// schemas, clamps, defaults drawn from the theme palette, the colours each
// effect puts behind text (for the composite contrast check) and the
// deterministic starfield generator. Pure; no DOM.

import { composite, formatColor, mixColors, parseColor, rgbToOklch, oklchToRgb, seededRandom, withAlpha, type Rgba } from "./color";
import { EFFECT_AREAS, EFFECT_TYPES, PARTICLE_SHAPES, didYouMean, type ColorString, type EffectArea, type EffectType, type ParticleShape, type Speed, type ThemeEffects, type ValidationIssue } from "./spec";

export type EffectGroup = "backdrop" | "texture" | "accent";
export type ParamDesc =
  | { kind: "colors"; min: number; max: number; doc: string }
  | { kind: "color"; doc: string }
  | { kind: "number"; min: number; max: number; default: number; step?: number; doc: string }
  | { kind: "int"; min: number; max: number; default: number; doc: string }
  | { kind: "enum"; values: readonly (string | number)[]; default: string | number; doc: string }
  | { kind: "bool"; default: boolean; doc: string }
  | { kind: "targets"; values: readonly string[]; default: readonly string[]; doc: string }
  | { kind: "range"; min: number; max: number; default: [number, number]; doc: string };

export interface EffectDef {
  type: EffectType;
  group: EffectGroup;
  impl: "css" | "canvas";
  /** Plain-words description for the design kit. */
  doc: string;
  params: Record<string, ParamDesc>;
}

const SPEEDS: readonly Speed[] = ["still", "slow", "medium", "lively"];
const speed = (doc = "still | slow | medium | lively"): ParamDesc => ({ kind: "enum", values: SPEEDS, default: "slow", doc });
const area = (): ParamDesc => ({
  kind: "enum", values: EFFECT_AREAS, default: "window",
  doc: "Where it shows: window (everywhere, default), chat (only the chat side: top bar, messages and composer; never the left navigator or the Tools panel) or sidebar (only the left navigator).",
});

/** Particle counts: the canvas stays light at these sizes (measured at 30fps, see docs/design/pro-ui.md). */
export const PARTICLE_LIMITS = { min: 8, max: 60, maxWithLinks: 40, maxStreaks: 160 } as const;
/** Default count per shape when count is not given (rain needs many thin streaks to read as rain). */
export const PARTICLE_DEFAULT_COUNT: Readonly<Record<ParticleShape, number>> = { dot: 24, streak: 90, flake: 40, petal: 22 };
/** Pixels per second per shape and speed. Streaks fall at rain speed; flakes and petals drift down slowly. */
export const PARTICLE_SPEED_PX: Readonly<Record<ParticleShape, Record<Speed, number>>> = {
  dot: { still: 0, slow: 6, medium: 12, lively: 22 },
  streak: { still: 0, slow: 300, medium: 520, lively: 820 },
  flake: { still: 0, slow: 18, medium: 32, lively: 52 },
  petal: { still: 0, slow: 22, medium: 38, lively: 60 },
};
export const PARTICLE_ANGLE = { min: -30, max: 30 } as const;

export const EFFECTS: Readonly<Record<EffectType, EffectDef>> = {
  aurora: {
    type: "aurora", group: "backdrop", impl: "css",
    doc: "Soft northern-light ribbons drifting behind the window background. Calm and premium; the best first choice for dark themes.",
    params: {
      colors: { kind: "colors", min: 2, max: 4, doc: "2–4 colours; defaults to the accent family." },
      intensity: { kind: "number", min: 0, max: 1, default: 0.35, doc: "0–1 (0.35)." },
      speed: speed(),
      position: { kind: "enum", values: ["top", "bottom", "full"], default: "top", doc: "Where the light gathers." },
      area: area(),
    },
  },
  mesh: {
    type: "mesh", group: "backdrop", impl: "css",
    doc: "A slow gradient mesh: four large colour fields wandering in the corners.",
    params: {
      colors: { kind: "colors", min: 3, max: 5, doc: "3–5 colours." },
      intensity: { kind: "number", min: 0, max: 1, default: 0.3, doc: "0–1 (0.3)." },
      speed: speed(),
      area: area(),
    },
  },
  starfield: {
    type: "starfield", group: "backdrop", impl: "css",
    doc: "Three layers of tiny stars with gentle twinkle and optional slow parallax drift and rare shooting stars. Best on dark themes.",
    params: {
      color: { kind: "color", doc: "Star colour (defaults to text)." },
      accentColor: { kind: "color", doc: "Optional colour for a few brighter stars." },
      density: { kind: "enum", values: ["sparse", "normal", "dense"], default: "normal", doc: "How many stars." },
      twinkle: { kind: "bool", default: true, doc: "Slow twinkle." },
      drift: { kind: "enum", values: ["none", "slow"], default: "slow", doc: "Parallax drift." },
      shootingStars: { kind: "bool", default: false, doc: "A rare shooting star (one every 12–20s)." },
      area: area(),
    },
  },
  particles: {
    type: "particles", group: "backdrop", impl: "canvas",
    doc: "Particles drawn on a small canvas (30fps cap): floating dots (optionally joined by faint lines), rain streaks, soft snowflakes or tumbling petals. For weather: rain = shape streak, snow = flake, blossoms or autumn leaves = petal; tilt them with angle for wind.",
    params: {
      colors: { kind: "colors", min: 1, max: 3, doc: "1–3 colours. Rain reads best in a pale, low-chroma tint of text (e.g. a blue-grey); petals in 2–3 close pinks." },
      shape: { kind: "enum", values: PARTICLE_SHAPES, default: "dot", doc: "dot (round motes, default), streak (thin slanted rain lines that fall fast), flake (soft snow that sways as it falls), petal (small petals that tumble and spin)." },
      count: { kind: "int", min: PARTICLE_LIMITS.min, max: PARTICLE_LIMITS.maxStreaks, default: PARTICLE_DEFAULT_COUNT.dot, doc: `${PARTICLE_LIMITS.min}–${PARTICLE_LIMITS.max} for dots, flakes and petals (${PARTICLE_LIMITS.maxWithLinks} with links); streaks up to ${PARTICLE_LIMITS.maxStreaks}. Default per shape: dot ${PARTICLE_DEFAULT_COUNT.dot}, streak ${PARTICLE_DEFAULT_COUNT.streak}, flake ${PARTICLE_DEFAULT_COUNT.flake}, petal ${PARTICLE_DEFAULT_COUNT.petal}.` },
      size: { kind: "range", min: 1, max: 4, default: [1, 2.5], doc: "[min, max], 1–4. Dot and flake radius in px; streak thickness (1 = hairline drizzle, 2–3 = heavy rain); petal size (about 3× in px)." },
      speed: speed("still | slow | medium | lively. Streaks fall at rain speed (slow drizzle about 300 px/s, lively downpour about 820 px/s); flakes and petals drift down gently."),
      direction: { kind: "enum", values: ["rise", "fall", "drift"], default: "rise", doc: "Movement direction. Defaults to fall for streak, flake and petal, rise for dot." },
      angle: { kind: "number", min: PARTICLE_ANGLE.min, max: PARTICLE_ANGLE.max, default: 0, step: 1, doc: "Wind slant in degrees for rise and fall, −30…30 (0 = straight; positive leans to the right). Ignored for drift." },
      links: { kind: "bool", default: false, doc: "Faint lines between near particles (dots only)." },
      glow: { kind: "bool", default: false, doc: "Soft halo on each particle (dots; flakes are always soft)." },
      area: area(),
    },
  },
  grid: {
    type: "grid", group: "backdrop", impl: "css",
    doc: "A retro perspective floor gliding toward a glowing horizon in the lower window.",
    params: {
      color: { kind: "color", doc: "Grid line colour (defaults to accent)." },
      speed: { kind: "enum", values: SPEEDS, default: "medium", doc: "still | slow | medium | lively" },
      horizon: { kind: "number", min: 0.55, max: 0.8, default: 0.66, doc: "Horizon height as a fraction from the top (0.55–0.8)." },
      glow: { kind: "bool", default: true, doc: "A soft glow along the horizon." },
      area: area(),
    },
  },
  grain: {
    type: "grain", group: "texture", impl: "css",
    doc: "Fine film grain over the whole window; makes flat colour feel like paper or film.",
    params: {
      amount: { kind: "number", min: 0, max: 1, default: 0.4, doc: "0–1 (0.4)." },
      animated: { kind: "bool", default: false, doc: "A gentle 8fps grain jitter." },
      area: area(),
    },
  },
  scanlines: {
    type: "scanlines", group: "texture", impl: "css",
    doc: "Faint CRT scanlines. Never flickers.",
    params: {
      opacity: { kind: "number", min: 0, max: 1, default: 0.3, doc: "0–1 (0.3)." },
      spacing: { kind: "enum", values: [2, 3, 4], default: 3, doc: "Line spacing in px." },
      roll: { kind: "bool", default: false, doc: "A very slow downward roll." },
      area: area(),
    },
  },
  vignette: {
    type: "vignette", group: "texture", impl: "css",
    doc: "Darkened window edges behind the content.",
    params: {
      strength: { kind: "number", min: 0, max: 1, default: 0.3, doc: "0–1 (0.3)." },
      color: { kind: "color", doc: "Edge colour (defaults to black or a deep tint of bg)." },
      area: area(),
    },
  },
  glow: {
    type: "glow", group: "accent", impl: "css",
    doc: "A soft accent glow on focus, primary buttons, the send button or the selected row; optional slow breathing.",
    params: {
      targets: { kind: "targets", values: ["focus", "primary", "send", "selectionBar"], default: ["focus", "primary"], doc: "Any of focus, primary, send, selectionBar." },
      strength: { kind: "number", min: 0, max: 1, default: 0.4, doc: "0–1 (0.4)." },
      pulse: { kind: "bool", default: false, doc: "Slow 2.8s breathing." },
      color: { kind: "color", doc: "Glow colour (defaults to accent)." },
    },
  },
  shimmer: {
    type: "shimmer", group: "accent", impl: "css",
    doc: "An occasional light sweep across one element, then a long rest.",
    params: {
      targets: { kind: "targets", values: ["activeTab", "selectionBar", "primary", "landingTitle"], default: ["selectionBar"], doc: "Any of activeTab, selectionBar, primary, landingTitle." },
      interval: { kind: "number", min: 6, max: 30, default: 10, doc: "Seconds between sweeps (6–30)." },
      color: { kind: "color", doc: "Sheen colour (defaults to a soft white or the accent)." },
    },
  },
  border: {
    type: "border", group: "accent", impl: "css",
    doc: "A slowly turning gradient border around the composer or the focused field.",
    params: {
      targets: { kind: "targets", values: ["composer", "focusedField"], default: ["composer"], doc: "composer, focusedField." },
      colors: { kind: "colors", min: 2, max: 4, doc: "2–4 colours; defaults to the accent family." },
      speed: speed(),
      width: { kind: "enum", values: [1, 1.5, 2], default: 1.5, doc: "Ring width in px." },
    },
  },
  accentFlow: {
    type: "accentFlow", group: "accent", impl: "css",
    doc: "Accent fills (primary buttons, send, switches) become a slowly flowing gradient. Every stop must keep onAccent readable.",
    params: {
      colors: { kind: "colors", min: 2, max: 3, doc: "2–3 colours near the accent." },
      speed: speed(),
    },
  },
};

export const GROUP_LIMITS: Readonly<Record<EffectGroup, number>> = { backdrop: 2, texture: 2, accent: 3 };
export const MAX_EFFECTS = 6;
export const MAX_CANVAS_EFFECTS = 1;

/** Loop lengths in seconds per effect and speed. "still" means no motion. */
export const SPEED_SECONDS: Readonly<Record<string, Record<Exclude<Speed, "still">, number>>> = {
  aurora: { slow: 48, medium: 30, lively: 20 },
  mesh: { slow: 60, medium: 38, lively: 24 },
  grid: { slow: 10, medium: 6, lively: 3.6 },
  border: { slow: 8, medium: 5, lively: 3 },
  accentFlow: { slow: 12, medium: 8, lively: 5 },
  particles: { slow: 1, medium: 1.8, lively: 3 },
};

/** Palette an effect may default to. All opaque. */
export interface EffectPalette {
  scheme: "light" | "dark";
  bg: Rgba; text: Rgba; accent: Rgba; fill: Rgba; onAccent: Rgba; info: Rgba; success: Rgba; danger: Rgba; warning: Rgba;
}

type Params = Record<string, unknown>;
export type ResolvedParams = Record<string, unknown>;

function hueShift(color: Rgba, degrees: number, lightness = 0): Rgba {
  const lch = rgbToOklch(color);
  return { ...oklchToRgb({ l: Math.min(0.95, Math.max(0.05, lch.l + lightness)), c: lch.c, h: (lch.h + degrees + 360) % 360 }), a: 1 };
}

function defaultColors(type: EffectType, p: EffectPalette): Rgba[] {
  switch (type) {
    case "aurora": return [hueShift(p.accent, -38), p.accent, hueShift(p.accent, 52)];
    case "mesh": return [p.accent, hueShift(p.accent, 60), hueShift(p.accent, -70), hueShift(p.info, 0)];
    case "particles": return [p.accent, hueShift(p.accent, 40, 0.05)];
    case "border": return [p.accent, hueShift(p.accent, 70), hueShift(p.accent, -60)];
    case "accentFlow": return [p.fill, hueShift(p.fill, 34), hueShift(p.fill, -30)];
    default: return [p.accent];
  }
}

export interface ClampResult { params: Params; issues: ValidationIssue[]; warnings: string[] }

/** Validate and clamp one effect's params. Unknown keys and wrong types are errors; out-of-range numbers are clamped with a warning. */
export function clampEffectParams(type: EffectType, raw: unknown, path = `effects.${type}`): ClampResult {
  const def = EFFECTS[type];
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const params: Params = {};
  if (raw === true || raw === undefined) return { params, issues, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: `${type} takes an object of params (or {} for defaults).` });
    return { params, issues, warnings };
  }
  const names = Object.keys(def.params);
  for (const [key, value] of Object.entries(raw as Params)) {
    const desc = def.params[key];
    const at = `${path}.${key}`;
    if (!desc) { issues.push({ path: at, message: `${type} has no param \`${key}\`. Params: ${names.join(", ")}.${didYouMean(key, names)}` }); continue; }
    if (value === null || value === undefined) continue;
    switch (desc.kind) {
      case "colors": {
        if (!Array.isArray(value)) { issues.push({ path: at, message: `Use an array of ${desc.min}–${desc.max} colours.` }); break; }
        const parsed: string[] = [];
        value.forEach((item, index) => {
          const color = parseColor(item);
          if (!color) issues.push({ path: `${at}[${index}]`, message: `\`${String(item).slice(0, 40)}\` is not a colour. Use #rrggbb, rgb(), hsl() or oklch().` });
          else parsed.push(formatColor({ ...color, a: 1 }));
        });
        if (parsed.length > desc.max) { warnings.push(`${at}: kept the first ${desc.max} of ${parsed.length} colours.`); parsed.length = desc.max; }
        if (parsed.length < desc.min && issues.every((issue) => !issue.path.startsWith(at))) issues.push({ path: at, message: `${type} needs ${desc.min}–${desc.max} colours (got ${parsed.length}).` });
        params[key] = parsed;
        break;
      }
      case "color": {
        const color = parseColor(value);
        if (!color) issues.push({ path: at, message: `\`${String(value).slice(0, 40)}\` is not a colour.` });
        else params[key] = formatColor({ ...color, a: 1 });
        break;
      }
      case "number":
      case "int": {
        if (typeof value !== "number" || !Number.isFinite(value)) { issues.push({ path: at, message: `Use a number from ${desc.min} to ${desc.max}.` }); break; }
        let next = desc.kind === "int" ? Math.round(value) : value;
        if (next < desc.min || next > desc.max) {
          next = Math.min(desc.max, Math.max(desc.min, next));
          warnings.push(`${at}: ${value} is outside ${desc.min}–${desc.max}; used ${next}.`);
        }
        params[key] = next;
        break;
      }
      case "enum":
        if (!desc.values.includes(value as string | number)) issues.push({ path: at, message: `Use one of ${desc.values.join(", ")}.${typeof value === "string" ? didYouMean(value, desc.values.map(String)) : ""}` });
        else params[key] = value;
        break;
      case "bool":
        if (typeof value !== "boolean") issues.push({ path: at, message: "Use true or false." });
        else params[key] = value;
        break;
      case "targets": {
        const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
        if (!list) { issues.push({ path: at, message: `Use an array of ${desc.values.join(", ")}.` }); break; }
        const kept: string[] = [];
        for (const item of list) {
          if (typeof item === "string" && desc.values.includes(item)) { if (!kept.includes(item)) kept.push(item); }
          else issues.push({ path: at, message: `\`${String(item)}\` is not a target. Use ${desc.values.join(", ")}.${typeof item === "string" ? didYouMean(item, desc.values) : ""}` });
        }
        if (kept.length === 0 && list.length === 0) issues.push({ path: at, message: `Pick at least one target: ${desc.values.join(", ")}.` });
        params[key] = kept;
        break;
      }
      case "range": {
        if (!Array.isArray(value) || value.length !== 2 || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) { issues.push({ path: at, message: `Use [min, max] between ${desc.min} and ${desc.max}.` }); break; }
        let [lo, hi] = (value as number[]).map((n) => Math.min(desc.max, Math.max(desc.min, n)));
        if (lo > hi) [lo, hi] = [hi, lo];
        if (lo !== value[0] || hi !== value[1]) warnings.push(`${at}: clamped to [${lo}, ${hi}].`);
        params[key] = [lo, hi];
        break;
      }
    }
  }
  if (type === "particles" && typeof params.count === "number") {
    const shape = (params.shape as ParticleShape | undefined) ?? "dot";
    const cap = shape === "streak" ? PARTICLE_LIMITS.maxStreaks : params.links === true && shape === "dot" ? PARTICLE_LIMITS.maxWithLinks : PARTICLE_LIMITS.max;
    if (params.count > cap) {
      const why = shape === "streak" ? "streaks" : params.links === true && shape === "dot" ? "particles with links" : `${shape}s (only streaks go above ${PARTICLE_LIMITS.max})`;
      warnings.push(`${path}.count: ${params.count} ${why} is too heavy; used ${cap}.`);
      params.count = cap;
    }
  }
  return { params, issues, warnings };
}

export interface EffectsResult { effects: ThemeEffects; issues: ValidationIssue[]; warnings: string[] }

/** Validate a whole effects map: known types, group limits, per-effect params. */
export function normalizeEffects(raw: unknown, path = "effects"): EffectsResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const effects: ThemeEffects = {};
  if (raw === undefined || raw === null) return { effects, issues, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path, message: "effects is a map of effect type to params, e.g. {\"aurora\":{\"intensity\":0.35}}." });
    return { effects, issues, warnings };
  }
  const counts: Record<EffectGroup, number> = { backdrop: 0, texture: 0, accent: 0 };
  let canvas = 0;
  let total = 0;
  for (const [type, params] of Object.entries(raw as Params)) {
    if (params === null || params === false) continue;
    if (!(EFFECT_TYPES as readonly string[]).includes(type)) {
      issues.push({ path: `${path}.${type}`, message: `\`${type}\` is not an effect. Effects: ${EFFECT_TYPES.join(", ")}.${didYouMean(type, EFFECT_TYPES)}` });
      continue;
    }
    const def = EFFECTS[type as EffectType];
    const result = clampEffectParams(def.type, params, `${path}.${type}`);
    issues.push(...result.issues);
    warnings.push(...result.warnings);
    counts[def.group]++;
    total++;
    if (def.impl === "canvas") canvas++;
    (effects as Record<string, unknown>)[type] = result.params;
  }
  for (const group of Object.keys(counts) as EffectGroup[]) {
    if (counts[group] > GROUP_LIMITS[group]) issues.push({ path, message: `At most ${GROUP_LIMITS[group]} ${group} effects (got ${counts[group]}). Remove one.` });
  }
  if (canvas > MAX_CANVAS_EFFECTS) issues.push({ path, message: "At most one canvas effect (particles)." });
  if (total > MAX_EFFECTS) issues.push({ path, message: `At most ${MAX_EFFECTS} effects in total (got ${total}).` });
  return { effects, issues, warnings };
}

/** Fill defaults (palette-derived where needed). The result has every param. */
export function resolveEffectParams(type: EffectType, params: Params | undefined, palette: EffectPalette): ResolvedParams {
  const def = EFFECTS[type];
  const out: ResolvedParams = {};
  const given = params ?? {};
  for (const [key, desc] of Object.entries(def.params)) {
    const value = given[key];
    if (value !== undefined && value !== null) { out[key] = value; continue; }
    if (desc.kind === "colors") out[key] = defaultColors(type, palette).map((c) => formatColor(c));
    else if (desc.kind === "color") out[key] = undefined;
    else out[key] = desc.default;
  }
  if (type === "particles") {
    const shape = (out.shape as ParticleShape) ?? "dot";
    if (given.count === undefined || given.count === null) out.count = PARTICLE_DEFAULT_COUNT[shape] ?? PARTICLE_DEFAULT_COUNT.dot;
    if ((given.direction === undefined || given.direction === null) && shape !== "dot") out.direction = "fall";
  }
  if (type === "starfield") {
    out.color = out.color ?? formatColor(palette.scheme === "dark" ? mixColors(palette.text, palette.bg, 0.12) : mixColors(palette.text, palette.bg, 0.35));
  }
  if (type === "grid") out.color = out.color ?? formatColor(palette.accent);
  if (type === "glow") out.color = out.color ?? formatColor(palette.accent);
  if (type === "vignette") out.color = out.color ?? formatColor(palette.scheme === "dark" ? { r: 0, g: 0, b: 0, a: 1 } : mixColors(palette.bg, { r: 0.18, g: 0.12, b: 0.06, a: 1 }, 0.85));
  if (type === "shimmer") out.color = out.color ?? formatColor(palette.scheme === "dark" ? { r: 1, g: 1, b: 1, a: 1 } : palette.accent);
  return out;
}

export function effectSeconds(type: EffectType, value: unknown): number | null {
  const table = SPEED_SECONDS[type];
  if (!table || value === "still") return null;
  return table[(value as Exclude<Speed, "still">) ?? "slow"] ?? table.slow;
}

// ---- Contrast palette ---------------------------------------------------------

/** A colour an effect may paint behind or over text, at its strongest opacity, and where it shows. */
export interface EffectPaint { color: Rgba; opacity: number; layer: "back" | "front"; effect: EffectType; area: EffectArea }

/** The area a (resolved or raw) effect shows in; "window" when unset. */
export function effectArea(params: Record<string, unknown> | undefined): EffectArea {
  const value = params?.area;
  return value === "chat" || value === "sidebar" ? value : "window";
}

/** Whether paint in `area` sits behind the given region ("chat" = the main panel incl. top bar; "sidebar" = the left navigator). */
export function areaCovers(area: EffectArea, region: "chat" | "sidebar"): boolean {
  return area === "window" || area === region;
}

/** Peak opacity an aurora/mesh blob reaches for a given intensity. */
export function blobOpacity(intensity: number, scheme: "light" | "dark", kind: "aurora" | "mesh"): number {
  const peak = kind === "aurora" ? (scheme === "dark" ? 1 : 0.6) : (scheme === "dark" ? 0.85 : 0.5);
  return Math.max(0, Math.min(1, intensity)) * peak;
}
/** Strongest darkening/lightening the grain adds to any pixel (used by the contrast check). */
export function grainOpacity(amount: number): number { return Math.max(0, Math.min(1, amount)) * 0.1; }
export function scanlineOpacity(opacity: number): number { return Math.max(0, Math.min(1, opacity)) * 0.06; }
export function vignetteAlpha(strength: number): number { return Math.max(0, Math.min(1, strength)) * 0.35; }

/** Everything the effects may put behind (back) or over (front) text, for the composite check. */
export function effectPaints(effects: ThemeEffects, palette: EffectPalette): EffectPaint[] {
  const out: EffectPaint[] = [];
  for (const type of EFFECT_TYPES) {
    const raw = effects[type] as Params | undefined;
    if (!raw) continue;
    const p = resolveEffectParams(type, raw, palette);
    const colors = (key: string) => ((p[key] as ColorString[] | undefined) ?? []).map((c) => parseColor(c)).filter((c): c is Rgba => Boolean(c));
    const color = (key: string) => (typeof p[key] === "string" ? parseColor(p[key]) : null);
    const where = effectArea(p);
    const push = (paint: Omit<EffectPaint, "area">) => out.push({ ...paint, area: where });
    switch (type) {
      case "aurora":
      case "mesh":
        for (const c of colors("colors")) push({ color: c, opacity: blobOpacity(p.intensity as number, palette.scheme, type), layer: "back", effect: type });
        break;
      case "starfield": {
        // Stars are 1–2px points; a half-strength wash bounds what a star does to a glyph next to it.
        const star = color("color"); if (star) push({ color: star, opacity: 0.5, layer: "back", effect: type });
        const accent = color("accentColor"); if (accent) push({ color: accent, opacity: 0.5, layer: "back", effect: type });
        break;
      }
      case "particles":
        for (const c of colors("colors")) push({ color: c, opacity: 0.5, layer: "back", effect: type });
        break;
      case "grid": {
        const c = color("color"); if (c) push({ color: c, opacity: p.glow ? 0.55 : 0.4, layer: "back", effect: type });
        break;
      }
      case "vignette": {
        const c = color("color"); if (c) push({ color: c, opacity: vignetteAlpha(p.strength as number), layer: "back", effect: type });
        break;
      }
      case "grain":
        push({ color: palette.scheme === "dark" ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }, opacity: grainOpacity(p.amount as number), layer: "front", effect: type });
        break;
      case "scanlines":
        push({ color: palette.scheme === "dark" ? { r: 0, g: 0, b: 0, a: 1 } : { r: 0.1, g: 0.08, b: 0.06, a: 1 }, opacity: scanlineOpacity(p.opacity as number), layer: "front", effect: type });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Effect order within each area matches the back layer in ThemeEffectsLayer. */
const BACKDROP_ORDER: readonly EffectType[] = ["vignette", "mesh", "aurora", "grid", "starfield", "particles"];

/** Include where two backdrop effects overlap behind the same translucent pane. */
export function backdropExtremes(base: Rgba, paints: EffectPaint[]): Array<{ color: Rgba; effects: string[] }> {
  const out: Array<{ color: Rgba; effects: string[] }> = [{ color: base, effects: [] }];
  // Window effects paint first, then the effects clipped to a pane. Each effect
  // contributes at most one colour per sample because its opacity is shared.
  for (const area of EFFECT_AREAS) {
    for (const effect of BACKDROP_ORDER) {
      const group = paints.filter((paint) => paint.layer === "back" && paint.area === area && paint.effect === effect);
      if (!group.length) continue;
      const below = out.slice();
      for (const paint of group) {
        const foreground = withAlpha(paint.color, paint.opacity);
        const label = `${effect} (${formatColor(paint.color)})`;
        for (const backdrop of below) {
          out.push({ color: composite(foreground, backdrop.color), effects: [...backdrop.effects, label] });
        }
      }
    }
  }
  return out;
}

// ---- Deterministic starfield ----------------------------------------------------

export const STAR_TILE = { width: 1800, height: 1200 } as const;
const STAR_COUNTS = { sparse: [40, 20, 9], normal: [80, 40, 16], dense: [140, 70, 26] } as const;

/**
 * Box-shadow lists for the three star layers (far, mid, near). Positions come
 * from the theme id, so a theme always shows the same sky. Each star is drawn
 * four times (one tile right and one tile down), so wide windows stay covered and a
 * translateY(-tile) drift loops cleanly.
 * Far stars are dim and tiny, near stars brighter; a few near stars take the
 * accent colour.
 */
export function starLayers(seed: string, density: "sparse" | "normal" | "dense", accent?: string): string[] {
  const random = seededRandom(`stars:${seed}`);
  const counts = STAR_COUNTS[density] ?? STAR_COUNTS.normal;
  return counts.map((count, layer) => {
    const shadows: string[] = [];
    for (let i = 0; i < count; i++) {
      const x = Math.round(random() * STAR_TILE.width);
      const y = Math.round(random() * STAR_TILE.height);
      const size = layer === 0 ? 0 : layer === 1 ? (random() < 0.3 ? 0.5 : 0) : (random() < 0.5 ? 1 : 0.5);
      const ink = accent && layer === 2 && random() < 0.28 ? accent : "currentColor";
      for (const dx of [0, STAR_TILE.width]) for (const dy of [0, STAR_TILE.height]) shadows.push(`${x + dx}px ${y + dy}px 0 ${size}px ${ink}`);
    }
    return shadows.join(", ");
  });
}
