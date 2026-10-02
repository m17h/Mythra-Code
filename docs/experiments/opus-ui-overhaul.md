# Opus UI overhaul experiment: "Lumen"

Status: **PR #122 open; review repairs complete, final verification in progress.**
This is an unmerged UI experiment on
`codex/opus-ui-overhaul-experiment` (base `be7fc1b`). Morgan authorized committing,
pushing and creating a PR on 2026-10-02, but not merging or releasing. Earlier
uncommitted/unpushed statements below describe the state at those checkpoints.
No version change or release is part of this experiment.

## PR review (2026-10-02)

- Initial implementation commit: `fbc2755`; proposed merge:
  <https://github.com/m17h/Mythra-Code/pull/122>. No merge is authorized yet.
- Five GPT-6.1-Sol reviewers checked sub-agent state, Settings/onboarding,
  CSS/accessibility, animations/compatibility and test integrity. Codex reviewed
  their repairs independently. The implementation's earlier Opus passes are
  recorded below; no new Opus pass was needed for this review.
- Confirmed defects repaired with focused regressions:
  - Settings chooser columns overflowed at short windows and enlarged scale;
    columns now respond to the pane's available width.
  - Comet's unsupported `color-mix()` values invalidated its rail; plain-color
    fallbacks keep it visible without removing modern colors or motion.
  - Header actions overlapped without container-query support; a wrapping,
    named-icon fallback retains the controls.
  - Transforming an entire inbox row displaced its viewport-positioned menu;
    the same entrance animation now belongs to the card, not the menu's ancestor.
  - Usage day cards assumed a fixed containing block that WebKit did not
    establish; explicit layout containment makes placement consistent.
  - Settings dropdowns remained clipped without Popover support; dialog-local
    portals preserve keyboard focus and theme inheritance. Generic shell menus
    use viewport-fixed placement; scrolled dialogs account for their own offsets.
    Independent review caught both generic zoom offsets and the dialog-scroll
    omission before the final source was frozen.
  - Full WebKit verification then exposed a menu-opening focus race and normal
    Tab escaping Settings. Initial focus is now cancelled on close and respects
    deliberate focus; explicit popup Tab order retains search, favorite stars
    and Show all, then exits to the surrounding dialog at the boundary. The
    shared modal trap was not changed, and already-handled events remain owned
    by their handler. Four actual-App cases cover both API paths at 100%/150%.
- The initial hosted run failed. Cold-cache reproduction identified a browser
  test optimizer reload caused by the dynamically discovered Tauri window API.
  It is explicitly preloaded, rather than hiding failing tests or adding retries.
  macOS/Windows Rust and all four unit shards passed that initial run; repaired
  renderer code still requires a fresh complete gate on the final PR input.
- Native macOS evidence: the isolated experiment app was visually inspected;
  account selection remained separate from the default provider, and the modern
  default-provider and scale popups appeared above neighboring cards. Native
  Tab/Shift+Tab moved between provider choices without selecting; Escape
  refocused the trigger. Cancel restored
  preferences. No real provider turns or official-app data changes were needed.
  Browser tests use isolated fixtures/stubbed IPC; current WebKit/Chromium with
  APIs disabled are not actual Safari 13/Chrome 105 or Windows desktop evidence.
- Focused repair evidence: Settings containment 5/5 per engine; Comet 14/14
  per engine, logo/Lumen 56/56 per engine; no-container header 4/4 per engine;
  strengthened calendar placement passed WebKit; row-menu anchoring passed
  Chromium; final select/focus regressions 17/17 per engine; focused select/modal
  unit tests 19/19. Full cold Chromium initially passed all 629 tests across
  62 files, proving the optimizer repair; subsequent full WebKit passed 628
  and caught the focus failure described above, also reproduced by hosted CI.
  The corrected browser inventory now contains 633 cases.
  TypeScript, lint, production renderer build, Chromium/WebKit emitted startup,
  lazy Settings and reload, and the performance scorecard pass. Growth remains
  report-only; the existing 500 kB chunk warning is informational, not a new
  suppressed test failure. Full cold Chromium, combined WebKit and the fresh
  hosted gate are being checked next. See PR #122 for their final results rather
  than treating this checkpoint document as merge authorization.

## Latest feedback pass (2026-10-02)

### Normal-chat folder actions

- Normal chat inbox menus no longer offer Open folder. The action remains in
  project-thread menus (including isolated worktree resolution) and both pinned
  and unpinned project menus.
- A browser regression reproduced the old unwanted action, then passed for
  pinned and unpinned normal chats in Chromium and WebKit. Five focused browser
  cases per engine, six existing folder integration cases, TypeScript, affected
  ESLint and diff whitespace checks passed. Browser IPC is stubbed; no real
  folders, provider requests or user data were changed.

### New threads require their own sub-agent opt-in

- Fresh drafts always start with spawning off, even if saved app/project
  defaults are enabled. Users enable spawning in that thread's composer.
  The explicit boolean is saved per conversation in native durable storage;
  reopening that conversation preserves its choice. Preexisting conversations
  without a local record retain their previous shared-setting behavior.
- Saved configured agents, provider/model choices and concurrency limits remain
  reusable. Only the spawning switch becomes thread-local. Captured crews still
  stage roster changes locally rather than rewriting defaults.
- New Thread, workspace switches and actual provider handoffs reset the draft.
  Changing providers for the same unsent draft retains its deliberate opt-in.
  Forks and fresh scheduled/workflow threads record off immediately, including
  paths where later preparation fails. Existing child-depth restrictions remain.
- Two GPT-6.1-Sol agents implemented and independently reviewed this behavior,
  with Codex conducting an additional source review and real-renderer acceptance.
  Review caught loss of composer-configured agents in an initial full-policy
  approach, captured-roster leakage into defaults, failed-selection draft
  inheritance, and an unnecessary reset on unsent provider selection. The final
  implementation uses a small per-thread boolean map and guards prototype-like
  IDs. Settings and proposal approval copy explain the scope.
- Verification: 300 affected helper/hook/storage tests, ten composer integration
  cases and eleven related Settings cases passed; the independent reviewer also
  confirmed the ten integration cases. Nine actual-App browser regressions
  passed in both Chromium and WebKit across all five providers, including roster
  retention and app/project enabled-default cases. Browser IPC is stubbed;
  these are renderer checks, not live model requests.
- Native acceptance in the isolated Mac dev app: enabling an unsent Chats draft,
  closing the controls and clicking New Thread visibly returned Sub-agents to
  off. No real model turn or official-app data change was needed. The experiment
  remains uncommitted and unpushed.

This section supersedes the historical descriptions of gradient controls,
logo halos, context eyebrows, radio dots and composer hairlines below.

### Comet replaces Filament (current)

- Morgan chose **01 Comet** from the supplied concept sheet. Opus 5.5 read
  the actual image and implemented that panel: slim ice-blue trail, three
  moving streaks and a white rounded-square thumb, with a neutral unfilled
  rail. Two transform-only streak layers flow continuously toward the thumb.
  Max is modestly faster and brighter than High. No new dependency or JS
  animation loop was added.
- Saved global and project `dart` and `filament` values now migrate to
  `comet`; unknown project styles are still discarded. Other styles and the
  Aurora default are unchanged. Settings and onboarding use the shared catalog.
- Codex independently reviewed the source and updated focused regressions:
  **138 unit tests**, **119 Chromium browser tests**, and **18 focused WebKit
  tests passed**. These cover both rail variants, theme contrast at every
  effort level across all eight themes, clipping/head geometry, disabled and
  empty states, reduced motion, settings/onboarding, and actual-App legacy
  migrations. The first browser run exposed stale Filament expectations;
  assertions now test Comet's deliberately lighter text and clipped streak
  layers instead. No assertions were relaxed to accept low contrast.
- `npm run build`, targeted ESLint and `git diff --check` passed. The existing
  informational 500 kB chunk warning remains. No full release/merge gate was
  run for this local experiment.
- **Native evidence:** the isolated Mac Tauri dev app (not a browser fixture)
  was exercised on Mythra and Atari. Native keyboard navigation selected High
  and Max, and pointer dragging returned Max to High. Two nine-second window
  recordings show continuous motion at both levels; extracted frames were
  inspected and cropped-rail frame hashes changed over time.
- An 18.27-second, 30 fps H.264 close-up was sent to Morgan on Telegram:
  High first, then Max. Telegram confirmed delivery (`ok: true`, message 544).
  The isolated dev app is left on Mythra with Comet at High. The official app
  and its user data were not modified. No real provider request was required;
  this verifies the UI, not model inference or performance profiling.
- Work remains uncommitted and unpushed on the experimental branch.

### Dart replaced with Filament (historical; superseded above)

- Opus 5.5 designed and implemented a new `filament` effort-slider style:
  neutral recessed groove, copper-to-amber filament, rounded-square cap and
  a softly drawing current. Dart's arrow, wedge, palette and animation are
  removed. The Settings swatch animates the same visual language.
- Motion uses CSS transform/opacity, not a new JavaScript loop. The current
  stays inside the filled length and hides while empty, dragging or disabled.
  Reduced motion stops both the real slider and its Settings swatch.
- Saved global and project `dart` selections migrate to Filament. Other
  styles and the Aurora default stay unchanged. Codex added the project
  migration path and regression coverage independently.
- Independent review caught insufficient small-text contrast at low effort
  on Mythra/Kiwi (4.07:1). Opus brightened the lowest copper step; rendered
  contrast now passes 4.5:1 on panel surfaces at every level of all eight
  themes. The normal composer controls use darker field surfaces in dark
  themes. Existing selector/card tests were updated to the new intended style.
- Final checks: 137 focused unit tests; 118 Chromium tests across model
  controls, actual App and onboarding; 17 focused WebKit tests (91 unrelated
  tests filtered out); TypeScript/production renderer build; affected-file
  ESLint and diff whitespace check passed. The build retains its existing
  informational 500 kB chunk warning.
- Native evidence: isolated Mac dev app Settings swatch and composer were
  visually inspected in Mythra and Atari; pointer drag reached Maximum,
  keyboard Left reached Extra high and Home/Right returned to Medium. The
  test profile's original Mythra/Aurora preferences were restored afterward.
  No model requests/authentication or official app data were touched. The
  final low-step color adjustment was verified in Chromium/WebKit; no Windows
  native or release build is claimed. Work remains uncommitted/unpushed.

### Rounded-square outlines

#### Clipped-corner follow-up

- Morgan's photo was reproduced in the native Mac dev app: the outer typeface
  and effort-style cards lost their curved border segments. Lumen's stronger
  `.set-card` rule accidentally restored a 20px radius to bare grid wrappers,
  which still inherited `overflow: hidden`. Their own tighter card curves
  were painted underneath an invisible rounded clip.
- Opus reset only `.set-card.bare` to zero wrapper radius and visible overflow.
  Theme, typeface, effort-style and provider-mark cards retain their own
  rounded corners, hover/selection treatments and animation. Ordinary joined
  Settings cards still have rounded clipped surfaces; the outer content pane
  remains responsible for scrolling. No application logic or preferences
  changed.
- Codex independently reviewed the narrow CSS edit, visually verified complete
  curves in native macOS, and added actual-App regressions across Mythra/Atari,
  100%/150% scale and a 700px single-column window. The old CSS is replayed to
  establish the clipped-corner geometry, then all four outer card corners are
  checked for pointer reachability and font selection/Cancel remains working.
  WebKit does not consistently exclude rounded overflow corners in hit testing,
  despite native paint clipping, so old-state evidence uses clip geometry
  rather than assuming that engine's hit testing proves visual correctness.
- Final focused Chromium run: 60 passed (actual-App plus Settings motion).
  Focused WebKit: 12 passed, 33 excluded by name filter. Browser IPC/storage
  are isolated fixtures, while before/after native images use the dev wrapper.
  Production renderer build, typecheck, focused lint and whitespace checks
  pass. The experiment remains uncommitted and unpushed.

#### Original shape pass

- At Morgan's request, Opus replaced capsule control outlines across the
  experimental shell with 10px rounded-rectangle controls and 6px small tags.
  Settings navigation/search/scale/footer, composer actions, header chips,
  workspace controls, onboarding and transcript actions share that language.
  Genuine status dots, avatars, toggle/slider knobs and thin progress tracks
  remain round. Only CSS geometry/comments changed; palettes, logo, layout,
  functionality and motion were preserved.
- Codex reviewed the actual edits and remaining legacy capsule selectors,
  catching four missed Git filter/count/tag selectors. Opus supplied scoped
  overrides and correctly retained the 6px feedback status dot as a circle.
  A regression loads Git/feedback CSS after Lumen to exercise lazy-sheet order.
- The actual-App squircle regression failed on the old 999px thread switch
  radius before correction. Final focused Chromium run: 113 passed across
  actual-App, Lumen, onboarding and Settings motion. Focused WebKit: 19 passed
  (69 excluded by filter), including shape, composer focus/expanded controls,
  popup hit testing, scaled header layout and lazy Git styles. Browser IPC is
  stubbed; these are renderer checks, not real provider or Windows evidence.
- Native macOS dev verification showed rounded-square selected Settings rows,
  search/scale/footer controls and landing/composer/sidebar/header controls,
  with the scale popup fully above neighboring content. Opening the Git dock
  retained usable header layout and the new shapes. Menus were dismissed and
  the dock restored closed without changing settings, accounts or Git data.
- Typecheck/production renderer build, focused lint and diff whitespace checks
  pass. No commits, pushes, releases or version changes were made.

### Settings controls and onboarding follow-up

- Codex reproduced the default model popup being clipped inside Lumen's
  Settings card. The default provider/model pair and Interface size selector
  now use the existing top-layer popup path, retaining theme inheritance,
  keyboard navigation, viewport placement and UI-scale compensation.
- Models & accounts separates account browsing from buffered defaults.
  Provider cards only choose which credentials to manage; the paired default
  provider/model selectors choose the startup settings for new threads.
  Existing threads, onboarding drafts, provider catalogs and Save/Cancel are
  preserved. Switching providers resets the model menu's search state.
- An explicit onboarding theme selection immediately saves the app-wide theme
  and updates the whole renderer. Fonts and effort-slider styles still preview
  locally until saved in Settings; copy now explains that distinction. During
  the tour, global theme selection takes precedence over project appearance;
  existing project-specific overrides are not overwritten and resume on exit.
- Native macOS verified account browsing without changing defaults, a complete
  model menu over neighboring cards, and Atari applied to the app behind the
  onboarding sheet and retained on exit/reopening Settings. Test-only default
  edits were discarded and the original Mythra theme restored. No accounts,
  real prompts, Git state or official app data were changed.
  The native Interface size menu was also visually verified fully above the
  adjacent typeface controls, then dismissed with Escape without changing scale.
- Focused unit/integration run: 121 passed (230 excluded by name filter).
  Actual-App + onboarding + Lumen browser run: 92 passed in Chromium. The
  focused WebKit run passed 14, including menus at 100%/150% and the project
  override case. Two later Interface size regressions passed in each engine,
  checking real hit testing, scale selection and restoration on cancellation.
  These browser checks stub IPC and use isolated browser storage, not real
  native provider evidence. Typecheck, lint and production renderer build pass.

### Earlier corrections

- Opus restored a neutral New thread button and simple line icons in the
  left navigator, matching the installed official app's restraint. Morgan
  explicitly approved the new icons; they were preserved in subsequent passes.
- Opus reduced container washes and clashing accents across the other themes,
  used coherent tonal logo palettes, and preserved Mythra's original cyan/blue
  mark. The logo's original geometry and interaction animation are unchanged.
- The redundant project/normal-chat eyebrow beneath the logo is removed.
- The corner selection circles on Shared project / Isolated worktree are gone.
  Codex added `aria-pressed` to both buttons so selection is also announced to
  screen readers; draft isolation behavior is unchanged.
- Codex synchronized theme-preview swatches with Opus's actual CSS palettes,
  with eight theme-specific browser regressions.
- Opus removed the focused composer's decorative 2px gradient top line and its
  choreography, retaining ordinary focus and each control's keyboard outline.
- Opus removed the workspace tab tile's extra left stripe (`::after`), keeping
  the sliding selected tile, border, icon accent and keyboard navigation.
- At Morgan's explicit request, Codex increased the standard Settings sheet
  from 720px to 760px: 20px above and below the same center. Usage stays 880px;
  short windows still clamp to available space and keep scrollable navigation.
- Codex added Open folder to both pinned and unpinned project row menus using
  the existing cross-platform `open_workspace_folder` command. It targets that
  project's root, not the selected thread's isolated worktree, and does not
  select/resume a thread or change the active workspace. Native failures remain
  visible through the existing error path. Thread folder behavior is preserved.

### Independent evidence for the latest pass

- Before the neutral-button fix, all eight quiet-button regressions failed.
  Before adding the project action, both new integration regressions failed on
  the absent menu item. Before the taller sheet, actual Settings navigation had
  628px of content in 604px of space. Before removing the workspace stripe, its
  new pseudo-element regression failed. Those behaviors were replayed after fix.
- Six project/thread folder integration tests passed. Actual-App browser tests
  cover pinned/unpinned menus while Chats stays selected, native errors, and
  unchanged Windows path passing (this is not Windows native Explorer evidence).
- Native macOS dev app: Open folder opened Finder **inside** the exact experiment
  project directory; the menu dismissed without changing workspace. Switched
  the empty draft Claude → Cursor → Claude without sending a prompt and visually
  verified the bright composer line absent. Selected Git retains its tile and
  icon accent with no left stripe. All Settings categories including Updates
  fit at the current roomy window size, without scrolling the category list.
- Native selection-card checks verified pressed state switching and removal of
  both radio dots, then restored Shared project. No worktree or turn was created.
- Fixture galleries were reviewed for Atari landing, Synthwave conversation
  and Light Mythra Settings. These are synthetic content, not native/provider
  evidence; real-App tests use a stubbed IPC bridge and isolated browser storage.
- Typecheck, renderer lint and production build passed. Production startup,
  lazy Settings and reload were exercised in Chromium and modern WebKit.
- Final actual-App regressions: 32 passed in Chromium and 32 in WebKit;
  Settings motion regressions: 15 passed in each engine, including the
  experiment's 760px sheet expanding to Usage and returning smoothly without
  moving its center. The prior six-file WebKit run's only five failures were
  the keyboard-modality harness issue below, fixed and replayed independently.
- Final complete Chromium renderer run: 60 files / 577 tests passed. The
  focused integration selection passed eight tests (remaining tests excluded
  by the targeted name filter, not treated as a full unit-suite run).
- The browser harness needed two corrections: wait for the existing menu/error
  entrance rather than asserting opacity on the first frame, and use a real
  keyboard Tab to test `:focus-visible` after real pointer input. No assertions
  were relaxed to accommodate invisible controls or missing focus outlines.
- No release checks, real provider prompts, native Windows interaction or
  Safari 13 runtime claims are made. The native wrapper uses a separate test
  profile; the official installed app and main checkout remain unchanged.

## Correction pass (Morgan's feedback on real renderer screenshots)

Everything below was driven by Morgan's screenshots and Codex's replay
audits. The rest of the Lumen design (layout, motion, Atari) is kept.

### 1. Mythra palette: dark gray with light-blue accents

- **Feedback:** "I want the Mythra theme to feel like it has with the dark gray
  and the light blue accents."
- **Diagnosis:** Lumen gave Mythra navy surfaces, an indigo second accent,
  gradient headings and accent washes on every container.
- **Fix** (a Mythra-only block in `tokens.css`; other themes are untouched):
  - surfaces, lines and ink return to the legacy `styles.css` Mythra palette
    (`#1e2024` / `#22252a` / `#292d32` / `#30353b`);
  - the canvas is a darker neutral (`#16181b`);
  - the accent is `#64ddf2`, and the second accent is a near-cyan rather than
    indigo;
  - headings and the wordmark render as plain text (no gradient);
  - code slabs are neutral (`#1a1c20`);
  - user bubbles have a neutral edge.
- **Two new tokens** keep this scoped:
  - `--lm-wash` covers container washes (sidebar, dock, stage tops, notes,
    stat tiles, bubbles, code strips). It is transparent in Mythra and the
    accent tint elsewhere.
  - `--lm-accent-glow` covers accent-coloured shadows. It is faint in Mythra
    and the accent elsewhere.
- The light-blue accent remains on primary actions, selection and focus.
- The Mythra preview swatch in `appConfig.ts` now matches:
  `#16181b / #292d32 / #64ddf2`.

### 2. Logo rings removed

- **Feedback:** the circles behind the new-thread logo looked like a bug.
- **Fix:** the `landing-hero` wrapper, the `landing-halo` element, its CSS, its
  `lm-halo-in` keyframes and all fixture uses are gone. The logo is again a
  direct child of the landing, followed by the workspace eyebrow, with no
  placeholder gap.
- **Checks:**
  - in the real App (`App.header.browser.test.tsx`), the logo is present and no
    halo exists;
  - in the Lumen spec, there is no backdrop and the eyebrow sits within 12px of
    the logo.

### 3. Header overlap when the workspace dock opens

- **Reported:** Morgan's 1500×1000 Atari screenshot. Codex's renderer audit
  found:
  - 1500px / 100% with the dock open: Run edit over Search by 12px;
  - 1500px / 125% with the dock closed: Run over Search by 58px;
  - 1500px / 150% with the dock open (chat column 415px): Run and edit over the
    usage chip.
- **Diagnosis:** Lumen's chips and instrument tray are wider than legacy's.
  Lumen's higher-specificity selectors left nothing on the left able to shrink.
  The project name collapsed to zero width and the chips ran under the tray.
  Below 1250px the legacy overlay dock also covered the header.
- **Fix** (`stage.css` header ladder, driven by the real `chat-main` column
  width, not the window width):
  - the left group may shrink; the project name gives way first, to a 64px
    minimum, with ellipsis;
  - progressive steps at 1080, 960, 860, 760 and 600px hide kbd hints, status
    text and labels;
  - controls become 30px icon buttons and keep their `aria-label`/`title`;
  - Search and export stay reachable at every width (legacy hid them below
    720px);
  - at 400px or less, the tray wraps to its own row instead of overlapping;
  - in `responsive.css`, the ≤1250px overlay dock now starts below the header,
    and the header sits above it, so the header is never covered.
- **Regression:** `src/App.header.browser.test.tsx` renders the **real `<App />`**
  with the Tauri bridge stubbed. It uses browser localStorage only, cleared
  after each test, and makes no provider requests. It checks:
  - every header control has an accessible name, sits inside the header, has a
    hit area of at least 24px, and is the element hit at its centre;
  - the left group never intersects the tray;
  - no two buttons overlap by more than 2px (the audit's own test);
  - the project name stays at least 48px wide.

  Scenarios:
  - Atari and Mythra at 100%, 125% and 150%, with the dock opened and the
    navigator hidden;
  - a long project name at 1250, 1180 and 980px;
  - a widened navigator and dock;
  - the audit's exact matrix: 1500, 1380, 1180 and 980px at 100%, and 1500px at
    125% and 150%, with a Claude provider, a long pinned project, and the dock
    closed and open.
- **Proof that it fails before the fix:** with the Lumen header ladder disabled,
  8 of 14 cases failed. They included the audit's three reported cases, with
  measured overlaps of 15px (1500/100, dock open), 47px (1500/125, dock closed)
  and 24px (1500/150, dock open). With the ladder restored, all pass.

### 4. Composer provider and model controls match

- **Feedback:** the provider button outline looked odd next to the model button.
- **Diagnosis:** the provider trigger is
  `class="provider-pill openrouter-trigger"`. Legacy let the later
  `.openrouter-trigger` rule win (a 46px rounded rectangle, like every model
  trigger), but Lumen gave `.provider-pill` a 30px pill.
- **Fix:** one field-control recipe in `composer.css` for the provider pill and
  every model trigger (OpenAI's `.model-picker-trigger`, plus
  Claude/OpenRouter/Cursor/LM Studio `.openrouter-trigger`). All of them share:
  - the same height, radius, border and fill;
  - a hover fill;
  - an expanded state with an accent edge and ring;
  - one focus outline that follows the corners;
  - a disabled opacity;
  - a dashed sign-in-required state.

  Provider logos are not recoloured.
- **Checks:**
  - **Real App**, for Claude (signed in and signed out), OpenAI, Cursor,
    OpenRouter and LM Studio across Mythra, Atari and Light Kiwi:
    - idle geometry and fill are equal;
    - wrapper elements draw no border or shadow (no nested outlines);
    - hover, keyboard focus and expanded states match;
    - when signed out, the trigger is dashed and the sign-in toast appears.
  - **Disabled state:** covered with the real controls in `LumenShell` (Mythra,
    Atari, Light Kiwi).
  - **Before the fix:** with the old rule restored, all 6 real-App cases failed
    (provider 30px against model 46px).

### 5. Theme-aware Mythra logo throughout the app

- **Request:** Morgan asked for the Mythra logo to match the active theme. This
  supersedes the earlier byte-identical logo constraint, for colour wiring only.
- **Animated logo** (`AnimatedMythraLogo.tsx/.css`):
  - only the gradient stops gained classes, and the caret fill reads
    `--mythra-mark-caret`;
  - geometry, assembly, idle, hover, click and keyboard behaviour,
    reduced-motion handling, visibility pausing, unique ids and accessibility
    are unchanged;
  - its existing browser tests pass.
- **New shared colour sheet:** `MythraMarkColors.css` sets each stop's
  `stop-color` to `var(--mythra-mark-*, <brand hex>)`. The `stop-color`
  attribute remains a second fallback.
- **New static mark:** `MythraMark.tsx`, an inline SVG with the exact geometry
  of `public/mythra-code-glyph.svg` and instance-unique ids. It replaces the
  `<img>` in:
  - the sidebar brand tile, now a neutral theme surface;
  - the onboarding header glyph;
  - the onboarding welcome glyph, now a neutral tile instead of an accent fill.
- **Per-theme palettes** in `tokens.css` reach the marks through live CSS
  inheritance from the shell, so app, project and preview themes apply with no
  React state:
  - Mythra keeps the brand colours;
  - every other theme has its own palette (Atari brick and amber, Monochrome
    white and steel, and so on);
  - no filters or hue rotation are used.
- **Not changed:** native Dock/tray/installer assets and the SVG files on disk.
- **Checks:**
  - the brand fallback applies outside a shell;
  - the animated and static marks match inside a shell;
  - changing `data-theme` live recolours existing marks without a render;
  - gradient ids are unique;
  - all 8 palettes are distinct;
  - outer pieces reach at least 3:1 and centre/fold at least 2.5:1 against
    `--bg` in all 8 themes (Mythra's original brand fold is about 2.8:1 and is
    kept);
  - in the real App, the brand mark and landing logo use Atari's brick in Atari
    and the brand cyan in Mythra.

### 6. Onboarding provider tiles: logo and name only

- **Feedback:** the second line under each tile was redundant (for example
  "ChatGPT / ChatGPT plan" and "OpenRouter / API credits").
- **Fix:**
  - the visible `.ob-tile-kind` line is removed, along with its CSS;
  - readiness is now a small corner dot (`.ob-tile-status`): hollow until the
    provider is ready, then filled with the accent and a soft ring;
  - the kind and status remain in each tile's accessible description, the live
    status line and the selected provider's panel (instructions, Models &
    accounts, Setup guide);
  - keyboard selection is unchanged.
- **Checks:**
  - Codex's jsdom regression "shows only provider names on the tiles without
    redundant subtitles" passes (13/13 onboarding jsdom tests);
  - a new real-browser check in `LumenShell` (Mythra at 1400×900, Atari at
    760×560) confirms:
    - five tiles, each with a single name line;
    - the dot sits inside the tile, clear of the logo and name;
    - only the ready provider's dot is filled;
    - the description still says "API credits";
    - arrow keys move the selection;
    - the panel follows the selection;
  - screenshots are in `test-results/lumen/onboarding-tiles-*.png`.

### Test infrastructure corrections

- **Stylesheet order:** `src/test/browser-setup.ts` now imports `styles.css`
  and then Lumen, matching `main.tsx`. Before, Lumen loaded first, so legacy
  keyframes won in tests but Lumen's won in production. The corrected order
  exposed two real production regressions in Lumen's re-choreographed
  keyframes, both now fixed in `motion.css`:
  - `sa-select-pop` faded select menus in from opacity 0; legacy is
    transform-only, so menus are visible from the first frame;
  - `update-notice-arrive` travelled 14px and briefly rose over the header; it
    now uses legacy's 6px.
- **Fresh App per scenario:** browser mode does not re-evaluate modules after
  `vi.resetModules()`, so the real-App spec imports `App.tsx?header-case=N`.
- **Stable first run:** `vitest.browser.config.ts` pre-bundles
  `@tauri-apps/api/webview`, `@tauri-apps/plugin-notification` and
  `@testing-library/user-event`, so the first run doesn't reload mid-test.

### Evidence for this pass

- Full Chromium browser suite: **60 files / 529 tests pass**. This was run
  after the logo, composer and header work, before the onboarding-tile change.
- After the onboarding-tile change:
  - `OnboardingModal.browser` + `LumenShell.browser`: 40 tests pass;
  - `OnboardingModal.test` (jsdom): 13 tests pass;
  - `npm run check:types`: pass;
  - ESLint on the changed files: pass.
- WebKit (Playwright's WebKit, **not** Safari 13):
  `env MYTHRA_BROWSER_TEST_ENGINE=webkit npm run test:browser -- <8 focused files>`
  passed 8 files / 91 tests. The files were the real-App header/composer spec,
  LumenShell, AnimatedMythraLogo, ThemeToggle, ThemePalette, AppSelectMenu,
  UpdateNotice and OnboardingModal. This was run before the onboarding-tile
  change.
- **Not re-run in this pass:**
  - the full jsdom suite and repo-wide lint (Codex interrupted the CLI pass
    to deliver Morgan's additional onboarding request);
  - the WebKit lane after the onboarding-tile change;
  - native/Tauri runs and the full `npm run verify`.

  The independent Codex checks below supersede overlapping gaps in this list.

### Independent Codex verification after the onboarding correction

- Onboarding unit regression: 13 tests pass, including the check that failed
  before Opus removed the duplicate visible text.
- Final full Chromium browser suite: 60 files / 531 tests pass.
- Final focused WebKit suite: 4 files / 69 tests pass (actual-App header and
  composer, LumenShell with onboarding tiles and all theme palettes, animated
  logo interaction/motion, and onboarding keyboard/layout checks).
- Type check, repository renderer lint, production renderer build and
  Chromium production startup / lazy Settings / reload: pass.
- Native macOS evidence: the separate `Mythra Code UI Experiment` dev host
  rendered the logo in Atari's brick/amber colors and Monochrome's white/gray
  colors, in both sidebar and new-thread branding. Provider/model outlines
  matched. Earlier native workspace-open verification showed the corrected
  header and no decorative logo rings. This is a native dev build, not a signed
  release. It uses a separate test profile; the installed release and its
  saved threads were not modified.
- The final onboarding tile rendering was reviewed in browser fixtures;
  native onboarding interactions were not completed because Morgan was using
  the dev app. Browser rendering does not prove native authentication behavior.
- Full jsdom, hosted Windows, actual Safari 13 and exhaustive native workflow
  verification remain outside this correction pass. No claim of merge or
  release readiness is made, and no commits or pushes were performed.

## First-pass design record (historical)

The sections below preserve the original pass for comparison. Where they
mention logo halos, blue-heavy Mythra surfaces, stylesheet order, or missing
WebKit/native evidence, the correction-pass sections above supersede them.

### Design direction: Lumen, floating instruments on a lit canvas

The current app is a flat, hairline-bordered three-column layout: sidebar, chat
and dock sit edge to edge on one ground. Lumen changes the spatial model, not
just the tint.

1. **Canvas and islands.** The window is a deep canvas lit by a static,
   theme-tinted aurora. The aurora is painted once and never animated. The
   navigator (sidebar), stage (chat) and workbench (dock) float on it as
   separate rounded islands, with gutters between them.
2. **A two-tone accent.** Every theme gains `--accent-2`. These elements are
   gradient-lit (`--green → --accent-2`) over a solid accent fallback:
   - primary actions, the new-thread capsule and the send orb;
   - active navigation and toggles;
   - progress, headings and the wordmark.
3. **Instrument typography.** Display headings are heavier and tightly tracked,
   with gradient clipping where supported. They pair with small mono uppercase
   *instrument labels* for captions, counts and kbd hints.
4. **Capsules and tiles.** Controls are pills. Choices are tiles. Lists are
   stacks of rounded tiles rather than hairline-divided rows.
5. **Conversation as a spine.**
   - User turns are lit bubbles on the right.
   - The assistant runs flush beside a round provider orb.
   - Tool, reasoning, approval and agent activity hang off a vertical spine as
     nodes.
   - Code renders as slabs with a header strip.
6. **Floating composer.** The composer is an elevated capsule with three lit
   states:
   - a gradient focus hairline that draws outward from the centre;
   - a halo ring;
   - a circular send orb.
   Permission, agent and attachment controls are chips, and the model rail sits
   inside the capsule as a recessed tray.
7. **The workbench mirrors the navigator.** The dock's tool rail moves to the
   window's outer right edge, with one sliding selection indicator. Below
   1250px the dock floats over the chat as an inset island, as legacy intends.

## Architecture and compatibility

Production targets are **Safari 13** (macOS) and **Chrome 105** (Windows); see
`vite.config.ts`. An early draft wrapped the legacy CSS in `@layer`, but it was
**abandoned before integration**. WebKit only gained cascade layers in Safari
15.4, so older engines would drop the wrapped structural CSS. What ships:

**Stylesheet structure**
- **Legacy CSS is untouched and unwrapped** (`git diff` on `src/styles.css` is
  empty). It still owns structure, positioning, overflow, sizes and
  behaviour-coupled motion.
- **Lumen is a separate stylesheet set**: `src/styles/lumen/*.css`, with entry
  file `index.css`. It is imported in `main.tsx` **after** `styles.css`.

**Uniform scope instead of layers**
- Every Lumen rule starts with `.app-shell[data-theme][data-color-scheme]`.
  App.tsx always sets both attributes.
- The (0,3,0) prefix beats legacy theme and light overrides, which are (0,2,0).
  It also beats lazily loaded component sheets (Settings, Git, Usage,
  Onboarding) regardless of load order. There is no `!important`.

**Restated legacy rules**
- The scope also out-ranks the legacy media and container queries, and some
  legacy variant rules.
- So `responsive.css` restates every breakpoint whose properties Lumen also
  sets:
  - width breakpoints: 1250 (dock overlay), 1180, 1000, 860, 760 (Settings pill
    strip) and 700 px;
  - the 720 px height breakpoint;
  - the `chat-main` 520 container query.
- Variant rules overridden by Lumen base rules are restated explicitly:
  - user message single column;
  - queued-turn failed/sending borders;
  - Git "nothing to commit" settled state;
  - relay failed state.

**Selector compatibility**
- Lumen selector lists contain no `:is()`, `:where()` or `:has()`.
- `:focus-visible` appears only in rules of its own, because Safari 13 drops a
  whole rule over one unknown selector.
- The production minifier keeps `:focus-visible` rules separate for safari13.
  This was verified in the emitted CSS.

**Value compatibility**
- Gradients use plain `var()` colour stops.
- Every gradient fill sits on a solid `--green` background-colour. Text is
  measured against a real colour, and engines without the gradient paint it.
- `color-mix()` tokens have plain baselines. Richer values apply only inside
  `@supports (color: color-mix(in srgb, red, blue))`.
- Gradient-clipped heading and wordmark text sits behind
  `@supports ((-webkit-background-clip:text) or (background-clip:text))`,
  with a solid default, so text can never go invisible.

**Progressive enhancements only.** Essential positioning never depends on
these:
- individual `scale`/`translate`: press feedback, and the entrances of
  elements whose `transform` is layout-owned (row menu, scroll-to-latest);
- `@container` restatements;
- `mask-image` on the decorative halo;
- `backdrop-filter` on scrims.

**Presentation-only markup**
- `App.tsx`: a landing hero wrapper and a decorative, `aria-hidden` halo around
  the unchanged `<AnimatedMythraLogo />`, plus a workspace eyebrow
  ("Project · name" / "Normal chat · no project folder").
- `StudioDock.tsx`: an `aria-hidden` sliding indicator span and a
  `--studio-tab-index` custom property on the tablist.
- Roles, labels, keyboard handling and handlers are unchanged.
- `appConfig.ts`: the display-only theme preview swatches were updated to the
  Lumen palettes. Ids, names and descriptions are unchanged, and nothing is
  persisted.
- `AnimatedMythraLogo.tsx/.css` were byte-identical in the first pass. In the
  correction pass, Morgan asked for the logo to follow the theme, which
  superseded that constraint for colour wiring only:
  - stop classes, the caret fill variable and the shared colours import were
    added;
  - geometry, motion and accessibility are unchanged;
  - Lumen never animates `.mythra-logo*`, and the landing entrance skips the
    logo.

## Motion system

| Token | Value | Use |
| --- | --- | --- |
| `--lm-d-1` | 120ms | hover, press, colour |
| `--lm-d-2` | 200ms | chips, toggles, small popovers |
| `--lm-d-3` | 320ms | panels, tiles, dock, nodes |
| `--lm-d-4` | 520ms | landing choreography, sent-message lift |
| `--lm-ease-out` | `cubic-bezier(.16,1,.3,1)` | entrances |
| `--lm-spring` | `cubic-bezier(.34,1.56,.64,1)` | pops, dots, hovers |
| `--lm-spring-soft` | `cubic-bezier(.22,1.25,.36,1)` | sheets, bubbles, indicator glide |
| stagger | 40–60ms, capped | thread tiles, landing, settings groups, dock panels, palette |

- **Every Lumen transition and animation is inside
  `@media (prefers-reduced-motion: no-preference)`.** Under reduced motion,
  Lumen adds nothing. Legacy reduced-motion rules, which tests pin, stay in
  charge. The new spec verifies this for the landing, halo and indicator.
- Entrances play only on insertion and use `backwards` fill, so they release
  the element afterwards. The timeline does not virtualize by remounting, so
  rows do not replay on scroll.
- Assistant prose is never delayed or animated by Lumen.
- No new infinite decorative loops are added. The loading shimmer exists only
  while something is loading.
- Some legacy keyframes are referenced by tests or JS, so they keep their
  names: `settings-modal-*`, `settings-backdrop-*`, `palette-in`, `sa-pop*`,
  `sa-select-pop`, `update-notice-arrive` and `toast-arrive`. Lumen loads after
  `styles.css`, and the last same-named `@keyframes` wins in production, so
  `motion.css` re-choreographs these. In the browser test runner, Lumen loads
  before each spec's own `styles.css`, so tests see the legacy frames under the
  same names. Keyframes in lazily loaded component sheets are left alone.

**What moves, by area**
- Navigator:
  - sidebar collapse, brand-mark tilt and new-thread lift;
  - workspace active bar and icon pop;
  - the thread-type active pill springing in;
  - thread tiles dealing in (staggered) with a hover lift, and status pills
    popping;
  - the settings gear turning on hover and resize handles growing in.
- Landing: halo bloom, staggered copy and choices, radio dot spring.
- Transcript:
  - sent-message lift;
  - tool rows and nodes sliding onto the spine;
  - message-action capsule rise;
  - scroll-to-latest pop.
- Composer:
  - focus hairline and halo;
  - send-orb hover and press springs, plus an icon-swap pop;
  - stop, steer and queue entrances;
  - queued turns and attachment chips;
  - mention and permission menus.
- Workbench:
  - dock open and close;
  - rail indicator glide and active icon pop;
  - panel content dealing in on every tab switch;
  - card lifts.
- Settings:
  - a softer spring on the sheet entrance;
  - nav groups and pane groups staggering in on section switch;
  - toggles, theme tiles and usage stat tiles.
- Overlays:
  - command-palette groups and the active item;
  - dialog icon pops and row menus;
  - toasts and update notices.

## Coverage map

| Area | Surfaces | Status |
| --- | --- | --- |
| 1 Shell | canvas aurora, islands, gutters, sidebar open/close, resize handles | done |
| 1 Navigator | wordmark, new-thread capsule, workspace rows, pinned group, thread-type capsule, search, inbox tiles, row menus, archived, settings pill | done |
| 2 Stage header | borderless title, instrument tray (export, search, status, usage, workspace), capsule chips (prompt, run, isolation, handoff) | done |
| 2 Landing | logo on halo, eyebrow, gradient display heading, trust badges, radio tiles, shortcut capsules; welcome orb | done |
| 2 Transcript | bubbles, orbs, markdown, code slabs, spine/nodes, reasoning capsule, relay tiles, inline approvals, scroll/history pills, loading shimmer | done |
| 2 Composer | capsule, focus hairline/halo, send orb, stop/steer/queue, chips, queue tiles, attachments, mention/permission menus, model-rail tray, provider menu, sub-agent panel | done (rail internals keep legacy layout and motion, recoloured) |
| 3 Dock | island and overlay sheet, outer-edge rail with indicator, panel header, deal-in, action chips, tiles, metrics, code/diff/terminal slabs, Git view tabs/branch/actions/commit states | done |
| 4 Settings | sheet, lit nav pills, display pane heading, group cards, rows, toggles, selects, theme gallery, provider/profile cards, usage stats/segmented/cards/day card | done (deep sub-pages inherit tokens and the card primitives) |
| 5 Overlays | shared floating surface, row/select/model menus, prompt/usage popovers, command palette, confirm/approval/runtime/auth dialogs, onboarding sheet, toast, update notice | done |
| 5 States | empty threads/projects/dock, loading shimmer, error banners, settled Git states | done |

## Files

**New**
- `src/styles/lumen/` stylesheets: `index.css`, `tokens.css`, `motion.css`,
  `shell.css`, `stage.css`, `transcript.css`, `composer.css`, `dock.css`,
  `settings.css`, `overlays.css` and `responsive.css`.
- `src/components/LumenShell.browser.test.tsx`: 16 focused tests:
  - real `StudioDock`: the rail sits on the outer edge, the indicator lands on
    each keyboard-selected tab, there is no horizontal overflow, and the
    indicator glides with motion but not under reduced motion;
  - landing: centred without scroll at 1080×700, every item reachable in
    710×350 and 510×300 panels, the logo still hit-testable through the halo,
    and the entrance absent under reduced motion while the logo element is
    never animated;
  - thread-type capsule: fits a 236px navigator on one line, and its active
    segment has legible ink;
  - regression check: user bubbles keep their full single column;
  - gradient-filled controls, including the destructive confirm button, have a
    real fill and at least 4.5:1 text contrast in all 8 themes.
- `src/components/LumenGallery.browser.test.tsx`: **a fixture gallery, not
  evidence of native or provider behaviour.**
  - It composes the real shell classes with real components where they need no
    native services: inbox cards, logo, `StudioDock`, `CommandPalette`,
    `UpdateNotice` and `ModelPowerControl`.
  - All data is invented sample text.
  - It writes screenshots to `test-results/lumen/*.png` (git-ignored):
    - Mythra landing and conversation;
    - Light Mythra conversation;
    - Atari landing;
    - Synthwave conversation;
    - Mythra and Light Kiwi settings;
    - Mythra and Light Kiwi overlays;
    - Midnight welcome with an open permission menu;
    - the command palette;
    - a Kiwi 980×680 minimum window.

**Edited (presentation only)**
- `src/main.tsx`: import order.
- `src/App.tsx`: landing hero and eyebrow.
- `src/components/StudioDock.tsx`: indicator.
- `src/lib/appConfig.ts`: preview swatches.
- `src/test/browser-setup.ts`: loads Lumen for every browser spec.

**Tests updated for intentional palette changes.** Contrast assertions were
kept or strengthened.
- `ThemeToggle.browser.test.tsx`: now asserts an accent track with an
  on-accent thumb, and adds a thumb/track ≥3:1 check across all themes.
- `ThemePalette.browser.test.tsx`: two Monochrome colour pins updated.

## Verification evidence

- `npm run check:types`: pass.
- `npm run lint`: pass.
- `npm run test:run` (jsdom): 185 files passed and 1 skipped; 3,125 tests
  passed and 5 skipped. The skips are already in the suite.
- `npm run test:browser` (Chromium): 59 files / 497 tests pass with Lumen
  loaded. The baseline before any change was 57 / 468.
- Defects caught by specs or the gallery and fixed in CSS:
  - transparent fills behind gradients failed contrast checks;
  - the active Git tab had low contrast against the dock;
  - the "nothing to commit" settled state had been overridden;
  - the legacy narrow-window Settings ladder had been overridden;
  - the day-card radius broke its hit area at 125% zoom;
  - **user bubbles collapsed to a 30px column** (found by screenshot);
  - the thread-type switch wrapped in a narrow navigator;
  - the dark-theme destructive button had low contrast;
  - the dock overlay at ≤1250px needed Lumen insets.
- `npm run build` (safari13): pass. The emitted entry CSS has:
  - no `@layer`;
  - no `:is()`, `:where()` or `:has()` in any Lumen-scoped selector;
  - intact `@supports` gates for `color-mix` and `background-clip:text`;
  - separate `:focus-visible` rules.
- Size: the entry CSS grew from 354.7 kB to 474.3 kB raw, and from 53.2 kB to
  69.2 kB gzip. This was measured by building with and without the Lumen
  import. `npm run verify:performance` passes in report-only mode.
- **Not run:**
  - The WebKit browser lane: selecting it needs an environment-variable
    prefix, which this session's sandbox blocked.
  - Native/Tauri runs, real providers and the full `npm run verify`.
  - No real provider requests were made, and no user data was read or written.

## First-pass caveats (historical; see correction-pass evidence)

- **WebKit has not been exercised at runtime.** Compatibility rests on the
  emitted-CSS inspection and the authoring rules above. Codex should run the
  WebKit lane and a native macOS session.
- On Safari < 16.2, `color-mix()` enhancements are absent. Tiles lose subtle
  translucency and soft washes but keep solid surfaces and readable text.
- These keep their legacy layout and motion, recoloured by the new tokens:
  - model-rail internals (sliders, orbs, star fields);
  - deeper Settings sub-pages (skills editor, workflow builder, sub-agent
    policy);
  - PR panels.
- The fixture gallery approximates App layout with static markup. It is not
  the real `App.tsx` tree, so real-app visual verification is still needed.
- Startup CSS grows by about 120 kB raw / 16 kB gzip. If this were pursued, a
  shorter scope (for example a single attribute) would cut raw size.
- `node_modules` is a symlink to the main checkout's installed dependencies (a
  local convenience, not part of the change). Nothing was reinstalled, and no
  lockfile changed.
