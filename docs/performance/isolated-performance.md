# Isolated performance tests

Run these tests when you want to understand the cost of a presentation change.
They are optional, report-only measurements: they do not run during `verify`,
unit/browser suites, merge checks, production builds, or releases. The application
does not import the lab. Nothing calls a provider or opens your desktop profile.

```sh
npm run performance:isolated
npm run performance:isolated -- --engine all --output .test-artifacts/isolated-performance/both-engines.json
```

Use the same Node runtime as the repository's hosted checks (currently Node 22)
and the installed Playwright engines. `--help` lists the independent options.
The default uses Chromium; `--engine webkit` measures the installed Playwright
WebKit engine. This is browser evidence on the recorded OS, not evidence for
the Windows native WebView2 or macOS embedded WebKit build. The runner records
the actual engine version, CPU/OS/architecture, Node version, source hashes,
build hashes, capture hash, individual repetitions and summaries.

The fixture is a genuine Claude Code Haiku 4.5 response captured on 2026-10-07.
Its public garden-writing prompt and original arrival times are included in
`performance-lab/fixtures/haiku45-community-garden.json`. Cumulative events were
losslessly converted to delta text to avoid duplicating the complete essay
hundreds of times. Each replay supplies all 662 events over about 16.6 seconds,
without running inference or including capture/provider overhead in the result.
Input lateness records how accurately the browser follows the original times.

Both variants use the actual production `AssistantMessageMarkdown`, Markdown
plugins, CSS and controllers. `smooth` selects the existing presentation and
`lines` selects the Work history presentation. The baseline is that existing
controller mode inside this source tree, not an old complete application build.
The lab compiles an independent minified frontend with React's profiling renderer
so committed rendering can be observed. It adds profiling overhead to both
variants and does not measure the exact shipped binary.
The message host is 760 pixels wide with shared application CSS. It mounts the
renderer directly, not the complete Work history modal, its typography/layout,
or its autoscroll. Line wrapping and cost can differ inside that real modal.

One warmup pair precedes five measured pairs in one credential-free page per
engine. Ordering alternates. Each replay creates a new React root, finishes,
observes idle scheduling, unmounts, and checks cleanup. Keeping the page allows
code warming and also exposes leftover page decorations. Warmup samples are
retained separately and excluded from summaries. A smaller pilot is useful for
checking the harness, but is labeled as insufficient for a stable conclusion:

```sh
npm run performance:isolated -- --rounds 1 --warmups 1 --output .test-artifacts/isolated-performance/pilot.json
```

Allow roughly four minutes per engine with the default fixture/settings. Avoid
other builds, profile tools or busy applications during a comparative run. Keep
display, power mode, viewport, engine, dependencies and fixture fixed. Compare
raw paired samples and p50/p95 spread before attributing a change to the renderer.
No arbitrary speed threshold produces a pass or fail. Source changes during the
measurement produce a warning; repeat from stable source before drawing conclusions.
The temporary lab build and JSON report are retained for inspection.
The JSON is checkpointed after each replay; an interrupted run stays marked
`running`, and an observed failure stays marked `failed` with completed samples.
`complete` means the measurements finished, not that every correctness or
cleanup observation passed. Inspect those fields explicitly.

## What the numbers mean

| Measurement | What it supports |
| --- | --- |
| Committed renders / commits | React Profiler callbacks for completed updates of the real renderer. Both counts describe the same commit events; abandoned attempts and individual Markdown parse calls are unavailable. |
| React committed render duration | React's measured work for committed updates. A rendering proxy with profiling overhead, not OS CPU usage. |
| Script, style and layout duration | Chromium page performance counters around replay and completion settling, including lab observation. Unsupported WebKit counters are `null`. Task duration is a broader browser task counter, not whole-app process CPU. |
| Frames and stalls | Browser animation-frame intervals and the number over 50 ms. These are frame opportunities, not confirmed pixel presentation or GPU time. Raw intervals are retained. |
| Line latency | Time from a completed plain source line's recorded arrival to observed visible DOM text. Eligible text must occur exactly once in the final static Markdown output. Syntax, lists, entities, HTML, ambiguous/repeated lines and the incomplete final line are excluded with recorded reasons. Observation waits for both scheduled time and actual receipt, and reads after commits/mutations. This measures source-newline prose lines, not every visual wrap line. |
| Completion text / tail | Received source must concatenate exactly, and final rendered text must match that variant's static production Markdown output. The observed completion tail includes up to two frame opportunities of observation resolution. |
| DOM / heap | Final DOM node count, empty DOM after unmount, optional approximate browser heap snapshots and Chromium heap counters. No forced GC: these do not prove retained-object ownership, total app memory, or absence of every leak. |
| Idle cleanup | Pending timers/intervals/animation frames, callback growth during idle and after unmount, CSS highlights, fade stylesheet count and retained line-measurement probe count. The lab's own replay timers/frame observer bypass this counter. Leak observations are saved before emergency cleanup; unsupported highlight observations remain unavailable. |
| Observer duration | Time spent reading text after commits/mutations for line matching. It is reported separately, but remains included in broad browser script counters. |

Pending work, missing lines, text mismatches and cleanup failures remain in the
report. Read those correctness observations before interpreting apparent speedups.
Measurements are scoped to this message renderer; they do not establish faster
main chat, thread loading, inference, battery use, or the entire desktop app.
The default fixture has six eligible unique plain prose lines. Other source
lines have formatting or an incomplete final line and are outside latency
coverage. Validate the generic matcher independently with:

```sh
node performance-lab/validate-line-targets.mjs
```

For a short real-browser harness check in both engines, use the synthetic
validation fixture. It includes wrapping prose, lists, an entity, HTML and
duplicate lines. Its timings are validation data, not comparative evidence:

```sh
npm run performance:isolated -- --engine all --rounds 1 --warmups 1 \
  --capture performance-lab/fixtures/line-target-validation.json \
  --output .test-artifacts/isolated-performance/final-validation.json
```

## Optional actual process CPU and resident memory

Use an existing production executable in a dedicated test OS account/profile
and follow [the native capture guide](native-harness.md). The existing opt-in
`scripts/native-performance.mjs` records actual native main-process cumulative
CPU time and RSS/working set. It does not include WebView helper processes, and
its default scenario is launch/idle rather than this captured streaming replay.
Keep its report separate from the browser fixture report. For example:

```sh
node scripts/native-performance.mjs capture --app '/absolute/path/to/Mythra Code.app' \
  --output /absolute/path/to/native-idle.json --label isolated-idle --runs 5 --idle-seconds 30
```

For a real streaming process capture, mark the interaction's start/end in a
native profiler such as Activity Monitor/Instruments on macOS or Task Manager/
Windows Performance Recorder on Windows. Record the exact binary, profile,
scenario, owned helper PIDs and timestamps; measure cumulative CPU differences
and resident memory for those explicitly identified processes. Do not sum
unrelated shared WebViews or turn JavaScript duration into CPU percent. There
is no GPU or whole-app CPU/RSS sampler in this browser lab.

The standalone files use no `.test`/`.spec` naming, live under
`performance-lab/`, and use their own Vite configuration. Existing discovery
includes only `src/` and `scripts/` suites. No CI, merge or release configuration
is changed or required by this lab.
