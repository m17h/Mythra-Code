// The design kit returned by get_theme_design_kit: everything a model needs
// to design a good Mythra Code theme, in one JSON object. It is only sent
// when a model asks for it, so it can be thorough.

import type { ThemeName } from "../../types";
import { readBaseTokens } from "./baseTokens";
import { EFFECTS, GROUP_LIMITS, MAX_EFFECTS } from "./effects";
import { CSS_LIMITS, PROTECTED_CLASSES, PROTECTED_PREFIXES } from "./sanitizeCss";
import {
  BUILT_IN_THEMES, CHAT_FONTS, DESCRIPTION_MAX, DISPLAY_FONTS, ELEVATIONS, KIT_TOKENS, MONO_FONTS, NAME_MAX, SHAPES, THEME_LIMITS, THEME_SCHEMA,
  TRANSLUCENCY_MAX, UI_FONTS, builtInScheme,
} from "./spec";

export interface DesignKit {
  schema: string;
  principles: string[];
  workflow: string[];
  spec: Record<string, string>;
  bases: Array<{ id: ThemeName; scheme: "light" | "dark" }>;
  required: string[];
  tokens: Array<{ key: string; cssVar: string; role: string; doc: string; translucentAllowed: boolean; dark?: string; light?: string }>;
  derivation: string[];
  contrast: string[];
  effects: { limits: Record<string, number | string>; catalog: Array<{ type: string; group: string; doc: string; params: Record<string, string> }> };
  typography: Record<string, string[] | string>;
  shapes: string[];
  elevations: string[];
  customCss: { summary: string; allowed: string[]; denied: string[]; protectedClasses: string[]; limits: Record<string, number>; example: string };
  patchSemantics: string[];
  examples: Array<{ name: string; spec: Record<string, unknown> }>;
}

function paramDoc(desc: (typeof EFFECTS)[keyof typeof EFFECTS]["params"][string]): string {
  switch (desc.kind) {
    case "colors": return `${desc.min}–${desc.max} colours. ${desc.doc}`;
    case "color": return `colour. ${desc.doc}`;
    case "number": return `number ${desc.min}–${desc.max}, default ${desc.default}. ${desc.doc}`;
    case "int": return `integer ${desc.min}–${desc.max}, default ${desc.default}. ${desc.doc}`;
    case "enum": return `one of ${desc.values.join(" | ")}, default ${desc.default}. ${desc.doc}`;
    case "bool": return `boolean, default ${desc.default}. ${desc.doc}`;
    case "targets": return `array of ${desc.values.join(" | ")}, default [${desc.default.join(", ")}]. ${desc.doc}`;
    case "range": return `[min, max] ${desc.min}–${desc.max}, default [${desc.default.join(", ")}]. ${desc.doc}`;
  }
}

export function buildDesignKit(): DesignKit {
  const dark = readBaseTokens("mythra");
  const light = readBaseTokens("light-mythra");
  return {
    schema: THEME_SCHEMA,
    principles: [
      "Design for long coding sessions: calm surfaces a small step apart, readable muted text, one clear accent used sparingly.",
      "Pick bg, text and accent first; let Mythra Code derive the rest, then override only what the idea needs.",
      "Keep panels, menus and fields solid; use surfaces.translucency (0.1–0.2) only to let a backdrop effect breathe behind the window background and sidebar.",
      "Motion should be slow and quiet: one backdrop effect plus at most one or two accent touches. Prefer speed \"slow\".",
      "Light themes: tinted paper, deep inks, a saturated but dark accent. Dark themes: lifted graphite or tinted night, soft white text, a luminous accent.",
      "Prefer tokens and curated effects; customCss is for small cosmetic touches and is sanitized.",
    ],
    workflow: [
      "1. Read this kit once.",
      "2. create_custom_theme with name, base, tokens (bg, text, accent at least), and optionally effects/typography.",
      "3. Read adjustments and warnings in the result; tell the user in plain words what was nudged for readability.",
      "4. For any later change use update_custom_theme with a small patch; use undo_custom_theme to go back.",
    ],
    spec: {
      name: `1–${NAME_MAX} characters`,
      description: `0–${DESCRIPTION_MAX} characters`,
      base: `one of ${BUILT_IN_THEMES.join(", ")}; the theme keeps its light/dark scheme and inherits everything you don't set`,
      tokens: "colours by kit key (see tokens); #rrggbb, rgb(), rgba(), hsl() or oklch()",
      shape: SHAPES.join(" | ") + " (corner radii; default standard)",
      elevation: ELEVATIONS.join(" | ") + " (shadow depth; default soft)",
      typography: "{ui, display, mono, chat} (see typography)",
      surfaces: `{translucency: 0–${TRANSLUCENCY_MAX}} (default 0). 0.2 makes the window background and sidebar half see-through so backdrop effects show; 0.1–0.16 is a calm choice`,
      effects: "map of effect type to params (see effects)",
      motion: "{enabled: boolean} (default true)",
      customCss: `optional sanitized cosmetic CSS, at most ${THEME_LIMITS.maxCustomCssBytes} bytes`,
    },
    bases: BUILT_IN_THEMES.map((id) => ({ id, scheme: builtInScheme(id) })),
    required: ["name", "base", "tokens.bg", "tokens.text", "tokens.accent"],
    tokens: KIT_TOKENS.map((token) => ({
      key: token.key, cssVar: token.cssVar, role: token.role, doc: token.doc, translucentAllowed: token.alphaAllowed,
      ...(dark[token.cssVar] ? { dark: dark[token.cssVar] } : {}),
      ...(light[token.cssVar] ? { light: light[token.cssVar] } : {}),
    })),
    derivation: [
      "canvas = bg. sidebar/panel/panel2/panel3 are OKLCH lightness steps from bg (dark +0.02/+0.035/+0.06/+0.10; light −0.02/0/−0.035/−0.07); field ≈ sidebar; menu ≈ panel (raised on dark).",
      "topbar = bg at 90% alpha; bubble = panel2; codeBg = bg slightly darker (dark) or lighter (light); codeInk = readingInk.",
      "line/lineStrong/lineQuiet = text at 8/13/5% alpha (dark) or 9/15/5.5% (light).",
      "ink2 = text mixed 15% toward bg; readingInk = text mixed 7% toward bg on dark themes; muted/muted2 = the softest ink that still reads at 4.5:1 everywhere.",
      "accent2 = accent a little darker; fill = accent; onAccent = near-black or near-white, whichever reads best on fill; accentSoft/accentLine = accent at 12%/34% alpha.",
      "success/warning/danger/info, syntax.*, diff.*, chart1/2 and scrim are inherited from the base (adjusted only if they fail contrast on your surfaces). mark.* is a tonal family from accent.",
    ],
    contrast: [
      "text, readingInk, ink2: ≥ 4.5:1 on bg, sidebar, panel, panel2, menu, field, bubble and topbar (7:1 recommended for text).",
      "muted, muted2: ≥ 4.5:1 on bg, sidebar, panel, menu, field and a selected row.",
      "accent: ≥ 4.5:1 on bg, sidebar, panel and menu; ≥ 3:1 on panel3 and field (focus visibility).",
      "onAccent on fill (and every accentFlow colour), onDanger on danger: ≥ 4.5:1.",
      "Status inks on bg, panel and their own tints; syntax and diff inks on codeBg and the diff tints: ≥ 4.5:1.",
      "With translucency, surfaces are checked over the plain window and over every backdrop effect colour at full strength; textures are included.",
      "A failing ink is moved along lightness only (hue kept) by up to 0.15; the change is reported in adjustments. Surfaces are never moved: if an ink can't be fixed, the call fails with advice.",
    ],
    effects: {
      limits: { ...GROUP_LIMITS, total: MAX_EFFECTS, canvas: 1, note: "Backdrop effects show only through see-through surfaces (surfaces.translucency > 0). Accent effects decorate specific controls. Everything pauses for reduced motion, the user's pause switch and when the app is in the background." },
      catalog: Object.values(EFFECTS).map((def) => ({ type: def.type, group: def.group, doc: def.doc, params: Object.fromEntries(Object.entries(def.params).map(([key, desc]) => [key, paramDoc(desc)])) })),
    },
    typography: {
      ui: [...UI_FONTS], display: [...DISPLAY_FONTS], mono: [...MONO_FONTS], chat: [...CHAT_FONTS],
      note: "Only system and bundled fonts (Pixelify Sans for display: pixel, VT323 for mono: terminal). display styles headings and pane titles. mono: terminal applies to code blocks only. chat is a suggestion that applies only while the user's chat font is the default.",
    },
    shapes: [...SHAPES],
    elevations: [...ELEVATIONS],
    customCss: {
      summary: "Cosmetic CSS scoped to the app window. Selectors are scoped automatically; colours for text and surfaces must use var(--token) (literal colours only as faint tints with alpha ≤ 0.14). ::before/::after may hold absolutely positioned decorations (content: \"\") with transform/opacity animations. Anything not allowed is removed (the rest of the theme still saves) and reported in warnings; fix what they name.",
      allowed: [
        "color, background-color (token colours), background-image gradients, borders (≤ 3px), border-radius (≤ 20px), outline-color/offset, box-shadow (≤ 4 layers, blur ≤ 48px), text-shadow (≤ 2, blur ≤ 6px), caret-color, accent-color, font-weight 400–700, font-style, letter-spacing −0.02em…0.06em, text-decoration colour/style, transitions ≤ 400ms",
        "On ::before/::after only: content \"\", position: absolute, inset/offsets, width/height (%), transform, opacity, mix-blend-mode, z-index −1…1, filter blur ≤ 24px / hue-rotate / saturate, gradient masks",
        "@keyframes (≤ 12) animating transform, opacity, background-position (colours and box-shadow only on pseudo-elements); durations ≥ 1.2s (≥ 2s when infinite); no flashing (large changes faster than 333ms are rejected)",
        "@media for prefers-reduced-motion, prefers-color-scheme, min-width, max-width; @supports",
        "Custom properties named --ct-*; var() of theme tokens",
      ],
      denied: [
        "url() and any image/file loading, @import, @font-face, other at-rules",
        "display, visibility, position on real elements, width/height/margin/padding, overflow, clip-path, z-index on real elements, transform/filter/opacity on real elements, font-family, font-size, line-height, cursor, user-select, pointer-events (except none on decorations), background-clip: text, will-change",
        "Universal *, ID selectors, :has(), :root/html/body, ::backdrop, !important (removed), redefining app tokens (set them in tokens instead)",
      ],
      protectedClasses: [...PROTECTED_CLASSES, ...PROTECTED_PREFIXES.map((prefix) => `${prefix}*`)],
      limits: { bytes: THEME_LIMITS.maxCustomCssBytes, rules: CSS_LIMITS.rules, declarationsPerRule: CSS_LIMITS.declsPerRule, selectorChars: CSS_LIMITS.selectorChars, keyframes: CSS_LIMITS.keyframes, infiniteAnimations: CSS_LIMITS.infiniteAnimations },
      example: ".thread-card::after { content: \"\"; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, var(--accent-soft), transparent 60%); opacity: 0; transition: opacity 200ms ease; }\n.thread-card:hover::after { opacity: 1; }",
    },
    patchSemantics: [
      "tokens merge key by key; null resets a token to derived/inherited.",
      "effects merge by type; null removes an effect; params merge, null resets a param.",
      "typography, surfaces and motion merge key by key; customCss replaces the whole stylesheet (\"\" removes it); other fields replace.",
    ],
    examples: [
      {
        name: "Calm aurora (dark)",
        spec: {
          name: "Nebula", base: "mythra", description: "Indigo night, violet accent, a slow aurora behind the sidebar",
          tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff" },
          surfaces: { translucency: 0.12 },
          effects: { aurora: { colors: ["#6d5dfc", "#b794ff", "#36d0c7"], intensity: 0.4, speed: "slow", position: "top" }, glow: { targets: ["focus", "send"], strength: 0.35 } },
        },
      },
      {
        name: "Paper (light)",
        spec: { name: "Paper", base: "atari", tokens: { bg: "#f7f3ea", text: "#2a241c", accent: "#9a4a1f" }, typography: { display: "serif" }, effects: { grain: { amount: 0.45 } } },
      },
    ],
  };
}
