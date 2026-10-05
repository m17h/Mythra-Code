# Claude subscription wrap-up

Source: [Anthropic's Wrap-Up Allowance policy](https://support.claude.com/en/articles/17040437-claude-code-wrap-up-allowance), checked October 5, 2026.

This is a capped, automatic allowance for an eligible response already underway, not unlimited task completion. Pro eligibility is once per weekly period; Max and eligible Team seats may receive it at each session limit, within their weekly cap. Claude Code 2.1.277 or newer is required, and rollout/eligibility remain Anthropic's decision.

This is the subscription feature: work continuing after the five-hour limit counts toward the weekly limit. It is **not** API billing or paid usage credits. The notice names the five-hour limit only when live telemetry identifies `five_hour`; other or unspecified windows use neutral usage-limit wording. A separate paid-usage warning is only a secondary safeguard when the runtime explicitly reports actual credit spending under the user's existing account settings.

## If work stops at the limit

Installing Mythra Code does **not** grant an allowance. Anthropic applies it
automatically only to eligible work already in progress. A new prompt or queued
follow-up sent after the limit is reached does not qualify merely because it is
in the same thread. Max does not guarantee availability: account/organization
age, rollout and remaining weekly usage still matter. Pro can have already used
its allowance for the weekly period. The allowance itself can also run out.

Models & accounts shows a nonblocking warning if the installed Claude runtime
is older than 2.1.277 or its version cannot be verified, with an Updates link.
Normal Claude use remains available; updating a runtime does not guarantee
account eligibility. The app does not silently update it or change billing.

An explicit runtime `assistant.error: rate_limit` produces a saved diagnostic
explaining this boundary and preserves Claude's original reset message. It
clears a stale live wrap-up notice but does not kill the process. Structured
terminal `errors[]` strings are also preserved when the result has no `result`
text, rather than replaced by a generic error. No automatic re-prompting, flag
overrides, custom quota headers or paid-usage activation are used.

## Integration boundary

Mythra Code uses the signed-in Claude Code runtime, which negotiates the allowance. Do not override Anthropic headers, force resets, re-prompt an exhausted task, or turn on paid usage credits to obtain it.

Inspection of installed Claude Code 2.1.288 confirmed its SDK `rate_limit_event` serialization includes `rateLimitGraceActive`. The signal can remain true after exhaustion; combine it with `status`. A rejected status means no active continuation. A reported `resetsAt` expires the live notice; a terminal turn (`result` or process exit) also clears it, as does a different turn's `system/init`. A repeated `init` within the same turn does not. Never restore live continuation from transcript history.

The public [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent)
does not document `rateLimitGraceActive` as an enable option. It is optional,
internal runtime telemetry, not an entitlement or an API Mythra can turn on.
Inspection of 2.1.288's shared request path found headless initialization and
ongoing-request wrap-up negotiation without an explicit SDK-mode exclusion.
That implementation evidence is not a guarantee of entitlement for any account
or future runtime. Keep using Anthropic's unmodified signed-in runtime.

## SDK availability is not yet confirmed

Anthropic's [current SDK subscription notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says SDK, `claude -p` and third-party usage still draw from subscription limits
(the previously announced billing change is paused). That confirms subscription
accounting, **not** that wrap-up is granted in every SDK integration. The wrap-up
policy does not explicitly confirm or prohibit SDK/headless use.

Read-only inspection of 2.1.288 found that remote feature evaluation includes
an `entrypoint` attribute: interactive uses `cli`, print mode defaults to
`sdk-cli`, and this integration identifies as `sdk-ts`. Anthropic can therefore
target modes differently even though they share the local request gate. Its
server-side targeting rules were not obtained. The flattened local feature
cache is not mode-specific evidence and cannot prove why a historical request
was refused. This source inspection also does not establish identical behavior
in every later runtime version.

Conclusion: an SDK-specific restriction is possible but unproven. Do not claim
this feature has been verified end-to-end in Mythra, or remove it as definitively
unsupported, without further evidence. Do not disguise SDK mode as interactive
or force provider feature flags/headers. Provider confirmation or evidence from
a naturally occurring eligible SDK response is needed to resolve that boundary;
do not deliberately exhaust a user's quota to test it.

`overageStatus` indicates credit availability, not consumption. Only explicit spending telemetry (`overageInUse`, or `isUsingOverage` outside an included model bucket) warrants the paid-credits notice. Mythra never changes the account's billing settings.

## Verification limits

Automated tests inject representative SDK events to cover notice routing, rejected events, expiry, simultaneous threads and retired turns. They do not prove that a particular account receives the allowance. Exhausting someone's subscription deliberately is not a suitable regression test; the provider's live event is the authority when an eligible account actually reaches its limit.
