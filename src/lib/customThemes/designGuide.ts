// How to work with the theme tools and how to make a theme that is beautiful
// AND comfortable for long coding sessions. Returned (with P1's design kit)
// by `get_theme_design_kit`, so a model pays for it only when it designs.
// Pure data: no imports, JSON-serializable. Owned by the bridge-tools package.

export const THEME_DESIGN_GUIDE = {
  workflow: [
    "One conversation, one theme. Create it once; every later request in the conversation (\"warmer\", \"less glow\", \"more contrast\", \"try a serif\") is update_custom_theme on that SAME theme, never a new create.",
    "In update_custom_theme send only what changes. tokens merge key by key (null resets a key to derived/inherited), effects merge by effect type (null removes an effect, params merge), typography/surfaces/motion merge key by key, customCss replaces the whole stylesheet (\"\" removes it), and name/description/base/shape/elevation replace. Keep the user's other choices.",
    "When the user names an existing theme (\"my Nebula theme\", \"the one from yesterday\"), call list_custom_themes, then get_custom_theme before a large change so you edit what is really there.",
    "Use create_custom_theme again only when the user explicitly asks for an additional, separate theme; then pass asNewTheme: true.",
    "Undo: undo_custom_theme with steps (default 1) walks back one change at a time. To restore a specific version, or to redo after an undo, read get_custom_theme with includeHistory: true and pass that revision as toRevision. Undo never deletes history; it saves a new revision.",
    "To switch the look without editing, use apply_custom_theme with themeId or builtInTheme (for example \"go back to Synthwave\").",
    "Pass expectedRevision from your last read; if the user edited the theme in Settings meanwhile, re-read it and apply your change again instead of overwriting theirs.",
    "You cannot delete themes. If asked, tell the user to delete it in Settings > Appearance > Custom themes.",
    "Every change saves automatically and the user sees an Undo. After each change, read `adjustments` and `warnings` in the result and tell the user in plain words what Mythra Code changed for readability.",
    "Before styling a part of the app, look it up in the kit's regions map: it names the real selector, the tokens that paint it and where effects show. Never guess class names such as .chat-stage or .main; they don't exist and the rule silently does nothing.",
    "After every change, read `layout` and `layoutFrom` in the result. layoutFrom.source live-window means the user's own window as it is now: only the screen they have open was measured, so a selector for another screen (a new thread, Settings, a Tools tab) can honestly match 0 there. hidden-preview means a sample-data copy of the app (used when the theme isn't on their screen). `regions` are the app's real areas with boxes (CSS px); `selectors` lists each customCss selector with how many elements it matched and where; for a selector that matched 0 on a screen that should have it, use its `didYouMean`. `decorations` and `effects` say whether each ::before/::after and effect is actually visible (yes / partly / sometimes / no), with `why` and `fix`.",
    'When the user asks about a particular screen, call capture_app_screenshot yourself with a view from preview.scenes. For the blank project thread and its animated logo, call with {"view":"new-thread"}. For the Chats landing, use new-chat. The tool draws a separate hidden window with bundled sample content at the user\'s window size. The user can stay on their current screen.',
    'After a logo edit, capture new-thread again and read the landmark SVG bounds and computed colours. For a button edit, capture the relevant state, for example {"view":"new-thread","control":"send","interaction":"press"}. Compare with interaction rest if needed. Use the returned picture when available, along with layout, landmarks and interaction facts. If previews are off or unavailable, report what you could confirm from the change result.',
    "Style buttons using the selectors and examples in controls. Small grows are for an enabled, opted-in button's own :hover or :focus-visible. Use colour, border or an inset shadow for :active. A press can retain the hover grow. Keep keyboard focus at least as visible as hover and inspect interaction focus after editing it.",
    'Write syntax, diff and mark as nested token objects. For example, update_custom_theme accepts {"patch":{"tokens":{"mark":{"blueA":"#7aa8ff"}}},"summary":"Lighten the centre logo piece"}.',
  ],
  palette: [
    "Start from a mood (calm night, warm paper, neon arcade) and pick three anchors: bg, text and one accent. Let Mythra Code derive the rest, then refine only what looks off.",
    "Surfaces are a quiet ladder: canvas/bg, then sidebar, panel and menu only a small lightness step apart (about 0.02–0.06 OKLCH L on dark themes). Big jumps look blotchy; identical values make menus and cards disappear.",
    "Tint neutrals toward the accent hue with very low chroma (for example a violet-black #16131f instead of pure #000). Pure black and pure white are harsh for long sessions.",
    "Use one accent, sparingly: selection, focus, primary buttons and links. A second accent (accent2) should be a close neighbour, not a competing colour.",
    "Keep status colours (success, warning, danger, info) recognisable: green, amber, red and blue families. Shift their tone to fit the palette, never their meaning.",
    "For a light theme choose a light base (light-mythra, daylight or atari) and a bg with OKLCH L above about 0.9. For a dark theme choose a dark base (mythra, kiwi or synthwave) and a bg with L below about 0.3. The base's light or dark scheme must match bg.",
    "Code colours (tokens.syntax) should be distinct from each other at a glance but softer than the accent; comments are the quietest readable ink.",
  ],
  contrast: [
    "Mythra Code checks contrast on every surface each ink is drawn on and nudges inks lighter or darker when needed. It never moves your surfaces.",
    "Aim higher than the minimum: body text 7:1 or more on bg and panel, muted text at least 4.5:1. A palette that needs many adjustments usually has surfaces that are too close to mid-grey.",
    "The accent must read as text on bg, sidebar and panel (4.5:1) and the text on accent fills (onAccent) must read on the fill. Very light accents on light themes fail; deepen them.",
    "If a create or update is rejected, read each `path: message` line and fix exactly that; do not start over.",
  ],
  motion: [
    "Animation is welcome in custom themes, but calm wins: slow speeds, low intensity, one backdrop effect and at most one or two accent effects. The user is coding, not watching a screensaver.",
    "Backdrop effects (aurora, mesh, starfield, particles, grid) show only where surfaces.translucency is above 0 (the chat side's background, the top bar and the left navigator). Panels, menus, the composer card, code and the Tools panel stay solid so text never sits on moving colour. 0.06–0.12 translucency is usually enough.",
    "Pick where each backdrop or texture effect shows with area: \"window\" (default, everywhere), \"chat\" (the chat side only: never the left navigator or the Tools panel) or \"sidebar\" (the left navigator only). For example rain over the chat but a calm sidebar: particles { shape: \"streak\", area: \"chat\" }.",
    "Weather uses the particles effect, not customCss: rain = shape \"streak\" (fast, thin, slanted with angle, up to 160 of them), snow = \"flake\", blossoms or leaves = \"petal\". angle (−30…30) tilts them for wind; keep rain colours pale and low-chroma so text stays calm on top.",
    "Good pairings: aurora or starfield on dark themes; a storm = particles streak (area chat) + a dark mesh + vignette; grain or a faint vignette on paper-like light themes; grid plus scanlines for retro; glow on focus and send for a little life.",
    "Prefer speed \"slow\" and intensity around 0.25–0.4. Use \"lively\" only when the user asks for energy.",
    "Lightning and other flashes are allowed but follow WCAG 2.3.1: never more than 3 flashes in any one second per animated element. A quick double flash, then a pause of a second or more, reads as lightning. Moving-only decorations (rain drawn in customCss) may loop as fast as 0.35s; anything that changes brightness, colour, size or glow needs at least 1.2s (2s when infinite).",
    "Theme effects, keyframes and the button grow respect reduced motion, the app's pause switch and the theme's motion.enabled flag. A hidden preview freezes effects and keyframes at a single moment. Keep the theme legible in that still view.",
  ],
  typography: [
    "Fonts are a short safe list (no downloads). Change ui only for a strong reason; display (headings) and mono (code) are where personality is cheap. Pixel and terminal fonts suit retro themes; keep them out of body text.",
    "typography.chat is only a suggestion: it applies while the user's own chat font is the default.",
  ],
  customCss: [
    "Reach for customCss last: tokens and curated effects cover most looks, are contrast-checked, and survive app updates.",
    "Use the kit's regions map for selectors and its recipes for decorations: .conversation::before (z-index 0) decorates only the message list, on the glass and under the text; .sidebar::before (z-index -1) only the left navigator; .main-panel::before (z-index -1) the whole chat side behind the glass (needs translucency). Don't offset decorations outside their host with masks or pixel tricks; pick the right host instead.",
    "customCss is cosmetic only and sanitized: colours via var(--token) or --ct-* variables, no layout, sizes, positioning of real elements, url(), fonts or !important. Dropped rules come back as warnings; fix or remove them rather than resending.",
    "If a customCss rule makes text unreadable on screen, Mythra Code turns that stylesheet off and tells you which landmark failed.",
  ],
  examples: [
    {
      intent: "Calm dark: indigo night with a slow aurora",
      create: {
        name: "Nebula", base: "mythra", description: "Indigo night, violet accent, a slow aurora behind the sidebar",
        tokens: { bg: "#16131f", sidebar: "#1b1726", panel: "#211c2e", text: "#ece8f6", muted: "#a49cb8", accent: "#b794ff" },
        surfaces: { translucency: 0.1 },
        effects: { aurora: { colors: ["#6d5dfc", "#b794ff", "#36d0c7"], intensity: 0.3, speed: "slow", position: "top" } },
        summary: "First version: indigo night with aurora",
      },
    },
    {
      intent: "Warm light: paper and ink, serif headings, faint grain",
      create: {
        name: "Paper & Ink", base: "light-mythra", description: "Warm paper, deep ink, a blue fountain-pen accent",
        tokens: { bg: "#f4f1ea", sidebar: "#ebe6dc", panel: "#fbf9f4", text: "#1f1d1a", muted: "#5c574e", accent: "#2f5fd0" },
        shape: "soft", typography: { display: "serif" },
        effects: { grain: { amount: 0.3 } },
        summary: "First version: warm paper",
      },
    },
    {
      intent: "Retro neon: grid floor, scanlines, glowing focus",
      create: {
        name: "Neon Arcade", base: "synthwave", description: "Midnight purple with a hot pink grid horizon",
        tokens: { bg: "#120d1f", sidebar: "#171027", panel: "#1d1530", text: "#f3ecff", muted: "#b3a6cc", accent: "#ff5fb4" },
        surfaces: { translucency: 0.12 }, typography: { display: "pixel" },
        effects: { grid: { color: "#ff5fb4", speed: "slow" }, scanlines: { opacity: 0.25 }, glow: { targets: ["focus", "send"], strength: 0.4 } },
        summary: "First version: neon arcade",
      },
    },
    {
      intent: "A follow-up adjusts the same theme",
      update: { patch: { tokens: { accent: "#ff8fd1" }, effects: { aurora: { intensity: 0.2 } } }, summary: "Pinker accent, softer aurora" },
    },
  ],
} as const;
