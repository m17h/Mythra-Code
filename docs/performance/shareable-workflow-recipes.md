# Shareable workflow recipes

Recipes are reusable across projects. New manual recipes do not require a project;
existing project bindings act as defaults. The run dialog shows a project selector,
requested inputs, runtime settings, and interpolated shell commands. Settings,
Workspace tools, and command-palette shortcuts share this dialog. Each run creates
a new workflow thread in its chosen project. Manual overrides never rewrite the
saved project used by interval and app-start runs, which still require a project.

## Sharing

Settings exports version-1 `.mythra-workflow.json` files through the existing native
text-export API, which supports visible destinations inside the home folder. The
save dialog starts in Downloads. Import uses a file picker and opens a draft for
review. It neither saves nor runs automatically. Imported recipes use the current
recipient settings and start with a manual trigger and no project binding.

The file includes names, descriptions, ordered prompt/command steps, conditions,
retry settings, referenced skill names, and variable defaults. It excludes machine
IDs, project bindings, provider settings, system prompts, permissions, schedules,
and history. Literal paths or secrets authored inside a prompt/command/input are
not automatically redacted: users should review recipe contents before sharing.
Skill implementations are not bundled; install referenced skills separately.
Strict import validation enforces the format/version, types, step/condition kinds,
retry bounds, variable names, a 256 KB file bound, and at most 100 entries in each
steps/skills/variables list. New IDs prevent collisions with existing recipes.

## Verification

Focused tests cover round-trip portability, stripping local settings and schedule
fields, malformed/oversized imports, review-before-save, creation without projects,
and actual destination dispatch without changing the saved default. Real WebKit
checks cover project selection/command previews and long commands with many inputs
in a 700 x 520 viewport.

In the isolated macOS development app, exported a two-step Claude Haiku recipe,
imported the resulting file, renamed it, and saved it as Any project. Selected a
disposable project at run time from a different active project. Both steps finished
and the second recalled the first step's code word. Native Windows file dialogs and
provider execution were not exercised in this pass. Sol reviewed the import
boundary and manual-versus-scheduled project handling; the destination ambiguity
found during review was fixed by sharing the explicit launch dialog.

After composer invocation, `npm run verify` passed end to end: 2,192
unit/integration tests, 230 Chromium browser tests, 255 Rust tests (3 ignored),
lint, Clippy, TypeScript, Cargo check, production build, and the exact measured
Safari performance limits. The Chrome production build and scorecard also pass.
All 230 WebKit tests passed on the final full run. The first WebKit run had one
ChecksControl output-toggle failure; its isolated three-test rerun and the next
full run passed without production or test changes.

## Performance

The recipe transfer code remains in lazy Settings and the shared launch dialog is
lazy from App. No dependencies, idle polling, or automatic model requests were
added. Production build measurements compared with the provider-compatibility tree:

| Target | Startup JS delta | Startup CSS delta | Total JS delta |
| --- | ---: | ---: | ---: |
| Chrome 105 | +3,300 B | +46 B | +5,934 B |
| Safari 13 | +3,439 B | +46 B | +6,073 B |

Startup JavaScript increases by about 0.4%; budgets record exact measured bytes.
This is feature cost. No animation was removed.

## Explicit composer invocation

Type `!` at the start of a token to search enabled recipes. No result is selected
initially. Clicking an option or navigating with an arrow then Enter adds a
removable recipe chip; raw typed or pasted `!name` text never invokes a recipe.
Space dismisses suggestions and preserves punctuation. Enter with no selected
suggestion sends ordinary prompt text. IME composition and Shift+Enter do not
accept workflow suggestions.

A chip opens the same run review with an optional note. Notes are appended only
to agent steps, never interpolated into shell commands. Command-only recipes use
their explicit inputs instead. A recipe launches in a new thread after reviewing
its target project. Cancel, invalid setup, and stale/deleted recipes retain the
source draft. Acceptance occurs once the workflow thread is created, not after
the whole run completes. Draft cleanup is scoped to the submitted thread and
exact submitted content, preserving newer edits and other threads' drafts.

The composer allows one recipe at a time and does not mix recipe launches with
active/queued turns, attachments, or review feedback. Editor inputs remove leading
whitespace; recipe imports reject it, and legacy saved names are normalized.

Sol reviews cover punctuation, explicit selection, draft ownership, IME, stale
recipe handling, validation, and launch lifecycle. Seven real-browser regressions
pass in Chromium and WebKit, including a short viewport and thread switching.
Native macOS checks confirmed space dismissal, explicit chip selection, optional
note preview, and cancellation preserving the draft.

The native two-step Haiku run completed and recalled the first step's word in the
second, with the added note visible in both prompts. Sending `Reply only OK. !`
used the ordinary chat path without starting a recipe. Windows native behavior
was not exercised for this composer change.

Composer invocation adds 6,329 B of Safari startup JavaScript and 904 B of startup
CSS; Chrome adds 5,776 B of startup JavaScript and the same 904 B of CSS.
These are under 0.8% startup JavaScript increases. Both profiles use exact
measured limits in performance-budgets.json.
The picker filters local recipe data only. There is no provider request until the
user reviews and starts a run; the existing launch dialog remains lazy.
