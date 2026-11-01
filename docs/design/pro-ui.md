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
| Fields | 28–30px | `--field` with a `--line` border. Focus: `--green-line` border plus `--ring`. |
| Segmented control | — | Recessed `--lm-press` track (2px padding). The selected segment is raised: `--panel-3` in dark themes, `#fff` in light ones, with a hairline shadow. |
| Switches and checkboxes | — | Accent fill when on. |

Fields and segmented controls use a 6–7px radius.

Selection in lists is a neutral `--lm-press` fill. The accent marks only the
row's icon, a check or a small dot. Don't use accent outlines, accent bars or
tinted gradient cards to show selection. A selected choice card (for example
a theme tile) can use a 1px `--green` border plus `0 0 0 1px var(--green)`.

## Colour

- The accent goes on primary actions, focus, selection marks, links and small
  status details. It never goes on large surfaces.
- Status colours (`--green`, `--orange` / `--amber`, `--red`, `--info`) show
  up as ink or as a faint tint (8–14% alpha), not as solid blocks.
- Never add glows, coloured shadows, text-shadows or gradient text.

## Elevation

Menus, popovers and sheets use `--menu-surface` with `--lm-pop-shadow`, which
already includes the hairline edge. Panes and cards are flat: no shadow
beyond `--elev-1`.

## Motion

- Use `--lm-d-1` / `--lm-d-2` with `--lm-ease-out`.
- Entrances travel at most 3–6px.
- No bounce, overshoot, hover lift (`translateY`), press shrink, stagger
  cascades or infinite decorative loops. Spinners and live-status indicators
  are allowed.
- Every animation stays inside `@media (prefers-reduced-motion: no-preference)`.
