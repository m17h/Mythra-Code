// Colour parsing, formatting and the maths the theme engine checks contrast
// with: sRGB <-> OKLab/OKLCH, WCAG 2.x relative luminance and contrast,
// alpha compositing and lightness-only nudges. Pure functions; no DOM.

/** sRGB channels and alpha, each 0..1. */
export interface Rgba { r: number; g: number; b: number; a: number }
export interface Oklch { l: number; c: number; h: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 },
};

/** Split a functional notation body on commas, whitespace and the "/" alpha separator. */
function functionArgs(body: string): { parts: string[]; alpha: string | null } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let main = trimmed;
  let alpha: string | null = null;
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    main = trimmed.slice(0, slash);
    alpha = trimmed.slice(slash + 1).trim();
    if (!alpha || alpha.includes("/")) return null;
  }
  const parts = main.includes(",") ? main.split(",").map((part) => part.trim()) : main.trim().split(/\s+/);
  if (parts.some((part) => part === "")) return null;
  if (alpha === null && main.includes(",") && parts.length === 4) {
    alpha = parts.pop() ?? null;
  }
  return { parts, alpha };
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parseNumber(token: string): number | null {
  return NUMBER.test(token) ? Number(token) : null;
}
function parsePercentOrNumber(token: string, percentScale: number): number | null {
  if (token.endsWith("%")) {
    const value = parseNumber(token.slice(0, -1));
    return value === null ? null : (value / 100) * percentScale;
  }
  return parseNumber(token);
}
function parseAlpha(token: string | null): number | null {
  if (token === null) return 1;
  const value = parsePercentOrNumber(token, 1);
  return value === null ? null : clamp01(value);
}
function parseHue(token: string): number | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/i.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "deg").toLowerCase();
  const degrees = unit === "turn" ? value * 360 : unit === "rad" ? (value * 180) / Math.PI : unit === "grad" ? value * 0.9 : value;
  return ((degrees % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** Parse a CSS colour. Returns null for anything outside the supported set. */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!value || value.length > 80) return null;
  if (NAMED[value]) return { ...NAMED[value] };
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? hex.split("").map((ch) => ch + ch).join("") : hex;
    const channel = (index: number) => parseInt(full.slice(index, index + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 };
  }
  const fn = /^(rgba?|hsla?|oklch)\((.*)\)$/.exec(value);
  if (!fn) return null;
  const args = functionArgs(fn[2]);
  if (!args || args.parts.length !== 3) return null;
  const alpha = parseAlpha(args.alpha);
  if (alpha === null) return null;
  const [p0, p1, p2] = args.parts;
  if (fn[1] === "rgb" || fn[1] === "rgba") {
    const channels = [p0, p1, p2].map((part) => parsePercentOrNumber(part, 255));
    if (channels.some((channel) => channel === null)) return null;
    const [r, g, b] = channels as number[];
    return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: alpha };
  }
  if (fn[1] === "hsl" || fn[1] === "hsla") {
    const h = parseHue(p0);
    const s = parsePercentOrNumber(p1, 100);
    const l = parsePercentOrNumber(p2, 100);
    if (h === null || s === null || l === null) return null;
    const [r, g, b] = hslToRgb(h, clamp01(s / 100), clamp01(l / 100));
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: alpha };
  }
  // oklch(L C H): L as 0..1 or a percentage, C as a number or a percentage of 0.4.
  const l = parsePercentOrNumber(p0, 1);
  const c = parsePercentOrNumber(p1, 0.4);
  const h = p2 === "none" ? 0 : parseHue(p2);
  if (l === null || c === null || h === null) return null;
  const rgb = oklchToRgb({ l: clamp01(l), c: Math.max(0, c), h });
  return { ...rgb, a: alpha };
}

const hex2 = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");

/** #rrggbb when opaque, otherwise rgba(r, g, b, a) with 0..255 channels. */
export function formatColor(color: Rgba): string {
  if (color.a >= 0.9995) return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  const channel = (value: number) => Math.round(clamp01(value) * 255);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${round(clamp01(color.a), 3)})`;
}

/** Parse then re-format; null when unparseable. */
export function normalizeColor(input: unknown): string | null {
  const parsed = parseColor(input);
  return parsed ? formatColor(parsed) : null;
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: clamp01(alpha) };
}

// ---- Linear light, luminance and contrast ----------------------------------

const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const fromLinear = (channel: number) => (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** Paint `fg` (possibly translucent) over `bg`; the result keeps bg's alpha combined. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (f: number, b: number) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
  return { r: channel(fg.r, bg.r), g: channel(fg.g, bg.g), b: channel(fg.b, bg.b), a };
}

/** Contrast ratio (1..21). A translucent ink is composited on the surface; the surface is treated as opaque. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const surface = { ...bg, a: 1 };
  const ink = fg.a < 1 ? composite(fg, surface) : fg;
  const l1 = relativeLuminance(ink);
  const l2 = relativeLuminance(surface);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix like color-mix(in srgb, a (1-t), b t). */
export function mixColors(a: Rgba, b: Rgba, t: number): Rgba {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k };
}

// ---- OKLab / OKLCH ----------------------------------------------------------

export function rgbToOklch(color: Rgba): Oklch {
  const r = toLinear(color.r), g = toLinear(color.g), b = toLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr), B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (channels: [number, number, number]) => channels.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH to sRGB. Out-of-gamut colours keep hue and lightness and lose chroma until they fit. */
export function oklchToRgb(input: Oklch): Omit<Rgba, "a"> & { a: number } {
  const target = { ...input, l: clamp01(input.l) };
  let linear = oklchToLinear(target);
  if (!inGamut(linear)) {
    let lo = 0, hi = target.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...target, c: mid }))) lo = mid; else hi = mid;
    }
    linear = oklchToLinear({ ...target, c: lo });
  }
  return { r: clamp01(fromLinear(Math.max(0, linear[0]))), g: clamp01(fromLinear(Math.max(0, linear[1]))), b: clamp01(fromLinear(Math.max(0, linear[2]))), a: 1 };
}

export function oklchLightness(color: Rgba): number {
  return rgbToOklch(color).l;
}

/** Shift OKLCH lightness by `delta` (hue and chroma kept, chroma reduced if out of gamut). */
export function shiftLightness(color: Rgba, delta: number): Rgba {
  const lch = rgbToOklch(color);
  return { ...oklchToRgb({ ...lch, l: clamp01(lch.l + delta) }), a: color.a };
}

/** Set OKLCH lightness, optionally scaling chroma. */
export function withLightness(color: Rgba, l: number, chromaScale = 1): Rgba {
  const lch = rgbToOklch(color);
  return { ...oklchToRgb({ l: clamp01(l), c: lch.c * chromaScale, h: lch.h }), a: color.a };
}

export function isDarkColor(color: Rgba): boolean {
  return oklchLightness(color) < 0.6;
}

export interface LightnessFix { color: Rgba; delta: number; ok: boolean; worst: number }

/**
 * Move `ink` along OKLCH lightness by the smallest step (|delta| <= maxDelta)
 * that gives at least `min` contrast on every surface. Tries both directions
 * and keeps the smaller move. `ok: false` means no step within the bound works;
 * `color` is then the best attempt found.
 */
export function adjustLightnessToContrast(ink: Rgba, surfaces: Rgba[], min: number, maxDelta = 0.15): LightnessFix {
  const worstOf = (candidate: Rgba) => surfaces.reduce((worst, surface) => Math.min(worst, contrastRatio(candidate, surface)), Infinity);
  const start = worstOf(ink);
  if (start >= min || surfaces.length === 0) return { color: ink, delta: 0, ok: true, worst: start };
  const step = 0.0025;
  let best: LightnessFix = { color: ink, delta: 0, ok: false, worst: start };
  for (let d = step; d <= maxDelta + 1e-9; d += step) {
    for (const sign of [1, -1]) {
      const candidate = shiftLightness(ink, sign * d);
      const worst = worstOf(candidate);
      if (worst >= min) return { color: candidate, delta: sign * d, ok: true, worst };
      if (worst > best.worst) best = { color: candidate, delta: sign * d, ok: false, worst };
    }
  }
  return best;
}

/** Ink that contrasts most on `fill`: a near-black or near-white tinted toward the fill's hue. */
export function pickOnColor(fill: Rgba): Rgba {
  const lch = rgbToOklch(fill);
  const dark = { ...oklchToRgb({ l: 0.16, c: Math.min(0.04, lch.c * 0.35), h: lch.h }), a: 1 };
  const light = { ...oklchToRgb({ l: 0.985, c: Math.min(0.012, lch.c * 0.12), h: lch.h }), a: 1 };
  // Prefer the tinted inks; fall back to pure black/white when a mid-tone fill needs every bit of contrast.
  const candidates: Rgba[] = [dark, light];
  if (Math.max(contrastRatio(dark, fill), contrastRatio(light, fill)) < 4.5) candidates.push({ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 });
  return candidates.reduce((best, candidate) => (contrastRatio(candidate, fill) > contrastRatio(best, fill) ? candidate : best));
}

/** Ratio rounded for messages, e.g. 3.6. */
export function ratioLabel(ratio: number): string {
  return `${round(ratio, 1)}:1`;
}

/** A deterministic 32-bit PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
