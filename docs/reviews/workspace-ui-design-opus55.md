# Workspace panel design proposal (Opus 5.5)

Companion to `workspace-ui-2026-09-22.md`. Interactive sample:
`workspace-ui-proposal.html` (design preview with sample data; nothing in it
runs Git, GitHub, or provider operations). Evidence came from `StudioDock.tsx`,
`GitPanel.tsx`, `ThreadPullRequestPanel.tsx`, `TerminalPanel.tsx`,
`useCheckpoints.ts`, `usePaneResize.ts`, `styles.css`, and the native captures
`01-native-merged-pr.png` and `06-native-merge-help.png`.

The content column is about 270 px wide at the minimum dock width: 340 px dock
minus the 70 px rail. Every rule below targets that width first.

## Three rules for every tab

1. **Status, one primary action, then content.** Header subtitles show live
   context such as `codex/pr-thread-finish · Shared folder`, `12 saved · latest 3
   min ago`, or `Scanned 2 min ago`. Remove slogans such as "Shape changes
   without leaving MYTHRA CODE". Each tab gets at most one filled button.
2. **Scope tags replace repeated scope sentences.** Mark section headers and
   confirmations with small tags: `Local` for this folder, `GitHub` for the
   remote, `Files` for checkpoint restores, and `Chat` for conversation history.
   Give each confirmation one consequence line. Keep the tags in the accessible
   name as well, for example with `aria-label="Commit (local only)"`. They make
   the local/GitHub and files/conversation distinctions easier to see while
   removing about half the fine print.
3. **Progressive disclosure has three levels, and only three.**
   - **Visible:** state, errors, retry, primary action, and the things that
     block that action.
   - **`More` (`AppActionMenu`):** secondary or rare actions, each with a
     one-line `description`. Destructive items use `danger: true` and keep their
     existing confirmation dialog.
   - **`Details` (`<details>` or disclosure button):** explanations, metadata,
     audit tables, and long policy text.
   Hover-only help is not a fourth level. Hover-only help can't be used with
   touch or keyboard, and hover-triggered expansion inside the page layout
   moves rows under the pointer (see "Merge help").

## Navigation rail

Reorder the rail into three groups separated by thin dividers. Keep all ten
labels visible and add no overflow button.

`Files · Review · Git · Terminal` | `Checkpoints · Worktrees` | `Agents · Attachments · Tools · Usage`

The common Files → Review → Git flow becomes adjacent. At the 680 px window
minimum, 10 tabs × 48 px plus two dividers is about 500 px, so the rail fits.
Add small count badges using data the app already has, with no new polling:
changed files on Review, active agents on Agents, and queued attachments on
Attachments. Git gets a dot when commits are waiting to push or a PR check
fails. Keep roving focus, `aria-controls`, and the open/close animation.

## Tab-by-tab treatment

### Git (highest priority)

Today, one scrolling column contains: a branch card; a Status, Diff, and More
row; a commit form with up to three full-width buttons; the PR panel, which
repeats the branch, folder, and uncommitted chips shown above it; a GitHub card
with Push; a separate "GitHub actions" menu; and a five-line auto-publish
paragraph. The layout groups actions by how they work. It should group them by
where they have an effect.

Proposed layout: **two scope sections.**

```
[Local]  codex/pr-thread-finish            Branch ▾
         15 changed · 3 staged · Review changes →
         ┌ Commit message (optional) ─────────────┐
         [ Commit 3 staged ]  [▾]                 More ▾
         Saved on this computer only.
[GitHub] m17h/Mythra-Code   2 to push · checked 4 min ago   [Push]   ⋯
         Pull request #104 card  (state · checks · review · actions)
         Auto-publish   ○ Off                      Details
▸ Git output (last command)
```

- **Local.** The branch menu stays. Status and Diff move into Local `More`
  (they remain available in read-only mode), next to Stage all, Unstage all,
  and Revert all changes…. Add a `Review changes →` link that opens the Review
  tab, since that is where the per-file diff lives.
- **Commit.** Use one primary action whose label states the scope:
  `Commit 3 staged`, or `Commit 15 changes` when nothing is staged. A compact
  `▾` menu beside it holds `Commit all 15 changes` (only when some files are
  staged) and `Commit and push`, which carries the GitHub tag. The consequence
  line is `Saved on this computer only.`, or `Auto-publish will push it.` when
  auto-publish is on.
- **GitHub.** Put the remote/sync row at the top of the GitHub section, with
  Push inline. Its `⋯` menu absorbs the separate "GitHub actions" menu. The PR
  card follows. Push belongs next to the PR because pushing is how an open PR
  gets new commits.
- **PR card inside Git.** Don't repeat the context chips the Local header
  already shows (branch, shared folder, uncommitted changes). Show a chip only
  when the value differs from the Local header, such as a PR head branch that
  is not the current branch.
- **Auto-publish.** Show one row: a switch, the label `Auto-publish commits`, a
  status such as `Off` or `Watching · pushed 2 min ago`, and `Details`. The
  current paragraph moves into Details unchanged. `Waiting` with Retry and
  `Paused` with its reason stay visible outside Details.
- **Git output.** Leave it collapsed once a command succeeds, with a one-line
  summary. Open it automatically on error.
- **Unchanged:** the Initialize Git card, the "Publish this project to GitHub…"
  disclosure, and the read-only rules. Branch creation stays inline.

### Merge help and the merged state (applies to the new work in this PR)

The screenshot `06-native-merge-help.png` shows a real problem that the audit
missed. Help opens on hover **in the page flow**, so hovering the first `ⓘ`
inserts about 60 px of text and pushes the next option's `ⓘ` away from the
pointer. The `ⓘ` buttons are also right-aligned, far from their labels at wide
dock widths. The screen also looks ready to use when it isn't: one check has
not reported, auto merge is off, and the confirm button is disabled.

Recommended changes:

1. **Replace the hover bubbles with one outcome line under each method, always
   visible.** No hover, no pinning, and no Escape handling are needed:
   - `Squash and merge` — *One new commit on main.*
   - `Create a merge commit` — *Keeps every commit, plus a merge commit.*
   - `Rebase and merge` — *Keeps every commit, rewritten onto main.*
   The selected method expands to the full existing sentence with an
   animation, and the expansion happens only on click. Keep the target branch
   name. Remove "A commit is one saved change." because anyone choosing a merge
   method has already seen the word commit on the same screen. The reviewer proposed this version; the lead kept the requested information
   buttons in the companion preview instead.
2. **Shorten the confirmation heading.** The confirmation is drawn inside the
   card whose title and head → base line appear directly above it, so repeating
   `m17h/Mythra-Code #104 — "full title"` and the refs line adds three lines
   without adding information. Use `Merge #104 into main` with a `GitHub` tag.
   The full repository and title stay in the button's accessible name.
3. **Show the blocker first when the merge is blocked.** If merging can't
   continue (soft blockers exist and auto merge isn't allowed), show the blocker
   with `Refresh` and `Open on GitHub`. Collapse the method choice behind
   `Choose method` so the screen doesn't look actionable.
4. **Local effect: one line.** Use `GitHub only · your local files and main
   here don't change.` Folder and branch details belong in the merged-state
   note, where they help the next step.
5. **Merged state (`01-native-merged-pr.png`).** Suppress the "this PR is on X,
   this folder is on Y… everything below acts on the pull request" note once
   the PR is merged or closed, because no pull-request actions remain. Show
   `Merged into main on GitHub · local files unchanged` with two buttons:
   `Update local main` and `Archive thread`. Keep the existing refusal
   reasons in the fine print.

Keep: named method labels, one card open at a time, the snapshot/drift
refusal, archive and auto merge as mutually exclusive checkboxes that start
unticked, and the `Merge on GitHub…` label (it separates this merge from the
local worktree merge).

### Checkpoints

The current card shows up to five peer buttons, four metadata chips, a stats
line, lineage lines, and a permanent paragraph that repeats the restore
confirmation dialog in `useCheckpoints.ts`. Proposed layout: a timeline list.

- **Header:** `Save now` (one button) and a subtitle such as `12 saved · latest
  3 min ago`.
- **One line in place of the note:** `Every run is saved automatically.` with
  `Details`. The existing dialog already states the full consequence at the
  moment of restoring, which is the moment it matters.
- **Row:** status icon · label · `3 min ago · 4 files +82 −17`, plus a `Current`
  pill. Warnings (`overlappingRun`, `error`) stay inline and are never hidden.
  Clicking a row expands it to show the thread, model, branch, lineage, and the
  preview diff.
- **Actions:** `Preview`, one restore button chosen by state, and `⋯`:

  | State | Primary | In `⋯` |
  | --- | --- | --- |
  | ready / accepted | `Undo changes…` (= restore before) | Restore result…, Accept / Undo accept, Delete… |
  | restored-before | `Reapply changes…` (= restore after) | Undo changes…, Accept, Delete… |
  | safety | `Restore this copy…` | Delete… |
  | running | none (spinner) | — |
  | legacy | `Fork conversation` | Delete… |

  "Undo changes" and "Reapply changes" describe outcomes. "Restore before" and
  "Restore result" required the user to know the model.
- **Conversation section, footer:** a `Chat` tag and `Fork thread` and
  `Undo last chat turn…`, with one line: `Changes chat history only. Files
  stay as they are.` The word "changes" belongs to files and "chat turn"
  belongs to conversation; the two never share a verb.

### Tools

Four inventories are always open, the policy card is generic, and loading,
failure, and genuinely empty states look the same.

- **Header subtitle:** `Scanned 2 min ago`, or `Scanning…`. Rescan becomes a
  header icon button.
- **Scan failure:** a red row reading `Couldn't read MCP status · Retry`. Rows
  from successful scans stay visible. This depends on the correctness fix in
  the audit, finding 1.
- **Access line:** in place of the policy card, show `Uses this thread's
  access: [Full access]` with `Details`. Show the actual current mode, which is
  what the user needs to know.
- **Counted disclosure sections, in this order:** `Project actions 3`,
  `Workflows 2`, `Connected services (MCP) 3 · 1 needs sign-in`, `Skills 14 · 12
  on`. A section with five or fewer items starts expanded, and a longer one
  starts collapsed. **I disagree with the audit's "expand populated sections"
  rule:** a user with 30 skills would get the wall of items back.
- **Empty section:** one row, for example `Workflows · none yet · Add in
  Settings`. No large empty card.
- **Search:** show a filter field once the total exceeds about 8 items.
- **Rows:**
  - Project actions show the command in mono and a `Run` button.
  - Workflows show `3 steps · last run passed` with Run, or Stop while
    running, plus `Open run`.
  - MCP servers show a status dot and tool count, and a `Connect` button only
    when disconnected.
  - Skills use an app-native **switch** in place of the ✓ / + icon buttons,
    which read as actions rather than as a state.

### Usage

The current hero shows the **cumulative** token total in large type while its
progress bar measures **context** use (`contextPercent`). Two different
quantities sit in one visual, which is the root confusion on this tab. The
audit said to "lead with the subscription window". **I disagree:** the top bar
already shows that figure (`5h 23% used`), and the action on this tab
(Compact) concerns context.

1. **`Context in this thread`** — a bar, `124k of 200k tokens · 62%`, and a
   `Compact…` button. At 70% and above the bar turns amber and Compact becomes
   the primary button. Label the bar with context tokens, never the
   cumulative total.
2. **`Plan limits`** — the provider name and plan, one bar per window, and
   `Resets in 2 h 14 m`. Label a figure as an estimate, or mark it
   `unavailable`, when it is one.
3. **`Details: token breakdown`** (collapsed) — cumulative total, input,
   output, reasoning, cache read/write, and `Estimated API cost $4.12 · not
   billed to your subscription`. OpenRouter history goes here too.
4. **`Details: request details`** (collapsed) — the audit table, with long
   values wrapped.

Refresh becomes a header icon, and the header shows how fresh the data is.

### Other tabs (agree with the audit, with these specifics)

- **Files:** the file list gets the full height until a file is selected. The
  preview then opens as a resizable lower pane containing `Attach to next
  message`. The tree gets keyboard navigation, as in the audit's correctness
  item.
- **Review:** use the header `Changes` with the subtitle `15 files · vs HEAD`.
  Don't call it "Local changes", because the Git tab's Local section would then
  share the same words. Toolbar: Refresh icon, `AI review`, and `Commit in Git
  →` when changes exist.
- **Terminal:** a slim output toolbar containing the running status (`Running ·
  npm test`), a Clear icon, and `2 running elsewhere ▾`. Remove the separate
  Clear row and the stacked banners. Disable Run when the command is empty.
- **Worktrees:** the first line is the status, `Shared project` or `Isolated ·
  branch`. For isolated work: `Review` plus `Bring into shared project…`, which
  opens a two-choice card (`Copy files` / `Merge commits`, both tagged `Local`).
  Show the existing paragraph once, behind Details.
- **Attachments** (renamed from Context): an `Add` button in the header, a
  compact list, one sentence `Sent with your next message only.`, and a count
  badge on the rail.
- **Agents:** rename to `Sub-agents` and show `2 active · 5 total`. Rows show
  status, the first two lines of the task, and `Open`. `Stop` appears only
  while the agent is active. IDs move to Details.

## Priorities

1. **Must fix (correctness or broken interaction):**
   - Tools scan and error truth
   - Agent Stop only on active agents
   - Files keyboard access
   - Merge help: replace in-flow hover with always-visible outcome lines
   - Usage: cumulative total vs context bar
2. **High value, modest code:**
   - Git two-scope layout and commit primary with `▾`
   - Merged-state note suppression and a shorter merge heading
   - Checkpoint row with state-chosen primary action and `⋯`
3. **Medium:**
   - Tools counted sections and skill switches
   - Usage disclosures
   - Terminal toolbar
   - Auto-publish summary row
4. **Low / after native comparison:**
   - Rail reorder and badges
   - Renames: Attachments, Sub-agents, Changes
   - Worktrees "Bring into shared project…"

## Keep as is

- Local-first ordering in Git: commit comes before the PR.
- Every confirmation dialog, and the drift and snapshot refusals.
- `AppActionMenu` and `AppSelectMenu`. No OS selects or menus.
- The dock open/close animation and resize separator. The Initialize Git card.
- Wording that names the target branch and never says "base".
- Read-only still allows Status, Diff, attaching and detaching PRs, and
  read-only commands.

## Disagreements with the consolidated audit

| Audit | This proposal | Why |
| --- | --- | --- |
| Merge help "stays inside the column without clipping" was treated as solved | Replace it with always-visible outcome lines | Help that opens on hover inside the page layout moves the next target away from the pointer. |
| Git: Local → Pull request → GitHub | Two scopes: Local, then GitHub (sync, PR, auto-publish) | Push and the PR both act on the remote. Two sections match the local/GitHub distinction the audit wants preserved. |
| Review header "Local changes" | "Changes" | It would clash with Git's Local section. |
| Usage: lead with the subscription window | Lead with context use | The top bar already shows the window. Compact is the only action on this tab. |
| Tools: expand populated sections | Expand only when a section has 5 or fewer items; add search | The wall of items returns for users with many skills. |
| Checkpoints: keep the restore explanation visible | One line plus Details | The confirmation dialog already states it at the moment of action. |

## Risks

- Moving Status and Diff into `More` hides them from users who rely on them in
  read-only mode. Mitigation: the `Review changes →` link, plus menu item
  descriptions.
- Scope tags only work if they are consistent. Apply them to every mutating
  control, or the missing ones will read as "safe".
- "Undo changes…" may be mistaken for Git revert. The confirmation must say
  `Restores files to before this run; a safety copy is saved first; Git
  commits unchanged`.
- Rail badges must use state that already exists. They must add no polling or
  provider calls.
- The preview has not been rendered or browser-tested by this reviewer.

## Delivery and review note

Opus 5.5 wrote this design critique through Claude Code (explicit model
`claude-opus-5-5[1m]`). Its later HTML generation did not complete before the
request was stopped. The lead implemented the companion preview from these
recommendations, preserving the requested merge info buttons and correcting
checkpoint, permission, and commit-scope wording. See the lead decisions in
`workspace-ui-2026-09-22.md`; recommendations above are not accepted blindly.
