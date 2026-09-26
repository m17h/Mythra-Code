import assert from "node:assert/strict";
import { test } from "vitest";
import { attachDiagnostics, compareRuns, parseArgs, parseMacProcessSample, sampleErrorCode, summarize, summarizeRun } from "./native-performance.mjs";

const sample = (index, time, resident = 100) => ({
  index,
  outcome: "window-visible",
  windowVisibleMs: time,
  idle: [
    { mainResidentBytes: resident, mainCpuMs: 10 },
    { mainResidentBytes: resident + 10, mainCpuMs: 25 },
  ],
});

const run = (hash, samples = [sample(0, 400), sample(1, 300), sample(2, 340)]) => ({
  schemaVersion: 1,
  label: hash,
  app: { sha256: hash },
  host: { platform: "darwin", arch: "arm64", osRelease: "test", cpu: "test-cpu", logicalCpus: 8 },
  options: { idleSeconds: 30, pollMs: 250 },
  samples,
});

test("summaries count failures separately and never treat missing timings as fast samples", () => {
  const capture = run("a", [...run("a").samples, { index: 3, outcome: "error", windowVisibleMs: null, idle: [] }]);
  const summary = summarizeRun(capture);
  assert.equal(summary.n, 4);
  assert.equal(summary.successfulN, 3);
  assert.equal(summary.failedN, 1);
  assert.deepEqual(summary.firstLaunchMs, { n: 1, p50: 400, p95: 400, maximum: 400 });
  assert.deepEqual(summary.repeatLaunchMs, { n: 2, p50: 300, p95: 340, maximum: 340 });
  assert.equal(summary.idleMainCpuGrowthMs.p50, 15);
});

test("comparison reports exact deltas and warns when host or sampling conditions differ", () => {
  const baseline = run("old");
  const candidate = run("new", [sample(0, 450), sample(1, 315), sample(2, 360)]);
  const report = compareRuns(baseline, candidate);
  assert.equal(report.comparable, true);
  assert.deepEqual(report.delta.repeatLaunchP50Ms, { baseline: 300, candidate: 315, delta: 15, percent: 5 });
  candidate.options.pollMs = 500;
  assert.equal(compareRuns(baseline, candidate).comparable, false);
  candidate.options.pollMs = 250;
  candidate.host.cpu = "different-cpu";
  assert.equal(compareRuns(baseline, candidate).comparable, false);
  assert.throws(() => compareRuns({}, candidate), /capture schema/);
});

test("renderer launch markers compare only when their start boundaries match", () => {
  const baseline = run("old");
  const candidate = run("new");
  const marker = (startBoundary, p50) => ({
    startBoundary,
    sampleCount: 5,
    metrics: { shellCommitMs: { p50 }, composerMountedMs: { p50 }, paintOpportunityMs: { p50 } },
  });
  baseline.firstUse = { rendererLaunch: marker("rendererNavigation", 10) };
  candidate.firstUse = { rendererLaunch: marker("rendererNavigation", 12) };
  assert.equal(compareRuns(baseline, candidate).rendererLaunch.paintOpportunityP50Ms.delta, 2);
  candidate.firstUse.rendererLaunch.startBoundary = "otherBoundary";
  const report = compareRuns(baseline, candidate);
  assert.equal(report.rendererLaunch, null);
  assert.match(report.warnings.join(" "), /boundaries differ/);
});

test("statistics exclude invalid numbers and use nearest-rank percentiles", () => {
  assert.deepEqual(summarize([5, -1, NaN, 1, 2, 3, 4]), { n: 5, p50: 3, p95: 5, maximum: 5 });
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, maximum: null });
});

test("macOS ps metrics parse short and day-spanning CPU time", () => {
  assert.deepEqual(parseMacProcessSample(" 512  2.5  01:02.25 "), {
    mainResidentBytes: 512 * 1024,
    mainCpuPercent: 2.5,
    mainCpuMs: 62_250,
  });
  assert.equal(parseMacProcessSample(" 1  0.0  2-01:00:00 ").mainCpuMs, 176_400_000);
  assert.throws(() => parseMacProcessSample("garbage"), /no process metrics/);
});

test("capture error codes cannot carry executable paths", () => {
  assert.equal(sampleErrorCode(new Error("spawn /private/app/Mythra Code.app/Contents/MacOS/mythra-code EIO")), "native-probe-failed");
  assert.equal(sampleErrorCode(Object.assign(new Error("open /private/file"), { code: "EACCES" })), "executable-not-permitted");
  assert.equal(sampleErrorCode(new Error("Timed out waiting for an accessible visible app window.")), "window-timeout");
});

test("CLI requires explicit app and output and bounds run duration", () => {
  const parsed = parseArgs(["capture", "--app", "/tmp/Mythra Code.app", "--output", "/tmp/results.json"]);
  assert.equal(parsed.runs, 5);
  assert.equal(parsed.idleSeconds, 30);
  assert.throws(() => parseArgs(["capture", "--app", "x", "--output", "y", "--runs", "0"]), /--runs/);
  assert.throws(() => parseArgs(["capture", "--app", "x", "--output", "y", "--unknown", "z"]), /Unknown option/);
  assert.equal(parseArgs(["compare", "--baseline", "a.json", "--candidate", "b.json"]).command, "compare");
  assert.equal(parseArgs(["attach", "--capture", "a.json", "--diagnostics", "d.json", "--output", "b.json"]).command, "attach");
});

test("diagnostics attachment keeps only grouped numeric first-use metrics", () => {
  const enriched = attachDiagnostics(run("hash"), {
    appVersion: "1.18.2",
    platform: "macos",
    architecture: "aarch64",
    auditEvents: [{
      kind: "performance.threadOpen",
      payload: {
        provider: "claude",
        warm: false,
        outcome: "completed",
        threadId: "private-id",
        path: "/private/file",
        durationMs: { shellCommit: 9, total: 42 },
      },
    }, {
      kind: "performance.rendererLaunch",
      payload: {
        schemaVersion: 1,
        startBoundary: "rendererNavigation",
        durationMs: { shellCommit: 12, composerMounted: 20, paintOpportunity: 34 },
        path: "/private/renderer-path",
      },
    }],
  });
  assert.equal(enriched.firstUse.sampleCount, 1);
  assert.equal(enriched.firstUse.groups[0].metrics.totalMs.p50, 42);
  assert.equal(enriched.firstUse.rendererLaunch.metrics.paintOpportunityMs.p50, 34);
  assert.equal(JSON.stringify(enriched).includes("private-id"), false);
  assert.equal(JSON.stringify(enriched).includes("/private/file"), false);
  assert.equal(JSON.stringify(enriched).includes("/private/renderer-path"), false);
});
