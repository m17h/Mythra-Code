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

## Working together

A child can send a question or an update with `message_parent`. Its parent
receives messages through `agent_status` and `collect_agent`. A question wakes
an outstanding collection call, even while the child is still working.
Reading a question does not mean it has been answered. Unanswered questions
remain available for the parent to recover after a missed response.

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

A child message does not automatically start a stopped or idle parent turn.
It stays visible for the parent's next turn and in the sub-agent details.
This prevents unexpected model usage.

While the parent waits in `collect_agent` for one child, a new question from
another child ends that wait early, once per question. `agent_status` lists
children that need a response first, pages long crews with `nextCursor`, and
gives fresh unread messages priority over reminders of earlier questions.
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

Automatic archiving waits for acceptance and for all relevant work to settle.
Parent turn completion alone is not acceptance. Accepted assignments are closed
to parent follow-ups; new assignments use new children. Users may still open
and continue a child conversation themselves, which clears its previous signoff.
Historical children created before this feature retain their old cleanup policy.

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
