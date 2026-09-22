# Thread pull request workflow performance review

Baseline: `0ff56d0` (v1.17.5), identical installed dependencies, Node 26.0.0, production Vite builds. Measured on macOS for both Safari 13 and Chrome 105 output targets. No release build or version change.

| Target / raw bytes | Before | After | Change |
| --- | ---: | ---: | ---: |
| safari13-minified / appEntryRawBytes | 380,346 | 396,661 | +16,315 |
| safari13-minified / startupJsRawBytes | 756,716 | 775,653 | +18,937 |
| safari13-minified / startupCssRawBytes | 363,306 | 364,225 | +919 |
| safari13-minified / totalJsRawBytes | 1,528,800 | 1,577,029 | +48,229 |
| chrome105-minified / appEntryRawBytes | 360,236 | 375,532 | +15,296 |
| chrome105-minified / startupJsRawBytes | 728,560 | 746,409 | +17,849 |
| chrome105-minified / startupCssRawBytes | 356,763 | 357,706 | +943 |
| chrome105-minified / totalJsRawBytes | 1,489,645 | 1,536,545 | +46,900 |

The extra bytes implement the requested feature. This is not evidence of faster rendering or lower total memory use. The lazy PR panel includes its forms, confirmation states and stylesheet. The eager portion is the header chip, durable thread-link controller, and guards against competing operations. Existing animation behavior is retained.

No new dependencies or background model calls are introduced. Status reads share in-flight requests, cache up to 64 results, and only poll the visible linked thread every 60 seconds. Document hiding pauses recurring reads; closing the Git panel removes the timer. Thread/cwd ownership is checked when asynchronous operations finish. Read caches and review lists are bounded. GitHub commands time out; Git commit hooks and pushes use a 120-second bound.

The scorecard limits were updated to the exact measured results. The pull request description must include this explicit performance-regression review before merge.

## Validation scope

Unit and integration tests cover per-thread attachment persistence, read-only attachment, late mutations, thread changes, refresh/reopen races, stale-head forms, and merge permissions. Chromium and WebKit tests cover narrow panel geometry and crowded header behavior. Native tests use disposable Git repositories; live authenticated read-only smoke checks exercise the GitHub response contract on macOS and Windows. Remote create and merge are not exercised against a real repository by these tests.
