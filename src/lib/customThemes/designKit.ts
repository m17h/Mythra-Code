// The design kit returned by get_theme_design_kit: everything a model needs
// to design a good Mythra Code theme, in one JSON object. It is only sent
// when a model asks for it, so it can be thorough.

import type { ThemeName } from "../../types";
import { readBaseTokens } from "./baseTokens";
import { EFFECTS, GROUP_LIMITS, MAX_EFFECTS } from "./effects";
import { CONTROL_MOTION_LIMITS, CSS_LIMITS, DECORATION_LIMITS, MOTION_LIMITS, PROTECTED_CLASSES, PROTECTED_PREFIXES } from "./sanitizeCss";
import { CONTROL_TARGETS, PREVIEW_INTERACTIONS, PREVIEW_SCENE_IDS, PREVIEW_SCENE_LIMITS, PREVIEW_SCENES } from "./previewScenes";
import {
  BUILT_IN_THEMES, CHAT_FONTS, DESCRIPTION_MAX, DISPLAY_FONTS, ELEVATIONS, KIT_TOKENS, MONO_FONTS, NAME_MAX, SHAPES, THEME_LIMITS, THEME_SCHEMA,
  TRANSLUCENCY_MAX, UI_FONTS, builtInScheme,
} from "./spec";

// ---- UI map (get_theme_design_kit → regions) ------------------------------------------
// Every selector here was checked against the real markup (App.tsx, StudioDock.tsx,
// ChatTimeline.tsx, the sidebar and message components) and against how it renders in
// a browser. A test (designKit.test.mjs) fails if a class here disappears from src.

export interface UiRegion {
  name: string;
  selector: string;
  where: string;
  contains: string;
  tokens: string;
  backdrop: string;
  decorate: string;
}
export interface UiRecipe { goal: string; css: string; notes: string }
export interface UiSelector { selector: string; what: string }
export interface UiMap {
  summary: string;
  layout: string;
  regions: UiRegion[];
  recipes: UiRecipe[];
  selectors: UiSelector[];
  stacking: string[];
}

export const UI_MAP: UiMap = {
  summary: "Where things are on screen, the selector to style each region, which tokens paint it, which backdrop effects show through it and whether it can hold a ::before/::after decoration. Selectors not listed here may not exist: a selector that matches nothing fails silently, so prefer these.",
  layout: "Left to right: the left navigator (.sidebar) | the chat side (.main-panel: top bar, message list, composer) | the Tools panel (.studio-dock, only while open). Menus, dialogs and Settings float above everything. There is no .chat-stage, .main or .chat element.",
  regions: [
    {
      name: "Left navigator",
      selector: ".sidebar",
      where: "Left edge, full height (about 260px; the user can resize or hide it).",
      contains: "App name and machine switcher (.sidebar-brand), New thread, the project list (.workspaces-section, rows .workspace-row), the thread list (.threads-section, rows .thread-card) and the Settings button (.sidebar-footer).",
      tokens: "--sidebar fills it (the same token also fills the Tools panel). Text --text, meta --muted/--muted-2, selected row --lm-press, hover --lm-hover.",
      backdrop: "Effects with area window or sidebar show through it when surfaces.translucency > 0.",
      decorate: "Good host: positioned, clipped (overflow hidden) and its own stacking layer. Use z-index: -1 so the decoration sits above the sidebar's background and under every row.",
    },
    {
      name: "Chat side",
      selector: ".main-panel",
      where: "Everything right of the left navigator, except the Tools panel.",
      contains: "The top bar, the message list (or a landing screen) and the composer.",
      tokens: "--bg fills it (see-through with surfaces.translucency).",
      backdrop: "Effects with area window or chat show through it when surfaces.translucency > 0.",
      decorate: "Positioned but NOT clipped and NOT its own stacking layer. z-index: -1 puts a decoration behind the see-through glass, exactly where backdrop effects are (invisible at translucency 0). Don't use z-index 0 or 1 here: it would cover the welcome screen; decorate .conversation instead.",
    },
    {
      name: "Top bar",
      selector: ".topbar",
      where: "A 52px strip across the top of the chat side.",
      contains: "Project and thread name (.project-heading), Run, Search, usage and the Tools button (.topbar-right, recolour only).",
      tokens: "--bg (transparent on see-through themes, so the chat side's backdrop runs under it); bottom edge --line.",
      backdrop: "Same as the chat side.",
      decorate: "Positioned and its own stacking layer: z-index: -1 sits above its fill and under its buttons.",
    },
    {
      name: "Message list (chat stage)",
      selector: ".conversation",
      where: "Between the top bar and the composer.",
      contains: "The scrolling message list (.timeline-shell > .timeline) or, in a new thread, the landing (.thread-empty-state).",
      tokens: "Transparent itself: --bg of the chat side shows. Prose --lm-reading-ink, links --accent, code --lm-code-bg/--lm-code-ink.",
      backdrop: "Same as the chat side.",
      decorate: "Best host for chat-only decorations: positioned and clipped (overflow hidden). z-index: 0 sits on the glass (over the see-through background, also on opaque themes) and under every message.",
    },
    {
      name: "Composer",
      selector: ".composer-zone",
      where: "The strip at the foot of the chat side; .composer is the rounded input card in it, .composer-caption the small print under it.",
      contains: "The text field, provider/model/reasoning controls, Attach and the send button (.send-button).",
      tokens: "Card --panel, edge --line-strong, focused edge --accent-line, shadow --lm-composer-shadow; send uses --lm-fill/--on-accent.",
      backdrop: "The zone is clear on see-through themes; the card itself is solid.",
      decorate: "Protected: recolour only, no ::before/::after. Use the border effect (targets: composer), glow (targets: focus, send) or accentFlow instead. The Send and Attach buttons take the interaction feedback in controls.",
    },
    {
      name: "Tools panel",
      selector: ".studio-dock",
      where: "Right edge, full height, only while open (Tools button or ⌘B). Its tab column (.studio-tabs) is on its far right, the open tool (.studio-panel) to the left of it. Always call it the Tools panel.",
      contains: "Changes, Git, Files, Terminal, Agents, Checkpoints and other tools.",
      tokens: "--sidebar (the same token as the left navigator; changing sidebar repaints both), edges --line, active tab icon --accent.",
      backdrop: "Always opaque: no backdrop effect ever shows through it (area chat never paints it).",
      decorate: "Not a good host (opaque, becomes an overlay on narrow windows). Style the active tab (.studio-tabs button.active) instead.",
    },
    {
      name: "Menus and popovers",
      selector: ".row-menu-list, .model-menu, .permission-menu",
      where: "Float next to the control that opened them.",
      contains: "Menu items ([role=\"menuitem\"]).",
      tokens: "--menu-surface, edge --line-strong, shadow --lm-pop-shadow, keyboard focus --lm-menu-focus.",
      backdrop: "Opaque; above all effects.",
      decorate: "Recolour with tokens only; menus stay solid.",
    },
    {
      name: "Dialogs, command palette and Settings",
      selector: ".modal-backdrop, .command-palette, .settings-modal",
      where: "Centred sheets over a dim layer. Preview with view settings-appearance or command-palette.",
      contains: "Confirmations, the ⌘K palette, Settings (rail .settings-nav).",
      tokens: "Dim --scrim; sheets --menu-surface/--panel; Settings uses --bg with a --sidebar rail.",
      backdrop: "Opaque; textures stay under them.",
      decorate: "Protected: use tokens for the sheet and scrim. The cosmetic subset can recolour controls, but customCss cannot add decorations or grow buttons here.",
    },
    {
      name: "Landing screens",
      selector: ".welcome-screen, .thread-empty-state",
      where: "Centred in the chat side: .welcome-screen when no project is open, .thread-empty-state for a new thread or chat (inside .conversation). Usually not on the user's screen: preview them with capture_app_screenshot view welcome, new-thread or new-chat.",
      contains: "The new-thread and new-chat landings use the animated Mythra logo (.mythra-logo__svg), a heading (.thread-empty-state h1), and a short line. The project landing adds the isolation choice and shortcuts. The welcome screen uses a separate icon and Open project / Open Chats buttons.",
      tokens: "Heading --text (font via typography.display), line --muted. Logo pieces use tokens.mark, for example tokens: { mark: { blueA: \"#7aa8ff\" } }.",
      backdrop: "Same as the chat side.",
      decorate: "Not positioned: decorate .conversation instead.",
    },
  ],
  recipes: [
    {
      goal: "Something only in the chat area (message list), above the see-through background but under the text",
      css: ".conversation::before { content: \"\"; position: absolute; inset: 0; z-index: 0; pointer-events: none; background-image: radial-gradient(60% 40% at 70% 0%, var(--accent-soft), transparent); }",
      notes: "Works at any translucency. Clipped to the message list, never on the left navigator or the Tools panel. For moving weather (rain, snow, petals) use the particles effect with area: \"chat\" instead of drawing it in CSS.",
    },
    {
      goal: "The whole chat side, behind the glass (like a backdrop effect)",
      css: ".main-panel::before { content: \"\"; position: absolute; inset: 0; z-index: -1; pointer-events: none; background-image: linear-gradient(to bottom, var(--accent-soft), transparent 60%); }",
      notes: "Needs surfaces.translucency > 0; it shows through the top bar, message list and composer zone, dimmed like backdrop effects. Keep inset: 0: .main-panel does not clip, so anything moved outside it shows through the left navigator.",
    },
    {
      goal: "Only the left navigator",
      css: ".sidebar::before { content: \"\"; position: absolute; inset: 0; z-index: -1; pointer-events: none; background-image: linear-gradient(to bottom, var(--accent-soft), transparent 45%); }",
      notes: "Works at any translucency: the sidebar is its own stacking layer, so -1 is above its background and under its rows. Clipped to the sidebar.",
    },
    {
      goal: "A backdrop effect on one side only",
      css: "(no CSS) effects: { particles: { shape: \"streak\", area: \"chat\" }, mesh: { area: \"window\" } }",
      notes: "Every backdrop and texture effect takes area: window (default), chat or sidebar. chat never paints the left navigator or the Tools panel; sidebar paints only the left navigator.",
    },
  ],
  selectors: [
    { selector: ".thread-card", what: "A thread row in the left navigator (positioned and clipped: a good ::after host for hover washes)." },
    { selector: ".thread-row-wrap.active > .thread-card", what: "The selected thread row (fill --lm-press)." },
    { selector: ".workspace-row", what: "A project row (Chats and each project) in the left navigator." },
    { selector: ".message.user .message-body", what: "The user's message bubble (fill --bubble; positioned, so ::after with inset: 0 and border-radius: inherit works)." },
    { selector: ".message.assistant .rich-markdown", what: "The assistant's prose (ink --lm-reading-ink)." },
    { selector: ".rich-markdown a", what: "Links in messages (--accent)." },
    { selector: ".rich-markdown .code-block", what: "A code block with its header (positioned); .rich-markdown pre is the code itself (--lm-code-bg)." },
    { selector: ".rich-markdown code", what: "Inline code." },
    { selector: ".primary-button", what: "Primary buttons (fill --lm-fill, ink --on-accent)." },
    { selector: ".send-button", what: "The composer's send button (protected: recolour, plus the bounded hover/focus grow in controls)." },
    { selector: ".studio-tabs button.active", what: "The active tab in the Tools panel (icon --accent)." },
    { selector: ".project-heading", what: "Project and thread name at the left of the top bar." },
    { selector: ".thread-empty-state h1", what: "The new-thread landing heading." },
    { selector: ".thread-empty-state .mythra-logo__svg", what: "The animated logo square on new-thread and new-chat. Style the gradient stops through tokens.mark. The preview reports the SVG's size in CSS pixels and the rendered stop colours under landmarks." },
  ],
  stacking: [
    "Backdrop effects live behind every pane; they show only through the see-through window background (.main-panel), the top bar and the left navigator. Panels, the composer card, menus, fields, code and the Tools panel stay solid.",
    "Texture effects (grain, scanlines) sit over the panes and under menus, dialogs and toasts.",
    "z-index on a decoration is -1, 0 or 1 and only means something relative to its host: on .sidebar and .topbar -1 is above the fill; on .main-panel -1 is behind the glass; on .conversation 0 is on the glass under the messages.",
  ],
};

export interface DesignKit {
  schema: string;
  principles: string[];
  workflow: string[];
  spec: Record<string, string>;
  regions: UiMap;
  bases: Array<{ id: ThemeName; scheme: "light" | "dark" }>;
  required: string[];
  tokenShape: { note: string; example: Record<string, unknown> };
  tokens: Array<{ key: string; path: string[]; cssVar: string; role: string; doc: string; translucentAllowed: boolean; dark?: string; light?: string }>;
  derivation: string[];
  contrast: string[];
  effects: { limits: Record<string, number | string>; catalog: Array<{ type: string; group: string; doc: string; params: Record<string, string> }> };
  typography: Record<string, string[] | string>;
  shapes: string[];
  elevations: string[];
  customCss: { summary: string; allowed: string[]; denied: string[]; protectedClasses: string[]; limits: Record<string, unknown>; example: string };
  controls: {
    summary: string;
    targets: Array<{ id: string; label: string; selector: string; where: string; scenes: string[] }>;
    rules: string[];
    limits: typeof CONTROL_MOTION_LIMITS;
    presets: UiRecipe[];
  };
  preview: {
    summary: string;
    howTo: string[];
    scenes: Array<{ view: string; shows: string; controls: string[] }>;
    interactions: string[];
    limits: string[];
    extending: string;
  };
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
      "Keep panels, menus and fields solid; use surfaces.translucency (0.1–0.2) only to let a backdrop effect breathe behind the window background and sidebar. Give an effect area: \"chat\" or \"sidebar\" to keep it on one side.",
      "Motion should be slow and quiet: one backdrop effect plus at most one or two accent touches. Prefer speed \"slow\".",
      "Light themes: tinted paper, deep inks, a saturated but dark accent. Dark themes: lifted graphite or tinted night, soft white text, a luminous accent.",
      "Prefer tokens and curated effects; customCss is for small cosmetic touches and is sanitized.",
    ],
    workflow: [
      "1. Read this kit once, including regions (the map of the app: real selectors, which tokens paint what, where effects show).",
      "2. create_custom_theme with name, base, tokens (bg, text, accent at least), and optionally effects/typography. Reach for curated effects (with area to pick a side) before customCss.",
      "3. Read adjustments and warnings in the result; tell the user in plain words what was nudged for readability. A customCss warning that a rule was dropped means it never reached the screen.",
      "4. Read `layout` and `layoutFrom` in every create/update/undo/apply result. layoutFrom.source says what was measured: live-window is the user's own screen as it is now (only what they have open, so selectors for other screens can match 0), hidden-preview is a sample-data copy of the app (used when the theme isn't on their screen), none says why there is no layout. Use didYouMean when a selector matched zero elements on a screen that should have it.",
      "5. When the request targets a screen or interaction, call capture_app_screenshot yourself with the corresponding view from preview.scenes. Use new-thread for a blank project thread, and new-chat for a blank chat without a project. After saving a button change, request its relevant hover, focus or press state in that scene. Use the returned picture when available and read the accompanying layout and interaction facts. The fixture uses bundled sample content and needs no navigation from the user.",
      "6. For any later change use update_custom_theme with a small patch; use undo_custom_theme to go back.",
    ],
    spec: {
      name: `1–${NAME_MAX} characters`,
      description: `0–${DESCRIPTION_MAX} characters`,
      base: `one of ${BUILT_IN_THEMES.join(", ")}; the theme keeps its light/dark scheme and inherits everything you don't set`,
      tokens: "colours by kit key (see tokenShape for nested syntax, diff and mark objects); #rrggbb, rgb(), rgba(), hsl() or oklch()",
      shape: SHAPES.join(" | ") + " (corner radii; default standard)",
      elevation: ELEVATIONS.join(" | ") + " (shadow depth; default soft)",
      typography: "{ui, display, mono, chat} (see typography)",
      surfaces: `{translucency: 0–${TRANSLUCENCY_MAX}} (default 0). 0.2 makes the window background and sidebar half see-through so backdrop effects show; 0.1–0.16 is a calm choice`,
      effects: "map of effect type to params (see effects). Backdrop and texture effects take area: window | chat | sidebar",
      motion: "{enabled: boolean} (default true)",
      customCss: `optional sanitized cosmetic CSS, at most ${THEME_LIMITS.maxCustomCssBytes} bytes`,
    },
    regions: UI_MAP,
    bases: BUILT_IN_THEMES.map((id) => ({ id, scheme: builtInScheme(id) })),
    required: ["name", "base", "tokens.bg", "tokens.text", "tokens.accent"],
    tokenShape: {
      note: "Each token's path lists the JSON keys to use in order. Write syntax.comment, diff.addInk and mark.blueA as nested properties under tokens.syntax, tokens.diff and tokens.mark. mark colours the Mythra logo, including the animated one on the new-thread and new-chat landings. The example is a tokens object. A create needs bg, text and accent, and an update patch may send just the nested values you want to change.",
      example: {
        bg: "#16131f", text: "#ece8f6", accent: "#b794ff",
        syntax: { comment: "#8a8299", keyword: "#c4a7f7", string: "#9fd8b8" },
        diff: { addInk: "#9fd8b8", delInk: "#f4a7bb" },
        mark: { blueA: "#7aa8ff" },
      },
    },
    tokens: KIT_TOKENS.map((token) => ({
      key: token.key, path: ["tokens", ...token.key.split(".")], cssVar: token.cssVar, role: token.role, doc: token.doc, translucentAllowed: token.alphaAllowed,
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
      "With translucency, surfaces are checked over the plain window and over every backdrop effect colour at full strength that shows behind them (an area: chat effect counts for bg and the top bar, area: sidebar for the sidebar); textures are included everywhere.",
      "A failing ink is moved along lightness only (hue kept) by up to 0.15; the change is reported in adjustments. Surfaces are never moved: if an ink can't be fixed, the call fails with advice.",
    ],
    effects: {
      limits: { ...GROUP_LIMITS, total: MAX_EFFECTS, canvas: 1, note: "Backdrop effects show only through see-through surfaces (surfaces.translucency > 0). Backdrop and texture effects take area: window (default, everywhere), chat (top bar, messages and composer only; never the left navigator or the Tools panel) or sidebar (the left navigator only). Accent effects decorate specific controls. Everything pauses for reduced motion, the user's pause switch and when the app is in the background." },
      catalog: Object.values(EFFECTS).map((def) => ({ type: def.type, group: def.group, doc: def.doc, params: Object.fromEntries(Object.entries(def.params).map(([key, desc]) => [key, paramDoc(desc)])) })),
    },
    typography: {
      ui: [...UI_FONTS], display: [...DISPLAY_FONTS], mono: [...MONO_FONTS], chat: [...CHAT_FONTS],
      note: "Only system and bundled fonts (Pixelify Sans for display: pixel, VT323 for mono: terminal). display styles headings and pane titles. mono: terminal applies to code blocks only. chat is a suggestion that applies only while the user's chat font is the default.",
    },
    shapes: [...SHAPES],
    elevations: [...ELEVATIONS],
    customCss: {
      summary: "Cosmetic CSS scoped to the app window. Use the selectors in regions (a selector that matches nothing fails silently). Selectors are scoped automatically; colours for text and surfaces must use var(--token) (literal colours only as faint tints with alpha ≤ 0.14). ::before/::after may hold absolutely positioned decorations (content: \"\") with transform/opacity animations. Anything not allowed is removed (the rest of the theme still saves) and reported in warnings; fix what they name.",
      allowed: [
        "color, background-color (token colours), background-image gradients, borders (≤ 3px), border-radius (≤ 20px), outline-color/offset, box-shadow (≤ 4 layers, blur ≤ 48px), text-shadow (≤ 2, blur ≤ 6px), caret-color, accent-color, font-weight 400–700, font-style, letter-spacing −0.02em…0.06em, text-decoration colour/style, transitions ≤ 400ms",
        "On ::before/::after only: content \"\", position: absolute, inset/offsets (−300%…300% or up to ±1600px, so a layer can be taller than its host), width/height (% up to 300%, or up to 40px), transform, opacity, mix-blend-mode, z-index −1…1, filter blur ≤ 24px / hue-rotate / saturate, gradient masks (mask-image/size/position/repeat, mask-composite and -webkit-mask-composite)",
        // Flash rule (WCAG 2.3.1) and motion limits: wording from the sanitizer owner; keep it in step with sanitizeCss.ts.
        "@keyframes (≤ 12) animating transform, opacity, background-position (colours and box-shadow only on pseudo-elements). Flashing follows WCAG 2.3.1: sharp, instant flashes are fine, but never more than 3 flashes in any one second per animated element (a flash is a rise and fall in brightness; all animations on one element are added together and the loop restart counts). For lightning, a quick double flash followed by a pause of a second or more works well. Durations: at least 1.2s (2s when infinite) when the animation changes opacity, colour, size (scale) or glow; a ::before/::after decoration that only moves (translate, rotate, background-position) may loop as fast as 0.35s, for example rain. Put animation-name, duration, timing, iteration count and direction in one rule (or use the animation shorthand); only animation-delay may be set in a separate rule, for staggering.",
        `Button grows (see controls): on an opted-in button's own :hover or :focus-visible, transform: scale() up to ${CONTROL_MOTION_LIMITS.hover.scale[1]}, drawn as the engine's own short, motion-gated grow`,
        "@media for prefers-reduced-motion, prefers-color-scheme, min-width, max-width; @supports",
        "Custom properties named --ct-*; var() of theme tokens",
      ],
      denied: [
        "url() and any image/file loading, @import, @font-face, other at-rules",
        "display, visibility, position on real elements, width/height/margin/padding, overflow, clip-path, z-index on real elements, transform/filter/opacity on real elements (except the bounded button feedback in controls), font-family, font-size, line-height, cursor, user-select, pointer-events (except none on decorations), background-clip: text, will-change",
        "Preview-only state hooks ([data-preview-*]); write real :hover, :focus-visible and :active instead",
        "Universal *, ID selectors, :has(), :root/html/body, ::backdrop, !important (removed), redefining app tokens (set them in tokens instead)",
      ],
      protectedClasses: [...PROTECTED_CLASSES, ...PROTECTED_PREFIXES.map((prefix) => `${prefix}*`)],
      limits: { bytes: THEME_LIMITS.maxCustomCssBytes, rules: CSS_LIMITS.rules, declarationsPerRule: CSS_LIMITS.declsPerRule, selectorChars: CSS_LIMITS.selectorChars, keyframes: CSS_LIMITS.keyframes, infiniteAnimations: CSS_LIMITS.infiniteAnimations, motion: MOTION_LIMITS, decoration: DECORATION_LIMITS },
      example: ".thread-card::after { content: \"\"; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, var(--accent-soft), transparent 60%); opacity: 0; transition: opacity 200ms ease; }\n.thread-card:hover::after { opacity: 1; }",
    },
    controls: {
      summary: "Style common buttons using their production selectors. Colour, background, border, box-shadow and short cosmetic transitions are available in :hover, :focus-visible and :active. Enabled buttons opted in by the app can grow slightly on hover or keyboard focus. Use an inset shadow, background or border for press. A pointer press also hovers the button, so it can retain the hover grow. A selector shared with approvals, dialogs or Settings can apply cosmetic styles there. Only the app's opted-in buttons get the grow.",
      targets: CONTROL_TARGETS.map((target) => ({
        id: target.id, label: target.label, selector: target.selector, where: target.where,
        ...(target.shared ? { shared: target.shared } : {}),
        scenes: PREVIEW_SCENE_IDS.filter((id) => PREVIEW_SCENES[id].controls.includes(target.id)),
      })),
      rules: [
        "Write the grow state on the button's own last compound, such as `.send-button:hover`, `.new-thread-button:focus-visible` or `.studio-tabs button:hover`. If the rule has a list of selectors, each needs its own top-level :hover or :focus-visible on the button. Use :active only in a separate cosmetic rule.",
        `transform takes only scale(), from 1 up to scale(${CONTROL_MOTION_LIMITS.hover.scale[1]}), and only on :hover or :focus-visible. Mythra Code turns it into its own ${CONTROL_MOTION_LIMITS.grow.durationMs}ms ease-out grow (no overshoot); your transitions don't change it, so don't list transform or scale in them.`,
        "The grow reaches only the opted-in buttons and only while they are enabled, and only while motion is allowed: no reduced-motion preference, theme animations not paused, the theme's motion.enabled not false. In forced-colours mode all customCss is off. Rotation, skew, translate and :active transforms are rejected.",
        "Put transitions on the resting rule, name the cosmetic properties, and use short literal times up to 400ms. For example `.send-button { transition: background-color 140ms ease, box-shadow 140ms ease; }`. An authored CSS keyframe animation on the same button takes turns with the grow. The built-in Accent flow effect and pseudo-element decorations can coexist with it.",
        "Colours in states follow the usual rules: var(--token) or --ct-* variables, so contrast stays checkable.",
        "Keep keyboard focus at least as visible as hover. Use var(--accent) for the focus outline if you recolour it, and keep the existing outline visible when adding a box shadow. Request interaction focus and inspect the rendered outline, shadow and surrounding surface together. Token checks cover standard surfaces, and focusIndicator reports computed styles for the fixture.",
        "Call capture_app_screenshot for the chosen view, control and interaction. The result identifies the actual element, lists the sampled computed styles that changed on it and reports its bounds at rest and in the requested state.",
      ],
      limits: CONTROL_MOTION_LIMITS,
      presets: [
        {
          goal: "Send: a soft glow and a slight grow on hover and focus, a pressed-in look on click",
          css: [
            ".send-button { transition: background-color 140ms ease, box-shadow 140ms ease; }",
            ".send-button:enabled:hover { box-shadow: 0 0 0 3px var(--accent-soft), 0 6px 18px var(--accent-soft); transform: scale(1.04); }",
            ".send-button:focus-visible { outline-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); transform: scale(1.03); }",
            ".send-button:enabled:active { box-shadow: inset 0 2px 6px var(--accent-line); }",
          ].join("\n"),
          notes: "Preview: view conversation (or new-thread), control send, interaction hover, focus or press. The preview types sample text so Send is enabled.",
        },
        {
          goal: "Quiet toolbar buttons: tint and grow on hover, an inset press",
          css: [
            ".new-thread-button, .workspace-tools-trigger, .attach-button { transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }",
            ".new-thread-button:enabled:hover, .workspace-tools-trigger:enabled:hover, .attach-button:enabled:hover { background-color: var(--accent-soft); border-color: var(--accent-line); transform: scale(1.02); }",
            ".new-thread-button:enabled:active, .workspace-tools-trigger:enabled:active, .attach-button:enabled:active { box-shadow: inset 0 1px 3px var(--accent-line); }",
          ].join("\n"),
          notes: "Preview: view conversation, control new-thread, tools-toggle or attach.",
        },
        {
          goal: "A soft hover shadow for Open project and a brighter border for Open Chats",
          css: [
            ".welcome-actions .primary-button, .welcome-actions .secondary-button { transition: box-shadow 160ms ease, border-color 160ms ease; }",
            ".welcome-actions .primary-button:hover { box-shadow: 0 4px 14px var(--accent-soft); transform: scale(1.02); }",
            ".welcome-actions .secondary-button:hover { border-color: var(--accent-line); }",
            ".welcome-actions button:focus-visible { outline-color: var(--accent); }",
          ].join("\n"),
          notes: "The .welcome-actions ancestor confines these styles to the welcome screen. Preview with view welcome and control primary or secondary.",
        },
        {
          goal: "Tools tabs and the new-thread landing's shortcuts",
          css: [
            ".studio-tabs button { transition: background-color 120ms ease, color 120ms ease; }",
            ".studio-tabs button:hover { background-color: var(--accent-soft); color: var(--text); }",
            ".empty-state-actions button:hover { border-color: var(--accent-line); transform: scale(1.02); }",
          ].join("\n"),
          notes: "Preview with view tools-git and control tools-tab, then view new-thread and control landing-action.",
        },
      ],
    },
    preview: {
      summary: "capture_app_screenshot draws a theme revision in a separate hidden window with the app's real components, bundled sample data, and the user's window size and scale. Request a scene yourself whenever the user asks how it looks. Create, update, undo and apply return layoutFrom so you can tell whether their automatic layout came from the user's current window, the hidden sample conversation, or neither.",
      howTo: [
        'A blank project thread at rest: capture_app_screenshot {"view":"new-thread"}. Use landmarks to read the animated logo SVG square and its rendered colours. To edit those colours in the conversation theme, update_custom_theme accepts {"patch":{"tokens":{"mark":{"blueA":"#7aa8ff"}}},"summary":"Lighten the centre logo piece"}. Preview new-thread again after saving.',
        "A control in a state: capture_app_screenshot { view: \"conversation\", control: \"send\", interaction: \"hover\" }. interaction is rest, hover, focus (keyboard focus) or press; control alone means hover; interaction alone uses the scene's first control.",
        "The layout is measured at rest before the requested state. Use the picture and interaction facts for the simulated CSS state. Image support depends on the runtime and current model. If a picture is unavailable, use the measured layout, landmarks and interaction facts and report the evidence you received.",
        "Preview the conversation's theme and newest revision by default. Pass themeId or revision to select a different saved theme or revision.",
        "The user can switch previews off (Settings > Appearance > Custom themes > Let models see theme previews); then neither pictures nor layout-only previews are drawn.",
      ],
      scenes: PREVIEW_SCENE_IDS.map((id) => ({ view: id, shows: PREVIEW_SCENES[id].shows, controls: [...PREVIEW_SCENES[id].controls] })),
      interactions: [...PREVIEW_INTERACTIONS],
      limits: [...PREVIEW_SCENE_LIMITS],
      extending: "Scenes are a fixed registry (src/lib/customThemes/previewScenes.ts) of production views with sample data; new app screens are added there, never by passing a route, selector or script.",
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
        name: "Storm (dark): rain on the chat side only",
        spec: {
          name: "Thunderhead", base: "mythra", description: "Storm-blue night, rain falling over the chat, a heavy sky",
          tokens: { bg: "#0f131b", sidebar: "#131822", panel: "#181e2a", text: "#e2e8f2", accent: "#8ab8ff" },
          surfaces: { translucency: 0.16 },
          effects: {
            particles: { shape: "streak", area: "chat", colors: ["#9fb3cc", "#c9d6e6"], count: 110, size: [1, 2], speed: "medium", angle: 12 },
            mesh: { colors: ["#1d2536", "#2b3350", "#1a2030", "#33405e"], intensity: 0.4, speed: "slow" },
            vignette: { strength: 0.45 },
          },
        },
      },
      {
        name: "Blossom (light): petals drifting down",
        spec: {
          name: "Sakura", base: "light-mythra", description: "Warm paper, a cherry accent and petals drifting across the chat",
          tokens: { bg: "#fbf6f4", sidebar: "#f5ece9", panel: "#fffbfa", text: "#2b1f22", accent: "#b23a5b" },
          surfaces: { translucency: 0.18 },
          effects: { particles: { shape: "petal", area: "chat", colors: ["#e98aa5", "#f3a9bd", "#dc6f8f"], count: 28, size: [1.5, 3], speed: "slow", angle: 18 }, aurora: { colors: ["#f9c9d4", "#fde3e8", "#f4a7bb"], intensity: 0.25, position: "top" } },
        },
      },
      {
        name: "Paper (light)",
        spec: { name: "Paper", base: "atari", tokens: { bg: "#f7f3ea", text: "#2a241c", accent: "#9a4a1f" }, typography: { display: "serif" }, effects: { grain: { amount: 0.45 } } },
      },
    ],
  };
}
