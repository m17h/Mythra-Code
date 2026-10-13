# Isolated performance lab retired

Automated browser replay, fixture validation and performance measurements are
disabled until Morgan explicitly reintroduces them. Do not run the isolated lab,
install browser engines for it or make its output a contribution/release gate.

Historical reports used a captured Claude response and the production message
renderer inside a separate profiling frontend. They describe that fixture,
recorded engine and observer overhead; they do not establish whole-application
CPU, native WebView behavior, battery use or inference latency. Frames were
rendering opportunities rather than confirmed screen presentation.

Preserve retained reports/fixtures and user data. Removed harness paths in older
reports are historical references. See [performance notes](../PERFORMANCE.md).
