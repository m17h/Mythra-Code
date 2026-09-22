# Thread completion and automatic titles

The inbox shows an attached PR's number and state using the existing persisted
snapshot. It does not fetch GitHub for each card. The title retains its own row;
metadata truncates to preserve status, pin, and provider controls.

The existing merge confirmation optionally archives the thread only after GitHub
returns the same PR as merged. It retains the local checkout and PR attachment.
Failed merge, attachment changes, active work, queued messages, and unanswered
questions prevent finishing. An archive failure leaves an explicit retry action.
Archived conversations remain recoverable. Automatic GitHub merges are separate:
there is no background archive monitor.

Automatic titles are off by default. New user conversations trigger one title
request after their first prompt is accepted. OpenAI's automatic option follows
Luna models actually present in the account catalog, falling back to the known
5.6 Luna identifier only before a catalog is available. Users can select any
supported provider and model. Explicit IDs are honored exactly, including aliases
missing from a partial catalog. A provider failure retains the ordinary title.
Manual names take precedence, and rename/archive/delete cancel pending jobs.

Only the first 2,000 characters of the first prompt are supplied to title
generation. The selected provider's account pays for this separate request;
settings disclose this even when the main thread uses another provider. No
transcript backfill, repeated naming, project inspection, or polling is added.
One title request runs at a time with a bounded queue. Native workers use isolated
temporary directories and disable tools; HTTP providers receive a single request
with no tool definitions. Workers share existing cancellation, process cleanup,
and provider transports with run-command discovery, without saving a chat.

## Measured build cost

Compared with main at 4176402, the production bundles add:

| Target | Startup JavaScript | Startup CSS | Total JavaScript |
| --- | ---: | ---: | ---: |
| Safari 13 | 6,957 bytes | 970 bytes | 13,320 bytes |
| Chrome 105 | 6,418 bytes | 970 bytes | 12,625 bytes |

These are raw minified byte counts, not runtime speed measurements. The settings
and PR panel remain lazy. No new dependency or animation reduction is involved.
The corresponding budget exception records exact measured limits without slack.

## Verification and remaining limits

- Focused tests exercise confirmed/unconfirmed merges, attachment drift, archive
  failure/retry, navigation, pending work/questions, provider selection, serial
  title jobs, cancellation, manual rename ordering, and invalid model output.
- Real Chromium and WebKit layout checks cover 210–320 px inbox cards in light
  and dark themes, including very long PR numbers and neighboring controls.
- The full native macOS development app was used to archive and restore a labeled
  preview conversation linked to real, already-merged PR #103. The PR badge and
  attachment survived. Settings and alternate-provider selection were inspected.
- One live 5.6 Luna title request returned a valid title and left the provider's
  saved-session inventory unchanged. This checks the native CLI protocol, not a
  complete user turn through the unsigned QA app, whose OpenAI account is not
  connected. Other providers and native Windows have automated coverage but were
  not live-account tested for this feature.
- No real open GitHub PR was merged as part of verification. Merge-to-archive
  failure paths are covered by focused tests; native archive/restore was real.
