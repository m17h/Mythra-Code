# Prompt reconciliation and native agent questions

## Behavior and regression review

A submitted prompt first has a Mythra ID. Codex can report the same prompt in a
live item or history page under a runtime ID. The old hydration path compared
only IDs and could retain both rows. Sub-agent startup has another ordering:
the provider can report its prompt before the launch call returns and Mythra
appends the local prompt.

The fix reconciles unacknowledged local prompts one-to-one within their runtime
turn, retaining the original visible text, images, and steering feedback. It
recognizes Mythra's generated skill/file context without changing model input.
Acknowledged messages cannot absorb a later identical send. The echo-before-append
path requires the explicit turn ID returned by child startup; ordinary steering
cannot mistake an older history item for its own echo. Reconciliation uses ID
and turn indexes, rather than comparing every history row against every live row.

Claude's `AskUserQuestion` is now available through the existing stdio permission
control channel. The form returns the original tool input plus answers keyed by
question text; it supports single choice, multiple choices, additional free text,
cancellation, and retry. The CLI remains paused until a response arrives.
Full-access mode still bypasses ordinary approvals. Read-only mode no longer
uses `dontAsk`, which suppresses interactive questions as well; it retains the
write-tool deny list and automatically denies every ordinary permission callback.
Only `AskUserQuestion` gets an interactive callback in that mode.

Codex `agentMessage.questions` renders an inline form without pausing the runtime.
Submitting while working sends `turn/steer`; submitting after completion starts
a turn on the same thread. A completion race queues the answer once. The ordinary
composer's draft, attachments, and skill expansion are not used for these answers.
Explicitly nonblocking `item/tool/requestUserInput` requests use the same inline
presentation, responding through their RPC while it remains valid and using a
follow-up after expiry. Expired secret questions are never converted into a
visible chat prompt. Blocking requests retain a blocking form.

Question rows remain visible when completed work folds up. Draft answers survive
row remounts and task switches within the app session, with a 100-form memory
limit. Active submissions are shared across remounts to prevent duplicate sends.
RPC question rows and successful answer acknowledgements use one native-hydrated
store, removed when their task is forgotten. Native request IDs are scoped by
thread, turn, and item before a response is written, and old drafts cannot attach
to reused IDs. Successful answers are recorded locally; secret answer values are not saved in
that record. Focusing a question stops automatic tail scrolling so new output
cannot move the input away. Stopping a turn clears its obsolete runtime requests
while retaining independent local settings proposals. Unattended scheduled runs
keep interactive Codex questions disabled on both start and resume.

## Protocol evidence and limits

- Local Codex CLI **0.154.0**: generated experimental app-server JSON schema
  includes `agentMessage.questions`, `AsyncUserInputQuestion`, and
  `ToolRequestUserInputParams.isBlocking`. Mythra already opts into experimental
  app-server fields. [App-server protocol](https://developers.openai.com/codex/app-server).
- Local Claude Code **2.1.269**: successful stdio initialization with
  `AskUserQuestion` available in both manual and bypass-permissions modes.
  Initial handshakes sent no user prompt. The subsequent review also exercised
  live Opus 5 question/answer turns on macOS and Windows (details below).
  [Claude user-input contract](https://code.claude.com/docs/en/agent-sdk/user-input)
  and [permission-mode behavior](https://code.claude.com/docs/en/permissions).
- Behavior is enabled by runtime capabilities, not hard-coded model names.
  Whether a model chooses to ask a question remains a model decision.
- Codex tests exercise generated protocol events and delivery races with
  controlled fixtures; no live Astra turn was run. Claude additionally has live
  stdio evidence using Opus 5, with the UI tested separately in real browsers.

## Performance-regression review for the change

The feature adds no dependency or background polling. Question controls and their
stylesheet load only when needed. Startup CSS is unchanged. In-memory drafts are bounded to 100 forms; durable question records follow the
conversation lifetime; no timer or animation runs for a question form. These are functional
costs, not a claimed application-wide performance improvement.

Production measurements below are raw bytes, compared with the previous enforced
budgets. Total JavaScript includes lazy chunks. Temporary build directories were
emptied before measurement to avoid counting stale chunks twice.

| Metric | Safari 13 target | Change from prior cap | Chrome 105 target | Change from prior cap |
| --- | ---: | ---: | ---: | ---: |
| App entry JS | 375,756 | +3,195 | 355,880 | +2,944 |
| Startup JS | 747,206 | +8,192 | 719,525 | +7,587 |
| Startup CSS | 362,499 | 0 | 355,956 | 0 |
| Total JS | 1,513,758 | +13,020 | 1,475,213 | +11,883 |

The startup JavaScript increase is about 1.1%. The reviewed exception in
`scripts/performance-budgets.json` records these exact costs without adding
headroom. Include this review in a future PR that carries the change.

## Verification

- After the independent review fixes, `npm run verify` passed on macOS and
  the isolated Windows snapshot: 1,711 unit/integration tests and 163 Chromium
  browser checks on each host, 166 Rust tests on macOS and 167 on Windows,
  lint, type/native checks, production builds, and both platform size budgets.
  The final snapshot matched all current source and script files. Windows
  verification did not alter the working checkout; its temporary copy was removed.
- Both question interaction tests also passed in WebKit, including retaining
  focus and scroll position while new output arrives and retaining draft input
  when a question row remounts.
- Claude stdio initialization succeeded on both operating systems in manual and
  bypass-permissions modes, with zero user prompts sent in all four handshakes.
- Live Opus 5 high probes then read a temporary marker, issued `AskUserQuestion`,
  waited for an explicit host answer, and returned the marker and chosen answer.
  macOS manual and bypass-permissions modes and Windows read-only/manual all
  passed. No result arrived during the one-second answer delay. Read did not
  require an ordinary permission callback under the read-only allowlist.
  These probes used isolated fixtures and changed no project files.

An initial Windows run exposed an existing test timing race: the Settings dialog
could commit before its passive mount effect ran. That assertion now waits for
the effect it measures, retaining the same mount-count and DOM-identity checks.
No timeout was increased and no application Settings behavior changed.

## Independent review follow-up

Opus 5 and GPT-5.6 Sol independently reviewed the change. Confirmed issues were
reproduced with focused tests before correction:

- A normal prompt echo arriving before `turn/start` returned could still create
  two rows. Pending-start reconciliation now handles that ordering without
  consuming older turns or intentional repeated sends.
- Generated file context in a skill envelope changed the visible prompt after
  reopening history. History display now removes recognized generated suffixes.
- Reused RPC IDs could overwrite an older question or direct its answer to a
  newer request. Turn/item IDs scope the row, and the native request ledger also
  checks thread/turn/item identity. A response finishing late cannot dismiss a
  replacement request, and a fresh question replaces a stale queued request
  with the same numeric ID. Blocking form drafts include request-instance identity.
- Nonblocking RPC questions were missing from native history, and dynamic answer
  keys were not hydrated from SQLite. One durable record store now restores
  questions and acknowledgements and removes them when their task is forgotten.
- Nonblocking questions no longer inflate approval counts or trigger a misleading
  notification saying the task is waiting for permission.
- Claude control responses no longer hold the pending-request lock while writing
  to the runtime pipe. A separate response lock preserves single delivery and
  retries while allowing cancellations and other requests to be processed.

The review's suspected Codex question-shape mismatch was checked against the
installed generated schema: `AsyncUserInputQuestion` uses `title` and string
options, while the RPC uses `question`, IDs, and labeled option objects. Mythra
handles both shapes separately. `serverRequest/resolved.threadId` is required
in that schema. Neither suspicion justified a protocol workaround.
