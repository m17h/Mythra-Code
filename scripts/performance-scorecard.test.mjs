import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScorecard, evaluateBudgets, measureBundles, parseArguments, summarizeDiagnostics, summarizeMetric } from "./performance-scorecard.mjs";

const temporaryDirectories = [];

function temporaryDist() {
  const directory = mkdtempSync(join(tmpdir(), "mythra-performance-scorecard-"));
  temporaryDirectories.push(directory);
  const assets = join(directory, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "App-fixture.js"), "export const app = true;\n");
  writeFileSync(join(assets, "ChatTimeline-fixture.js"), "export const timeline = true;\n");
  writeFileSync(join(assets, "Lazy-fixture.js"), "export const lazy = true;\n");
  writeFileSync(join(assets, "index.css"), ".app { color: green; }\n");
  const vite = join(directory, ".vite");
  mkdirSync(vite);
  writeFileSync(join(vite, "manifest.json"), JSON.stringify({
    "_shared.js": { file: "assets/ChatTimeline-fixture.js" },
    "index.html": { file: "assets/ChatTimeline-fixture.js", imports: ["_shared.js"], css: ["assets/index.css"] },
    "src/App.tsx": { file: "assets/App-fixture.js", imports: ["_shared.js"], dynamicImports: ["src/Lazy.tsx"] },
    "src/Lazy.tsx": { file: "assets/Lazy-fixture.js" },
  }));
  writeFileSync(join(vite, "performance-build.json"), JSON.stringify({ schemaVersion: 1, target: "safari13", minified: true }));
  return directory;
}

function temporaryBudgets(directory, profile = {
  appEntryRawBytes: 1,
  startupJsRawBytes: 1,
  startupCssRawBytes: 1,
  totalJsRawBytes: 1,
}) {
  const path = join(directory, "budgets.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    profiles: { "safari13-minified": profile },
    reference: { release: { ref: "v-test", profile: "safari13-minified", appEntryRawBytes: 1, totalJsRawBytes: 1 } },
  }));
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("performance scorecard", () => {
  it("rejects a missing path argument before touching the filesystem", () => {
    expect(() => parseArguments(["--dist"])).toThrow("--dist requires a path");
    expect(() => parseArguments(["--output", "--check"])).toThrow("--output requires a path");
  });

  it("uses nearest-rank percentiles without inventing samples", () => {
    expect(summarizeMetric([10, 20, 30, null, Number.NaN])).toEqual({ n: 3, p50: 20, p95: 30, maximum: 30 });
    expect(summarizeMetric([])).toEqual({ n: 0, p50: null, p95: null, maximum: null });
  });

  it("measures the critical entry and complete JavaScript bundle", async () => {
    const bundles = await measureBundles(temporaryDist());
    expect(bundles.appEntry.path).toBe("assets/App-fixture.js");
    expect(bundles.javascript.files).toBe(3);
    expect(bundles.javascript.rawBytes).toBeGreaterThan(bundles.appEntry.rawBytes);
    expect(bundles.startupJavascript.files).toBe(2);
    expect(bundles.startupJavascript.rawBytes).toBeLessThan(bundles.javascript.rawBytes);
    expect(bundles.startupStylesheets.files).toBe(1);
    expect(bundles.css.files).toBe(1);
  });

  it("reports byte growth without failing a valid production build", async () => {
    const bundles = await measureBundles(temporaryDist());
    const evaluation = evaluateBudgets(bundles, {
      appEntryRawBytes: 1,
      startupJsRawBytes: 1,
      startupCssRawBytes: 1,
      totalJsRawBytes: 1,
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.policy).toBe("report-only-byte-growth");
    expect(evaluation.checks).toEqual([
      expect.objectContaining({ metric: "appEntryRawBytes", passed: true, withinReference: false, actual: bundles.appEntry.rawBytes, deltaBytes: bundles.appEntry.rawBytes - 1 }),
      expect.objectContaining({ metric: "startupJsRawBytes", passed: true, withinReference: false, actual: bundles.startupJavascript.rawBytes }),
      expect.objectContaining({ metric: "startupCssRawBytes", passed: true, withinReference: false, actual: bundles.startupStylesheets.rawBytes }),
      expect.objectContaining({ metric: "totalJsRawBytes", passed: true, withinReference: false, actual: bundles.javascript.rawBytes }),
    ]);
  });

  it("includes static raw and gzip totals with comparable release history", async () => {
    const dist = temporaryDist();
    const scorecard = await createScorecard({ dist, budgets: temporaryBudgets(dist), diagnostics: null });
    expect(scorecard.staticMetrics.startupCombinedRawBytes).toBe(
      scorecard.bundles.startupJavascript.rawBytes + scorecard.bundles.startupStylesheets.rawBytes,
    );
    expect(scorecard.staticMetrics.totalCombinedGzipBytes).toBe(
      scorecard.bundles.javascript.gzipBytes + scorecard.bundles.css.gzipBytes,
    );
    expect(scorecard.historicalComparisons).toEqual([expect.objectContaining({
      name: "release",
      ref: "v-test",
      comparisons: {
        appEntryRawBytes: expect.objectContaining({ deltaBytes: scorecard.bundles.appEntry.rawBytes - 1 }),
        totalJsRawBytes: expect.objectContaining({ deltaBytes: scorecard.bundles.javascript.rawBytes - 1 }),
      },
    })]);
  });

  it("writes a machine-readable artifact and exits successfully on growth", () => {
    const dist = temporaryDist();
    const budgets = temporaryBudgets(dist);
    const output = join(dist, "scorecard.json");
    const result = spawnSync(process.execPath, [
      join(import.meta.dirname, "performance-scorecard.mjs"), "--dist", dist, "--budgets", budgets, "--check", "--output", output,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Performance scorecard (safari13-minified, report-only growth)");
    expect(result.stderr).toContain("startupJsRawBytes: +");
    const scorecard = JSON.parse(readFileSync(output, "utf8"));
    expect(scorecard.budgetEvaluation).toMatchObject({ passed: true, policy: "report-only-byte-growth" });
    expect(scorecard.budgetEvaluation.checks.every((check) => check.withinReference === false)).toBe(true);
  });

  it("keeps an unprofiled release reference visible without inventing a comparison", async () => {
    const dist = temporaryDist();
    const budgets = temporaryBudgets(dist);
    writeFileSync(budgets, JSON.stringify({
      schemaVersion: 1,
      profiles: { "safari13-minified": { appEntryRawBytes: 1, startupJsRawBytes: 1, startupCssRawBytes: 1, totalJsRawBytes: 1 } },
      reference: { release: { ref: "v-test", appEntryRawBytes: 7, totalJsRawBytes: 9 } },
    }));
    const scorecard = await createScorecard({ dist, budgets, diagnostics: null });
    expect(scorecard.historicalComparisons).toEqual([expect.objectContaining({
      name: "release",
      profile: null,
      comparable: false,
      referenceMetrics: { appEntryRawBytes: 7, totalJsRawBytes: 9 },
      comparisons: {},
    })]);
  });

  it("rejects missing profile references and unsupported build metadata", async () => {
    const dist = temporaryDist();
    const budgets = temporaryBudgets(dist, { appEntryRawBytes: 1 });
    await expect(createScorecard({ dist, budgets, diagnostics: null })).rejects.toThrow("Invalid or missing performance profile reference: startupJsRawBytes");
    writeFileSync(join(dist, ".vite", "performance-build.json"), JSON.stringify({ schemaVersion: 1, target: "unknown", minified: true }));
    await expect(createScorecard({ dist, budgets, diagnostics: null })).rejects.toThrow("Unsupported performance build profile");
    const result = spawnSync(process.execPath, [
      join(import.meta.dirname, "performance-scorecard.mjs"), "--dist", dist, "--budgets", budgets, "--check",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported performance build profile");
  });

  it("rejects a missing measured startup stylesheet", async () => {
    const dist = temporaryDist();
    writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "assets/ChatTimeline-fixture.js" },
      "src/App.tsx": { file: "assets/App-fixture.js" },
    }));
    await expect(measureBundles(dist)).rejects.toThrow("missing a startup or total JavaScript/CSS measurement");
  });

  it("summarizes renderer-navigation stages without carrying private fields", () => {
    const launch = (shellCommit, composerMounted, paintOpportunity) => ({
      kind: "performance.rendererLaunch",
      threadId: "private-thread",
      payload: {
        schemaVersion: 1,
        startBoundary: "rendererNavigation",
        durationMs: { shellCommit, composerMounted, paintOpportunity },
        path: "/private/path",
        prompt: "private prompt",
      },
    });
    const summary = summarizeDiagnostics({ auditEvents: [
      launch(10, 12, 15),
      launch(20, null, 30),
      launch(30, 35, 40),
      launch(-1, Number.NaN, 50),
      { ...launch(1, 2, 3), payload: { ...launch(1, 2, 3).payload, startBoundary: "processStart" } },
      { ...launch(1, 2, 3), payload: { ...launch(1, 2, 3).payload, schemaVersion: 2 } },
    ] });
    expect(summary.rendererLaunch).toEqual({
      startBoundary: "rendererNavigation",
      sampleCount: 4,
      metrics: {
        shellCommitMs: { n: 3, p50: 20, p95: 30, maximum: 30 },
        composerMountedMs: { n: 2, p50: 12, p95: 35, maximum: 35 },
        paintOpportunityMs: { n: 4, p50: 30, p95: 50, maximum: 50 },
      },
    });
    expect(summary.sampleCount).toBe(0);
    expect(JSON.stringify(summary)).not.toMatch(/private-thread|\/private\/path|private prompt|processStart/);
  });

  it("groups real samples without carrying thread ids, paths, or free-form payloads", () => {
    const diagnostics = {
      appVersion: "1.12.0",
      platform: "macos",
      architecture: "aarch64",
      generatedAt: 123,
      stateDatabase: "/secret/database",
      auditEvents: [
        ...[10, 20].map((timelineCommit, index) => ({
        kind: "performance.threadOpen",
        createdAt: 200 - index * 100,
        threadId: `secret-thread-${index}`,
        payload: {
          provider: "openai",
          warm: false,
          outcome: "completed",
          phase: "secret free-form phase",
          durationMs: { timelineCommit, timelinePaintOpportunity: timelineCommit + 2, runtimeReady: timelineCommit + 5, total: timelineCommit + 5 },
          history: { projectedBytes: 1_000 + index, messages: 2, activities: 3 },
          render: { rows: 5, timelineDomNodes: 20, totalDomNodes: 100 },
          longTasks: { count: 0, maximumDurationMs: 0 },
          javascriptHeap: { usedBytes: 2_000 },
          transcriptCache: { estimatedBytes: 3_000, hydratedThreads: 1, selectedEstimatedBytes: 3_000 },
          processMemory: { managedProcessTreeResidentBytes: 4_000 + index * 100, managedProcessCount: 2, cached: false },
        },
        })),
        {
          kind: "performance.runtimeTurn",
          threadId: "secret-runtime-thread",
          payload: {
            provider: "openai",
            outcome: "completed",
            observedDurationMs: 200,
            streaming: { deltaCalls: 20, deltaCharacters: 500, flushes: 4, queuedFrames: 3, queueToFrameMaximumMs: 12, flushWorkMaximumMs: 3 },
            persistence: { writes: 0, failures: 0, estimatedBytes: 0, durationTotalMs: 0, durationMaximumMs: 0 },
          },
        },
        { kind: "performance.composer", payload: { provider: "openai", samples: 3, inputToFrameMs: [4, 8, 12], ignored: "private" } },
      ],
    };

    const summary = summarizeDiagnostics(diagnostics);

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      provider: "openai",
      warm: false,
      n: 2,
      completedN: 2,
      outcomes: { completed: 2 },
      metrics: {
        timelineCommitMs: { n: 2, p50: 10, p95: 20, maximum: 20 },
        timelinePaintOpportunityMs: { n: 2, p50: 12, p95: 22, maximum: 22 },
        runtimeAfterVisibleMs: { n: 2, p50: 5, p95: 5, maximum: 5 },
        runtimeAfterPaintOpportunityMs: { n: 2, p50: 3, p95: 3, maximum: 3 },
        visibleHistoryEntries: { n: 2, p50: 5, p95: 5, maximum: 5 },
      },
    });
    expect(summary.runtimeGroups[0]).toMatchObject({
      provider: "openai",
      n: 1,
      completedN: 1,
      metrics: {
        deltaCharacters: { n: 1, p50: 500, p95: 500, maximum: 500 },
        queuedFrames: { n: 1, p50: 3, p95: 3, maximum: 3 },
        flushWorkMaximumMs: { n: 1, p50: 3, p95: 3, maximum: 3 },
      },
    });
    expect(summary.composerGroups).toEqual([{
      provider: "openai",
      metrics: { inputToFrameMs: { n: 3, p50: 8, p95: 12, maximum: 12 } },
    }]);
    expect(summary.memoryGrowth).toMatchObject({
      javascriptHeapUsedBytes: { n: 2, delta: 0, perSample: 0 },
      managedResidentBytes: { n: 2, delta: -100, perSample: -100 },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-thread");
    expect(serialized).not.toContain("secret free-form");
    expect(serialized).not.toContain("/secret/database");
  });

  it("does not let incomplete opens make completed latency look faster", () => {
    const summary = summarizeDiagnostics({
      appVersion: "1.12.0-not private",
      auditEvents: [
        { kind: "performance.threadOpen", payload: { provider: "openai", warm: true, outcome: "completed", durationMs: { total: 100 } } },
        { kind: "performance.threadOpen", payload: { provider: "openai", warm: true, outcome: "abandoned", durationMs: { total: 1 } } },
      ],
    });
    expect(summary.source.appVersion).toBeNull();
    expect(summary.groups[0]).toMatchObject({
      n: 2,
      completedN: 1,
      outcomes: { completed: 1, abandoned: 1 },
      metrics: { totalMs: { n: 1, p50: 100, p95: 100, maximum: 100 } },
    });
  });
});
