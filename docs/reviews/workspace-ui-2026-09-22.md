# Workspace UI review — September 22, 2026

Scope: all ten right-hand workspace tabs, their shared navigation, and GitHub
merge options on `codex/pr-thread-finish`. Three Sol reviewers split Git/Review/
Checkpoints/Worktrees, Files/Terminal/Context/navigation, and Agents/Usage/Tools.
The lead reviewed their evidence, challenged apparent defects against downstream
behavior and supported window sizes, and inspected the native macOS development
app. This is a UI assessment and proposed sequence, not a claim that every
recommendation below has been implemented or measured with users.

## Implemented in this pass

Each merge method now has a small app-styled information button. Hover or focus
shows a short explanation, click pins it, and Escape dismisses it. Only one
explanation is open at a time. It names the actual target branch and explains
that a commit is a saved change. Asking for help never selects a radio or starts
a merge. The explanation stays inside the scrolling column without clipping.
The local-folder message is now platform-neutral.

The native review also exposed misleading PR check text: GitHub can send an
empty/null conclusion while a check is still running. The parser previously
stopped at that empty field instead of reading its status, so the UI described
running CI as having no reported result. The parser now falls back to the actual
status, while truly missing results remain unknown and blocked.

The merge descriptions were checked against GitHub's primary documentation:
https://docs.github.com/en/pull-requests/reference/pull-request-merges

## Recommended layout rule

Keep the tab's current task and status at the top, followed by one primary
action and its content. Put secondary actions in an app-native More menu and
technical explanations in expandable details or small information buttons.
Keep errors and the consequences of destructive actions visible when relevant.
Retain animations, keyboard navigation, local-only workflows, and every useful
tool. A shorter interface must not hide whether an action changes local files,
GitHub, or conversation history.

## Tab-by-tab findings

| Tab | Current friction | Proposed layout and behavior |
| --- | --- | --- |
| Files | The empty preview reserves most of the vertical space before a file is selected. Up to 150 search-result buttons require repeated Tab presses; selection is largely visual. | Give the file list the available height initially; reveal a collapsible/resizable preview on selection. Keep Attach with the preview. Add arrow-key traversal and announced selection. Preserve ignored-folder filtering and stale-read protection. |
| Review | “Live turn diff” does not describe the repository-diff state. Staging changes has no clear next step into committing. | Use “Local changes”; retain the baseline and untracked-file warning. One toolbar with Refresh, AI review, and a route to Git when changes exist; keep the file list and per-file actions dominant. |
| Git | Commit, commit-all, commit-and-push, push, PR actions, and publishing policy compete on one scrolling page. Auto-publish scope is a long paragraph. | Visually separate Local changes → Pull request → GitHub. Keep one clear local commit action with an explicit file scope; secondary commit variants in a menu. Keep Push with GitHub. Condense auto-publish to a short summary with scope/details on demand, preserving failure/retry feedback. |
| Terminal | Run looks actionable when the command is empty. Clear consumes a separate row. Multiple commands running elsewhere stack above the terminal. | Disable the empty Run affordance, move Clear to an output toolbar/menu, and collapse other-project activity into a counted summary. Keep the terminal/output and command line dominant and the active project visible. |
| Checkpoints | Each card can display Preview, two restore actions, Accept, and Delete together, plus dense metadata. Conversation undo/fork sits beside project restoration concepts. | Show Preview, one state-appropriate Restore action, and More. Move alternate restore/accept/delete into More. Keep current-state and changed-file summaries visible; expand metadata as needed. Collapse conversation controls separately and preserve their distinct warning. |
| Worktrees | The shared-project state shows three explanation blocks without an immediate task. Active worktrees expose Review, Copy, Merge, and More as peers. | Start with a compact “Shared project” or “Isolated workspace” status. Explain setup once when shared. For isolated work, show branch/status, Review, and “Bring into shared project…” with explicit Copy files / Merge commits choices. Keep local-vs-GitHub effects and post-merge continuation clear. |
| Context | A large add card and another empty-state card repeat the same message. “Context” can be confused with the model's context limit in Usage. | Prefer “Attachments” or “Next-message attachments”: header Add button, compact queue, and one scope sentence. Show the count near the composer/tab. Keep all attachment entry points synchronized. |
| Agents | Stop appears even for finished agents. Full task prompts are truncated to one line; “Observed” and “Direct children” are internal language. | Use “Sub-agents”, a compact active/total summary, optional Active/All filter, and readable task rows. Open is the primary action; Stop appears only for active work. Show status and a short task preview; IDs and advanced metadata can be details. |
| Usage | Token tiles, estimated API-equivalent cost, subscription limits, and a technical request audit compete for attention. Long audit values may clip. | Lead with the subscription window and this thread's context use as separate concepts. Put token/cache/cost breakdown and “Advanced request details” behind disclosures. Clearly distinguish estimates from actual subscription charges. Wrap long values and show freshness/unavailable states. |
| Tools | Four inventories are always expanded, including empty sections. Permission/harness/MCP language is technical. Loading, failed scans, unavailable runtime, and genuine emptiness are not distinguished. | Compact scan status with Retry, then counted sections for project actions, workflows, connected services, and skills. Expand useful/populated sections; use search for large inventories. Use “Tools the model can use” and “Connected services (MCP)”. Empty sections get one short setup link, not a large card each. |

## Remaining findings that deserve correctness work

1. **Tools state is incomplete.** `App.refreshTools` ignores rejected results
   from `Promise.allSettled`. A failed MCP status request can look empty on first
   load or silently stale later. `skillsBusy` and `skillsError` exist, but the
   dock gets only the skill array. Pass separate scan/error/freshness state,
   retain successful rows, and distinguish an unavailable Codex runtime from a
   failed request and an actually empty result.
2. **Agent actions need lifecycle awareness.** `StudioDock` always renders Stop.
   Reuse the shared active-status predicate rather than adding a second list of
   status strings. Preserve access to completed results.
3. **Files need keyboard selection semantics.** `FileBrowser` uses a sequence of
   ordinary buttons. Add a focused list/tree interaction with announced selection
   and navigation tests, preserving the existing async race protection.

## Shared navigation and qualifications

The ten labeled tabs are understandable individually, but related work is split
apart: Review is near the top and Git is last. Put the common Files / Review /
Git / Terminal tasks together. Keep the remaining tools discoverable rather than
hiding all of them behind an unlabeled overflow button. Shorten generic header
subtitles; show operational context (project, branch, current state) instead.
Retain roving keyboard focus, linked tab panels, the resize separator, and the
existing open/close animation.

Two initial reviewer claims were downgraded after checking the implementation:

- The native window minimum is 980×680 and the visible scale picker tops out at
  125%. Claims based on a 320px phone window or a 480px-tall window do not prove a
  native regression. Rail scrolling and compact layouts are useful resilience
  work, but inaccessible tabs at supported sizes were not reproduced. Test actual
  minimum window size, maximum selectable scale, and minimum dock width first.
- Blank terminal commands return before any process/RPC starts. Their Run button
  is an affordance problem, not an execution bug. Read-only commands intentionally
  remain usable in a read-only, network-disabled sandbox. Do not disable all
  project actions; clarify their restrictions. Workflow permission is stored
  separately and must remain independent of the current thread.

## Suggested implementation order

1. Tools loading/error truth, agent lifecycle actions, and Files keyboard access.
2. Checkpoints and Git action hierarchy; concise auto-publish/restore help.
3. Tools counted sections, Usage advanced details, and conditional file preview.
4. Attachments/Worktrees wording and navigation grouping after native comparison.

Validate populated, empty, loading, failed, and busy states. Use native supported
window bounds and real Chromium/WebKit layout checks. Confirm that every moved
action remains accessible by mouse and keyboard, errors/retry controls remain
visible, all local workflows still work, and UI changes add no polling or
background provider requests.

Evidence: `StudioDock.tsx` (tab list, each conditional panel), `GitPanel.tsx`
(commit/GitHub/publishing sections), `FileBrowser.tsx` (listing/preview),
`TerminalPanel.tsx` and `useTerminal.ts` (Run and command guard), `App.tsx`
(`refreshTools`, skill state, project-action handler), `turnConfig.ts`
(`commandSandbox`), `useWorkflowEngine.ts` (saved run permission), `styles.css`
(workspace, file preview, audit, responsive rules), and `tauri.conf.json` /
`tauri.dev.conf.json` (supported window minimum).

## Opus 5.5 design review and lead decisions

See [the design proposal](workspace-ui-design-opus55.md) and
[interactive preview](workspace-ui-proposal.html). Both are proposals using
sample data, not implemented workspace behavior.

The strongest refinements are grouping Git into Local and GitHub sections
(with push and the PR together), showing state-appropriate checkpoint actions,
limiting initially expanded tool inventories, and leading Usage with current
context rather than the cumulative token total. Source inspection confirms that
Usage currently places a cumulative total and a context percentage in the same
hero; separate them even though the existing cumulative label is technically
correct. The Usage proposal supersedes the earlier subscription-first ordering.

Some recommendations need adjustment before implementation:

- Keep the requested merge information buttons. Opus proposes replacing them
  with always-visible outcome lines, which conflicts with the user's request
  and adds permanent text. In-flow help moves subsequent rows, but its trigger
  stays in place and the explanation remains reachable. Browser and native
  checks verified the current interaction; this is a design tradeoff, not a
  reproduced broken control. A future anchored popover must avoid clipping and
  preserve hover, focus, click, and Escape support. Keep the short commit gloss
  for beginners; seeing a word elsewhere does not mean understanding it.
- A default commit action must not silently expand from staged files to all
  changes. Any change in file scope must be explicit in the label and review.
- Scope tags supplement meaningful consequence text; they cannot replace the
  local-vs-GitHub or file-vs-chat warning at the point of action.
- Tool permissions vary: project actions use the thread's restrictions, while
  workflows retain their own saved permissions. A single thread-access line
  must not imply that it governs every workflow.
- Do not promise that every run is saved unless checkpoint availability and
  failure states are accounted for. Failed or incomplete protection stays
  visible. Context and quota values must retain their real data semantics and
  unavailable states; the preview's sample numbers are not measurements.

## Verification

- Full `npm run verify`: 2,005 unit tests, 190 Chromium tests, 238 Rust
  tests (three ignored), lint, type checks, native checks, production build,
  and measured bundle budgets passed. Eleven additional WebKit PR-panel
  layout tests passed.
- Merge help was exercised in the native macOS development app and browser
  tests; the check-status parser has a regression that failed before the fix.
  Native Windows UI and a live GitHub merge were not performed.
- The lead built the companion HTML preview from Opus's written design after
  its HTML generation did not complete. Chrome interaction checks covered all
  four tabs, merge help, checkpoint confirmation, tool retry, and the 320px
  panel setting. The preview is independent of the production app and uses no
  network requests, dependencies, or real project operations.
