# Opt-in native performance captures

`scripts/native-performance.mjs` measures an **existing production desktop
executable** on macOS or Windows. It is deliberately outside `npm run verify`,
CI, and the release scripts. It does not build, sign, tag, publish, or contact a
provider. Run it manually on each native OS when a change needs actual desktop
evidence. The script and its unit tests need only Node 20.19 or later.

## Prepare a comparable environment

Use the same machine, OS release, display setup, power mode, app version or
candidate binary, and probe settings for both captures. Close any existing
Mythra Code instance. Use a dedicated test OS account with no provider logins,
no project data, and networking disconnected or blocked. This matters because
the **app** may read its normal profile or check for updates on launch; the
runner itself cannot enforce an OS network boundary or credential isolation.
Do not run a credentialed everyday profile if the intended scenario is offline.

The default five runs include the first launch in the invocation and four
repeats. “First” means no earlier launch by this invocation. It does **not**
mean a flushed OS file cache, a fresh install, or an empty app profile. For a
profile-cold experiment, start from a fresh test account for each candidate and
record that setup beside the JSON. Do not pool these runs with warm-profile
samples. Run A/B in alternating order when possible to reduce thermal and OS
cache bias, and collect multiple captures before making a decision.

## Capture

Supply an already-built app bundle or executable. The runner uses the
production executable directly; it does not use Vite or a browser preview.
Paths below are examples:

```sh
node scripts/native-performance.mjs capture \
  --app 'src-tauri/target/release/bundle/macos/Mythra Code.app' \
  --output /absolute/path/to/baseline-native.json \
  --label baseline --runs 5 --idle-seconds 30
```

```powershell
node scripts/native-performance.mjs capture `
  --app 'C:\path\to\mythra-code.exe' `
  --output 'C:\path\to\candidate-native.json' `
  --label candidate --runs 5 --idle-seconds 30
```

Each sample launches the app, observes when a visible top-level window belongs
to its process, samples its **main process** once per second during an idle
soak, then stops only that launched process. A failed run remains in the JSON
with an outcome and never contributes a zero or artificially fast duration.
The file is checkpointed after each run, and an existing output file is never
overwritten. `--poll-ms` controls window polling (default 250 ms) and
`--timeout-seconds` controls the visibility timeout (default 30 seconds).

macOS window observation uses System Events and may require Accessibility
permission for Terminal or the shell host. Windows uses a visible window owned
by the launched PID. Both OS probes add latency; each capture records
`windowProbeMs` and the configured polling interval so a small apparent gain
can be judged against observer resolution. Window visibility is **not** a
first paint or interactive marker. A headless, blocked-permission, or crashed
run should be diagnosed rather than counted as a performance result.
The parser and comparison paths have unit coverage, but the complete native
capture loop has not yet been validated with Mythra Code on either OS; treat
first production measurements as a pilot and inspect every sample outcome.

`mainResidentBytes` is macOS `ps` RSS or Windows `WorkingSet64` for the native
main process. `mainCpuMs` is cumulative process CPU time; the summary compares
growth during each idle soak. macOS also records the sampled `ps` CPU percent.
WebKit/WebView2 helpers are excluded: their process ownership is not reliably
comparable across the two platforms, and other open WebViews may share helpers.
This is a main-process resource trend, not whole-app memory or energy use.

## Add real first-use diagnostics

For thread-opening first use, perform a representative local interaction in the
same fresh test profile and export **Settings → General → Diagnostics**. Use
only disposable local data, and do not start a provider turn. Attach the export
after the capture:

```sh
node scripts/native-performance.mjs attach \
  --capture /absolute/path/to/baseline-native.json \
  --diagnostics /absolute/path/to/baseline-diagnostics.json \
  --output /absolute/path/to/baseline-with-first-use.json
```

The attached data retains only the existing scorecard's grouped numeric
thread-open metrics and outcome counts, grouped by provider and warm/cold
state. It discards thread IDs, paths, prompts, and free-form errors. The export
can contain samples from earlier sessions; use a clean profile or treat the
group as historical rather than matched to this launch capture. Its `totalMs`
measures thread opening, **not** process launch or Settings first display.
The same attachment retains the scorecard's aggregate renderer launch markers
when present (`shellCommitMs`, `composerMountedMs`, and `paintOpportunityMs`).
These start at the renderer's declared `startBoundary`, not the native process
spawn, and paint opportunity is not confirmed pixel presentation. The runner
reports them separately from window visibility and compares them only when
both exports use the same boundary. There is no per-process join between the
two clocks.

## Compare A/B captures

```sh
node scripts/native-performance.mjs compare \
  --baseline /absolute/path/to/baseline-with-first-use.json \
  --candidate /absolute/path/to/candidate-with-first-use.json \
  --output /absolute/path/to/native-comparison.json
```

The report gives sample counts, nearest-rank p50/p95/maximum summaries, median
deltas, and warnings when host or probe settings differ or there are fewer than
five successful launches. First-use comparisons include only matching provider
and warm/cold groups and show completed sample counts. A comparison is a
report, not a pass/fail gate; inspect raw samples and probe latency before
calling a regression. The executable SHA-256 in each capture identifies the
measured binary without recording its absolute path.

Run the harness's deterministic unit tests with:

```sh
npx vitest run scripts/native-performance.test.mjs
```
