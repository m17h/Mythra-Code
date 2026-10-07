// Isolated performance tests: opt-in only. Never imported by app/test/CI gates.
import { build, preview } from "vite";
import { chromium, webkit } from "playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createRequire } from "node:module";
import { summarize } from "../scripts/native-performance.mjs";

const lab = dirname(fileURLToPath(import.meta.url));
const repository = dirname(lab);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);
const dependencyVersions = Object.fromEntries(["react", "react-dom", "vite", "playwright"].map((name) => [name, require(`${name}/package.json`).version]));
const usage = `Isolated performance tests (report-only; no performance pass/fail threshold)
Usage: npm run performance:isolated -- [--engine chromium|webkit|all] [--rounds 5] [--warmups 1]
       [--capture PATH] [--output PATH] [--idle-ms 500] [--tail-ms 800]
Each variant replays the entire captured timeline at original speed. Five rounds
plus one warmup take roughly four minutes per engine for the default capture.
No provider, native app, merge/release workflow, or existing CI gate is invoked.`;

function args(argv) {
  const options = { engine: "chromium", rounds: 5, warmups: 1, idleMs: 500, tailMs: 800,
    capture: join(lab, "fixtures/haiku45-community-garden.json"),
    output: join(repository, ".test-artifacts/isolated-performance/report.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help") return null;
    const key = argv[i], value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--engine") options.engine = value;
    else if (key === "--capture" || key === "--output") options[key.slice(2)] = resolve(value);
    else {
      const names = { "--rounds": "rounds", "--warmups": "warmups", "--idle-ms": "idleMs", "--tail-ms": "tailMs" };
      if (!names[key]) throw new Error(`Unknown option ${key}.`);
      const number = Number(value), minimum = key === "--warmups" ? 1 : key === "--rounds" ? 1 : 100;
      const maximum = key === "--rounds" || key === "--warmups" ? 30 : 10000;
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
      options[names[key]] = number;
    }
  }
  if (!["chromium", "webkit", "all"].includes(options.engine)) throw new Error("--engine must be chromium, webkit, or all.");
  return options;
}

function validateCapture(value) {
  if (!value || typeof value.model !== "string" || typeof value.source !== "string" || !Array.isArray(value.events) || !value.events.length) throw new Error("Capture needs model, source, and nonempty events.");
  let previousAt = -1, source = "";
  const events = value.events.map((event) => {
    if (!Number.isFinite(event.at) || event.at < previousAt || event.at < 0 || typeof event.text !== "string") throw new Error("Capture events must contain chronological nonnegative at milliseconds and delta text.");
    previousAt = event.at; source += event.text;
    return { at: event.at, text: event.text };
  });
  if (value.finalText !== undefined && value.finalText !== source) throw new Error("Capture finalText differs from concatenated deltas.");
  if (previousAt > 600000) throw new Error("Capture exceeds the lab's ten-minute timeline limit.");
  return { model: value.model, source: value.source, events };
}

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  }).sort();
}
function sourceHashes() {
  // Full renderer dependency tree and lab source, not only the headline pacer.
  return Object.fromEntries([...filesIn(join(repository, "src")), ...filesIn(lab), join(repository, "package.json"), join(repository, "package-lock.json")]
    .map((path) => [relative(repository, path), sha(readFileSync(path))]));
}
function git(...values) { try { return execFileSync("git", values, { cwd: repository, encoding: "utf8" }).trim(); } catch { return null; } }
function durationCounters(before, after) {
  if (!before || !after) return null;
  const delta = (key, multiplier = 1) => before[key] === undefined || after[key] === undefined ? null : (after[key] - before[key]) * multiplier;
  return {
    scriptDurationMs: delta("ScriptDuration", 1000), layoutDurationMs: delta("LayoutDuration", 1000), recalcStyleDurationMs: delta("RecalcStyleDuration", 1000),
    taskDurationMs: delta("TaskDuration", 1000), layoutCount: delta("LayoutCount"), recalcStyleCount: delta("RecalcStyleCount"),
    jsHeapUsedBytesBefore: before.JSHeapUsedSize ?? null, jsHeapUsedBytesAfter: after.JSHeapUsedSize ?? null,
    jsHeapUsedBytesDelta: delta("JSHeapUsedSize"), domNodesBefore: before.Nodes ?? null, domNodesAfter: after.Nodes ?? null,
    scope: "Chromium page Performance counters from before replay to after completion settling, including renderer and lab instrumentation; not OS process CPU/RSS, raster/GPU time, or retained-heap proof.",
  };
}
function summaries(samples) {
  return Object.fromEntries(["smooth", "lines"].map((variant) => {
    const group = samples.filter((sample) => sample.variant === variant);
    const metric = (fn) => summarize(group.map(fn));
    const every = (fn) => group.length ? group.every(fn) : null;
    const highlightGroup = group.filter((r) => r.highlightsAfterFinish !== null && r.cleanup.highlightsAfterUnmount !== null);
    return [variant, {
      n: group.length, committedRenders: metric((r) => r.committedRenderCount), reactCommittedRenderDurationMs: metric((r) => r.reactCommittedRenderDurationMs),
      scriptDurationMs: metric((r) => r.browserCounters?.scriptDurationMs), layoutDurationMs: metric((r) => r.browserCounters?.layoutDurationMs), recalcStyleDurationMs: metric((r) => r.browserCounters?.recalcStyleDurationMs),
      frameIntervalMs: summarize(group.flatMap((r) => r.frameIntervalsMs)), stallsOver50Ms: metric((r) => r.framesOver50Ms),
      finishVisibleTailMs: metric((r) => r.finalVisibleTailMs), completedPlainLineLatencyMs: summarize(group.flatMap((r) => r.lineLatency.map((line) => line.latencyMs))),
      inputLatenessMs: summarize(group.flatMap((r) => r.inputLatenessMs)), observerTimeMs: metric((r) => r.measurementObserverTimeMs),
      retainedDomNodes: metric((r) => r.retainedDomNodes), allExactSource: every((r) => r.exactSourceAtFinish), allExactVisibleText: every((r) => r.exactVisibleTextAtFinish),
      allUnmountedDomEmpty: every((r) => r.cleanup.domNodesAfterUnmount === 0),
      allLineProbesRemoved: every((r) => r.lineProbesAfterFinish === 0 && r.cleanup.lineProbesAfterUnmount === 0),
      allFadeStylesRemoved: every((r) => r.fadeStylesAfterFinish === 0 && r.cleanup.fadeStylesAfterUnmount === 0),
      highlightCleanupSupportedSamples: highlightGroup.length,
      allSupportedHighlightsRemoved: highlightGroup.length ? highlightGroup.every((r) => r.highlightsAfterFinish === 0 && r.cleanup.highlightsAfterUnmount === 0) : null,
      allIdleSchedulingStopped: every((r) => Object.values(r.cleanup.idleCallbacks).every((n) => n === 0) && r.cleanup.idle.pendingRaf === 0 && r.cleanup.idle.pendingTimeout === 0 && r.cleanup.idle.pendingInterval === 0),
      allUnmountedSchedulingStopped: every((r) => Object.values(r.cleanup.unmountCallbacks).every((n) => n === 0) && r.cleanup.unmounted.pendingRaf === 0 && r.cleanup.unmounted.pendingTimeout === 0 && r.cleanup.unmounted.pendingInterval === 0),
    }];
  }));
}

async function measure(engine, options, capture, url, checkpoint) {
  const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });
  const samples = [], warmups = [];
  try {
    const version = browser.version();
    checkpoint({ engine, version, status: "running", warmups, samples, summary: summaries(samples) });
    // Keep this page across warmups and alternating pairs so code warming is
    // meaningful. Every replay unmounts, audits cleanup, and creates a new root.
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: "no-preference" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    let session = null, counters = {};
    if (engine === "chromium") { session = await context.newCDPSession(page); await session.send("Performance.enable"); }
    await page.exposeBinding("isolatedBoundary", async (_source, phase) => {
      if (session) counters[phase] = Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.isolatedPerformance?.ready === true);
    for (let round = -options.warmups; round < options.rounds; round++) {
      const order = ((round + options.warmups) % 2) === 0 ? ["smooth", "lines"] : ["lines", "smooth"];
      for (const variant of order) {
        console.error(`${engine}: ${round < 0 ? "warmup" : `round ${round + 1}/${options.rounds}`} ${variant}`);
        counters = {};
        const result = await page.evaluate(async ({ variant, capture, idleMs, tailMs }) => window.isolatedPerformance.run(variant, capture, { idleMs, tailMs }), { variant, capture, idleMs: options.idleMs, tailMs: options.tailMs });
        if (pageErrors.length) throw new Error(`Renderer errors: ${pageErrors.join("; ")}`);
        const sample = { round: round < 0 ? round + options.warmups : round, order, ...result, browserCounters: durationCounters(counters.start, counters.end) };
        (round < 0 ? warmups : samples).push(sample);
        checkpoint({ engine, version, status: "running", warmups, samples, summary: summaries(samples) });
      }
    }
    return { engine, version, status: "complete", warmups, samples, summary: summaries(samples) };
  } finally { await browser.close(); }
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  const captureBytes = readFileSync(options.capture);
  const capture = validateCapture(JSON.parse(captureBytes));
  const sources = sourceHashes();
  const outputDirectory = mkdtempSync(join(os.tmpdir(), "mythra-isolated-performance-"));
  await build({ configFile: join(lab, "vite.config.mjs"), build: { outDir: outputDirectory, emptyOutDir: true } });
  const builtFiles = Object.fromEntries(filesIn(outputDirectory).map((path) => [relative(outputDirectory, path), sha(readFileSync(path))]));
  const server = await preview({ configFile: join(lab, "vite.config.mjs"), build: { outDir: outputDirectory }, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Local lab server has no TCP port.");
  const url = `http://127.0.0.1:${address.port}/`;
  const report = {
    schemaVersion: 1, name: "Isolated performance tests", status: "running", generatedAt: new Date().toISOString(),
    source: { gitHead: git("rev-parse", "HEAD"), gitStatus: git("status", "--short"), hashes: sources, builtFiles, buildDirectory: outputDirectory },
    host: { platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model ?? null, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
    renderer: { dependencyVersions, viewport: { width: 1400, height: 900 }, messageHostWidthPx: 760, layoutScope: "Direct message renderer in fixed-width host with shared app CSS; does not mount the full Work history modal typography/layout or autoscroll.", headless: true, reducedMotion: "no-preference", buildTarget: "es2022", buildMode: "production-minified-react-profiling", session: "One fresh context/page per engine; warmup and measured pairs share that page; each replay unmounts and audits cleanup." },
    capture: { path: options.capture, sha256: sha(captureBytes), model: capture.model, source: capture.source, events: capture.events.length, sourceCodeUnits: capture.events.reduce((sum, event) => sum + event.text.length, 0), timelineMs: capture.events.at(-1).at },
    options, limits: [
      "Report-only paired fixture replay; no speed threshold, provider runtime, native-app CPU/RSS, battery, or GPU measurement.",
      "Actual production AssistantMessageMarkdown and controllers, minified profiling React renderer; profiling/observation overhead differs from the shipped app.",
      "Both variants share the current Markdown renderer and CSS; smooth is the existing controller mode, not a complete historical app checkout.",
      "Original provider timestamps replayed after capture; capture/provider overhead is excluded. Input scheduler lateness is reported separately.",
      "Chromium CDP script/layout counters include lab observer work. WebKit unsupported counters are null. React duration covers committed render work; abandoned attempts are unobserved.",
      "Frame gaps are observed browser frame scheduling opportunities, not GPU measurements or guarantees of displayed pixels.",
      "Approximate heap snapshots use no forced GC. DOM counts and cleanup prove their named observations, not absence of every memory leak.",
    ], engines: [],
  };
  const save = () => {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  };
  try {
    for (const engine of options.engine === "all" ? ["chromium", "webkit"] : [options.engine]) {
      const checkpoint = (value) => {
        const index = report.engines.findIndex((item) => item.engine === engine);
        if (index === -1) report.engines.push(value); else report.engines[index] = value;
        save();
      };
      checkpoint(await measure(engine, options, capture, url, checkpoint));
    }
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  } finally { await server.close(); }
  report.status = "complete";
  report.source.changedDuringMeasurement = JSON.stringify(sources) !== JSON.stringify(sourceHashes());
  report.warnings = [...(options.rounds < 5 ? ["Fewer than five paired rounds; use for harness validation, not a stable performance conclusion."] : []), ...(report.source.changedDuringMeasurement ? ["Source changed during build/capture. Re-run from stable source before attributing results to hashes."] : [])];
  save();
  console.log(`Isolated performance report: ${options.output}`);
  for (const result of report.engines) console.log(JSON.stringify({ engine: result.engine, version: result.version, summary: result.summary }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
