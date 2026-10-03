# Claude subscription wrap-up

Source: [Anthropic's Wrap-Up Allowance policy](https://support.claude.com/en/articles/17040437-claude-code-wrap-up-allowance), checked October 3, 2026.

This is a capped, automatic allowance for an eligible response already underway, not unlimited task completion. Pro eligibility is once per weekly period; Max and eligible Team seats may receive it at each session limit, within their weekly cap. Claude Code 2.1.277 or newer is required, and rollout/eligibility remain Anthropic's decision.

This is the subscription feature: work continuing after the five-hour limit counts toward the weekly limit. It is **not** API billing or paid usage credits. The included wrap-up notice must say explicitly that the five-hour limit was reached and the continuing work counts toward weekly usage. A separate paid-usage warning is only a secondary safeguard when the runtime explicitly reports actual credit spending under the user's existing account settings.

## Integration boundary

Mythra Code uses the signed-in Claude Code runtime, which negotiates the allowance. Do not override Anthropic headers, force resets, re-prompt an exhausted task, or turn on paid usage credits to obtain it.

Inspection of installed Claude Code 2.1.288 confirmed its SDK `rate_limit_event` serialization includes `rateLimitGraceActive`. The signal can remain true after exhaustion; combine it with `status`. A rejected status means no active continuation. A reported `resetsAt` expires the live notice; a terminal turn (`result` or process exit) also clears it, as does a different turn's `system/init`. A repeated `init` within the same turn does not. Never restore live continuation from transcript history.

`overageStatus` indicates credit availability, not consumption. Only explicit spending telemetry (`overageInUse`, or `isUsingOverage` outside an included model bucket) warrants the paid-credits notice. Mythra never changes the account's billing settings.

## Verification limits

Automated tests inject representative SDK events to cover notice routing, rejected events, expiry, simultaneous threads and retired turns. They do not prove that a particular account receives the allowance. Exhausting someone's subscription deliberately is not a suitable regression test; the provider's live event is the authority when an eligible account actually reaches its limit.
