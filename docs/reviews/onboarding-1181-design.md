# Onboarding redesign proposal for 1.18.1 (Opus 5.5)

Status: implemented after reconciliation by the root reviewer and three GPT-6
Sol reviewers. This document preserves the original proposal; the final behavior,
review corrections, and verification evidence are in [1.18.1-validation.md](1.18.1-validation.md).

Evidence read: `src/components/OnboardingModal.tsx`, `OnboardingModal.css`,
the onboarding rules in `src/styles.css` (1155–1192, 2588–2609),
`OnboardingModal.test.tsx`, `src/lib/onboarding.ts`, the Settings nav in
`SettingsModal.tsx` (113–140), the Projects → Thread titles section
(1304–1330), `lib/turnConfig.ts`, `lib/completionPrompt.ts`, the composer
permission menu and worktree picker in `App.tsx` (6295–6306, 6446–6470),
`RunCommandDiscovery.tsx`, `ApprovalCenter.tsx` (question forms),
`effortFlair.tsx`, and `lib/appConfig.ts`.

## Summary

Go from **9 pages to 5**. Each page gets one headline, one sentence, and **one
focal interaction that changes something real**. Replace the 205 px left rail
with a top stepper. The budget is a 653 × 453 CSS px stage (see Constraints),
and the rail uses a third of that width.

1. **Connect AI.** Welcome and a single provider panel you pick from.
2. **Projects & chats.** Where a thread lives, plus the optional local-first
   GitHub route.
3. **Direct the work.** Permission picker, sub-agents, questions, and Stop.
4. **Make it yours.** Theme, chat font, and effort slider, all applied live,
   plus opt-in automatic titles.
5. **Ready.** Open a project or start a chat. Useful tools sit behind one
   disclosure.

## The current copy makes claims the code doesn't support

These need fixing whatever design wins.

| Current copy | What the code does | Fix |
| --- | --- | --- |
| "without adding a hidden harness-level system prompt" (welcome); "The base prompt starts empty"; "the app does not add a hidden harness prompt" (controls) | `threadStartParams` always sends `developerInstructions` from `mythraCodeDeveloperInstructions()`: skill-mention and completion-format rules, plus delegation and Run-button instructions when those are on. Each provider runtime also has its own built-in prompt. | Make no prompt-emptiness claims. Say only: "Add your own instructions in Settings → Prompts, or per project." |
| Read only: "without changing files **or using the network**" | `networkAccess: false` applies only to the Codex command sandbox (`commandSandbox`). Claude and Cursor enforce the modes their own way, and the model call itself always uses the network. | Reuse the composer's own strings: "Inspect without changing files." |
| Ask to act: "Work locally…" | Codex `workspaceWrite` has `networkAccess: true`. | Composer string: "Work locally; ask for elevated actions." |
| "Projects and commands stay local" (welcome) | Prompts, file contents the model reads, and command output all go to the chosen provider. | Cut it. |
| "rerun this guide from **Interface** Settings" (ready) | Onboarding lives under **Runtime** (`system`: "Onboarding, notifications, …"). | "Replay anytime from Settings → Runtime." |
| "up to 24" workers | This is a limit that changes over time, and the bridge enforces it. | Leave numbers out of onboarding. |
| OpenRouter key "stays in your OS credential store" | Not verified in this pass. `lib.rs` references it, but the Windows keyring cap (see memory) shows storage is platform-sensitive. | Leave it out, or a Sol reviewer verifies it on both operating systems first. |
| "Removing a project never deletes its folder" | The only in-app match is this onboarding string. No confirmation dialog repeats it. | A Sol reviewer verifies it in `removeProject`. Keep it only if it's true. |
| "Workers inherit the parent's permissions" | `childAgents.ts` stores a `permission` per entry. I didn't trace whether it always equals the parent's. | Verify it before keeping. Otherwise: "Sub-agents follow the permission you approve." |

Proposed guard: a unit test that fails if the onboarding text matches
`/hidden (harness|system)|starts empty|no network|without .*network|stay(s)? local/i`.

## Constraints that shape the layout

- **The stage is 653 × 453 CSS px at the minimum window and maximum UI
  scale.** The window minimum is 980 × 680 (`tauri.conf.json`). UI scale goes
  up to 150 and applies as CSS `zoom` on `.app-shell`, as the RowMenu and
  UsagePopover tests show. Every page's focal interaction and the footer must
  be visible **without scrolling** at that size. Only optional details may
  scroll.
- The modal becomes `width: min(880px, 100% − 32px)` and
  `height: min(600px, 100% − 32px)`. The stepper is 44 px tall, the footer is
  52 px, and the stage padding is 28/32 px, dropping to 18 px below 720 px
  width.
- **No OS-native selects.** Every choice is either an app-native radiogroup or
  a switch. `AppSelectMenu` is available but isn't needed on any page.
- **Word budget:** 60 visible words or fewer per page, excluding the stepper,
  footer, and collapsed details. Headlines are 8 words or fewer.

## Look and motion

**Art direction: one lit stage.** The modal is a dark or light panel in the
active theme. Each page has one focal object: a tile row, a route diagram, a
composer strip, a live preview, or a launch pair. That object sits on a
softly lit "plinth": a radial wash of `color-mix(var(--green) 8%,
var(--panel))` with a 1 px accent hairline. Everything else is plain type on
the panel. There are no cards of paragraphs and no nested boxes, and each
page has at most two text weights under the headline.

- **Type:** a small caps step eyebrow in the accent, then a `--fs-display`
  headline, then one `--fs-body` muted sentence. Supporting rows use
  `--fs-ui` for the label and `--fs-meta` for the detail.
- **Color:** only theme tokens (`--green`, `--panel`, `--line`, `--muted`), so
  all six themes (Mythra, Light Mythra, Kiwi, Light Kiwi, Midnight, Synthwave)
  work without any per-theme rules. Remove the hard-coded
  `#a78bfa/#ff8555/#73d7b5` in `OnboardingModal.css`.
- **Brand moment:** only on page 1. The Mythra glyph sits above the headline,
  with a slow accent aurora gradient behind it (12 s loop, 4 % opacity). It
  is static under reduced motion.

**Motion is theme-native and always means something.**

| Moment | Motion | Reduced motion |
| --- | --- | --- |
| Page change | 220 ms fade plus a 12 px slide in the direction of travel (forward goes left, back goes right) using `--ease` | Instant swap |
| Stepper | The active segment fill grows into the next one; completed steps show an accent check | Static |
| Provider pick | The panel height eases via `grid-template-rows: 0fr → 1fr`; the logo scales 1 → 1.06 | Instant |
| Provider becomes connected (props update live) | One accent ring pulse on the tile, and the status text crossfades | Text only |
| Theme pick | View Transition circular reveal from the clicked swatch when `document.startViewTransition` exists, otherwise a 180 ms color crossfade | Instant |
| Effort slider preview | The real `EffortSlider` animates in the chosen style | Uses the slider's existing reduced-motion behavior (Sol reviewer verifies it) |

## Page outline

The stepper labels, in order: `Connect AI · Projects & chats · Direct the work
· Make it yours · Ready`. At 653 px the steps show a number plus the current
label, so the other labels collapse.

### 1 · Connect AI

```
            [glyph]
     Welcome to Mythra Code
  Connect one AI provider to start. Add more anytime.

  ( ChatGPT )( Claude )( Cursor )( OpenRouter )( LM Studio )   ← radiogroup tiles
    plan ●     plan ○    plan ○    API credits ○  on this Mac ○  ← live status dot

  ┌ Claude ───────────────────────────────────────────────┐
  │ Claude Code  ✓ detected     Account  ○ not signed in  │
  │ Sign in with your Claude plan in Models & accounts.   │
  │ [ Connect Claude ]                 Setup guide ↗      │
  └───────────────────────────────────────────────────────┘
```

- **Tiles** show the logo, the name, and a one-word kind: `ChatGPT plan`,
  `Claude plan`, `Cursor plan`, `API credits`, `Local models`. A status dot
  is filled when connected.
- **Pre-selection:** the first connected provider. If none is connected, the
  first provider with a detected runtime. Otherwise nothing is selected, and
  the panel says "Choose a provider to see how to connect."
- **The panel is dynamic.** It shows the runtime and account status and **one
  next step** chosen by state:
  - Runtime missing: "Install Codex CLI / Claude Code / Cursor Agent", with
    the guide link.
  - Not signed in: "Sign in with your plan in Models & accounts."
  - Connected: "Connected. Pick a model under the composer and star your
    favorites."
  - OpenRouter adds `Create API key ↗`. LM Studio says "Start LM Studio's
    local server, then test it in Models & accounts."
- **Primary button:** `Connect <provider>`. It opens Settings → Models &
  accounts and **suspends** onboarding instead of completing it. When Settings
  closes, onboarding resumes on this page, and the statuses have updated
  because they're live props. This is a new App behavior (see Scope).
- `Continue` is never gated. A person with no provider can still tour.

### 2 · Projects & chats

```
  Work in a folder, or just talk.
  Projects open a real folder. Normal chats have none.

  [ 📁 Project ]  ←→  [ 💬 Normal chat ]      ← segmented, 2 options
  ─ selected: Project ─────────────────────────────────────
   Threads run in the folder: files, commands, Git, the workspace panel.

   Optional · with Git and GitHub
   (Shared folder)──(Isolated worktree)──(Commit)──(Push)──(Pull request)
      Local            Local                Local     GitHub   GitHub
```

- **Focal object:** a two-option segmented control. The detail line below
  changes with the choice. Normal chat: "Saved under Normal chats. No folder
  attached. Good for questions and planning."
- **GitHub route** (shown for Project): five stops with scope tags that match
  the workspace-panel proposal (`Local` / `GitHub`). The stops are a roving
  radiogroup. Selecting one shows a single line, for example:
  - Isolated worktree: "A private branch for one thread. Choose it before the
    first message; it needs a Git repo with one commit."
  - Commit: "Saved on this computer only."
  - Pull request: "Open, review, and merge on GitHub from the Git panel."
  These facts come from the `App.tsx` worktree picker and error strings.
- Secondary text link: `Connect GitHub` opens Settings → GitHub. It suspends
  onboarding the same way as page 1. Add the line "No Git yet? Mythra Code
  can initialize it locally."
- Cut from today's page: the fake folder visual and the three-item checklists.

### 3 · Direct the work

```
  You decide how far it goes.
  Pick a starting permission. Change it per thread under the composer.

  ( Read only )( Ask to act ✓ )( Full access )     ← radiogroup, writes default
   Work locally; ask for elevated actions.
   Enforcement depends on each provider's runtime.

  Composer strip (illustration with callouts)
  [Ask to act ▾]  [Sub-agents]  ............  [■ Stop]
       ①              ②                         ③   + ④ question card
```

- **Permission picker (real):** this radiogroup sets the starting permission
  for new threads, the same value as `settings.permission`, which defaults to
  `ask`. The caption says "Starting mode for new threads." The detail strings
  come from **one shared constant** also used by the composer menu. Today they
  are inline in `App.tsx:6466`. Full access gets the one-line caution "No
  approval prompts. Use for work you trust."
- **Composer strip:** a static, simplified drawing of the real controls that
  uses the real icons. Its four callouts are buttons. Selecting one shows a
  single line, and the first callout is open by default:
  1. **Permission:** "Per thread, and applied on every turn."
  2. **Sub-agents:** "Off by default. Turn them on for a new thread and build a
     crew from any connected models; each worker can use a different provider
     and model. Watch them in the Sub-agents panel."
  3. **Stop:** "Stops the current turn. Thinking and commands stay in the
     transcript to expand."
  4. **Questions:** "The agent may pause to ask you something; answer in the
     card to continue." This covers Codex `requestUserInput`, Claude
     `AskUserQuestion`, and Cursor `ask_question`.
- A footnote link: "Your instructions: Settings → Prompts, or per project."
- Cut from today's page: the "Nothing important is hidden" eyebrow and all of
  the prompt claims.

### 4 · Make it yours

```
  Make it feel like yours.
  Changes apply now. Fine-tune anytime in Settings → Interface.

  Theme      (●Mythra)(○Light Mythra)(○Kiwi)(○Light Kiwi)(○Midnight)(○Synthwave)
  Chat font  [ Interface | Humanist | Serif | Mono ]
  Effort     [ live EffortSlider in chosen style ]   Style: ‹ Reactor › (10)

  ─────────────────────────────────────────────────────────
  Automatic thread titles                           [ ○ ]
  Names new threads from your first message. That message
  goes to the title provider you choose.     Settings → Projects
```

- **All real.** Picking a theme, font, or slider style applies it live and
  saves it through a narrow `onAppearanceChange(patch)` prop that uses the
  same save path as Settings. There's no separate "Save" button. Skipping
  keeps whatever was picked, because every pick is an explicit action.
- **Theme:** six swatch chips in a radiogroup, using the `swatches` from
  `appConfig.ts`. The name and one-line description of the focused theme
  appear under the row.
- **Effort slider:** the real `EffortSlider` (variant `codex`, 4–5 levels) in a
  wrapper that sets the previewed style. The style chooser is a compact
  `‹ name ›` stepper with arrows and the name, not a grid of 10. Its
  description comes from `appConfig.ts`, for example "Pulsing energy cells
  and a glowing reactor core." Before implementation, verify how the style is
  scoped. If it's a root attribute, the preview needs a local wrapper or it
  will fight Settings' preview state.
- **Automatic titles:** a real switch, off by default, whose consequence line
  mirrors the Settings copy. Turning it on writes `automaticThreadTitles`
  **only when a title model resolves** (OpenAI Luna auto or a connected
  alternative). Otherwise the switch is replaced by `Set up in Settings →
  Projects`. The detail fields (provider and model) stay in Settings.
- Cut: UI scale. Resizing the UI inside a modal sized for it causes the layout
  to jump. The subtitle points to it instead.

### 5 · Ready

```
            ✓
     You're ready to build.
     Replay this guide anytime from Settings → Runtime.

  [ 📁 Open a project → ]   [ 💬 Start a chat → ]        ← the two primaries
     (Connect a provider → appears first only if none is connected)

  ▸ Useful once you're working            (collapsed disclosure)
     Run            Find run command investigates the project and saves its
                    dev command. Nothing launches until you press Run.
     Review         Changes and AI review in the workspace panel.
     Checkpoints    Every run is saved; undo a run's file changes.
     Skills         Markdown playbooks in one folder.   [Choose folder]
     Automation     Workflows and scheduled tasks in Settings.
```

- **Status line** (only when something is missing): "No provider connected"
  or "No runtime detected", with its fix button. When nothing is missing,
  show only the check mark and nothing else.
- The disclosure rows are one line each with a "where" chip. `Choose folder`
  is the only action in them, and it's real (`onChooseSkillsFolder`). The Run
  wording matches `RunCommandDiscovery.tsx:36`.
- `Done` in the footer completes. The destination buttons complete and then
  navigate, which is today's behavior.

## Keyboard and accessibility

- **Page arrows never steal keys.** Handle `ArrowLeft`/`ArrowRight` only if
  all of these hold:
  - `!event.defaultPrevented`
  - no modifier key is held
  - `!event.isComposing`
  - the target is not inside `input, textarea, select, button, a,
    [contenteditable], [role=slider|radio|radiogroup|switch|tab|option|menu|menuitem|listbox|combobox]`

  This matters because every focal object on pages 1–4 is a radiogroup that
  uses arrows. Today's handler (`OnboardingModal.tsx:269`) fires everywhere,
  including on the range input.
- After a page change, focus moves to the page `h2` (`tabIndex=-1`), not to
  the whole stage, so the heading is announced and arrows work again.
- Radiogroups use roving `tabIndex`, arrows, and Home/End, with
  `aria-checked` and a visible `:focus-visible` ring in the accent.
- **Escape** closes an open disclosure or callout first. Only an unhandled
  Escape skips. Enter never advances pages.
- Stepper items are buttons with `aria-current="step"` and stay freely
  navigable.
- The dialog keeps `useModalFocus` and `aria-modal`. The suspend/resume path
  for Settings must return focus to the control that opened it.

## Three biggest cuts

1. **The standalone Welcome page and its principle trio.** Welcome becomes the
   title of Connect AI. The trio held two of the inaccurate claims.
2. **Five parallel instruction lists (15 steps).** They're replaced by one
   selected-provider panel whose single next step is chosen from live status.
3. **Three whole pages: Build your crew, Everyday tools, and Local skills.**
   The crew content becomes one callout on Direct the work. Tools and skills
   become one-line rows behind Ready's disclosure. Usage chips, project
   instructions, pinning, and MCP go entirely, because they're discoverable
   where they live.

## Coverage map

| Topic | New home |
| --- | --- |
| Providers, runtimes, favorites | 1 |
| Projects vs normal chats; Git init; isolated worktree; commit/push/PR | 2 |
| Permissions; sub-agents across providers; questions; Stop; Prompts pointer | 3 |
| Themes, chat fonts, effort slider styles; auto titles (Settings → Projects) | 4 |
| Run / Find run command; Review / AI review; checkpoints; skills; workflows and schedules | 5 (details) |
| Usage chips, pinning, project instructions, MCP, UI scale | Cut, with pointers only where noted |

## Scope for the implementation step (once authorized)

- `OnboardingModal.tsx`: rewrite it as five page components plus a
  `useOnboardingKeys` guard. Replace `OnboardingModal.css` and move the
  onboarding rules out of `styles.css` (1155–1192, 2588–2609) into it.
- New props: `settings` (a `Pick` of `theme`, `chatFont`, `effortSlider`,
  `permission`, `automaticThreadTitles`), `onAppearanceChange(patch)`,
  `onPermissionDefault(mode)`, `titleModelAvailable`, and `githubConnected`.
  Change `onOpenSettings` so it suspends onboarding instead of completing it.
- Move the permission detail strings into a shared constant used by both the
  composer menu and onboarding.
- `App.tsx`: the suspend/resume wiring and the new props. `ONBOARDING_VERSION`
  **stays 1**, so established installs are not shown the tour again (root's
  call).
- Tests:
  - rewrite `OnboardingModal.test.tsx` (pages, the provider panel state
    machine, setting writes, the suspend path)
  - arrow-key non-stealing tests (radiogroup, switch, slider, button focus)
  - the inaccurate-claims regex guard
  - a new `OnboardingModal.browser.test.tsx` at 980 × 680 with `zoom: 1.5`
    (the `UsagePopover.browser.test.tsx` pattern): no horizontal overflow,
    focal object and footer inside the viewport without scrolling, and a
    reduced-motion emulation that checks there are no running animations
- Run `npm run verify`, then check it natively on macOS. Windows needs its own
  pass for the View Transition fallback in WebView2.

## Questions for the Sol reviewers

1. Should Connect AI suspend and resume around Settings (recommended), or
   stack Settings above onboarding? Two dimmed modals look poor, and
   `useModalFocus` isn't built to hand off between them.
2. Should the permission picker write the default (recommended, because it's
   a real interaction), or only explain the modes?
3. Please verify the three unverified claims: project removal keeps the
   folder, sub-agent permission inheritance, and OpenRouter key storage on
   both operating systems.
4. Is `EffortSlider` style scoping per-element or root-level?
5. Should there be 5 pages or 6? I considered splitting GitHub into its own
   page. I rejected it: it's optional, and as a scoped route on page 2 it stays
   honest about being local-first. It's worth a sixth page only if reviewers
   want a real `Connect GitHub` status check there.

## Risks

- The composer strip on page 3 is a drawing, so it can drift from the real
  composer. Build it from the same icon components and cover it in the
  browser test.
- Live theme changes inside onboarding use the same preview state as Settings
  (`previewTheme` and related state in `App.tsx`). Suspend/resume must not
  leave a preview behind.
- The View Transition API differs between WKWebView and WebView2. It must be
  feature-detected, with the crossfade as the fallback.
- This proposal hasn't been rendered. Every size claim above is a budget
  target that the browser test must prove.
