# Pro UI design language

Morgan's brief (2026-11-01): a cleaner interface that feels like a
professional Apple app, with some inspiration from other pro tools such as
Linear, Raycast and Xcode. The overhaul is a restyle. Every control stays where
it is and keeps its behaviour; only the presentation changes. Density is
balanced, like Xcode or Finder. All six themes stay, and each keeps its accent.

The tokens live in `src/styles/lumen/tokens.css`. The Lumen compatibility
contract in that file still applies: the shell-scope selector, no `@layer`,
and no `:is()`, `:where()`, `:has()` or `:focus-visible` inside selector
lists.

## Structure

- **One continuous window.** The sidebar, chat and workbench sit flush with
  each other and are divided by 1px `--line` hairlines. Don't use floating
  islands, gutters, canvas gradients or "aurora" washes.
- **Content panes:** `--bg`.
- **Source lists** (the sidebar and the dock rail): `--sidebar`.
- **Cards inside content:** `--panel` with a 1px `--line` border, or
  `--line-quiet` for very quiet cards. Cards are for grouping. Don't nest
  cards inside cards; inside a card, use hairline row separators.

## Type

| Use | Size / weight |
| --- | --- |
| Interface text, buttons, rows | 13px (`--fs-ui`), 400–500 |
| Secondary and meta text | 11–12px, `--muted` / `--muted-2` |
| Section headings | 11px (`--fs-meta`), 600, `--muted-2`, **sentence case** |
| Pane titles | 13.5–15px, 600–650 |
| Sheet / page titles | 20px (`--fs-title`), 650 |
| Landing headline | 28px (`--fs-display`), 650, `--track-display` |
| Chat prose | 14px (`--fs-body`), line-height 1.6–1.65 |

- Use `--font-sans` for all interface text.
- `--font-mono` is only for code, commands, file paths, branch names and
  hashes. Labels, counts, kbd hints, badges and captions are never mono.
- Never use `text-transform: uppercase` with wide tracking. Captions are
  sentence case with `letter-spacing: 0`.
- Use `font-variant-numeric: tabular-nums` for changing numbers.

## Shape

Use rounded squares, never ovals (a standing preference from Morgan). Keep
`--r-pill` for slim tracks and progress bars only.

| Element | Radius |
| --- | --- |
| Buttons, fields, segmented controls, menu items | `--r-control` / `--r-sm` (6px) |
| Badges, tags, kbd | `--r-chip` (4px) |
| Cards, list rows | `--r-md` / `--r-lg` (8–10px) |
| Popovers, menus, composer, toasts | `--r-xl` (12px) |
| Sheets and modals | 14px |

## Controls

| Control | Height | Notes |
| --- | --- | --- |
| Toolbar buttons | 28px | Borderless. Hover: `--lm-hover`. Pressed or on: `--lm-press`, with an accent icon. |
| Primary button | 28–32px | Flat `--lm-fill`, `--on-accent` ink, weight 600. No shadow, glow, gradient or lift. Hover: `filter: brightness(1.06)`. |
| Secondary button | 28–32px | Dark: `--lm-press` fill with a `--line` border. Light: `--panel` with a `--line-strong` border and a 1px shadow. Weight 500. |
| Destructive button | 28–32px | `--red` ink. A red edge and a faint red fill appear on hover only. |
| Fields | 28–30px | `--field` with a `--line` border. Focus: `--accent-line` border plus `--ring`. Never remove the outline without one of these. |
| Segmented control | — | Recessed `--lm-press` track (2px padding). The selected segment is raised: `--lm-seg-surface` (`--panel-3` in dark themes, white in light ones) with `--lm-seg-shadow`. |
| Switches and checkboxes | — | Accent fill when on. |

Fields and segmented controls use a 6–7px radius.

Selection in lists is a neutral `--lm-press` fill. The accent marks only the
row's icon, a check or a small dot. Don't use accent outlines or tinted
gradient cards to show selection. A selected choice card (for example a theme
tile) can use a 1px `--accent` border plus `0 0 0 1px var(--accent)`.

**One exception: the selection bar.** The current row of a navigation list
whose rows are otherwise identical in shape (the sidebar's thread list, the
Settings rail, the Tools rail) may add a 3px × 16px `--accent` bar at its
left edge, vertically centred, with a 2px outer radius. It marks "you are
here" in a list people scan quickly; it is never used for hover, for multi-
selection, for status, or on cards, menus or tables, and it always sits on
top of the neutral selected fill, never instead of it. In forced-colors mode
it becomes `Highlight`.

## Colour

- The accent goes on primary actions, focus, selection marks, links and small
  status details. It never goes on large surfaces.
- Status colours (`--success`, `--orange` / `--amber`, `--red`, `--info`) show
  up as ink or as their own tint (`--success-soft`, `--orange-soft`,
  `--red-soft` / `--red-line`, `--info-soft`), not as solid blocks.
- Never add glows, coloured shadows, text-shadows or gradient text.

### Token names

- **Accent:** `--accent` is the theme's interaction colour (cyan in Mythra,
  sky blue in Light Mythra, lime in Kiwi, pink in Synthwave (which also has
  its own violet-night surfaces, lavender lines and inks, and code colours),
  green in Light
  Kiwi, brick in Atari), with `--accent-soft` (tint), `--accent-line`
  (hairline), `--accent-2` (pressed/darker) and `--on-accent` (ink on a solid
  accent fill; `--lm-fill` is that fill). `--green`, `--green-soft` and
  `--green-line` are old aliases of the accent kept for one release: don't
  use them in new rules.
- **Success is not the accent:** outcome words ("Connected", "Done",
  "Passed", "Installed", "Ready", "Work completed") use `--success` /
  `--success-soft`, a status green in every theme, so a pink or blue accent
  never reads as a good outcome. The accent is for selection, navigation and
  interaction only.
- **Two amber states are told apart by more than colour:** "Needs approval"
  (filled chip, raised-hand icon) and "Setup needed" (outlined chip, wrench
  icon) share `--orange` but never share a shape or a word.
- **Brand marks:** provider plates and their ink are `--brand-*` tokens
  (`--brand-claude`, `--brand-on-claude`, `--brand-cursor`…). They are the
  same in every theme.
- **Named surfaces and shadows:** switch knobs (`--lm-knob*`), segmented
  controls (`--lm-seg-*`), the composer (`--lm-composer-shadow`), the light
  control lift (`--lm-control-lift`), diff lines (`--diff-*`), chart series
  (`--chart-1/2`) and scrims. **`--scrim`** (one per theme: about 50% black
  on dark themes, a cool 26% veil on light ones) sits behind every dialog,
  sheet, palette and drawer; dialogs add a 6px blur (dropped under reduced
  transparency), drawers only dim. `--scrim-media` stays for the image
  viewer; `--lm-scrim` and `--scrim-firm/-deep` are legacy.
- **No raw colours outside `tokens.css`.** `npm run check:css` lists hex,
  `rgb()` and `hsl()` literals anywhere else. Exceptions live in
  `scripts/css-token-allowlist.json` with a reason: the effort-slider skin
  previews and the Poet skin palette (art, not UI), the developer
  performance overlay, the Mythra mark fallbacks, and a shrink-only budget
  for the legacy `src/styles.css`. A literal inside a `var()` fallback is
  allowed.

## Elevation

Menus, popovers and sheets use `--menu-surface` with `--lm-pop-shadow`, which
already includes the hairline edge. Panes and cards are flat: no shadow
beyond `--elev-1`.

Stacking uses the named scale in `tokens.css`, lowest to highest:
`--z-raised`, `--z-sticky`, `--z-composer`, `--z-drawer` (the narrow-window
Tools drawer), `--z-drawer-chrome`, `--z-peek-scrim` / `--z-peek` (the
floating sidebar), `--z-popover`, `--z-modal`, `--z-toast`, `--z-top` (drag
ghost, performance overlay and the dialog fallbacks for engines without a top
layer). Use a raw number only to order siblings inside one card or list.

## Focus

Every focusable control shows keyboard focus. Fields use the `--accent-line`
border plus `--ring`; buttons use the 2px accent outline; menu rows use
`--lm-menu-focus` plus a 1px `--lm-menu-focus-edge` inset (hover is the fill
alone). Only remove `outline` in a rule that also draws one of these, or on an
element that is never a Tab stop (`tabindex="-1"` focus targets such as a
dialog heading).

Modal surfaces (dialogs, sheets and the narrow-window sidebar peek) contain
focus with `useModalFocus` / `containTab` from `src/hooks/useModalFocus.ts`.
Their trap ends are computed by `reachableFocusables`, which skips hidden,
inert, disabled, zero-size and collapsed `<details>` content. Everything a
modal covers is `inert`, so a pointer or screen reader can't reach it either;
Escape closes it from wherever focus is, and focus returns to the opener.

## Top bar

The top bar sheds secondary chrome by the width it measures, not by a fixed
breakpoint (`useTopbarFit`, ladder in `src/lib/topbarFit.ts`): key hints, the
usage window name, the empty "Pull requests" chip (which then joins the "…"
menu), Search's label, the idle usage chip (whole, into the "…" menu: a quota
figure never loses its "left"/"used" word, so "62%" alone never appears),
unset Run's word, the panel toggle's label, Run's label, and last the long
status words take their short form ("Set up") while a "Sign in for usage"
chip joins the "…" menu. The thread title keeps about 200px
first. A thread that failed to open keeps its title as the subtitle and shows
an amber "Unavailable" status until Retry works or another thread opens. Status words are never removed, and the full state is always in a
`role="status"` region for assistive tech.

## Lists and long panes

- A row's status ("Needs approval", "Working 2m", "Failed", "Unavailable") is
  never truncated, in any state: pinned, selected, hovered, running or with
  its menu open. A row that is running or waiting on you puts its status on a
  second line under the title, so the title keeps the row's full width too;
  idle rows and a finished row's short "Done" stay one line. A row with a
  status hides its pin glyph until the status clears; the row menu has its
  own slot. The run time appears from 10s ("Working", then "Working 12s").
- A project row shows one indicator, by priority: threads waiting on you
  (amber hand + count) over threads working (the working mark + count). The
  tooltip and the row's accessible name give both counts.
- **One working mark.** Anything running (sidebar rows, project rows, the top
  bar status, the transcript's running digest) uses `PixelWorkingMark`, the
  dot-matrix comet in the status ink that holds still under reduced motion.
  Owner decision (2026-11-18): never a spinning ring or a second spinner
  style.
- **The composer bar keeps its original two-row layout** (owner decision,
  2026-11-18): provider, model and the always-visible reasoning slider (with
  its Fast badge) on the first row; Access, "Sub-agents: N" and Attach on the
  left of the second, voice, schedule and send on the right. The effort slider
  is never hidden behind a chip or pop-up. Narrow columns use the stacked
  layout the bar has always had (provider and model share a row, the slider
  goes under them); there is no extra compaction. Accessible names start
  with the visible words ("Ask to act, access"; "Steer: …"; "Queue: …").
- A Settings pane longer than about two screens gets a sticky "On this page"
  index of its section names (`SettingsJumpList`). It reads as an anchor strip,
  not tabs (every section stays on the page): the section filling most of the
  view is underlined in the accent, and a jump moves focus to the chosen
  heading and marks it briefly. Section-level actions ("Create preset",
  "Add model") sit at the right of the section heading.

## Naming

- **Tools** (owner decision, 2026-11-18) is the right-hand panel (⌘B) with
  Changes, Git, Checkpoints, Worktree, Files, Terminal, Actions, Sub-agents,
  Usage, and Skills & MCP. Never call it "Workspace": in the sidebar a
  workspace is a project or Chats. Labels and paths say "Tools"
  ("Show Tools", "Tools → Actions"); running prose may say "the Tools
  panel". Settings groups Projects, Workflows and Scheduled tasks under
  "Projects & automation". Ids and storage keys (`studio*`,
  `kiwi.studioTab`, `toggleWorkspace`) keep their old names.
- "Tools" means only that panel. The Settings pane for MCP servers and
  language tools is **"MCP & language servers"** (owner decision, round 7;
  its pane id stays `tools`, and native messages quote "Settings > MCP &
  language servers > Language tools"); its section about the open thread is
  "In this thread". Agent tools are named for what they are ("MCP servers
  and skills follow this thread's access setting"), never just "tools".
- The palette's Tools entries take their names and icons from the rail
  (`studioTabMeta.ts`), as its Settings results do from `settingsPaneIcons.ts`.
  Links into the panel use the tab's own name ("Files", "Changes").
- **Ellipsis rule.** A command label ends in "…" only when choosing it asks
  for more input before anything happens ("Commit…" asks for a message,
  "Switch or create branch…" for a name). Labels that go to a control or run
  directly match that control's own words ("Fetch", "Pull", "Push").
- A Settings pane has one icon (`settingsPaneIcons.ts`), used by the Settings
  rail and by the palette's Settings results alike.
- An empty section has one next action, inside its empty state (not repeated
  as a header button and a "choose … below" sentence).

- **Provider** = the company whose models and account it is: "OpenAI",
  "Claude" / "Anthropic", "Cursor", "OpenRouter", "LM Studio". Use it for
  pickers, usage ("OpenAI usage"), instructions layers and thread labels.
- **Runtime** = the program Mythra Code drives: "Codex CLI", "Claude Code",
  "Cursor Agent". Use it only where that program itself is meant: install,
  update, version, disconnects, its own sub-agents and saved approval rules.
  Never bare "Codex" for either.
- **Account** = "ChatGPT account" / "Sign in with ChatGPT" only where the
  sign-in literally is a ChatGPT account or plan.

## Motion

- Use `--lm-d-1` / `--lm-d-2` with `--lm-ease-out`.
- Entrances travel at most 3–6px.
- No bounce, overshoot, hover lift (`translateY`), press shrink, stagger
  cascades or infinite decorative loops. Spinners and live-status indicators
  are allowed.
- Every animation stays inside `@media (prefers-reduced-motion: no-preference)`.
- Expanding panels use `SmoothDisclosure` (`src/components/SmoothDisclosure.tsx`):
  height eases 0fr → 1fr over `--lm-d-3` with `--lm-ease-out`, the content
  fades and settles 4px, the chevron turns over the same 240ms, and closing
  plays the same way before the panel is hidden (inert while it leaves).
  First used by Settings → Models & accounts.

## Custom themes

Owner decision (2026-11-18): people can design their own themes, usually by
asking a model in any chat or through Settings → Appearance → Custom themes →
"Design a theme with AI". A custom theme is the user's own choice, so it may go
past this document's restraint rules: glows, gradients, coloured shadows and
continuous animation are allowed **inside a custom theme**, within the effect
library's caps (`src/lib/customThemes/effects.ts`) and the customCss
sanitizer (`sanitizeCss.ts`).

What stays the same:

- The six built-in themes and all app chrome follow the rules above. The
  Custom themes section in Settings is itself Pro UI: neutral selection,
  hairline rows, tokens only. Only the mini previews show a theme's own look.
- Readability is enforced, not suggested: every ink is checked against every
  surface it sits on (4.5:1 for text), and inks are nudged or the theme is
  refused. Effects never sit behind panels, menus, fields or code.
- Motion: no bounce, overshoot, hover lift or press shrink; entrances move at
  most 6px; nothing flashes faster than 3 times a second. All theme motion
  stops for `prefers-reduced-motion`, the "Theme animations" switch, a theme's
  own switch, and (by default) while the window is in the background.
- `PixelWorkingMark` stays the one working mark, and status words are never
  hidden or recoloured into the accent.
- Escape hatches always work, whatever a theme does: ⌘⌥⇧T (Ctrl+Alt+Shift+T),
  the palette's "Reset to default theme", the tray's "Use default theme", and
  safe mode (a theme that breaks a launch or a view is switched off and the
  user is told why).
- Models can create, adjust, undo and apply themes. Only the user can delete
  one, in Settings, with a confirmation and a short Undo.
