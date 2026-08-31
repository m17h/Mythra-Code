import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

export const SCORECARD_SCHEMA_VERSION = 1;
const root = resolve(import.meta.dirname, "..");
const defaultBudgetsPath = resolve(root, "scripts/performance-budgets.json");

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolean(value) {
  return typeof value === "boolean" ? value : null;
}

function enumValue(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function semver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizeMetric(values) {
  const sorted = values.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!sorted.length) return { n: 0, p50: null, p95: null, maximum: null };
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: sorted.at(-1),
  };
}

function sanitizedThreadOpenSample(event) {
  if (event?.kind !== "performance.threadOpen") return null;
  const payload = object(event.payload);
  const duration = object(payload.durationMs);
  const history = object(payload.history);
  const render = object(payload.render);
  const longTasks = object(payload.longTasks);
  const javascriptHeap = object(payload.javascriptHeap);
  const transcriptCache = object(payload.transcriptCache);
  const processMemory = object(payload.processMemory);
  const timelineCommitMs = finite(duration.timelineCommit);
  const runtimeReadyMs = finite(duration.runtimeReady);
  return {
    createdAt: finite(event.createdAt),
    provider: enumValue(payload.provider, ["openai", "openrouter", "lmstudio", "claude", "cursor"], "unknown"),
    warm: boolean(payload.warm),
    outcome: enumValue(payload.outcome, ["completed", "error", "abandoned", "superseded"], "unknown"),
    processMemoryCached: boolean(processMemory.cached),
    metrics: {
      shellCommitMs: finite(duration.shellCommit),
      historyHydratedMs: finite(duration.historyHydrated),
      timelineCommitMs,
      runtimeReadyMs,
      runtimeAfterVisibleMs: timelineCommitMs !== null && runtimeReadyMs !== null
        ? Math.max(0, runtimeReadyMs - timelineCommitMs)
        : null,
      totalMs: finite(duration.total),
      projectedHistoryBytes: finite(history.projectedBytes),
      visibleHistoryEntries: [finite(history.messages), finite(history.activities)].every((value) => value !== null)
        ? finite(history.messages) + finite(history.activities)
        : null,
      renderedRows: finite(render.rows),
      timelineDomNodes: finite(render.timelineDomNodes),
      totalDomNodes: finite(render.totalDomNodes),
      longTaskCount: finite(longTasks.count),
      maximumLongTaskMs: finite(longTasks.maximumDurationMs),
      javascriptHeapUsedBytes: finite(javascriptHeap.usedBytes),
      transcriptCacheBytes: finite(transcriptCache.estimatedBytes),
      hydratedThreads: finite(transcriptCache.hydratedThreads),
      selectedTranscriptBytes: finite(transcriptCache.selectedEstimatedBytes),
      managedResidentBytes: finite(processMemory.managedProcessTreeResidentBytes),
      managedProcessCount: finite(processMemory.managedProcessCount),
    },
  };
}

function sanitizedRuntimeTurnSample(event) {
  if (event?.kind !== "performance.runtimeTurn") return null;
  const payload = object(event.payload);
  const streaming = object(payload.streaming);
  const persistence = object(payload.persistence);
  return {
    provider: enumValue(payload.provider, ["openai", "openrouter", "lmstudio", "claude", "cursor"], "unknown"),
    outcome: enumValue(payload.outcome, ["completed", "interrupted", "error", "abandoned"], "unknown"),
    metrics: {
      observedDurationMs: finite(payload.observedDurationMs),
      deltaCalls: finite(streaming.deltaCalls),
      deltaCharacters: finite(streaming.deltaCharacters),
      flushes: finite(streaming.flushes),
      queueToFrameAverageMs: finite(streaming.queueToFrameAverageMs),
      queueToFrameMaximumMs: finite(streaming.queueToFrameMaximumMs),
      queueToFrameOverBudget: finite(streaming.queueToFrameOverBudget),
      flushWorkAverageMs: finite(streaming.flushWorkAverageMs),
      flushWorkMaximumMs: finite(streaming.flushWorkMaximumMs),
      flushWorkOverBudget: finite(streaming.flushWorkOverBudget),
      persistenceWrites: finite(persistence.writes),
      persistenceFailures: finite(persistence.failures),
      persistenceEstimatedBytes: finite(persistence.estimatedBytes),
      persistenceDurationTotalMs: finite(persistence.durationTotalMs),
      persistenceDurationMaximumMs: finite(persistence.durationMaximumMs),
    },
  };
}

function sanitizedComposerSample(event) {
  if (event?.kind !== "performance.composer") return null;
  const payload = object(event.payload);
  const values = Array.isArray(payload.inputToFrameMs)
    ? payload.inputToFrameMs.map(finite).filter((value) => value !== null).slice(0, 64)
    : [];
  if (!values.length) return null;
  return {
    provider: enumValue(payload.provider, ["openai", "openrouter", "lmstudio", "claude", "cursor"], "unknown"),
    values,
  };
}

function summarizeGrowth(values) {
  const samples = values.map(finite).filter((value) => value !== null);
  if (!samples.length) return { n: 0, first: null, last: null, delta: null, perSample: null, maximum: null };
  const first = samples[0];
  const last = samples.at(-1);
  return {
    n: samples.length,
    first,
    last,
    delta: last - first,
    perSample: samples.length > 1 ? Math.round(((last - first) / (samples.length - 1)) * 100) / 100 : null,
    maximum: Math.max(...samples),
  };
}

function summarizeRuntimeGroups(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const group = groups.get(sample.provider) ?? { provider: sample.provider, samples: [] };
    group.samples.push(sample);
    groups.set(sample.provider, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.provider.localeCompare(right.provider))
    .map((group) => {
      const completedSamples = group.samples.filter((sample) => sample.outcome === "completed");
      const metricNames = Object.keys(group.samples[0]?.metrics ?? {});
      return {
        provider: group.provider,
        n: group.samples.length,
        completedN: completedSamples.length,
        outcomes: Object.fromEntries(["completed", "interrupted", "error", "abandoned", "unknown"].map((outcome) => [
          outcome,
          group.samples.filter((sample) => sample.outcome === outcome).length,
        ])),
        metrics: Object.fromEntries(metricNames.map((name) => [
          name,
          summarizeMetric(completedSamples.map((sample) => sample.metrics[name])),
        ])),
      };
    });
}

export function summarizeDiagnostics(input) {
  const diagnostics = object(input);
  const auditEvents = Array.isArray(diagnostics.auditEvents) ? diagnostics.auditEvents : [];
  const samples = auditEvents.map(sanitizedThreadOpenSample).filter(Boolean);
  const runtimeSamples = auditEvents.map(sanitizedRuntimeTurnSample).filter(Boolean);
  const composerSamples = auditEvents.map(sanitizedComposerSample).filter(Boolean);
  const chronologicalCompletedSamples = samples
    .filter((sample) => sample.outcome === "completed")
    .map((sample, index) => ({ sample, order: sample.createdAt ?? index }))
    .sort((left, right) => left.order - right.order)
    .map(({ sample }) => sample);
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.provider}\0${String(sample.warm)}`;
    const group = groups.get(key) ?? { provider: sample.provider, warm: sample.warm, samples: [] };
    group.samples.push(sample);
    groups.set(key, group);
  }
  return {
    source: {
      appVersion: semver(diagnostics.appVersion),
      platform: enumValue(diagnostics.platform, ["macos", "windows", "linux"], "unknown"),
      architecture: enumValue(diagnostics.architecture, ["x86", "x86_64", "arm", "aarch64"], "unknown"),
      generatedAt: finite(diagnostics.generatedAt),
    },
    sampleCount: samples.length,
    runtimeSampleCount: runtimeSamples.length,
    composerSampleCount: composerSamples.reduce((total, sample) => total + sample.values.length, 0),
    memoryGrowth: {
      javascriptHeapUsedBytes: summarizeGrowth(chronologicalCompletedSamples.map((sample) => sample.metrics.javascriptHeapUsedBytes)),
      transcriptCacheBytes: summarizeGrowth(chronologicalCompletedSamples.map((sample) => sample.metrics.transcriptCacheBytes)),
      managedResidentBytes: summarizeGrowth(chronologicalCompletedSamples.filter((sample) => sample.processMemoryCached === false).map((sample) => sample.metrics.managedResidentBytes)),
    },
    runtimeGroups: summarizeRuntimeGroups(runtimeSamples),
    composerGroups: [...new Set(composerSamples.map((sample) => sample.provider))]
      .sort()
      .map((provider) => ({
        provider,
        metrics: {
          inputToFrameMs: summarizeMetric(composerSamples.filter((sample) => sample.provider === provider).flatMap((sample) => sample.values)),
        },
      })),
    groups: [...groups.values()]
      .sort((left, right) => left.provider.localeCompare(right.provider) || String(left.warm).localeCompare(String(right.warm)))
      .map((group) => {
        const completedSamples = group.samples.filter((sample) => sample.outcome === "completed");
        const outcomes = Object.fromEntries(["completed", "error", "abandoned", "superseded", "unknown"].map((outcome) => [
          outcome,
          group.samples.filter((sample) => sample.outcome === outcome).length,
        ]));
        const metricNames = Object.keys(group.samples[0]?.metrics ?? {});
        return {
          provider: group.provider,
          warm: group.warm,
          n: group.samples.length,
          completedN: completedSamples.length,
          outcomes,
          metrics: Object.fromEntries(metricNames.map((name) => [
            name,
            summarizeMetric(completedSamples.map((sample) => sample.metrics[name])),
          ])),
        };
      }),
  };
}

async function filesUnder(directory) {
  const output = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(directory);
  return output;
}

async function fileMeasurement(path, base) {
  const contents = readFileSync(path);
  return {
    path: relative(base, path).replaceAll("\\", "/"),
    rawBytes: contents.byteLength,
    gzipBytes: gzipSync(contents).byteLength,
  };
}

export async function measureBundles(distDirectory) {
  const dist = resolve(distDirectory);
  if (!existsSync(dist)) throw new Error(`Build output does not exist: ${dist}`);
  const files = await filesUnder(dist);
  const javascript = files.filter((path) => path.endsWith(".js"));
  const css = files.filter((path) => path.endsWith(".css"));
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Vite manifest does not exist: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const startupKeys = new Set();
  const visitManifestEntry = (key) => {
    if (startupKeys.has(key)) return;
    const entry = object(manifest[key]);
    if (!entry.file) throw new Error(`Vite manifest entry is missing: ${key}`);
    startupKeys.add(key);
    for (const importedKey of Array.isArray(entry.imports) ? entry.imports : []) visitManifestEntry(importedKey);
  };
  visitManifestEntry("index.html");
  visitManifestEntry("src/App.tsx");
  const appEntryPath = join(dist, manifest["src/App.tsx"].file);
  const startupJavascriptPaths = [...new Set([...startupKeys]
    .map((key) => manifest[key]?.file)
    .filter((path) => typeof path === "string" && path.endsWith(".js"))
    .map((path) => join(dist, path)))];
  const startupStylesheetPaths = [...new Set([...startupKeys].flatMap((key) => (
    Array.isArray(manifest[key]?.css) ? manifest[key].css : []
  )))].map((path) => join(dist, path));
  const [jsMeasurements, cssMeasurements, appEntry] = await Promise.all([
    Promise.all(javascript.map((path) => fileMeasurement(path, dist))),
    Promise.all(css.map((path) => fileMeasurement(path, dist))),
    fileMeasurement(appEntryPath, dist),
  ]);
  const [startupJavascriptMeasurements, startupStylesheetMeasurements] = await Promise.all([
    Promise.all(startupJavascriptPaths.map((path) => fileMeasurement(path, dist))),
    Promise.all(startupStylesheetPaths.map((path) => fileMeasurement(path, dist))),
  ]);
  const summarizeFiles = (measurements) => ({
    files: measurements.length,
    rawBytes: measurements.reduce((total, file) => total + file.rawBytes, 0),
    gzipBytes: measurements.reduce((total, file) => total + file.gzipBytes, 0),
  });
  return {
    appEntry,
    startupJavascript: summarizeFiles(startupJavascriptMeasurements),
    startupStylesheets: summarizeFiles(startupStylesheetMeasurements),
    javascript: summarizeFiles(jsMeasurements),
    css: summarizeFiles(cssMeasurements),
  };
}

export function evaluateBudgets(bundles, limitsInput) {
  const limits = object(limitsInput);
  const checks = [
    { metric: "appEntryRawBytes", actual: bundles.appEntry.rawBytes, limit: finite(limits.appEntryRawBytes) },
    { metric: "startupJsRawBytes", actual: bundles.startupJavascript.rawBytes, limit: finite(limits.startupJsRawBytes) },
    { metric: "startupCssRawBytes", actual: bundles.startupStylesheets.rawBytes, limit: finite(limits.startupCssRawBytes) },
    { metric: "totalJsRawBytes", actual: bundles.javascript.rawBytes, limit: finite(limits.totalJsRawBytes) },
  ].map((check) => ({ ...check, passed: check.limit !== null && check.actual <= check.limit }));
  return { passed: checks.every((check) => check.passed), checks };
}

export function parseArguments(argv) {
  const options = { dist: resolve(root, "dist"), diagnostics: null, budgets: defaultBudgetsPath, output: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takePath = () => {
      const value = argv[index += 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      return resolve(value);
    };
    if (argument === "--dist") options.dist = takePath();
    else if (argument === "--diagnostics") options.diagnostics = takePath();
    else if (argument === "--budgets") options.budgets = takePath();
    else if (argument === "--output") options.output = takePath();
    else if (argument === "--check") options.check = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(path) {
  const hash = createHash("sha256");
  return new Promise((resolveHash, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

export async function createScorecard(options) {
  const budgets = JSON.parse(readFileSync(options.budgets, "utf8"));
  if (budgets.schemaVersion !== 1) throw new Error("Unsupported performance budget schema");
  const buildMetadata = JSON.parse(readFileSync(join(options.dist, ".vite", "performance-build.json"), "utf8"));
  if (buildMetadata.schemaVersion !== 1 || typeof buildMetadata.target !== "string" || buildMetadata.minified !== true) {
    throw new Error("Performance budgets require a supported minified production build");
  }
  const profile = `${buildMetadata.target}-minified`;
  const limits = object(object(budgets).profiles)[profile];
  if (!limits) throw new Error(`No performance budget profile exists for ${profile}`);
  const bundles = await measureBundles(options.dist);
  const diagnosticInput = options.diagnostics ? JSON.parse(readFileSync(options.diagnostics, "utf8")) : null;
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      buildProfile: profile,
      budgetsSha256: await sha256(options.budgets),
    },
    bundles,
    budgetEvaluation: { profile, ...evaluateBudgets(bundles, limits) },
    realWorld: diagnosticInput ? summarizeDiagnostics(diagnosticInput) : null,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run performance:scorecard -- [--dist PATH] [--diagnostics PATH] [--budgets PATH] [--output PATH] [--check]");
    return;
  }
  const scorecard = await createScorecard(options);
  const text = `${JSON.stringify(scorecard, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, text, "utf8");
  else process.stdout.write(text);
  if (options.check && !scorecard.budgetEvaluation.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
