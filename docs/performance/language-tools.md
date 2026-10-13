# Historical language-tool measurements

Automated language-tool benchmarks, protocol fixtures and native tests are
disabled until Morgan explicitly reintroduces them. Do not execute old
measurement recipes or make them a merge/release requirement. The observations
below are historical evidence, not validation of new source. Removed tests and
harness paths may be unavailable. See [performance notes](../PERFORMANCE.md).

### Initial macOS observations (2026-10-08)

A direct TypeScript experiment completed 12 correct queries in each mode, with
observed process-group cleanup and unchanged core/harness hashes. Cold mode
started/initialized 12 servers; linger used one. Per-operation median answer
times were approximately 346–363 ms cold and 27–30 ms retained, including process
sampling but excluding cleanup. Retained sampled idle memory was 269.8 MiB.
Three samples per operation are illustrative, not a stable performance target.

An independent native-component comparison ran the preserved original `run()`
and the new implementation on identical small TypeScript fixtures. Both passed
12 queries and started 12 one-shot sessions. Aggregate test time was 3.53 versus
3.57 seconds: no demonstrated query-speed improvement on this fixture. Final
wrapped result bytes changed as follows:

| Operation | Original | New |
| --- | ---: | ---: |
| Definition | 1,108 | 867 |
| References | 1,398 | 890 |
| Hover | 641 | 784 |
| Symbols | 821 | 815 |

Hover grew because the new response includes source identity and explicit result
metadata. Do not claim every response shrinks or that these byte counts are
model-token savings. The native comparison excludes AppHandle launch selection
and its former preliminary probe; registry timing is separate. These observations
do not justify enabling persistent servers without cross-file freshness and
cross-platform ownership evidence.

### Development hashing and native Windows observations

Native Windows verification passed eleven fresh locked installs, thirteen server
roles, real TypeScript and Bash queries, the Solidity native analyzer, and owned
Job Object cancellation. Browser Settings verification is separate: full-modal
Chromium and WebKit checks use controlled IPC fixtures, not a Windows desktop
UI tour or a model autonomously selecting these tools.

The stock unoptimized Windows test build spent about 1,112 ms hashing the
selected executable/SDK identity even on repeated checks. Optimizing only the
same `sha2` dependency reduced that exact boundary to about 55 ms; full-file
hashing and pre/post checks were unchanged. The analogous macOS cold identity
measurement fell from about 569 to 42 ms; its warm memoized path was about
0.44 ms. Selected metadata reads remained about 1–6 ms in these native component
tests; this does not measure complete visual Settings latency.

`Cargo.toml` now applies `opt-level = 3` only to `sha2` in the development profile,
which tests inherit. The application keeps its ordinary development checks.
This is a measured development-build improvement, not a measured release-build
speedup. The release profile already uses compiler optimization; shipping
latency has not been measured here. Cold verification also depends on server
and operating-system caches, so do not attribute its whole elapsed-time change
to hashing alone.
