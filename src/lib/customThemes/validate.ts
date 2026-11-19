// Theme validation (DESIGN §4.1–4.2): shape checks with actionable errors,
// scheme agreement, derivation of omitted tokens, inheritance from the base
// built-in theme, WCAG contrast audit with lightness-only auto-fix, effect
// clamping, customCss cleaning and size limits.
//
// resolveTheme() is the single source of the final colour values; compile.ts
// calls it too, so validation and rendering can never disagree.

import type { ThemeName } from "../../types";
import { readBaseTokens, type ResolvedTokens } from "./baseTokens";
import {
  composite, contrastRatio, formatColor, mixColors, oklchLightness, parseColor, pickOnColor,
  ratioLabel, rgbToOklch, shiftLightness, withAlpha, withLightness, type Rgba,
} from "./color";
import { areaCovers, backdropExtremes, effectPaints, normalizeEffects, resolveEffectParams, type EffectPaint, type EffectPalette } from "./effects";
import { cleanCustomCss } from "./sanitizeCss";
import {
  BUILT_IN_THEMES, CHAT_FONTS, DESCRIPTION_MAX, DIFF_KEYS, DISPLAY_FONTS, ELEVATIONS, FLAT_TOKEN_KEYS, KIT_TOKENS, KIT_TOKEN_BY_KEY, MARK_KEYS, MONO_FONTS,
  NAME_MAX, SHAPES, SPEC_KEYS, SYNTAX_KEYS, THEME_LIMITS, THEME_SCHEMA, TRANSLUCENCY_MAX, UI_FONTS, builtInScheme, cleanText, closestMatch, didYouMean, isBuiltInTheme,
  seeThroughAlpha, utf8Bytes, type ContrastAdjustment, type NormalizeResult, type ThemeEffects, type ThemeSpec, type ThemeTokens, type ThemeTypography, type ValidationIssue,
} from "./spec";

type Scheme = "light" | "dark";
type Palette = Record<string, Rgba>;

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
const MAX_INK_SHIFT = 0.15;

// ---- Base values ------------------------------------------------------------------

/** Base tokens by kit key (parsed). Missing or unparseable values are skipped. */
export function basePalette(base: ThemeName, tokens: ResolvedTokens = readBaseTokens(base)): Palette {
  const out: Palette = {};
  for (const token of KIT_TOKENS) {
    const raw = tokens[token.cssVar];
    const parsed = raw ? parseColor(raw) : null;
    if (parsed) out[token.key] = parsed;
  }
  for (const name of ["--red-soft", "--orange-soft", "--info-soft", "--success-soft"]) {
    const parsed = tokens[name] ? parseColor(tokens[name]) : null;
    if (parsed) out[name] = parsed;
  }
  return out;
}

// ---- Resolution: derive, inherit, fix --------------------------------------------

export interface ContrastFailure { token: string; message: string }

export interface ResolvedTheme {
  scheme: Scheme;
  /** Final colour per kit key (plus status tint keys like "dangerSoft"). */
  palette: Palette;
  /** Inks moved for contrast (given or derived). */
  adjustments: ContrastAdjustment[];
  /** Inks that could not be fixed within the allowed shift. */
  failures: ContrastFailure[];
  warnings: string[];
  /** Effect paints used for the composite check. */
  paints: EffectPaint[];
  /** Effective surfaces after translucency + effects + textures (several per surface). */
  surfaces: Record<string, Rgba[]>;
  /** Reuse the token's full surface and texture requirements for render-time ink adjustments. */
  inkPasses: (key: string, color: Rgba) => boolean;
}

/** Lightness-step offsets for derived surfaces (dark / light). */
const SURFACE_STEPS: Record<Scheme, Record<string, number>> = {
  dark: { sidebar: 0.02, panel: 0.035, panel2: 0.06, panel3: 0.1, field: 0.02, menu: 0.045 },
  light: { sidebar: -0.02, panel: 0, panel2: -0.035, panel3: -0.07, field: 0, menu: 0 },
};

function overlayAll(color: Rgba, fronts: EffectPaint[]): Rgba {
  let out = color;
  for (const paint of fronts) out = composite(withAlpha(paint.color, paint.opacity), { ...out, a: 1 });
  return { ...out, a: 1 };
}

interface Requirement { surfaces: Rgba[]; min: number; label: string }

function worstRatio(ink: Rgba, reqs: Requirement[], fronts: EffectPaint[]): { ratio: number; req: Requirement | null; surface: Rgba | null } {
  let worst = { ratio: Infinity, req: null as Requirement | null, surface: null as Rgba | null, slack: Infinity };
  for (const req of reqs) {
    for (const surface of req.surfaces) {
      const ratio = contrastRatio(overlayAll(ink, fronts), overlayAll(surface, fronts));
      const slack = ratio / req.min;
      if (slack < worst.slack) worst = { ratio, req, surface, slack };
    }
  }
  return worst;
}

function passes(ink: Rgba, reqs: Requirement[], fronts: EffectPaint[]): boolean {
  return reqs.every((req) => req.surfaces.every((surface) => contrastRatio(overlayAll(ink, fronts), overlayAll(surface, fronts)) >= req.min));
}

/** Smallest lightness move that satisfies every requirement (both directions tried). */
function fixInk(ink: Rgba, reqs: Requirement[], fronts: EffectPaint[]): { color: Rgba; ok: boolean } {
  if (passes(ink, reqs, fronts)) return { color: ink, ok: true };
  for (let d = 0.0025; d <= MAX_INK_SHIFT + 1e-9; d += 0.0025) {
    for (const sign of [1, -1]) {
      const candidate = shiftLightness(ink, sign * d);
      if (passes(candidate, reqs, fronts)) return { color: candidate, ok: true };
    }
  }
  return { color: ink, ok: false };
}

/** The softest ink between text and bg (by mix) that still clears `min` everywhere. */
function softestInk(text: Rgba, bg: Rgba, reqs: Requirement[], fronts: EffectPaint[], maxMix: number): Rgba {
  let best = text;
  for (let f = 0.02; f <= maxMix + 1e-9; f += 0.01) {
    const candidate = { ...mixColors(text, bg, f), a: 1 };
    if (passes(candidate, reqs, fronts)) best = candidate; else break;
  }
  return best;
}

function surfaceAdvice(scheme: Scheme, surfaceName: string, surface: Rgba | null): string {
  const hex = surface ? formatColor(surface) : "";
  const l = surface ? oklchLightness(surface) : 0;
  if (scheme === "dark") return `Make ${surfaceName}${hex ? ` (${hex}, L=${l.toFixed(2)})` : ""} darker (L < ${Math.max(0.12, l - 0.08).toFixed(2)}) or choose a lighter ink.`;
  return `Make ${surfaceName}${hex ? ` (${hex}, L=${l.toFixed(2)})` : ""} lighter (L > ${Math.min(0.97, l + 0.06).toFixed(2)}) or choose a darker ink.`;
}

function tokenValue(tokens: ThemeTokens, key: string): string | undefined {
  if (key.includes(".")) {
    const [group, sub] = key.split(".") as ["syntax" | "diff" | "mark", string];
    return (tokens[group] as Record<string, string> | undefined)?.[sub];
  }
  return (tokens as Record<string, string | undefined>)[key];
}

/**
 * Compute every final colour of a (shape-valid) spec: given tokens, derived
 * tokens, inherited base tokens, then the contrast fixes. Deterministic.
 */
export function resolveTheme(spec: ThemeSpec, baseTokens?: ResolvedTokens): ResolvedTheme {
  const scheme = builtInScheme(spec.base);
  const dark = scheme === "dark";
  const base = basePalette(spec.base, baseTokens ?? readBaseTokens(spec.base));
  const given: Palette = {};
  for (const token of KIT_TOKENS) {
    const raw = tokenValue(spec.tokens, token.key);
    const parsed = raw ? parseColor(raw) : null;
    if (parsed) given[token.key] = parsed;
  }
  const p: Palette = {};
  const pick = (key: string, derive: () => Rgba | undefined) => {
    const value = given[key] ?? derive();
    if (value) p[key] = value;
  };
  const warnings: string[] = [];
  const surfaceNames = new Map<Rgba, string>();

  // Surfaces
  pick("bg", () => base.bg);
  const bg = p.bg ?? (dark ? { r: 0.13, g: 0.13, b: 0.15, a: 1 } : WHITE);
  const bgGiven = Boolean(given.bg);
  const step = (key: string) => (bgGiven ? shiftLightness(bg, SURFACE_STEPS[scheme][key]) : base[key] ?? shiftLightness(bg, SURFACE_STEPS[scheme][key]));
  pick("canvas", () => (bgGiven ? bg : base.canvas ?? bg));
  pick("sidebar", () => step("sidebar"));
  pick("panel", () => step("panel"));
  pick("panel2", () => (given.panel ? shiftLightness(given.panel, dark ? 0.025 : -0.035) : step("panel2")));
  pick("panel3", () => (given.panel ? shiftLightness(given.panel, dark ? 0.065 : -0.07) : step("panel3")));
  pick("field", () => (given.sidebar && dark ? given.sidebar : bgGiven ? shiftLightness(bg, SURFACE_STEPS[scheme].field) : base.field ?? bg));
  pick("menu", () => (given.panel ? shiftLightness(given.panel, dark ? 0.01 : 0) : bgGiven ? shiftLightness(bg, SURFACE_STEPS[scheme].menu) : base.menu ?? p.panel));
  pick("topbar", () => withAlpha(bg, 0.9));
  pick("bubble", () => p.panel2);
  pick("codeBg", () => (bgGiven ? shiftLightness(bg, dark ? -0.02 : 0.01) : base.codeBg ?? bg));

  // Inks
  pick("text", () => base.text);
  const text = p.text;
  const bgText = bg;
  pick("ink2", () => (given.text || bgGiven ? { ...mixColors(text, bgText, 0.15), a: 1 } : base.ink2));
  pick("readingInk", () => (dark ? (given.text || bgGiven ? { ...mixColors(text, bgText, 0.07), a: 1 } : base.readingInk ?? text) : text));
  pick("codeInk", () => (given.readingInk || given.text || bgGiven ? p.readingInk : base.codeInk ?? p.readingInk));

  // Lines and interaction fills
  const lineInk = given.text || bgGiven ? text : undefined;
  pick("line", () => (lineInk ? withAlpha(lineInk, dark ? 0.08 : 0.09) : base.line));
  pick("lineStrong", () => (lineInk ? withAlpha(lineInk, dark ? 0.13 : 0.15) : base.lineStrong));
  pick("lineQuiet", () => (lineInk ? withAlpha(lineInk, dark ? 0.05 : 0.055) : base.lineQuiet));
  pick("hover", () => (lineInk ? (dark ? withAlpha(text, 0.035) : withAlpha(BLACK, 0.03)) : base.hover));
  pick("press", () => (lineInk ? (dark ? withAlpha(text, 0.09) : withAlpha(BLACK, 0.075)) : base.press));
  pick("selectedHover", () => (lineInk ? (dark ? withAlpha(text, 0.1) : withAlpha(BLACK, 0.1)) : base.selectedHover ?? p.press));
  pick("menuFocus", () => p.press);

  // Accent
  pick("accent", () => base.accent);
  const accentGiven = Boolean(given.accent);
  pick("accent2", () => (accentGiven ? shiftLightness(p.accent, -0.05) : base.accent2 ?? shiftLightness(p.accent, -0.05)));
  pick("fill", () => (accentGiven ? p.accent : base.fill ?? p.accent));
  pick("onAccent", () => (accentGiven || given.fill ? pickOnColor(p.fill) : base.onAccent ?? pickOnColor(p.fill)));
  pick("accentSoft", () => withAlpha(given.fill && !dark ? given.fill : p.accent, 0.12));
  pick("accentLine", () => withAlpha(p.accent, 0.34));

  // Status (inherited) and their tints
  pick("success", () => base.success);
  pick("warning", () => base.warning);
  pick("danger", () => base.danger);
  pick("info", () => base.info);
  pick("onDanger", () => (given.danger ? pickOnColor(p.danger) : base.onDanger ?? pickOnColor(p.danger)));

  // Overlays
  pick("scrim", () => base.scrim);
  if (p.scrim) {
    const [lo, hi] = dark ? [0.35, 0.75] : [0.15, 0.5];
    const a = Math.min(hi, Math.max(lo, p.scrim.a));
    if (a !== p.scrim.a) warnings.push(`tokens.scrim: alpha ${p.scrim.a.toFixed(2)} is outside ${lo}–${hi} for a ${scheme} theme; used ${a}.`);
    p.scrim = withAlpha(p.scrim, a);
  }
  pick("shadowTint", () => BLACK);
  pick("chart1", () => base.chart1);
  pick("chart2", () => base.chart2);
  for (const key of SYNTAX_KEYS) pick(`syntax.${key}`, () => base[`syntax.${key}`]);
  for (const key of DIFF_KEYS) pick(`diff.${key}`, () => base[`diff.${key}`]);

  // Logo: a tonal family from the accent unless the base already matches it.
  const markOffsets: Record<string, number> = { cyanA: 0.12, cyanB: 0.05, blueA: -0.05, blueB: -0.12, foldA: 0, foldB: -0.08 };
  for (const key of MARK_KEYS) {
    pick(`mark.${key}`, () => {
      if (!accentGiven) return base[`mark.${key}`];
      if (key === "caret") return withLightness(p.accent, 0.97, 0.15);
      const lch = rgbToOklch(p.accent);
      return withLightness(p.accent, Math.min(0.92, Math.max(0.3, lch.l + markOffsets[key])));
    });
  }

  // Status tints follow their inks.
  const soft = dark ? 0.12 : 0.095;
  const tints: Record<string, Rgba> = {
    dangerSoft: withAlpha(p.danger, soft), warningSoft: withAlpha(p.warning, dark ? 0.12 : 0.1), infoSoft: withAlpha(p.info, soft), successSoft: withAlpha(p.success, dark ? 0.12 : 0.1),
    dangerLine: withAlpha(p.danger, dark ? 0.35 : 0.3), warningLine: withAlpha(p.warning, dark ? 0.35 : 0.3), infoLine: withAlpha(p.info, dark ? 0.35 : 0.3),
  };
  Object.assign(p, tints);

  // ---- Effective surfaces ----------------------------------------------------
  const palette: EffectPalette = { scheme, bg, text, accent: p.accent, fill: p.fill, onAccent: p.onAccent, info: p.info, success: p.success, danger: p.danger, warning: p.warning };
  const paints = effectPaints(spec.effects, palette);
  const fronts = paints.filter((paint) => paint.layer === "front");
  const t = seeThroughAlpha(Math.min(TRANSLUCENCY_MAX, Math.max(0, spec.surfaces.translucency || 0)));
  const named = (color: Rgba, name: string): Rgba => { const copy = { ...color, a: 1 }; surfaceNames.set(copy, name); return copy; };
  // Each see-through surface is checked over the plain window and over every back-layer effect that
  // actually shows behind it: bg and the top bar sit in the chat side, the sidebar in the left navigator.
  const seeThrough = (surface: Rgba, name: string, region: "chat" | "sidebar") => {
    if (t <= 0) return [named(surface, name)];
    const behind = paints.filter((paint) => paint.layer === "back" && areaCovers(paint.area, region));
    return backdropExtremes(bg, behind).map((backdrop) => named(
      composite(withAlpha(surface, 1 - t), backdrop.color),
      backdrop.effects.length ? `${name} seen over the ${backdrop.effects.join(" and ")}` : name,
    ));
  };
  const surfaces: Record<string, Rgba[]> = {
    bg: seeThrough(bg, "bg", "chat"),
    sidebar: seeThrough(p.sidebar, "sidebar", "sidebar"),
    panel: [named(p.panel, "panel")], panel2: [named(p.panel2, "panel2")], panel3: [named(p.panel3, "panel3")], menu: [named(p.menu, "menu")], field: [named(p.field, "field")], bubble: [named(p.bubble, "bubble")],
    topbar: t > 0 ? seeThrough(bg, "topbar", "chat") : [named(composite(p.topbar, bg), "topbar")],
    codeBg: [named(p.codeBg, "codeBg")],
  };
  const pressOnSidebar = surfaces.sidebar.map((surface) => named(composite(p.press, surface), `a selected row on ${surfaceNames.get(surface)}`));
  const pressOnMenu = [named(composite(p.press, p.menu), "a highlighted menu item")];
  const onCode = (tint: Rgba) => [named(composite(tint, p.codeBg), "a diff line tint on codeBg")];
  const all = (...names: string[]) => names.flatMap((name) => surfaces[name]);

  // ---- Contrast audit -----------------------------------------------------------
  const textSurfaces = all("bg", "sidebar", "panel", "panel2", "menu", "field", "bubble", "topbar");
  const mutedSurfaces = [...all("bg", "sidebar", "panel", "menu", "field"), ...pressOnSidebar, ...pressOnMenu];
  const accentFlowStops = spec.effects.accentFlow ? ((resolveEffectParams("accentFlow", spec.effects.accentFlow as Record<string, unknown>, palette).colors as string[]) ?? []).map((c) => parseColor(c)).filter((c): c is Rgba => Boolean(c)) : [];

  const rules: Record<string, Requirement[]> = {
    text: [{ surfaces: textSurfaces, min: 4.5, label: "text surfaces" }],
    readingInk: [{ surfaces: textSurfaces, min: 4.5, label: "text surfaces" }],
    ink2: [{ surfaces: textSurfaces, min: 4.5, label: "text surfaces" }],
    codeInk: [{ surfaces: surfaces.codeBg, min: 4.5, label: "codeBg" }],
    muted: [{ surfaces: mutedSurfaces, min: 4.5, label: "muted surfaces" }],
    muted2: [{ surfaces: mutedSurfaces, min: 4.5, label: "muted surfaces" }],
    accent: [{ surfaces: all("bg", "sidebar", "panel", "menu"), min: 4.5, label: "bg/sidebar/panel/menu" }, { surfaces: all("panel3", "field"), min: 3, label: "panel3/field" }],
    onAccent: [{ surfaces: [named(p.fill, "fill"), ...accentFlowStops.map((stop, i) => named(stop, `accentFlow colour ${i + 1}`))], min: 4.5, label: accentFlowStops.length ? "fill and accentFlow stops" : "fill" }],
    onDanger: [{ surfaces: [named(p.danger, "danger")], min: 4.5, label: "danger" }],
  };
  for (const [ink, tint] of [["success", tints.successSoft], ["warning", tints.warningSoft], ["danger", tints.dangerSoft], ["info", tints.infoSoft]] as const) {
    rules[ink] = [{ surfaces: [...all("bg", "panel"), named(composite(tint, p.panel), `its own ${ink} tint on panel`)], min: 4.5, label: "bg/panel/own tint" }];
  }
  const codeTints = [...surfaces.codeBg, ...onCode(p["diff.addBg"]), ...onCode(p["diff.delBg"])];
  for (const key of SYNTAX_KEYS) rules[`syntax.${key}`] = [{ surfaces: codeTints, min: 4.5, label: "codeBg and diff tints" }];
  rules["diff.addInk"] = [{ surfaces: onCode(p["diff.addBg"]), min: 4.5, label: "added lines" }];
  rules["diff.delInk"] = [{ surfaces: onCode(p["diff.delBg"]), min: 4.5, label: "removed lines" }];
  rules["diff.gutterInk"] = [{ surfaces: surfaces.codeBg, min: 3, label: "codeBg" }];

  // Derived muted inks are the softest step that passes; given ones are checked and nudged.
  p.muted = given.muted ?? softestInk(text, bg, [{ surfaces: mutedSurfaces, min: 4.75, label: "" }], fronts, 0.5);
  p.muted2 = given.muted2 ?? (given.muted ? p.muted : softestInk(text, bg, [{ surfaces: mutedSurfaces, min: 4.6, label: "" }], fronts, 0.5));

  const adjustments: ContrastAdjustment[] = [];
  const failures: ContrastFailure[] = [];
  for (const [key, reqs] of Object.entries(rules)) {
    const ink = p[key];
    if (!ink) continue;
    const before = worstRatio(ink, reqs, fronts);
    if (passes(ink, reqs, fronts)) continue;
    const fix = fixInk(ink, reqs, fronts);
    const surfaceName = (before.surface && surfaceNames.get(before.surface)) ?? before.req?.label ?? "its surface";
    if (fix.ok) {
      p[key] = fix.color;
      adjustments.push({ token: key, from: formatColor(ink), to: formatColor(fix.color), reason: `${before.req?.min ?? 4.5}:1 on ${surfaceName} (was ${ratioLabel(before.ratio)})${given[key] ? "" : "; this value was derived or inherited"}` });
    } else {
      if (key === "muted2" && !given.muted2 && failures.some((failure) => failure.token === "muted")) continue;
      const origin = given[key] ? "" : " (this value was derived or inherited from the base; set it explicitly)";
      const overEffect = surfaceName.includes(" seen over the ");
      let suggestion = "";
      for (let d = MAX_INK_SHIFT; d <= 0.7; d += 0.01) {
        const candidate = [shiftLightness(ink, d), shiftLightness(ink, -d)].find((c) => passes(c, reqs, fronts));
        if (candidate) { suggestion = ` An ink like ${formatColor(candidate)} would pass.`; break; }
      }
      const advice = (overEffect ? "Lower that effect's intensity or surfaces.translucency, choose calmer effect colours, or pick a stronger ink." : surfaceAdvice(scheme, surfaceName, before.surface)) + suggestion;
      failures.push({ token: key, message: `${key} (${formatColor(ink)}) can't reach ${before.req?.min ?? 4.5}:1 on ${surfaceName}${before.surface ? ` (${formatColor(before.surface)}, ${ratioLabel(before.ratio)})` : ""} within a small lightness change${origin}. ${advice}` });
    }
  }

  // Warnings only
  if (contrastRatio(p.text, bg) < 7) warnings.push(`tokens.text: ${ratioLabel(contrastRatio(p.text, bg))} on bg; 7:1 or more reads better for long sessions.`);
  if (contrastRatio(composite(p.lineStrong, bg), bg) < 1.25) warnings.push("tokens.lineStrong: field and menu edges are barely visible on bg (below 1.25:1).");
  if (Math.abs(oklchLightness(p.panel) - oklchLightness(bg)) < 0.012 && !(scheme === "light" && formatColor(p.panel) === formatColor(bg))) warnings.push("tokens.panel: cards sit too close to bg to read as a separate surface (lightness step < 0.012).");
  if (Math.abs(oklchLightness(p.menu) - oklchLightness(bg)) < 0.02 && scheme === "dark") warnings.push("tokens.menu: menus sit too close to bg to read as raised (lightness step < 0.02).");

  const inkPasses = (key: string, color: Rgba) => Boolean(rules[key] && passes(color, rules[key], fronts));
  return { scheme, palette: p, adjustments, failures, warnings, paints, surfaces, inkPasses };
}

// ---- Shape checks -------------------------------------------------------------------

const OPAQUE_HINT = "Surfaces and inks must be opaque; use `surfaces.translucency` for see-through backgrounds.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTokens(raw: unknown, issues: ValidationIssue[]): ThemeTokens {
  const out: ThemeTokens = {};
  if (raw === undefined) return out;
  if (!isPlainObject(raw)) { issues.push({ path: "tokens", message: "tokens is an object of colours by kit key, e.g. {\"bg\":\"#16131f\",\"text\":\"#ece8f6\",\"accent\":\"#b794ff\"}." }); return out; }
  const groups = { syntax: SYNTAX_KEYS, diff: DIFF_KEYS, mark: MARK_KEYS } as const;
  const allowed = [...FLAT_TOKEN_KEYS, ...Object.keys(groups)];
  const one = (key: string, value: unknown, path: string): string | null => {
    if (value === null || value === undefined) return null;
    const token = KIT_TOKEN_BY_KEY.get(key);
    const color = parseColor(value);
    if (!color) { issues.push({ path, message: `\`${String(value).slice(0, 40)}\` is not a colour. Use #rrggbb, rgb(), rgba(), hsl() or oklch().` }); return null; }
    if (color.a < 1 && token && !token.alphaAllowed) { issues.push({ path, message: OPAQUE_HINT }); return null; }
    return formatColor(color);
  };
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(groups, key)) {
      if (value === null || value === undefined) continue;
      if (!isPlainObject(value)) { issues.push({ path: `tokens.${key}`, message: `tokens.${key} is an object, e.g. {"${groups[key as keyof typeof groups][0]}":"#c4a7f7"}.` }); continue; }
      const subKeys = groups[key as keyof typeof groups] as readonly string[];
      const target: Record<string, string> = {};
      for (const [sub, subValue] of Object.entries(value)) {
        if (!subKeys.includes(sub)) { issues.push({ path: `tokens.${key}.${sub}`, message: `\`${sub}\` is not a ${key} token. ${key} keys: ${subKeys.join(", ")}.${didYouMean(sub, subKeys)}` }); continue; }
        const color = one(`${key}.${sub}`, subValue, `tokens.${key}.${sub}`);
        if (color) target[sub] = color;
      }
      if (Object.keys(target).length) (out as Record<string, unknown>)[key] = target;
      continue;
    }
    // The kit names nested tokens with dots (mark.blueA, syntax.comment);
    // they are written as nested objects.
    const dot = key.indexOf(".");
    const group = key.slice(0, dot) as keyof typeof groups;
    if (dot > 0 && Object.hasOwn(groups, group)) {
      const sub = key.slice(dot + 1);
      const subKeys = groups[group] as readonly string[];
      const known = subKeys.includes(sub) ? sub : closestMatch(sub, subKeys);
      const exampleValue = value === null || (typeof value === "string" && value.length <= 64 && parseColor(value)) ? value : "#7aa8ff";
      const example = JSON.stringify({ tokens: { [group]: { [known ?? subKeys[0]]: exampleValue } } });
      issues.push({
        path: `tokens.${key}`,
        message: `Use a nested ${group} object, for example ${example}.${known === sub ? "" : ` Valid ${group} keys: ${subKeys.join(", ")}.`}`,
      });
      continue;
    }
    if (!FLAT_TOKEN_KEYS.includes(key)) {
      issues.push({ path: `tokens.${key}`, message: `\`${key}\` is not a token.${didYouMean(key, allowed) || ` Tokens: ${FLAT_TOKEN_KEYS.join(", ")}, syntax.*, diff.*, mark.*.`}` });
      continue;
    }
    const color = one(key, value, `tokens.${key}`);
    if (color) (out as Record<string, unknown>)[key] = color;
  }
  return out;
}

function normalizeTypography(raw: unknown, issues: ValidationIssue[]): ThemeTypography {
  const out: ThemeTypography = {};
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) { issues.push({ path: "typography", message: "typography is {ui, display, mono, chat}." }); return out; }
  const lists: Record<string, readonly string[]> = { ui: UI_FONTS, display: DISPLAY_FONTS, mono: MONO_FONTS, chat: CHAT_FONTS };
  for (const [key, value] of Object.entries(raw)) {
    const list = lists[key];
    if (!list) { issues.push({ path: `typography.${key}`, message: `typography has ui, display, mono and chat.${didYouMean(key, Object.keys(lists))}` }); continue; }
    if (value === null || value === undefined) { if (key === "chat") out.chat = null; continue; }
    if (typeof value !== "string" || !list.includes(value)) {
      issues.push({ path: `typography.${key}`, message: `Use one of ${list.join(", ")}.${typeof value === "string" ? didYouMean(value, list) : ""} Only system and bundled fonts are available.` });
      continue;
    }
    (out as Record<string, string>)[key] = value;
  }
  return out;
}

function bgSchemeError(bg: string | undefined, base: ThemeName): ValidationIssue | null {
  const color = bg ? parseColor(bg) : null;
  if (!color) return null;
  const l = oklchLightness(color);
  const scheme = builtInScheme(base);
  const lights = BUILT_IN_THEMES.filter((id) => builtInScheme(id) === "light").map((id) => `\`${id}\``);
  const darks = BUILT_IN_THEMES.filter((id) => builtInScheme(id) === "dark").map((id) => `\`${id}\``);
  if (scheme === "dark" && l > 0.5) return { path: "tokens.bg", message: `\`bg\` is light (L=${l.toFixed(2)}) but base \`${base}\` is a dark theme. Use base ${lights.join(", ")}, or a darker \`bg\` (L ≤ 0.50).` };
  if (scheme === "light" && l < 0.72) return { path: "tokens.bg", message: `\`bg\` is dark (L=${l.toFixed(2)}) but base \`${base}\` is a light theme. Use base ${darks.join(", ")}, or a lighter \`bg\` (L ≥ 0.72).` };
  return null;
}

export interface NormalizeOptions {
  mode: "create";
  /** Testing / host override for the base values. */
  baseTokens?: ResolvedTokens;
}

/**
 * Validate and normalize a theme. On success the spec is canonical: colours
 * normalized, given inks already contrast-fixed, effects clamped, customCss
 * cleaned (unscoped). Normalizing a normalized spec returns it unchanged.
 */
export function normalizeThemeInput(input: unknown, opts: NormalizeOptions = { mode: "create" }): NormalizeResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: "", message: "A theme is a JSON object with name, base and tokens." }] };
  for (const key of Object.keys(input)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) issues.push({ path: key, message: `Unknown key \`${key}\`. Allowed: ${SPEC_KEYS.filter((k) => k !== "schema").join(", ")}.${didYouMean(key, SPEC_KEYS)}` });
  }
  if (input.schema !== undefined && input.schema !== THEME_SCHEMA) issues.push({ path: "schema", message: `schema must be "${THEME_SCHEMA}" (or omitted).` });

  // name / description
  let name = "";
  if (typeof input.name !== "string" || !cleanText(input.name)) issues.push({ path: "name", message: `name is required: 1–${NAME_MAX} characters.` });
  else {
    name = cleanText(input.name);
    if (name.length > NAME_MAX) { warnings.push(`name: shortened to ${NAME_MAX} characters.`); name = Array.from(name).slice(0, NAME_MAX).join("").trim(); }
  }
  let description = "";
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") issues.push({ path: "description", message: `description is a string (0–${DESCRIPTION_MAX} characters).` });
    else {
      description = cleanText(input.description);
      if (description.length > DESCRIPTION_MAX) { warnings.push(`description: shortened to ${DESCRIPTION_MAX} characters.`); description = Array.from(description).slice(0, DESCRIPTION_MAX - 1).join("").trim() + "…"; }
    }
  }

  // base
  const base = input.base;
  if (!isBuiltInTheme(base)) issues.push({ path: "base", message: `base is required: one of ${BUILT_IN_THEMES.join(", ")}.${typeof base === "string" ? didYouMean(base, BUILT_IN_THEMES) : ""} Its light/dark scheme is kept.` });

  // tokens
  const tokens = normalizeTokens(input.tokens, issues);
  if (opts.mode === "create") {
    for (const key of ["bg", "text", "accent"] as const) {
      if (!tokens[key] && !issues.some((issue) => issue.path === `tokens.${key}`)) issues.push({ path: `tokens.${key}`, message: `tokens.${key} is required.` });
    }
  }
  if (isBuiltInTheme(base)) {
    const schemeIssue = bgSchemeError(tokens.bg, base);
    if (schemeIssue) issues.push(schemeIssue);
  }

  // enums
  const shape = input.shape ?? "standard";
  if (!SHAPES.includes(shape as never)) issues.push({ path: "shape", message: `Use one of ${SHAPES.join(", ")}.` });
  const elevation = input.elevation ?? "soft";
  if (!ELEVATIONS.includes(elevation as never)) issues.push({ path: "elevation", message: `Use one of ${ELEVATIONS.join(", ")}.` });
  const typography = normalizeTypography(input.typography, issues);

  // surfaces / motion
  let translucency = 0;
  if (input.surfaces !== undefined && input.surfaces !== null) {
    if (!isPlainObject(input.surfaces)) issues.push({ path: "surfaces", message: "surfaces is {translucency: 0–0.2}." });
    else {
      for (const key of Object.keys(input.surfaces)) if (key !== "translucency") issues.push({ path: `surfaces.${key}`, message: "surfaces only has translucency (0–0.2)." });
      const value = input.surfaces.translucency;
      if (value !== undefined && value !== null) {
        if (typeof value !== "number" || !Number.isFinite(value)) issues.push({ path: "surfaces.translucency", message: "Use a number from 0 to 0.2." });
        else {
          translucency = Math.round(Math.min(TRANSLUCENCY_MAX, Math.max(0, value)) * 1000) / 1000;
          if (translucency !== value) warnings.push(`surfaces.translucency: ${value} is outside 0–${TRANSLUCENCY_MAX}; used ${translucency}.`);
        }
      }
    }
  }
  let motionEnabled = true;
  if (input.motion !== undefined && input.motion !== null) {
    if (!isPlainObject(input.motion) || (input.motion.enabled !== undefined && typeof input.motion.enabled !== "boolean")) issues.push({ path: "motion", message: "motion is {enabled: true | false}." });
    else {
      for (const key of Object.keys(input.motion)) if (key !== "enabled") issues.push({ path: `motion.${key}`, message: "motion only has enabled." });
      if (input.motion.enabled === false) motionEnabled = false;
    }
  }

  // effects
  const effectsResult = normalizeEffects(input.effects);
  issues.push(...effectsResult.issues);
  warnings.push(...effectsResult.warnings);
  const effects: ThemeEffects = effectsResult.effects;
  const backdropTypes = (Object.keys(effects) as (keyof ThemeEffects)[]).filter((type) => ["aurora", "mesh", "starfield", "particles", "grid", "vignette"].includes(type));
  if (backdropTypes.length && translucency === 0) warnings.push(`effects: ${backdropTypes.join(", ")} only show through see-through surfaces; set surfaces.translucency (e.g. 0.12) to make them visible.`);

  // customCss
  let customCss = "";
  if (input.customCss !== undefined && input.customCss !== null) {
    if (typeof input.customCss !== "string") issues.push({ path: "customCss", message: "customCss is a string of CSS (or \"\")." });
    else if (utf8Bytes(input.customCss) > THEME_LIMITS.maxCustomCssBytes) issues.push({ path: "customCss", message: `customCss is ${utf8Bytes(input.customCss)} bytes; the limit is ${THEME_LIMITS.maxCustomCssBytes}. Prefer tokens and curated effects.` });
    else if (input.customCss.trim()) {
      const cleaned = cleanCustomCss(input.customCss);
      // A forbidden declaration is removed, not fatal: the rest of the theme
      // (tokens, effects, the safe rules) still saves and the model reads why.
      for (const error of cleaned.errors) warnings.push(`customCss: removed ${error.replace(/\.$/, "")}`);
      for (const drop of cleaned.dropped) warnings.push(`customCss: dropped ${drop.where} (${drop.reason})`);
      customCss = cleaned.css;
    }
  }

  if (issues.length) return { ok: false, errors: issues };

  const spec: ThemeSpec = {
    schema: THEME_SCHEMA,
    name,
    description,
    base: base as ThemeName,
    tokens,
    shape: shape as ThemeSpec["shape"],
    elevation: elevation as ThemeSpec["elevation"],
    typography,
    surfaces: { translucency },
    effects,
    motion: { enabled: motionEnabled },
    customCss,
  };

  // Contrast: fix given inks in place (so the stored spec is canonical) and report.
  const resolved = resolveTheme(spec, opts.baseTokens);
  if (!resolved.palette.bg || !resolved.palette.text) return { ok: false, errors: [{ path: "base", message: "Mythra Code couldn't read the base theme's colours. Try again in a moment." }] };
  if (resolved.failures.length) return { ok: false, errors: resolved.failures.map((failure) => ({ path: `tokens.${failure.token}`, message: failure.message })) };
  for (const adjustment of resolved.adjustments) {
    if (tokenValue(spec.tokens, adjustment.token) === undefined) continue;
    setToken(spec.tokens, adjustment.token, adjustment.to);
  }
  warnings.push(...resolved.warnings);

  const bytes = utf8Bytes(JSON.stringify(spec));
  if (bytes > THEME_LIMITS.maxSpecBytes) return { ok: false, errors: [{ path: "", message: `The theme is ${bytes} bytes; the limit is ${THEME_LIMITS.maxSpecBytes}. Shorten customCss or remove effects.` }] };
  return { ok: true, spec, adjustments: resolved.adjustments, warnings };
}

function setToken(tokens: ThemeTokens, key: string, value: string): void {
  if (key.includes(".")) {
    const [group, sub] = key.split(".") as ["syntax" | "diff" | "mark", string];
    const target = ((tokens as Record<string, Record<string, string>>)[group] ??= {});
    target[sub] = value;
  } else (tokens as Record<string, string>)[key] = value;
}

// ---- Patches ------------------------------------------------------------------------

const PATCH_KEYS = SPEC_KEYS.filter((key) => key !== "schema");

function mergeTokens(current: ThemeTokens, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(current));
  for (const [key, value] of Object.entries(patch)) {
    if ((key === "syntax" || key === "diff" || key === "mark") && isPlainObject(value)) {
      const group: Record<string, unknown> = { ...(out[key] as Record<string, unknown> | undefined) };
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === null) delete group[sub]; else group[sub] = subValue;
      }
      if (Object.keys(group).length) out[key] = group; else delete out[key];
    } else if (value === null && !key.includes(".")) delete out[key];
    else out[key] = value;
  }
  return out;
}

function mergeEffects(current: ThemeEffects, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(current));
  for (const [type, value] of Object.entries(patch)) {
    if (value === null || value === false) { delete out[type]; continue; }
    if (isPlainObject(value) && isPlainObject(out[type])) {
      const merged: Record<string, unknown> = { ...(out[type] as Record<string, unknown>) };
      for (const [key, param] of Object.entries(value)) {
        if (param === null) delete merged[key]; else merged[key] = param;
      }
      out[type] = merged;
    } else out[type] = value;
  }
  return out;
}

/**
 * Apply an update_custom_theme patch, then normalize. tokens merge key by key
 * (null resets to derived/inherited); effects merge by type (null removes) and
 * params merge (null resets a param); typography, surfaces and motion merge key
 * by key; customCss replaces ("" removes); name, description, base, shape and
 * elevation replace.
 */
export function applyThemePatch(current: ThemeSpec, patch: unknown, opts: Omit<NormalizeOptions, "mode"> = {}): NormalizeResult {
  if (!isPlainObject(patch)) return { ok: false, errors: [{ path: "patch", message: "patch is an object with any of: " + PATCH_KEYS.join(", ") + "." }] };
  const errors: ValidationIssue[] = [];
  for (const key of Object.keys(patch)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) errors.push({ path: `patch.${key}`, message: `Unknown key \`${key}\`. A patch may change: ${PATCH_KEYS.join(", ")}.${didYouMean(key, PATCH_KEYS)}` });
  }
  if (Object.keys(patch).length === 0) errors.push({ path: "patch", message: "The patch is empty; send only what changes." });
  if (errors.length) return { ok: false, errors };
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(current));
  for (const [key, value] of Object.entries(patch)) {
    if (key === "tokens") {
      if (value === null) next.tokens = {};
      else if (!isPlainObject(value)) return { ok: false, errors: [{ path: "patch.tokens", message: "tokens is an object; null on a key resets it." }] };
      else next.tokens = mergeTokens(current.tokens, value);
    } else if (key === "effects") {
      if (value === null) next.effects = {};
      else if (!isPlainObject(value)) return { ok: false, errors: [{ path: "patch.effects", message: "effects is a map of effect type to params; null removes an effect." }] };
      else next.effects = mergeEffects(current.effects, value);
    } else if ((key === "typography" || key === "surfaces" || key === "motion") && isPlainObject(value)) {
      const merged: Record<string, unknown> = { ...(current[key] as unknown as Record<string, unknown>) };
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === null && !(key === "typography" && sub === "chat")) delete merged[sub]; else merged[sub] = subValue;
      }
      next[key] = merged;
    } else if (key === "customCss" && value === null) next.customCss = "";
    else next[key] = value;
  }
  const result = normalizeThemeInput(next, { mode: "create", baseTokens: opts.baseTokens });
  if (!result.ok) return { ok: false, errors: result.errors.map((issue) => ({ ...issue, path: issue.path ? `patch.${issue.path}` : "patch" })) };
  return result;
}

/** Dotted paths that differ between two specs (for tool results: "tokens.accent", "effects.aurora.intensity"). */
export function diffThemeSpecs(before: ThemeSpec, after: ThemeSpec): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a === undefined || b === undefined) { out.push(path); return; }
    if (depth < 3 && isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
    } else if (depth < 3 && (isPlainObject(a) || isPlainObject(b))) {
      const obj = (isPlainObject(a) ? a : b) as Record<string, unknown>;
      const other = (isPlainObject(a) ? b : a) as unknown;
      if (other === undefined) for (const key of Object.keys(obj)) walk(isPlainObject(a) ? obj[key] : undefined, isPlainObject(b) ? obj[key] : undefined, path ? `${path}.${key}` : key, depth + 1);
      else out.push(path);
    } else out.push(path);
  };
  walk(before, after, "", 0);
  return out.filter((path) => path !== "schema");
}

/** [canvas, panel, accent] for gallery tiles (resolved, so derived values show). */
export function themeSwatches(spec: ThemeSpec): [string, string, string] {
  try {
    const { palette } = resolveTheme(spec);
    return [formatColor(palette.canvas ?? palette.bg), formatColor(palette.panel), formatColor(palette.accent)];
  } catch {
    return [spec.tokens.canvas ?? spec.tokens.bg ?? "#212226", spec.tokens.panel ?? spec.tokens.bg ?? "#2a2b30", spec.tokens.accent ?? "#64ddf2"];
  }
}
