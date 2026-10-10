# Model pricing reference

Settings → Model pricing shows published OpenAI and Anthropic standard
text-generation API token prices in US dollars per million tokens. It covers
input, output, cached input, and published cache-write rates, including
Anthropic's five-minute and one-hour write durations. Published long-context
bands are separate rows with their source-defined prompt threshold.

These are API list prices, not ChatGPT or Claude subscription allowances.
The reference does not change selected models, authorize paid inference, or
enable extra usage. Image, audio, embedding, moderation, tools, batch, priority,
regional and data-residency charges are outside this standard token table.
Missing prices say “Not published”; they are not represented as free.

The application checks the public official pricing pages after launch without
blocking startup. Refresh checks them again using the same bounded, shared
fetcher. No provider API key or model call is required. Cached successful
listings remain readable offline; separate last-success and failed-attempt
metadata prevent old prices from looking newly verified. A successful listing
removes models no longer shown by that source. Malformed documents or caches
must not replace valid data with guessed prices.

Refreshing also checks the available OpenAI and Claude model catalogs for
connected accounts, so new models can appear in the selectors. Availability
comes from the provider runtime, not from the public price table. The current
model choice is preserved rather than silently replaced. Failed catalog reads
keep the last usable list and report the problem separately from price checks.
Launch checks do not restart an active runtime; manual refresh cannot replace a
runtime while work, approvals, or unresolved native workers depend on it.

Compaction controls use this same catalog's per-model input-price boundaries
instead of advertising 100K for every provider/model. A missing boundary is
unknown, not a guessed pricing limit. Published long-context rates without a
known boundary are distinguished from models without a listed price increase.
These convenience choices do not enforce billing: compaction is based on the
runtime's context estimate and can overshoot or fail. Saved compaction choices
remain unchanged when the model or price catalog changes.

Saved verification dates more than five minutes ahead of the device clock are
marked uncertain rather than presented as newly verified. Saved prices remain
readable, and a future attempt date does not suppress the next routine check.

The display catalog is separate from historical usage-rate evidence. Adding a
specialized model or prompt-dependent band to this reference does not silently
change historical cost estimates. In particular, Haiku 5.5's prompt-dependent
pricing remains unpriced by the usage ledger until that ledger supports those
bands; both bands are still shown here.

Sources:

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
