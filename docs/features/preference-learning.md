# Learned preferences

This feature is experimental. Hover, focus, or click **Experimental** in its
settings for an explanation. Learning adds an independent app-wide or project
prompt layer, without overwriting authored prompts or editing project files.
Learned instructions can still affect answers, and analysis sends selected
conversation text to the chosen provider and consumes quota or credits.

Learned preferences let Mythra Code remember how you like to work, using
selected conversation messages. Learning is off by default for every scope.
When enabled, accepted updates are saved automatically and a toast identifies
the scope that changed. The updated instructions apply to future turns.
Turn preparation waits for the initial saved-preference read. If that read
fails, the turn reports an error before model dispatch; the next attempt retries
the read rather than silently dropping enabled instructions.

## Enable learning

Open **Settings → Prompts → Learned preferences**:

1. Choose **App** or a saved project under **Scope**.
2. Review the disclosure about conversation content and account usage.
3. Choose the **Learning provider** and **Learning model**.
4. Turn on **Automatically learn preferences**.

App preferences apply across projects and chats. Project preferences apply only
to that project's turns. Each scope has its own switch, model, document, and
history checkpoints. Enabling one scope does not enable the others.

OpenAI's **Automatic · latest GPT-6 Luna** option selects the newest matching
Luna model in the live catalog. An empty catalog does not select a fallback
model: refresh the catalog in **Models & accounts**, or choose an available
model explicitly. Changing the learning provider turns the scope off until you
select a model and enable it again. A saved model missing from the current
catalog retains its exact ID.

Learning controls save immediately, independently of **Save settings**. They
do not rewrite your global, provider, project, or saved profile prompts.

## New conversations and recent history

Automatic learning starts with authored messages submitted while the scope is
enabled, after their turn completes successfully. Opening old chats or enabling
learning does not automatically analyze existing history. Generated workflow
prompts and sub-agent conversations are excluded from automatic collection.
Nearby completed assistant replies can provide context only when their turn
also has verified authored input captured after that scope was enabled. Older
replies are not silently included when learning is first enabled in an existing chat.

New completed conversations are collected for a one-minute quiet window before
analysis. Pending work for the same scope is combined. One analysis runs at a
time, with at most eight active or queued requests across scopes.

To include older conversations, enable the desired scope and choose **Analyze
recent past conversations**. One pass examines at most eight recent eligible
chats and three pages per chat. Codex-backed pages contain at most 12 turns;
local transcript pages use a 40 KB read budget. Only selected, bounded text is
sent for analysis, so this action does not cover your full history. Some older
messages cannot establish authored input and are skipped.
Older transcripts do not consistently record how user-role text was created.
History analysis uses conservative filters, but cannot certify every older
message's origin; review any inferred preferences.
Conversation references no longer present in the app's active history storage
are counted as skipped items. Other history read failures stop the pass before
any analysis request is submitted.

The history action shows an animated working indicator while reading, waiting
for analysis, analyzing, and saving. Its button stays disabled during that run,
and **Cancel preference learning** remains available until the final save begins.
During that short, atomic save, the disabled button says **Finishing save…**.
A checkmarked completion
message appears only after successful analysis and saving, or when no eligible
new messages were found. It distinguishes updated preferences from no changes;
coverage counts explain skipped or limited history. Conversation and page
attempts include missing references, so these counts do not imply that every
conversation or page was successfully read. A failure or cancellation
does not display a successful completion checkmark.
If settings or preferences change after a native save has already begun, the
finished notice distinguishes that saved result from the later change; it does
not claim the completed save was cancelled. Later changes remain authoritative.

Every analysis selects at most 40 messages and 24,000 characters of conversation
text, skipping individual messages above 4,000 characters. Each scope allows at
most 12 analysis requests in a rolling 24 hours, including history requests and
failed provider attempts and genuine history-read failures. Missing or empty
history does not consume an attempt. App and project analysis are separate requests when
both scopes are enabled. A full queue can skip a conversation; this feature is
best-effort learning, not a complete archive analysis.

## Application and scope

Enabled learned instructions are a separate system-prompt layer, added after
authored instructions and skill resolution. Current explicit requests and
authored instructions remain authoritative; project preferences take precedence
over conflicting app preferences. Mentioning a skill in learned text does not
activate that skill.

The current documents are read when a new turn is prepared, including queued
messages, scheduled tasks, workflow agent steps, and sub-agents. These use the
target project's scope, rather than the project currently visible in the app.
An update does not restart or change the instructions of a turn already running.

## Content and account usage

The chosen learning provider receives selected conversation messages and the
scope's existing learned document. This uses that provider account's quota or
API credits, even when your conversation used a different provider. Assistant
replies can supply context; accepted preferences must cite selected user
messages as evidence. Inferences can still be wrong, so the document remains
visible and editable.

Tool output, activities, file and attachment contents, and expanded skill
instructions are excluded from the learning input. Basic secret patterns and
oversized messages are skipped, but this is not a guarantee that all sensitive
text is detected. Choose scopes accordingly.

## Review, edit, disable, or clear

Use **Learned instructions** to review the document, then **Save learned
instructions** to save edits. If an automatic update arrives while you are
editing, save is blocked until you load the latest document; copy your draft
first if needed.

Turning the switch off stops both learning and application for that scope. Its
saved document remains available for later review or re-enabling.
**Cancel preference learning** stops the selected scope's pending or running
work, preserving its saved document and switch setting. Once the final save has
begun, cancellation is disabled so the displayed outcome matches the saved result.

**Clear learned preferences** removes the scope's document without deleting
conversations or authored prompts. Learning stays enabled if it was enabled,
and can learn other preferences from new conversations. Removed instructions
are remembered in a bounded suppression list to reduce immediate relearning.
**Undo clear** is available while that scope's editor remains open and the saved
state has not changed again.

Saved scopes for projects no longer in your project list appear as **Removed
project · ID** in the scope picker. You can inspect their documents; automatic
learning and history analysis remain unavailable. **Forget removed project
preferences** asks for confirmation, then removes only that project's saved
learned preferences and learning metadata. It preserves conversations and
authored prompts, frees the saved scope's registry slot, and cannot be undone.
If the scope changes while confirmation is open, forgetting is blocked until
you review the latest preferences and try again.
The private registry supports up to 128 saved scopes, including App. Forgetting
removed-project entries frees capacity; merely clearing their text does not.

Documents and learning metadata are kept in the application's private data
storage. Generated Markdown is not written into project repositories, their
`AGENTS.md` files, or saved prompt profiles.

Unavailable providers, malformed model output, or failed storage operations
leave existing preferences in place. Check the selected scope's status in this
panel. Analysis errors do not prevent ordinary conversations from running.
