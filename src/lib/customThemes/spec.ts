// Custom theme spec (mythra.theme/1): the versioned JSON a model or the user
// writes, plus the design-kit token table that maps friendly keys to the CSS
// variables in src/styles/lumen/tokens.css. Pure data and types; no DOM.
//
// See /tmp/themes/DESIGN.md §3 (spec), §1.1 (token coverage) and §5 (effects).

import type { Provider, ThemeName } from "../../types";

export const THEME_SCHEMA = "mythra.theme/1" as const;

export type CustomThemeId = `ct_${string}`;
/** What settings.theme stores: a built-in id or `custom:ct_…`. */
export type ThemeId = ThemeName | `custom:${CustomThemeId}`;
/** #rgb #rrggbb #rrggbbaa rgb() rgba() hsl() hsla() oklch(); normalised to #rrggbb or rgba(). */
export type ColorString = string;
export type Speed = "still" | "slow" | "medium" | "lively";

export const CUSTOM_THEME_ID_PATTERN = /^ct_[a-z0-9]{10}$/;
export const BUILT_IN_THEMES: readonly ThemeName[] = ["mythra", "light-mythra", "kiwi", "daylight", "synthwave", "atari"];
export const LIGHT_BUILT_INS: readonly ThemeName[] = ["light-mythra", "daylight", "atari"];

export function isCustomThemeId(value: unknown): value is CustomThemeId {
  return typeof value === "string" && CUSTOM_THEME_ID_PATTERN.test(value);
}
export function isBuiltInTheme(value: unknown): value is ThemeName {
  return typeof value === "string" && (BUILT_IN_THEMES as readonly string[]).includes(value);
}
export function builtInScheme(base: ThemeName): "light" | "dark" {
  return LIGHT_BUILT_INS.includes(base) ? "light" : "dark";
}
/** A fresh id (`ct_` + 10 lowercase base-36 characters). */
export function newCustomThemeId(random: () => number = Math.random): CustomThemeId {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return `ct_${out}`;
}

export const SYNTAX_KEYS = ["keyword", "string", "comment", "number", "function", "type", "tag", "attr", "property", "punct", "operator", "heading"] as const;
export const DIFF_KEYS = ["addInk", "addBg", "addMark", "delInk", "delBg", "delMark", "gutterInk", "hunkBg"] as const;
export const MARK_KEYS = ["cyanA", "cyanB", "blueA", "blueB", "foldA", "foldB", "caret"] as const;
export type SyntaxKey = (typeof SYNTAX_KEYS)[number];
export type DiffKey = (typeof DIFF_KEYS)[number];
export type MarkKey = (typeof MARK_KEYS)[number];

export interface ThemeTokens {
  canvas?: ColorString; bg?: ColorString; sidebar?: ColorString; panel?: ColorString; panel2?: ColorString;
  panel3?: ColorString; field?: ColorString; menu?: ColorString; topbar?: ColorString; bubble?: ColorString;
  codeBg?: ColorString; codeInk?: ColorString;
  line?: ColorString; lineStrong?: ColorString; lineQuiet?: ColorString;
  text?: ColorString; ink2?: ColorString; readingInk?: ColorString; muted?: ColorString; muted2?: ColorString;
  accent?: ColorString; accent2?: ColorString; onAccent?: ColorString; fill?: ColorString;
  accentSoft?: ColorString; accentLine?: ColorString;
  success?: ColorString; warning?: ColorString; danger?: ColorString; info?: ColorString; onDanger?: ColorString;
  hover?: ColorString; press?: ColorString; selectedHover?: ColorString; menuFocus?: ColorString;
  scrim?: ColorString; shadowTint?: ColorString; chart1?: ColorString; chart2?: ColorString;
  syntax?: Partial<Record<SyntaxKey, ColorString>>;
  diff?: Partial<Record<DiffKey, ColorString>>;
  mark?: Partial<Record<MarkKey, ColorString>>;
}
export type FlatTokenKey = Exclude<keyof ThemeTokens, "syntax" | "diff" | "mark">;

export type UiFont = "system" | "rounded" | "humanist" | "serif-headings";
export type DisplayFont = "system" | "rounded" | "serif" | "pixel" | "mono";
export type MonoFont = "system" | "terminal";
export type ChatFontSuggestion = "system" | "humanist" | "serif" | "mono" | "pixelify" | "vt323";
export interface ThemeTypography { ui?: UiFont; display?: DisplayFont; mono?: MonoFont; chat?: ChatFontSuggestion | null }

export const UI_FONTS: readonly UiFont[] = ["system", "rounded", "humanist", "serif-headings"];
export const DISPLAY_FONTS: readonly DisplayFont[] = ["system", "rounded", "serif", "pixel", "mono"];
export const MONO_FONTS: readonly MonoFont[] = ["system", "terminal"];
export const CHAT_FONTS: readonly ChatFontSuggestion[] = ["system", "humanist", "serif", "mono", "pixelify", "vt323"];

/** Font stacks. Only system and bundled fonts: the CSP has no font-src. */
export const FONT_STACKS = {
  ui: {
    system: null,
    rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", sans-serif',
    humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", "Segoe UI", sans-serif',
    "serif-headings": null,
  },
  display: {
    system: null,
    rounded: 'ui-rounded, "SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", sans-serif',
    serif: '"New York", ui-serif, Charter, "Iowan Old Style", "Sitka Heading", Cambria, Georgia, serif',
    pixel: '"Pixelify Sans", "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    mono: 'ui-monospace, "SF Mono", "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace',
  },
  mono: {
    system: null,
    terminal: '"VT323", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
} as const;

// ---- Effects (§5) ---------------------------------------------------------

export type AuroraPosition = "top" | "bottom" | "full";
export interface AuroraParams { colors?: ColorString[]; intensity?: number; speed?: Speed; position?: AuroraPosition }
export interface MeshParams { colors?: ColorString[]; intensity?: number; speed?: Speed }
export interface StarfieldParams { color?: ColorString; accentColor?: ColorString; density?: "sparse" | "normal" | "dense"; twinkle?: boolean; drift?: "none" | "slow"; shootingStars?: boolean }
export interface ParticlesParams { colors?: ColorString[]; count?: number; size?: [number, number]; speed?: Speed; direction?: "rise" | "fall" | "drift"; links?: boolean; glow?: boolean }
export interface GridParams { color?: ColorString; speed?: Speed; horizon?: number; glow?: boolean }
export interface GrainParams { amount?: number; animated?: boolean }
export interface ScanlinesParams { opacity?: number; spacing?: 2 | 3 | 4; roll?: boolean }
export interface VignetteParams { strength?: number; color?: ColorString }
export type GlowTarget = "focus" | "primary" | "send" | "selectionBar";
export interface GlowParams { targets?: GlowTarget[]; strength?: number; pulse?: boolean; color?: ColorString }
export type ShimmerTarget = "activeTab" | "selectionBar" | "primary" | "landingTitle";
export interface ShimmerParams { targets?: ShimmerTarget[]; interval?: number; color?: ColorString }
export type BorderTarget = "composer" | "focusedField";
export interface BorderParams { targets?: BorderTarget[]; colors?: ColorString[]; speed?: Speed; width?: 1 | 1.5 | 2 }
export interface AccentFlowParams { colors?: ColorString[]; speed?: Speed }

export interface ThemeEffects {
  aurora?: AuroraParams;
  mesh?: MeshParams;
  starfield?: StarfieldParams;
  particles?: ParticlesParams;
  grid?: GridParams;
  grain?: GrainParams;
  scanlines?: ScanlinesParams;
  vignette?: VignetteParams;
  glow?: GlowParams;
  shimmer?: ShimmerParams;
  border?: BorderParams;
  accentFlow?: AccentFlowParams;
}
export type EffectType = keyof ThemeEffects;
export const EFFECT_TYPES: readonly EffectType[] = ["aurora", "mesh", "starfield", "particles", "grid", "grain", "scanlines", "vignette", "glow", "shimmer", "border", "accentFlow"];

// ---- Spec -----------------------------------------------------------------

export type ThemeShape = "crisp" | "standard" | "soft";
export type ThemeElevation = "flat" | "soft" | "deep";

export interface ThemeSpec {
  schema: typeof THEME_SCHEMA;
  name: string;
  description: string;
  base: ThemeName;
  tokens: ThemeTokens;
  shape: ThemeShape;
  elevation: ThemeElevation;
  typography: ThemeTypography;
  surfaces: { translucency: number };
  effects: ThemeEffects;
  motion: { enabled: boolean };
  customCss: string;
}

export type ThemeAuthor = { kind: "model"; provider: Provider; model?: string; threadId?: string } | { kind: "user" };

export const SPEC_KEYS = ["schema", "name", "description", "base", "tokens", "shape", "elevation", "typography", "surfaces", "effects", "motion", "customCss"] as const;
export const SHAPES: readonly ThemeShape[] = ["crisp", "standard", "soft"];
export const ELEVATIONS: readonly ThemeElevation[] = ["flat", "soft", "deep"];

export const THEME_LIMITS = {
  maxThemes: 24,
  maxRevisions: 30,
  maxSpecBytes: 49152,
  maxCustomCssBytes: 12288,
  maxLibraryBytes: 1_572_864,
} as const;
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 160;
export const TRANSLUCENCY_MAX = 0.2;
/**
 * How see-through the window background and sidebar really are for a given
 * surfaces.translucency (0–0.2): 0.2 means half see-through. The contrast
 * check always uses this effective value.
 */
export function seeThroughAlpha(translucency: number): number {
  return Math.min(0.5, Math.max(0, translucency) * 2.5);
}

export interface ContrastAdjustment { token: string; from: string; to: string; reason: string }
export interface ValidationIssue { path: string; message: string }
export type NormalizeResult =
  | { ok: true; spec: ThemeSpec; adjustments: ContrastAdjustment[]; warnings: string[] }
  | { ok: false; errors: ValidationIssue[] };

// ---- Design-kit token table -------------------------------------------------

export type TokenRole = "surface" | "ink" | "accent" | "status" | "line" | "interaction" | "overlay" | "code" | "chart" | "mark" | "diff";

export interface KitToken {
  /** Kit key: a flat key ("muted") or a grouped key ("syntax.keyword"). */
  key: string;
  /** CSS custom property set on the shell. */
  cssVar: string;
  role: TokenRole;
  /** Plain-words purpose, shown in the design kit. */
  doc: string;
  /** Translucent values are allowed (tints, lines, interaction fills, scrim). */
  alphaAllowed: boolean;
}

const t = (key: string, cssVar: string, role: TokenRole, alphaAllowed: boolean, doc: string): KitToken => ({ key, cssVar, role, alphaAllowed, doc });

export const KIT_TOKENS: readonly KitToken[] = [
  t("canvas", "--lm-canvas", "surface", false, "Window canvas behind everything (defaults to bg)."),
  t("bg", "--bg", "surface", false, "Main window background: the chat stage and top bar. Required."),
  t("sidebar", "--sidebar", "surface", false, "Left navigator and the Tools panel."),
  t("panel", "--panel", "surface", false, "Cards, composer and settings groups: one step above bg."),
  t("panel2", "--panel-2", "surface", false, "Second step: hovered cards, chips, the user's message bubble."),
  t("panel3", "--panel-3", "surface", false, "Third step: segmented-control thumbs, strong chips."),
  t("field", "--field", "surface", false, "Text fields and inputs."),
  t("menu", "--menu-surface", "surface", false, "Menus and popovers; should read as raised above bg."),
  t("topbar", "--topbar", "surface", true, "Toolbar fill (usually bg at 90% alpha)."),
  t("bubble", "--bubble", "surface", false, "The user's chat bubble (defaults to panel2)."),
  t("codeBg", "--lm-code-bg", "code", false, "Code block background."),
  t("codeInk", "--lm-code-ink", "code", false, "Plain code text."),
  t("line", "--line", "line", true, "Hairline dividers and card edges (usually text at ~8% alpha)."),
  t("lineStrong", "--line-strong", "line", true, "Firmer edges: fields, menus, selected outlines."),
  t("lineQuiet", "--line-quiet", "line", true, "Faintest separators inside lists."),
  t("text", "--text", "ink", false, "Primary text. Required. Aim for 7:1 or more on bg."),
  t("ink2", "--ink-2", "ink", false, "Secondary strong text (labels, hovered rows)."),
  t("readingInk", "--lm-reading-ink", "ink", false, "Chat prose; slightly softer than text on dark themes."),
  t("muted", "--muted", "ink", false, "Descriptions and meta text; must reach 4.5:1 everywhere."),
  t("muted2", "--muted-2", "ink", false, "Third-level ink: section heads, placeholders, row meta."),
  t("accent", "--accent", "accent", false, "The one accent: links, focus, selection marks. Required."),
  t("accent2", "--accent-2", "accent", false, "Pressed/hover accent (defaults to accent a little darker)."),
  t("onAccent", "--on-accent", "accent", false, "Ink on solid accent fills (buttons). Picked for contrast if omitted."),
  t("fill", "--lm-fill", "accent", false, "Solid accent fill for primary buttons and switches (defaults to accent)."),
  t("accentSoft", "--accent-soft", "accent", true, "Faint accent tint (selection washes)."),
  t("accentLine", "--accent-line", "accent", true, "Accent hairline (focused cards)."),
  t("success", "--success", "status", false, "Good outcomes (Connected, Done)."),
  t("warning", "--orange", "status", false, "Warnings and running indicators."),
  t("danger", "--red", "status", false, "Errors and destructive actions."),
  t("info", "--info", "status", false, "Informational notes."),
  t("onDanger", "--lm-on-danger", "status", false, "Ink on a solid danger fill."),
  t("hover", "--lm-hover", "interaction", true, "Hover fill on rows and buttons."),
  t("press", "--lm-press", "interaction", true, "Pressed / selected row fill."),
  t("selectedHover", "--lm-selected-hover", "interaction", true, "Hover on an already-selected row."),
  t("menuFocus", "--lm-menu-focus", "interaction", true, "Keyboard focus fill in menus."),
  t("scrim", "--scrim", "overlay", true, "Backdrop dim behind dialogs."),
  t("shadowTint", "--ct-shadow-tint", "overlay", false, "Colour of shadows (defaults to black)."),
  t("chart1", "--chart-1", "chart", false, "First data series in charts."),
  t("chart2", "--chart-2", "chart", false, "Second data series in charts."),
  ...SYNTAX_KEYS.map((key) => t(`syntax.${key}`, `--syntax-${key}`, "code", false, `Code colour for ${key} tokens.`)),
  t("diff.addInk", "--diff-add-ink", "diff", false, "Added-line text."),
  t("diff.addBg", "--diff-add-bg", "diff", true, "Added-line wash (translucent)."),
  t("diff.addMark", "--diff-add-mark", "diff", false, "Added-line gutter mark."),
  t("diff.delInk", "--diff-del-ink", "diff", false, "Removed-line text."),
  t("diff.delBg", "--diff-del-bg", "diff", true, "Removed-line wash (translucent)."),
  t("diff.delMark", "--diff-del-mark", "diff", false, "Removed-line gutter mark."),
  t("diff.gutterInk", "--diff-gutter-ink", "diff", false, "Line numbers in diffs."),
  t("diff.hunkBg", "--diff-hunk-bg", "diff", true, "Hunk header wash."),
  t("mark.cyanA", "--mythra-mark-cyan-a", "mark", false, "Logo: light outer piece A."),
  t("mark.cyanB", "--mythra-mark-cyan-b", "mark", false, "Logo: light outer piece B."),
  t("mark.blueA", "--mythra-mark-blue-a", "mark", false, "Logo: centre A."),
  t("mark.blueB", "--mythra-mark-blue-b", "mark", false, "Logo: centre B."),
  t("mark.foldA", "--mythra-mark-fold-a", "mark", false, "Logo: fold A."),
  t("mark.foldB", "--mythra-mark-fold-b", "mark", false, "Logo: fold B."),
  t("mark.caret", "--mythra-mark-caret", "mark", false, "Logo: caret highlight."),
];

export const KIT_TOKEN_BY_KEY: ReadonlyMap<string, KitToken> = new Map(KIT_TOKENS.map((token) => [token.key, token]));
export const FLAT_TOKEN_KEYS: readonly string[] = KIT_TOKENS.filter((token) => !token.key.includes(".")).map((token) => token.key);

/** Extra CSS variables the engine writes beyond the kit table (status tints, radii, shadows). */
export const DERIVED_ONLY_VARS = [
  "--red-soft", "--red-line", "--orange-soft", "--orange-line", "--info-soft", "--info-line", "--success-soft",
  "--lm-pop-shadow", "--elev-1", "--elev-2", "--elev-3", "--lm-composer-shadow", "--lm-drawer-shadow",
  "--r-xs", "--r-sm", "--r-md", "--r-lg", "--r-xl", "--r-control", "--r-chip",
  "--lm-island-edge", "--lm-selected-hover",
] as const;

/** Every CSS custom property a custom theme may set; customCss can only read these (plus --ct-*). */
export function knownTokenVars(): Set<string> {
  const out = new Set<string>(KIT_TOKENS.map((token) => token.cssVar));
  for (const name of DERIVED_ONLY_VARS) out.add(name);
  for (const name of ["--accent-soft", "--accent-line", "--green", "--green-soft", "--green-line", "--amber", "--lm-grad", "--lm-tint", "--lm-tint-strong", "--ring",
    "--font-sans", "--font-mono", "--font-display", "--chat-font", "--lm-reading-ink", "--fs-micro", "--fs-meta", "--fs-ui", "--fs-body", "--fs-lede", "--fs-title", "--fs-display",
    "--lm-d-1", "--lm-d-2", "--lm-d-3", "--lm-d-4", "--lm-ease-out", "--lm-ease-in", "--lm-spring", "--lm-spring-soft", "--r-pill", "--lm-clear", "--lm-fill-2", "--lm-grad-soft",
    "--surface-quiet", "--surface-selected", "--toggle-active-track", "--lm-scrim", "--shadow"]) out.add(name);
  return out;
}

// ---- Small shared helpers ---------------------------------------------------

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length][b.length];
}

/** The closest candidate for a mistyped key, or null when nothing is close. */
export function closestMatch(word: string, candidates: readonly string[]): string | null {
  const lower = word.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    let score = editDistance(lower, c);
    if (c.includes(lower) || lower.includes(c)) score = Math.min(score, Math.abs(c.length - lower.length) * 0.5 + 0.5);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

export function didYouMean(word: string, candidates: readonly string[]): string {
  const match = closestMatch(word, candidates);
  return match ? ` Did you mean \`${match}\`?` : "";
}

/** UTF-8 byte length. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Strip control characters (prompt-injection hygiene for names shown to models). */
export function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}
