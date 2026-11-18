// compileThemeCss (DESIGN §3, §5, §10): one stylesheet per applied theme.
//
//   1. A token block on the (0,5,0) selector
//        :root .app-shell[data-theme][data-color-scheme][data-custom-theme="ct_x"]
//      which outranks the Windows ink rule (0,4,1) and every Lumen theme block.
//   2. See-through surfaces for backdrop effects (only the window background,
//      the sidebar and the toolbar; panels, menus, fields and code stay solid).
//   3. Accent effects on app elements (glow, shimmer, border, accentFlow).
//      Static parts are always on; every animation sits behind
//      @media (prefers-reduced-motion: no-preference) and [data-theme-motion="on"].
//   4. Typography and, on Windows dark themes, the eased inks.
//   5. The theme's sanitized customCss (separate string so it can be disabled).
//
// Nothing here animates custom properties on the shell; the only animated
// custom property (--ct-fx-angle) is registered, non-inherited and set on one
// pseudo-element.

import type { ResolvedTokens } from "./baseTokens";
import { contrastRatio, formatColor, mixColors, parseColor, shiftLightness, withAlpha, type Rgba } from "./color";
import { EFFECTS, effectSeconds, resolveEffectParams, type EffectPalette } from "./effects";
import { customCssScope, sanitizeCustomCss } from "./sanitizeCss";
import { EFFECT_TYPES, FONT_STACKS, KIT_TOKENS, seeThroughAlpha, type CustomThemeId, type EffectType, type ThemeSpec } from "./spec";
import { resolveTheme, type ResolvedTheme } from "./validate";

export interface CompileOptions {
  id: CustomThemeId;
  scope: "app" | "preview";
  platform: "mac" | "windows" | "other";
  customCssEnabled?: boolean;
  /** Testing / host override for base values. */
  baseTokens?: ResolvedTokens;
}

export interface CompiledTheme {
  /** Everything (tokens + effects + customCss when enabled). */
  css: string;
  /** Effect types present (for data-ct-fx). */
  effectTypes: string[];
  /** True when something in this theme animates (effects or customCss). */
  hasMotion: boolean;
  /** Token block, surfaces, accent effects and typography only. */
  tokenCss: string;
  /** Scoped customCss only ("" when absent or disabled). */
  customCss: string;
  scheme: "light" | "dark";
}

/** Hooks into app markup used by accent effects. Keep in one place: a class rename silently disables an effect (never breaks the app). */
export const EFFECT_HOOKS = {
  composer: ".composer",
  send: ".send-button:not(:disabled)",
  primary: ".primary-button:not(:disabled)",
  selectionRow: ".thread-row-wrap.active > .thread-card",
  activeTab: ".studio-tabs button.active",
  landingTitle: ".thread-empty-state h1",
  switchOn: ".toggle-switch.on",
  input: "input:focus-visible",
  textarea: "textarea:focus-visible",
  codeBlock: ".rich-markdown pre",
  seeThrough: [".main-panel", ".sidebar"],
  seeThroughClear: [".topbar"],
} as const;

const RADII: Record<ThemeSpec["shape"], Record<string, string>> = {
  crisp: { "--r-xs": "2px", "--r-sm": "3px", "--r-md": "5px", "--r-lg": "6px", "--r-xl": "8px", "--r-control": "3px", "--r-chip": "2px" },
  standard: { "--r-xs": "4px", "--r-sm": "6px", "--r-md": "8px", "--r-lg": "10px", "--r-xl": "12px", "--r-control": "6px", "--r-chip": "4px" },
  soft: { "--r-xs": "5px", "--r-sm": "8px", "--r-md": "10px", "--r-lg": "13px", "--r-xl": "16px", "--r-control": "8px", "--r-chip": "5px" },
};

type ShadowLayer = [geometry: string, alpha: number];
const SHADOWS: Record<"dark" | "light", Record<string, ShadowLayer[]>> = {
  dark: {
    "--lm-pop-shadow": [["0 0 0 1px", 0.5], ["0 14px 34px -8px", 0.5], ["0 4px 10px -4px", 0.35]],
    "--elev-1": [["0 1px 2px", 0.3]],
    "--elev-2": [["0 6px 18px -8px", 0.5]],
    "--elev-3": [["0 16px 40px -14px", 0.6]],
    "--lm-composer-shadow": [["0 8px 24px -14px", 0.55], ["0 1px 3px", 0.18]],
    "--lm-drawer-shadow": [["-16px 0 40px -12px", 0.35]],
  },
  light: {
    "--lm-pop-shadow": [["0 0 0 1px", 0.08], ["0 14px 34px -10px", 0.22], ["0 3px 8px -3px", 0.1]],
    "--elev-1": [["0 1px 2px", 0.06]],
    "--elev-2": [["0 6px 16px -8px", 0.16]],
    "--elev-3": [["0 16px 36px -14px", 0.22]],
    "--lm-composer-shadow": [["0 8px 22px -14px", 0.2], ["0 1px 2px", 0.06]],
    "--lm-drawer-shadow": [["-16px 0 40px -12px", 0.14]],
  },
};
const ELEVATION_FACTOR: Record<ThemeSpec["elevation"], number> = { flat: 0.3, soft: 1, deep: 1.55 };

function shadowVars(scheme: "light" | "dark", elevation: ThemeSpec["elevation"], tint: Rgba): Record<string, string> {
  const out: Record<string, string> = {};
  const factor = ELEVATION_FACTOR[elevation];
  for (const [name, layers] of Object.entries(SHADOWS[scheme])) {
    out[name] = layers.map(([geometry, alpha], index) => {
      // The 1px popover edge stays crisp even on flat themes.
      const a = name === "--lm-pop-shadow" && index === 0 ? alpha : Math.min(0.85, alpha * factor);
      return `${geometry} ${formatColor(withAlpha(tint, a))}`;
    }).join(", ");
  }
  return out;
}

function block(selector: string, vars: Record<string, string>): string {
  const body = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

function fmt(color: Rgba | undefined): string | null {
  return color ? formatColor(color) : null;
}

/** The final CSS variables for a resolved theme (kit tokens + tints + derived). */
export function themeVariables(spec: ThemeSpec, resolved: ResolvedTheme): Record<string, string> {
  const p = resolved.palette;
  const vars: Record<string, string> = {};
  for (const token of KIT_TOKENS) {
    if (token.key === "shadowTint") continue;
    const value = fmt(p[token.key]);
    if (value) vars[token.cssVar] = value;
  }
  // Status tints and their compatibility partners.
  Object.assign(vars, {
    "--red-soft": formatColor(p.dangerSoft), "--red-line": formatColor(p.dangerLine),
    "--orange-soft": formatColor(p.warningSoft), "--orange-line": formatColor(p.warningLine),
    "--info-soft": formatColor(p.infoSoft), "--info-line": formatColor(p.infoLine),
    "--success-soft": formatColor(p.successSoft),
    "--lm-island-edge": formatColor(p.line),
    "--lm-scrim": formatColor(withAlpha(p.scrim, Math.max(0.1, p.scrim.a * 0.85))),
    "--lm-code-bg": formatColor(p.codeBg),
  });
  Object.assign(vars, RADII[spec.shape]);
  Object.assign(vars, shadowVars(resolved.scheme, spec.elevation, p.shadowTint ?? { r: 0, g: 0, b: 0, a: 1 }));
  const ui = spec.typography.ui ?? "system";
  if (FONT_STACKS.ui[ui]) vars["--font-sans"] = FONT_STACKS.ui[ui] as string;
  const display = spec.typography.display ?? (ui === "serif-headings" ? "serif" : "system");
  if (FONT_STACKS.display[display]) vars["--font-display"] = FONT_STACKS.display[display] as string;
  else if (ui === "serif-headings") vars["--font-display"] = FONT_STACKS.display.serif;
  return vars;
}

function effectPalette(resolved: ResolvedTheme): EffectPalette {
  const p = resolved.palette;
  return { scheme: resolved.scheme, bg: p.bg, text: p.text, accent: p.accent, fill: p.fill, onAccent: p.onAccent, info: p.info, success: p.success, danger: p.danger, warning: p.warning };
}

const parseList = (value: unknown): Rgba[] => (Array.isArray(value) ? value.map((c) => parseColor(c)).filter((c): c is Rgba => Boolean(c)) : []);

/** Whether an effect (with its resolved params) moves at all. */
export function effectMoves(type: EffectType, params: Record<string, unknown>): boolean {
  switch (type) {
    case "aurora": case "mesh": case "grid": case "border": case "accentFlow": return params.speed !== "still";
    case "particles": return params.speed !== "still";
    case "starfield": return params.twinkle !== false || params.drift === "slow" || params.shootingStars === true;
    case "grain": return params.animated === true;
    case "scanlines": return params.roll === true;
    case "glow": return params.pulse === true;
    case "shimmer": return true;
    default: return false;
  }
}

function accentEffectCss(spec: ThemeSpec, resolved: ResolvedTheme, id: CustomThemeId): { css: string; vars: Record<string, string> } {
  const scope = customCssScope(id);
  const motion = customCssScope(id, true);
  const dark = resolved.scheme === "dark";
  const palette = effectPalette(resolved);
  const rules: string[] = [];
  const moving: string[] = [];
  const vars: Record<string, string> = {};
  const H = EFFECT_HOOKS;
  const animate = (selector: string, value: string) => moving.push(`${selector} { animation: ${value}; }`);

  const glow = spec.effects.glow ? resolveEffectParams("glow", spec.effects.glow as Record<string, unknown>, palette) : null;
  if (glow) {
    const strength = glow.strength as number;
    const color = parseColor(glow.color as string) ?? resolved.palette.accent;
    const blur = Math.round(4 + 10 * strength);
    vars["--ct-fx-glow"] = formatColor(withAlpha(color, Math.min(0.45, 0.12 + 0.33 * strength)));
    vars["--ct-fx-glow-blur"] = `${blur}px`;
    const targets = glow.targets as string[];
    if (targets.includes("focus")) {
      rules.push(`${scope} ${H.composer}:focus-within { box-shadow: var(--lm-composer-shadow), 0 0 0 1px var(--accent-line), 0 0 ${blur + 6}px -2px var(--ct-fx-glow); }`);
      rules.push(`${scope} ${H.input} { box-shadow: 0 0 0 1px var(--accent-line), 0 0 ${blur}px 0 var(--ct-fx-glow); }`);
    }
    const halo = (selector: string, spread: number) => {
      rules.push(`${scope} ${selector} { position: relative; }`);
      rules.push(`${scope} ${selector}::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: 0 0 ${blur}px ${spread}px var(--ct-fx-glow); pointer-events: none; }`);
      if (glow.pulse) animate(`${motion} ${selector}::after`, "ct-fx-breathe 2.8s ease-in-out infinite");
    };
    if (targets.includes("primary")) halo(H.primary, 0);
    if (targets.includes("send")) halo(H.send, 1);
    if (targets.includes("selectionBar")) {
      rules.push(`${scope} ${H.selectionRow}::after { content: ""; position: absolute; left: 0; top: 24%; bottom: 24%; width: 3px; border-radius: 2px; background: var(--accent); box-shadow: 0 0 ${blur}px 1px var(--ct-fx-glow); pointer-events: none; }`);
      if (glow.pulse) animate(`${motion} ${H.selectionRow}::after`, "ct-fx-breathe 2.8s ease-in-out infinite");
    }
  }

  const shimmer = spec.effects.shimmer ? resolveEffectParams("shimmer", spec.effects.shimmer as Record<string, unknown>, palette) : null;
  if (shimmer) {
    const interval = shimmer.interval as number;
    const sweep = Math.max(1, Math.min(40, (1.2 / interval) * 100));
    const sheenBase = parseColor(shimmer.color as string) ?? (dark ? { r: 1, g: 1, b: 1, a: 1 } : resolved.palette.accent);
    const sheen = formatColor(withAlpha(sheenBase, dark ? 0.3 : 0.22));
    const frames = `ct-fx-shimmer-${id}`;
    // A 300%-wide gradient moved from 100% to 0%: at both ends it still covers the whole box, so the
    // target is always fully painted (vital for the clipped title text) and the band only shows mid-sweep.
    rules.push(`@keyframes ${frames} { 0% { background-position: 100% 0; } ${sweep.toFixed(2)}% { background-position: 0% 0; } 100% { background-position: 0% 0; } }`);
    const sheet = (selector: string, pseudo: "before" | "after") => {
      rules.push(`${scope} ${selector} { position: relative; }`);
      rules.push(`${scope} ${selector}::${pseudo} { content: ""; display: block; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: linear-gradient(100deg, transparent 40%, ${sheen} 50%, transparent 60%) no-repeat; background-size: 300% 100%; background-position: 100% 0; }`);
      animate(`${motion} ${selector}::${pseudo}`, `${frames} ${interval}s ease-in-out infinite`);
    };
    const targets = shimmer.targets as string[];
    if (targets.includes("primary")) sheet(H.primary, "before");
    if (targets.includes("selectionBar")) sheet(H.selectionRow, "before");
    if (targets.includes("activeTab")) sheet(H.activeTab, "after");
    if (targets.includes("landingTitle")) {
      const band = formatColor(dark ? mixColors(resolved.palette.accent, { r: 1, g: 1, b: 1, a: 1 }, 0.35) : resolved.palette.accent);
      rules.push(`@supports ((-webkit-background-clip: text) or (background-clip: text)) {\n${scope} ${H.landingTitle} { background-image: linear-gradient(100deg, var(--text) 40%, ${band} 50%, var(--text) 60%); background-size: 300% 100%; background-position: 100% 0; background-repeat: no-repeat; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }\n}`);
      animate(`${motion} ${H.landingTitle}`, `${frames} ${interval}s ease-in-out infinite`);
    }
  }

  const border = spec.effects.border ? resolveEffectParams("border", spec.effects.border as Record<string, unknown>, palette) : null;
  if (border) {
    const colors = parseList(border.colors).map(formatColor);
    const width = border.width as number;
    const seconds = effectSeconds("border", border.speed);
    const stops = [...colors, colors[0]].join(", ");
    const targets = border.targets as string[];
    if (targets.includes("composer")) {
      rules.push(`${scope} ${H.composer} { position: relative; }`);
      rules.push(`@supports ((mask-composite: exclude) or (-webkit-mask-composite: xor)) {\n${scope} ${H.composer}::before { content: ""; position: absolute; inset: -1px; z-index: 0; padding: ${width}px; border-radius: inherit; background: conic-gradient(from var(--ct-fx-angle, 0deg), ${stops}); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); pointer-events: none; opacity: .9; }\n${scope} ${H.composer}:focus-within::before { opacity: 1; }\n}`);
      if (seconds) animate(`${motion} ${H.composer}::before`, `ct-fx-turn ${seconds}s steps(${Math.round(seconds * 30)}) infinite`);
    }
    if (targets.includes("focusedField")) {
      const frames = `ct-fx-ring-${id}`;
      const ring = colors.map((c, i) => `${Math.round((i / colors.length) * 100)}% { outline-color: ${c}; }`).join(" ");
      rules.push(`@keyframes ${frames} { ${ring} 100% { outline-color: ${colors[0]}; } }`);
      for (const hook of [H.input, H.textarea]) rules.push(`${scope} ${hook} { outline: ${width}px solid ${colors[0]}; outline-offset: 1px; }`);
      rules.push(`${scope} ${H.composer} ${H.textarea} { outline: none; }`);
      if (seconds) for (const hook of [H.input, H.textarea]) animate(`${motion} ${hook}`, `${frames} ${seconds}s linear infinite`);
    }
  }

  const flow = spec.effects.accentFlow ? resolveEffectParams("accentFlow", spec.effects.accentFlow as Record<string, unknown>, palette) : null;
  if (flow) {
    const colors = parseList(flow.colors).map(formatColor);
    const gradient = `linear-gradient(110deg, ${[...colors, colors[0]].join(", ")})`;
    vars["--ct-fx-flow"] = gradient;
    const seconds = effectSeconds("accentFlow", flow.speed);
    for (const hook of [H.send, H.primary, H.switchOn]) {
      rules.push(`${scope} ${hook} { background-image: var(--ct-fx-flow); background-size: 300% 100%; background-position: 0% 50%; }`);
      if (seconds) animate(`${motion} ${hook}`, `ct-fx-flow ${seconds}s ease-in-out infinite alternate`);
    }
  }

  if (moving.length) rules.push(`@media (prefers-reduced-motion: no-preference) {\n${moving.join("\n")}\n}`);
  return { css: rules.join("\n"), vars };
}

function windowsEasing(resolved: ResolvedTheme): Record<string, string> {
  if (resolved.scheme !== "dark") return {};
  const p = resolved.palette;
  const surfaces = ["bg", "sidebar", "panel", "panel2", "menu", "field"].flatMap((name) => resolved.surfaces[name] ?? []);
  const out: Record<string, string> = {};
  const ease = (key: string, cssVar: string, delta: number) => {
    const eased = shiftLightness(p[key], delta);
    if (surfaces.every((surface) => contrastRatio(eased, surface) >= 4.5)) out[cssVar] = formatColor(eased);
  };
  ease("text", "--text", -0.04);
  ease("ink2", "--ink-2", -0.04);
  ease("readingInk", "--lm-reading-ink", -0.04);
  ease("muted", "--muted", -0.02);
  ease("muted2", "--muted-2", -0.02);
  return out;
}

function typographyCss(spec: ThemeSpec, scope: string): string {
  const out: string[] = [];
  if (spec.typography.mono === "terminal") {
    out.push(`${scope} ${EFFECT_HOOKS.codeBlock}, ${scope} ${EFFECT_HOOKS.codeBlock} code { font-family: ${FONT_STACKS.mono.terminal}; font-size: 1.16em; line-height: 1.25; }`);
  }
  if (spec.typography.chat && spec.typography.chat !== "system") {
    // A suggestion: it only applies while the user's own chat font is the default.
    out.push(`${scope}[data-chat-font="system"] { --chat-font: var(--chat-font-${spec.typography.chat}); }`);
  }
  if (spec.typography.display === "pixel" || spec.typography.display === "mono") {
    out.push(`${scope} .thread-empty-state h1 { font-family: var(--font-display); letter-spacing: 0; }`);
  } else if ((spec.typography.display && spec.typography.display !== "system") || spec.typography.ui === "serif-headings") {
    out.push(`${scope} .thread-empty-state h1 { font-family: var(--font-display); }`);
  }
  return out.join("\n");
}

function seeThroughCss(spec: ThemeSpec, resolved: ResolvedTheme, scope: string): string {
  const t = seeThroughAlpha(spec.surfaces.translucency);
  if (!t || t <= 0) return "";
  const p = resolved.palette;
  const rules = [
    `${scope} ${EFFECT_HOOKS.seeThrough[0]} { background-color: ${formatColor(withAlpha(p.bg, 1 - t))}; background-image: none; }`,
    `${scope} ${EFFECT_HOOKS.seeThrough[1]} { background-color: ${formatColor(withAlpha(p.sidebar, 1 - t))}; }`,
    `${scope} ${EFFECT_HOOKS.seeThroughClear[0]} { background: transparent; }`,
  ];
  // Reduced transparency: everything opaque again (backdrop effects become invisible, by design).
  rules.push(`@media (prefers-reduced-transparency: reduce) {\n${scope} ${EFFECT_HOOKS.seeThrough[0]} { background-color: var(--bg); }\n${scope} ${EFFECT_HOOKS.seeThrough[1]} { background-color: var(--sidebar); }\n}`);
  return rules.join("\n");
}

/** Compile a normalized spec into CSS for the app shell (or a preview tile). */
export function compileThemeCss(spec: ThemeSpec, opts: CompileOptions): CompiledTheme {
  const resolved = resolveTheme(spec, opts.baseTokens);
  const vars = themeVariables(spec, resolved);
  const effectTypes = EFFECT_TYPES.filter((type) => spec.effects[type]);
  const palette = effectPalette(resolved);
  const effectsMove = spec.motion.enabled && effectTypes.some((type) => effectMoves(type, resolveEffectParams(type, spec.effects[type] as Record<string, unknown>, palette)));

  if (opts.scope === "preview") {
    const selector = `[data-ct-preview="${opts.id}"]`;
    const tokenCss = block(selector, { ...vars, "--ct-fx-scale": ".12" });
    return { css: tokenCss, tokenCss, customCss: "", effectTypes, hasMotion: effectsMove, scheme: resolved.scheme };
  }

  const scope = customCssScope(opts.id);
  const accent = accentEffectCss(spec, resolved, opts.id);
  const tokenVars = { ...vars, ...accent.vars, ...(opts.platform === "windows" ? windowsEasing(resolved) : {}) };
  // The shell becomes a stacking context so the effects layer (z-index -1) paints above its background and below every pane.
  const shell = `${scope} { position: relative; isolation: isolate; }`;
  const tokenCss = [block(scope, tokenVars), shell, seeThroughCss(spec, resolved, scope), accent.css, typographyCss(spec, scope)].filter(Boolean).join("\n");

  let customCss = "";
  let customMoves = false;
  if (opts.customCssEnabled !== false && spec.customCss) {
    const sanitized = sanitizeCustomCss(spec.customCss, { id: opts.id });
    customCss = sanitized.css;
    customMoves = /animation-name:/.test(customCss) && spec.motion.enabled;
  }
  return {
    css: customCss ? `${tokenCss}\n/* customCss */\n${customCss}` : tokenCss,
    tokenCss,
    customCss,
    effectTypes,
    hasMotion: effectsMove || customMoves,
    scheme: resolved.scheme,
  };
}

export { EFFECTS };
