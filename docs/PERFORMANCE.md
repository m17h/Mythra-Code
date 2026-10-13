# Performance notes

Automated performance measurements, tests and gates are disabled locally and on
GitHub until Morgan explicitly reintroduces them. No scorecard, browser replay,
native A/B capture, budget threshold or performance audit is required for a
change, merge, build or release.

The reports in [performance/](performance/) preserve historical observations
and design rationale. Their old commands, test results, thresholds and suggested
next measurements are historical records, not current instructions to execute
checks. Removed harnesses or tests may make old paths unavailable.

Performance claims should describe the actual observed behavior and its limits.
Bundle bytes, mounted rows, synthetic timings and a completed build do not by
themselves establish a faster desktop application. Preserve visible content,
controls, animations, user data and supported OS behavior when implementing
performance changes.

Users can still export the application's privacy-safe diagnostics from Settings.
An export describes the device/session that produced it; pooled devices and
unlike provider workloads do not establish a comparable performance trend.
Do not invent measurements or claim that historical reports validate new source.
