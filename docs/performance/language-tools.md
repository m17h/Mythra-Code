# Isolated language-tool measurements

These are on-demand experiments, not additional merge or release gates. They
make no model requests, install no tools automatically, and do not use a Mythra
chat profile. Supply an already-installed, trusted server from an isolated QA
installation. Do not point the fixtures at a real project or a user's tool
storage. Use the repository's supported Node runtime, not a newer ambient one.

## What is measured

- Startup and initialization count: how often we start a language server rather
  than reuse an existing one.
- Time to an answer: server initialization, opening the source, querying, and
  cleanup are recorded separately where the harness supports them.
- Response size: raw server results, the compact application result, and the
  final JSON-wrapped model response are different measurements. A smaller answer
  can reduce context, but does not prove a particular model saves tokens or
  solves a task better.
- CPU and memory: direct tests sample identified live server descendants.
  Sampling can miss short-lived workers and costs time itself. These are not
  guaranteed peak memory or complete process-tree CPU measurements.
- Correctness and cleanup: wrong, failed, changed-source, changed-harness, or
  unverified-cleanup runs are not accepted performance comparisons.

## Direct server experiment

Run the small protocol-instrument validation first:

```sh
node performance-lab/language-tools/validate.mjs
```

It checks fragmented frames, configuration requests while idle, source reopen,
late responses, timeouts, empty pending requests, and process-group cleanup.
Its fake server is an instrumentation fixture, not product validation.

For a real TypeScript server, supply absolute Node and server paths:

```sh
node performance-lab/language-tools/bench.mjs \
  --command /absolute/path/to/node \
  --args-json '["/absolute/path/to/typescript-language-server/lib/cli.mjs","--stdio"]' \
  --initialization-json '{"tsserver":{"path":"/absolute/path/to/typescript/lib/tsserver.js","useSyntaxServer":"never"},"disableAutomaticTypingAcquisition":true}' \
  --mode cold --rounds 3 --output /absolute/path/to/cold.json
```

Repeat with `--mode linger` and a separate output file to measure an experimental
retained server. Do not run the comparison modes concurrently: competition for
CPU changes the comparison. Reports retain synthetic projects, source/server
and harness hashes, failures, observed cleanup and platform information. The
source drift check covers four core Rust files, not the whole repository or
fixture tree. Launch-file hashes are captured before execution; they are not
proof that every installed dependency remained unchanged during the run.

The fixture has imported TypeScript files and 150 function symbols. It checks
definitions, references, hover and symbols. This is a direct protocol client;
it does **not** execute Mythra's authenticated bridge, launch selection, settings,
or project-authorization logic. Retained sessions are **not enabled in Mythra**.
Repeated answers on an unchanged fixture do not establish imported-file,
configuration, branch, permission or crash freshness.

The direct benchmark refuses Windows execution because Node alone does not
provide Mythra's kill-on-close Job Object ownership. Use native tests instead.
Unix cleanup proves bounded observed process-group absence after shutdown,
not automatic cleanup after the benchmark parent crashes.

## Native application components

The Rust modules have explicitly ignored, opt-in native measurements:

```sh
cargo test --manifest-path src-tauri/Cargo.toml \
  language_queries::tests::native_query_efficiency_measurement \
  -- --ignored --exact --nocapture

cargo test --manifest-path src-tauri/Cargo.toml \
  language_tools::tests::native_registry_efficiency_smoke \
  -- --ignored --exact --nocapture
```

The query measurement requires `MYTHRA_LANGUAGE_QUERY_BENCH_COMMAND`,
`MYTHRA_LANGUAGE_QUERY_BENCH_ARGS` (a JSON argument array), and optionally
`MYTHRA_LANGUAGE_QUERY_BENCH_INITIALIZATION` (JSON options). It creates an
isolated synthetic project, runs three rounds of the four operations through
the actual one-shot query implementation, and records final response bytes.
Set `MYTHRA_LANGUAGE_QUERY_METRICS=1` for phase timing. It does not include
AppHandle-based launch selection or preliminary health checks in its timing.

The registry measurement requires `MYTHRA_LANGUAGE_EFFICIENCY_ROOT`, an isolated
retained QA root named `mythra-language-tools-<uuid>` under the native temporary
directory. `MYTHRA_LANGUAGE_EFFICIENCY_TOOL` defaults to `typescript`. It measures
selected inventory, executable/runtime identity, and cold versus cached health
checks through the real registry components. It does not measure visual Settings
latency or a complete application turn. Windows conservatively rehashes launch
files; report that cost rather than assuming its cache path costs match macOS.

Use the existing opt-in real query and Windows cancellation tests separately to
validate results and Job Object cleanup. An ignored test is not evidence until
explicitly executed. Native runs must preserve active user applications and use
temporary QA installations and projects.

## Interpreting changes

The production improvement removes the separate preliminary health probe from
shared queries: the query's own successful initialize certifies that exact role.
Settings reads metadata rather than initializing every available server.
Compact filtered results reduce repeated absolute paths and JSON formatting;
limits and omitted counts remain explicit. Claude plugin descriptors are reused
without rewriting identical files.

Stronger executable/SDK identities add hashing work, especially on Windows.
Measure the complete relevant path before claiming an overall latency gain.
Neither lockfiles nor passing initialization prove third-party packages are
vulnerability-free; dated inherited dependency findings are documented in
`src-tauri/language-recipes/README.md`.

Do not turn experimental persistence, broad package deletion, hardlink sharing,
or new performance thresholds into defaults based only on these fixtures. Those
changes require separate lifecycle, freshness and cross-platform evidence.

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
