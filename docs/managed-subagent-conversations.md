# Mythra-managed sub-agent conversations

These features apply to the Mythra Code sub-agent engine. Provider-native
Claude Code and Codex agents continue to use their own collaboration tools.

## V2 preview setting

Settings → Sub-agents includes **Mythra sub-agents V2 (Preview)**, off by
default. Off keeps the original spawn, status, collect and cancel workflow.
On additionally enables questions, parent guidance, same-conversation follow-ups
and explicit assignment sign-off. The shared ownership, Stop and recovery
protections apply in both modes; this is not a rollback to older source code.

The switch is locked while Mythra-managed sub-agent work is starting, running, queued for
delivery or has an unconfirmed outcome. Save rechecks the live state so a run
that starts after the settings window opens cannot change mode mid-flight.
Native Claude Code/Codex work and saved native-agent history do not lock this
Mythra-only switch. Native delegation is not enabled or disabled by this setting.
Their native models, concurrency limits, compaction settings and tools are not
changed by the preview switch. Native bridge registrations cannot advertise or
execute the Mythra V2 conversation tools, and native runtime instructions omit
Mythra V2 guidance even if the global preview is enabled.

New crews adopt the chosen mode at the next turn boundary. A V2 crew with
unaccepted assignments keeps its conversations and review tools even if the
global default is turned off. Once those assignments are accepted, its next
turn adopts the current default. Existing child history is never discarded.
Deferred queued and timed prompts read the current preview choice when they
actually begin, even if the user has navigated to another project. Their
captured provider, model and permission choices remain unchanged.

## Model guidance

Settings → Sub-agents → Model guidance lets users save a short note about
when and how to use a provider's model. Add a model, choose its provider and
model, and describe its strengths or preferred uses. Entries can be edited or
removed, and follow the Settings window's Save and Cancel behavior.

This applies to Mythra-managed crews in both V1 and V2, regardless of the
parent's provider. A parent receives only notes matching its approved crew,
once per provider/model even when several workers use that model. Notes appear
beside the crew in the `spawn_mythra_agent` description, with no extra lookup
call. Without a matching note, the parent uses its own judgment.

Notes match the crew's exact provider and model ID; different aliases are not
automatically treated as the same model. Provider-default crew entries match
the resolved default model. Saved changes apply at the next parent turn.
Notes never approve or enable sub-agents, override permissions or limits, or
change provider-native Claude Code or Codex delegation.

Model notes use the room remaining in a 3,800-unit tool-description budget,
counted in UTF-16 units like Claude Code's default 4,096-unit limit (including
emoji). Notes that all fit are included without reserving space for an
unnecessary omission warning. Otherwise, the longest prefix of whole notes
that fits together with its omission count is included in captured crew order.
If no such prefix fits, only an omission notice is included when there is room.
Shorter notes let more of them through. The crew roster itself is never trimmed
to make room for notes. A note for a provider-default entry matches the default
model's current ID, so a
future change of default stops matching until the note is moved to the new
model.

## Working together

In V2, a child can use `message_parent` with kind `question` when it needs the
parent to respond or act on a question, blocker or decision. Kind `update` is
the default for progress that needs no action. Provider approvals and native
user-input requests still go to the user. The parent receives child messages
through `agent_status` and `collect_agent`. Reading a question leaves it open
for the parent to recover after a missed response.

The parent replies with `send_agent_message`, using `replyTo` for an answer to
a particular question. A running child receives guidance through its provider's
steering capability, or pulls it with `read_parent_messages`. If delivery is not
currently possible, the message is labeled queued, not delivered. Once the child
finishes its turn, queued guidance can continue its existing conversation when a
slot is available. The app does not create a replacement conversation silently.
Live guidance to one child is delivered in order, one batch at a time, and a
pull never takes a later message ahead of an earlier one still being delivered.
When several children wait for a slot, the oldest waiting guidance goes first.

If a message cannot be delivered, the parent's `agent_status` and
`collect_agent` report it with its reason. This repeats until later guidance
with the same text is delivered or the work is accepted. Unrelated later
messages do not clear it. Each entry says whether it was not delivered or
whether delivery is uncertain (for example, the runtime accepted the request
but never confirmed it, or the app reloaded mid-delivery). Uncertain guidance
is never resent automatically. Messages already queued behind it are not sent
across that gap either: they are marked not delivered so the parent can
decide.

A child can pass a `replayKey` to `read_parent_messages`. Reading again with the
same key returns that earlier batch if its response was lost. Nothing is
redelivered or resent. Replay lasts only while that batch remains in bounded
history; use a fresh key for a new pull.

Both send tools accept an optional `clientRequestId`. Reusing it for the same
uncertain send returns the retained message and its current state; a different
payload with that key is refused. An intentional new instruction uses a fresh
key, even if its wording is identical. This is bounded-history deduplication,
not a promise of exactly-once provider execution across failures or forever.

A question can start a turn when Mythra Code is following a waiting parent
run and its continuation checks pass. Otherwise it stays available for the
parent's next turn and in the sub-agent details. Updates stay available in the
same places and never start a turn.

While the parent waits in `collect_agent` for one child, an unread question
from another child can end that wait early, including a question that arrived
before the call. The response includes the question and its child ID.
`agent_status` lists children that need a response first and pages long crews
with `nextCursor`. Unread questions get space before progress updates in a
bounded response. Earlier open questions remain available in focused status.
For failed or unconfirmed guidance, focused status responses return a bounded
page. Pass `childId` and `guidanceNextOffset` as `guidanceOffset` to inspect the
next page, including outcomes beyond the first eight. This is live ordering,
not a frozen snapshot; explicit resolution can move outcomes between pages.

## Finishing an assignment

A completed turn is **Awaiting review**, not acceptance of the assignment.
The parent can collect the result, ask for corrections, and collect again.
When satisfied, it calls `accept_agent` with the collected result's `reviewToken`.
If newer work intervened, that old token cannot accept the newer result. Newer
work includes every explicit new attempt (a parent follow-up or a user-typed
turn), even one that fails before producing a turn. It also includes guidance
that failed or was cancelled after the result was collected. An attempt that
ends without a turn of its own never presents the previous turn's text as its
result.
Users can also explicitly accept work from the sub-agent command center.

Automatic archiving waits for acceptance, for all relevant work to settle, and
for any parent run following the child to close.
Parent turn completion alone is not acceptance. Accepted assignments are closed
to parent follow-ups; new assignments use new children. Users may still open
and continue a child conversation themselves, which clears its previous signoff.
Historical children created before this feature retain their old cleanup policy.

## Following delegated work

A parent's model can end its turn while its children still work. A turn that
started with the Mythra crew available is followed: Mythra Code records a parent
run before any provider request, and that record decides what happens when the
turn ends. The model's words are never read, and no timer is involved.

- **Waiting.** If a child is unfinished, the turn shows as waiting rather than
  completed. No provider process stays alive and no model usage occurs. Servers,
  watchers and other shell work are not part of this and never hold it open.
  The sidebar also shows **Waiting**, or **Needs input** when the run pauses,
  instead of labelling the parent **Done**.
- **Continuing.** When every assigned child has settled, a visible continuation
  turn can start in the same conversation. A child can also wake the parent
  while siblings are still working by asking a question or by finishing,
  failing or being cancelled with a result the parent has yet to collect.
  Undelivered guidance can also wake the parent while the child still works.
  Signals available together share one turn, and each signal can independently
  wake the parent once. A child held on the user's approval, taken over or
  stopped by the user, or with an unconfirmed status cannot wake the parent on
  its own. An unannounced question can still wake it after the approval clears.
  The generated notice lists child IDs, names and states only. The parent
  reads questions with `agent_status`,
  answers with `send_agent_message` using `replyTo`, and reads results through
  `collect_agent`. A continuation with no progress can return to waiting while
  a child can still move forward. If the parent still has work to do and its
  children cannot move it forward, the run pauses.
- **Finishing.** The run completes when every assigned child is reviewed. V1 work
  needs its exact result collected. Successful V2 work needs that result signed
  off with `accept_agent`. Failed or parent-cancelled V2 work needs its exact
  result collected, not accepted. A child the user stopped no longer holds the
  run and is never restarted automatically. A child the user accepted in the
  crew panel is settled: if the parent already read that result nothing further
  runs, and if it never did, it is continued so its answer reflects the result.

In **Settings → Sub-agents → Automatic parent follow-ups**, choose a whole number
from 1 to 1,000 or **Unlimited**. The default is eight, including for settings
saved before this option. Each authorization has its own count, which carries
over if the user sends a message while the parent is waiting. The run pauses
when it runs out of automatic follow-ups, a continuation ends with no progress,
the parent turn fails, or a provider refuses the start. **Continue with** uses
the current model and account and starts the automatic count at zero.
**Dismiss** ends the run and leaves the children in the crew panel. Unlimited
lifts the count limit. Progress, execution identity, queue and recovery rules
still apply, and each follow-up is a normal model turn with normal usage.

The limit is an app-wide setting on the machine running the conversation,
including conversations started from another device on the local network. Each
automatic decision reads the saved value, including for runs already waiting
and when rechecking after an in-flight identity check. A follow-up that has
already started can finish. If a waiting run has used at least as many
follow-ups as the saved limit, it pauses when it would next continue. To
resume a paused run after changing the limit, use
**Continue with** or the typed-message behavior below when it applies.

**Typing into a paused conversation.** A message the user types into the
conversation while one of the run's children is genuinely still working keeps
that run: the same children stay followed, the turn recaptures the execution
identity, and the limit is not reset. Typing is the user acting here, and a
message sent during a wait already behaves this way. The message can be an
ordinary send, a steer that arrived after the turn ended, or an answer to the
parent's question. The kept run stays paused if that turn has no crew.

Otherwise a new prompt while paused retires the run, so nothing attaches to later
work. That covers runs with only settled children, a loaded run after a restart
and a start that could not be confirmed. Children the user stopped, accepted or
took over do not count as working. Preparing or unconfirmed child starts alone
do not keep a paused run. Queued, timed and generated prompts never keep a run:
they are not the user answering this pause, so they cannot restore automatic work.
Each of them retires a paused run as before.

**Stop**, **Dismiss** and **Don't auto-continue** end the run. A later message does
not bring it back, and reading a child never does either. A child is followed
again only if the parent gives it more work in a later turn with
`send_agent_message`.

`spawn_mythra_agent`, `agent_status` and `collect_agent` report `automaticFollowUp`
for children with outstanding work. The field is true only when a live,
unpaused run owns that exact child and the saved limit allows another
continuation at the time of the report. Unlimited satisfies the count check.
The tools read the child's existing review ownership and tell the model to
avoid promising automatic follow-up when the field is false. A model can still
end its turn or say something else.

**Stop** ends the run and stops the children. **Don't auto-continue** ends the run
and leaves the children working. While a run can still continue by itself, the line
above the composer says so and that normal model usage applies. A follow-up is a
continuation of the delegated request, so it does not ask for permission, and
nothing here promises lower usage. A paused run makes no such promise.

User, queued and timed prompts always go first, and a continuation that fails to
start leaves the conversation and queue as they were. A continuation also waits,
rather than pausing, while a different conversation works in the same shared
folder; a parent's own children never count as that. A question from a child
waiting on the user's approval does not wake the parent, because only the user can
unblock that child. Automatic archiving and Git auto-publish wait while a run is
being followed.

**Nothing starts by itself after a reload or restart.** A live run becomes paused
there. A run whose start cannot be confirmed says so and is never resent. Children
are independent of this: they may still be running. Conversations and links from
before this existed never create a run.
An unacknowledged start keeps **Stop** available and shows **Status unknown**;
**Continue** is disabled until that start settles or is stopped, preventing a
duplicate prompt.
Existing provider recovery and Stop rules still apply. A Codex-hosted start that
has not supplied a turn ID cannot yet be interrupted by ID; the app must confirm
its ownership rather than guessing that nothing started.

### Limits

This follows Mythra crew work only. Provider-native sub-agents and workflow-owned
conversations are outside it. A shell `sleep` or other waiting in a parent's live
turn is discouraged by its instructions but not intercepted. A child that hangs
without any event keeps the run waiting, with no timeout. The follow-up limit counts
turns, not tokens. The model can still mention a time, which the app neither honors
nor enforces. Actual provider behavior, including how models respond to these
instructions, has not been exercised at runtime.

### Diagnostics

Each meaningful transition appends one `parentRun.transition` row to the app's
local audit log, which keeps its newest 20,000 rows. These records have no automatic upload.
A row holds the run ID, previous and new phase, resumes used and the saved limit
at that transition in `budget` (a number or `"unlimited"`). It can also include
the follow-up ID, automatic or explicit trigger, and finite categories for the
pause cause and outcome when applicable (resolved, retired, failed, uncertain or
unknown), including whether Stop, **Don't auto-continue**, **Dismiss**, a new turn or removing the
conversation retired it. A typed message that keeps a paused run appears as a move
from paused to active on the same run ID, with the pause cause it cleared. If its
start is refused or has no crew, restoring that earlier pause records the phase
change without calling the old failure a new outcome. A row never holds prompts, child output, titles, paths,
account details, keys or provider error text. A run that resolves inside its original
turn writes no ordinary completion record; explicit retirement actions are still
recorded. A pause applied while loading saved state is not a row of its own;
the next action on that run records its cause. Resolved means no child
obligations remain; it does not judge the work's quality and also covers children
the user stopped or removed.

### Execution identity

A continuation uses the provider, model, reasoning, permission mode, service
tier, execution folder, crew and account captured by the turn before it, never
the visible conversation's. Before it starts, Mythra Code reads the provider's
current account afresh and compares everything. A difference, or anything it
cannot establish, pauses the run. The pause names a real difference. If the read
failed or an account identity is missing, it says Mythra Code couldn't confirm the
model or account, because nothing shows the account changed. It never switches between subscription and API
billing. A saved API key is identified by its billing mode and the app's record
of key changes, since it has no email or plan. A signed-in account must report an
email or plan; one that reports neither, such as a Cursor Enterprise account
without an email, pauses here rather than passing as unchanged, and **Continue
with** still works.

The comparison covers credential and billing changes made in the app and any
change visible in the reported account. A credential replaced outside Mythra Code
that leaves those reported fields identical cannot be detected at this point. The
provider's own spawn-time checks, including Claude's billing confirmation, still
apply to the continuation.

The notice also tells the parent that if it still needs an answer from the user,
it should not guess, but state what it needs and end its turn. If that leaves no
progress, the run pauses for the user. This is an instruction to the model, not a
check: Mythra Code does not read the model's words or detect that a question is
open, so a model can still continue without the answer.

Notices are stored as user-role messages because that is the timeline's turn
boundary, and are shown as one quiet line. They are excluded from previews, edit,
preference learning and provider handoffs, which keep the parent's own answers.
Provider history can lose message metadata, so a notice is recognized there only
by an exact match of its whole generated format, including the earlier v1 request
wording. Native local conversation search
reads stored message text directly and can still match notice text.

## Boundaries and recovery

- Children can communicate only with their own parent, not unrelated threads.
- They do not acquire spawning, project-control, or terminal-control powers.
- Follow-ups retain the child's provider, model, reasoning and context setting;
  permissions remain controlled by the app and the parent policy.
  If the user explicitly changes a child's model or reasoning setting, parent
  follow-ups are refused rather than silently reverting the user's choice.
- Opening a managed child, including one outside a saved project, retains its
  parent mailbox. Managed children cannot acquire native delegation by inheriting
  a parent's native-engine setting.
- The child's original assignment and ownership are published before model
  dispatch. A bounded recovery pass after reload reconnects pending initial
  acknowledgements and inspects unresolved work; it does not continuously poll.
- Initial model starts must claim their exact backend reservation. On reload,
  abandoned preparation that never claimed model dispatch can be retired safely;
  claimed or otherwise uncertain work stays owned until confirmed evidence.
- Bridge requests carry a non-secret registration identity. Retired requests
  cannot start work using an earlier permission or execution context.
- Stop cancels pending guidance and invalidates starts already being prepared.
  A stopped child is not silently restarted.
- Stopping a parent run stops its working or unconfirmed children. Children
  that had already finished (awaiting review or accepted) are not marked as
  stopped, so the parent's next user-initiated turn can still continue them.
  Both cutoff passes of one Stop act only on the work that Stop targeted. Neither
  pass ever stops a child turn the user started afterwards, nor a newer
  parent turn.
  A shared native process whose original identity cannot be established is
  not killed by an older request; Stop reports that cutoff as unconfirmed.
- A user-typed turn in a child conversation reopens it under a new result
  revision. Activity that starts late on a stopped child, without a user start,
  is not treated as the user continuing it.
- In-flight delivery remains protected until the provider confirms an outcome.
  Stop does not turn a newer, uncertain activation into an older completed result.
- Follow-up slots have activation identities. A late completion from an older
  turn cannot release a newer turn's slot.
- A reload while a follow-up is still preparing (before any provider request)
  is recognized on recovery: its slot is released and the previous result
  stands. A reload after the request was sent stays uncertain.
- After a reload, an initial start that the backend proves never claimed its
  dispatch is shown as failed, not as unknown forever.
- Unchanged child bridges can reattach after a renderer reload. Changed or stale
  runtime capabilities fail closed instead of pretending communication works.
- Ambiguous provider starts retain visible ownership and uncertainty until the
  runtime proves the outcome. An exception alone is not proof nothing started.
- Message history is bounded. Pending work is protected; trimmed settled history
  is disclosed. A full mailbox refuses additional messages rather than dropping
  them silently.
- Local-provider child history is hydrated before saving, steering or stopping
  an unloaded conversation. Automatic archiving flushes its latest saved work;
  a committed archive/delete with cleanup trouble reports that partial outcome.

Each mailbox trims settled history toward 50 messages, protecting unresolved
work even when that target is exceeded, with admission limits of 20 unread
updates/unanswered questions and eight queued/in-flight parent messages. New
work has an aggregate budget of 1,048,576 serialized characters; replies and
settled-history trimming target 2,097,152 characters. Settlement never discards
unresolved work merely to meet that target. There is no separate
400-conversation ceiling. Existing pending data above a limit remains readable,
but further admissions can be refused. These are bounded-history and normal
recovery protections, not promises of crash-proof storage or exactly-once
provider execution.

Delivered steering means the runtime wrote the message into the child's
input stream, not that the model processed it. A lost confirmation stays
visibly unconfirmed rather than appearing to be sending forever.
