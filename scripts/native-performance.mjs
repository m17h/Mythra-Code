#!/usr/bin/env node
// Opt-in, local-only measurements of an existing production desktop binary.
// This script never builds, signs, updates, or invokes a provider.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { summarizeDiagnostics } from "./performance-scorecard.mjs";

export const SCHEMA_VERSION = 1;
function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function summarize(values) {
  const sorted = values.filter(finiteNonnegative).sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), maximum: sorted.at(-1) ?? null };
}

export function summarizeRun(run) {
  const successful = run.samples.filter((sample) => sample.outcome === "window-visible");
  const cpuGrowth = (sample) => sample.idle?.length > 1
    ? sample.idle.at(-1).mainCpuMs - sample.idle[0].mainCpuMs
    : null;
  return {
    n: run.samples.length,
    successfulN: successful.length,
    failedN: run.samples.length - successful.length,
    firstLaunchMs: summarize(successful.filter((sample) => sample.index === 0).map((sample) => sample.windowVisibleMs)),
    repeatLaunchMs: summarize(successful.filter((sample) => sample.index > 0).map((sample) => sample.windowVisibleMs)),
    idleMainResidentBytes: summarize(successful.flatMap((sample) => sample.idle ?? []).map((point) => point.mainResidentBytes)),
    idleMainCpuGrowthMs: summarize(successful.map(cpuGrowth)),
  };
}

export function compareRuns(baseline, candidate) {
  validateRun(baseline);
  validateRun(candidate);
  const comparable = baseline.host.platform === candidate.host.platform &&
    baseline.host.arch === candidate.host.arch &&
    baseline.host.osRelease === candidate.host.osRelease &&
    baseline.host.cpu === candidate.host.cpu &&
    baseline.host.logicalCpus === candidate.host.logicalCpus &&
    baseline.options.idleSeconds === candidate.options.idleSeconds &&
    baseline.options.pollMs === candidate.options.pollMs;
  const a = summarizeRun(baseline);
  const b = summarizeRun(candidate);
  const diff = (oldValue, newValue) => oldValue === null || newValue === null ? null : {
    baseline: oldValue,
    candidate: newValue,
    delta: newValue - oldValue,
    percent: oldValue === 0 ? null : ((newValue - oldValue) / oldValue) * 100,
  };
  const firstUse = [];
  for (const oldGroup of baseline.firstUse?.groups ?? []) {
    const newGroup = (candidate.firstUse?.groups ?? []).find((group) =>
      group.provider === oldGroup.provider && group.warm === oldGroup.warm);
    if (!newGroup) continue;
    firstUse.push({
      provider: oldGroup.provider,
      warm: oldGroup.warm,
      baselineN: oldGroup.completedN,
      candidateN: newGroup.completedN,
      totalP50Ms: diff(oldGroup.metrics.totalMs?.p50 ?? null, newGroup.metrics.totalMs?.p50 ?? null),
    });
  }
  const oldRenderer = baseline.firstUse?.rendererLaunch;
  const newRenderer = candidate.firstUse?.rendererLaunch;
  const rendererLaunch = oldRenderer && newRenderer && oldRenderer.startBoundary === newRenderer.startBoundary
    ? {
      startBoundary: oldRenderer.startBoundary,
      baselineN: oldRenderer.sampleCount,
      candidateN: newRenderer.sampleCount,
      shellCommitP50Ms: diff(oldRenderer.metrics.shellCommitMs?.p50 ?? null, newRenderer.metrics.shellCommitMs?.p50 ?? null),
      composerMountedP50Ms: diff(oldRenderer.metrics.composerMountedMs?.p50 ?? null, newRenderer.metrics.composerMountedMs?.p50 ?? null),
      paintOpportunityP50Ms: diff(oldRenderer.metrics.paintOpportunityMs?.p50 ?? null, newRenderer.metrics.paintOpportunityMs?.p50 ?? null),
    }
    : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    comparable,
    warnings: [
      ...(!comparable ? ["Platform, architecture, OS release, CPU, idle duration, or probe interval differ; compare only with care."] : []),
      ...(baseline.firstUse && candidate.firstUse && (
        baseline.firstUse.platform !== candidate.firstUse.platform ||
        baseline.firstUse.architecture !== candidate.firstUse.architecture
      ) ? ["Attached diagnostics come from different platforms or architectures."] : []),
      ...(oldRenderer && newRenderer && oldRenderer.startBoundary !== newRenderer.startBoundary
        ? ["Renderer launch marker boundaries differ; their timings are not compared."] : []),
      ...(a.successfulN < 5 || b.successfulN < 5 ? ["Fewer than five successful launch samples in at least one run."] : []),
      ...(baseline.app.sha256 === candidate.app.sha256 ? ["Both runs use the same executable hash."] : []),
    ],
    baseline: { label: baseline.label, appSha256: baseline.app.sha256, summary: a },
    candidate: { label: candidate.label, appSha256: candidate.app.sha256, summary: b },
    delta: {
      firstLaunchP50Ms: diff(a.firstLaunchMs.p50, b.firstLaunchMs.p50),
      repeatLaunchP50Ms: diff(a.repeatLaunchMs.p50, b.repeatLaunchMs.p50),
      idleMainResidentP50Bytes: diff(a.idleMainResidentBytes.p50, b.idleMainResidentBytes.p50),
      idleMainCpuGrowthP50Ms: diff(a.idleMainCpuGrowthMs.p50, b.idleMainCpuGrowthMs.p50),
    },
    firstUse,
    rendererLaunch,
  };
}

export function attachDiagnostics(run, diagnostics) {
  validateRun(run);
  const summary = summarizeDiagnostics(diagnostics);
  const renderer = summary.rendererLaunch;
  return {
    ...run,
    firstUse: {
      source: "Settings diagnostics export; samples may span sessions unless collected in a fresh test profile",
      appVersion: summary.source.appVersion,
      platform: summary.source.platform,
      architecture: summary.source.architecture,
      sampleCount: summary.sampleCount,
      rendererLaunch: renderer ? {
        startBoundary: renderer.startBoundary,
        sampleCount: renderer.sampleCount,
        metrics: {
          shellCommitMs: renderer.metrics?.shellCommitMs ?? null,
          composerMountedMs: renderer.metrics?.composerMountedMs ?? null,
          paintOpportunityMs: renderer.metrics?.paintOpportunityMs ?? null,
        },
      } : null,
      groups: summary.groups.map(({ provider, warm, n, completedN, outcomes, metrics }) => ({
        provider,
        warm,
        n,
        completedN,
        outcomes,
        metrics: {
          shellCommitMs: metrics.shellCommitMs,
          historyHydratedMs: metrics.historyHydratedMs,
          timelineCommitMs: metrics.timelineCommitMs,
          runtimeReadyMs: metrics.runtimeReadyMs,
          totalMs: metrics.totalMs,
        },
      })),
    },
  };
}

export function validateRun(value) {
  if (value?.schemaVersion !== SCHEMA_VERSION || !value.host || !value.options ||
    !value.app || !Array.isArray(value.samples)) {
    throw new Error(`Expected native performance capture schema ${SCHEMA_VERSION}.`);
  }
}

function positiveInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!["capture", "compare", "attach"].includes(command)) throw new Error(usage());
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage());
    if (values[key] !== undefined) throw new Error(`Duplicate ${key}.`);
    values[key] = value;
  }
  const allowed = command === "capture"
    ? ["--app", "--output", "--label", "--runs", "--idle-seconds", "--poll-ms", "--timeout-seconds"]
    : command === "compare" ? ["--baseline", "--candidate", "--output"]
      : ["--capture", "--diagnostics", "--output"];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unknown option ${key}.`);
  if (command === "compare") {
    if (!values["--baseline"] || !values["--candidate"]) throw new Error(usage());
    return { command, baseline: resolve(values["--baseline"]), candidate: resolve(values["--candidate"]), output: values["--output"] ? resolve(values["--output"]) : null };
  }
  if (command === "attach") {
    if (!values["--capture"] || !values["--diagnostics"] || !values["--output"]) throw new Error(usage());
    return { command, capture: resolve(values["--capture"]), diagnostics: resolve(values["--diagnostics"]), output: resolve(values["--output"]) };
  }
  if (!values["--app"] || !values["--output"]) throw new Error(usage());
  return {
    command,
    app: resolve(values["--app"]),
    output: resolve(values["--output"]),
    label: values["--label"] ?? "native capture",
    runs: positiveInteger(values["--runs"] ?? "5", "--runs", 50),
    idleSeconds: positiveInteger(values["--idle-seconds"] ?? "30", "--idle-seconds", 3600),
    pollMs: positiveInteger(values["--poll-ms"] ?? "250", "--poll-ms", 5000),
    timeoutSeconds: positiveInteger(values["--timeout-seconds"] ?? "30", "--timeout-seconds", 120),
  };
}

function usage() {
  return "Usage: node scripts/native-performance.mjs capture --app PATH --output JSON [--label NAME] [--runs 5] [--idle-seconds 30] [--poll-ms 250] [--timeout-seconds 30]\n" +
    "       node scripts/native-performance.mjs attach --capture JSON --diagnostics JSON --output JSON\n" +
    "       node scripts/native-performance.mjs compare --baseline JSON --candidate JSON [--output JSON]";
}

function executablePath(path) {
  if (!existsSync(path)) throw new Error(`App path does not exist: ${path}`);
  if (process.platform === "darwin") {
    const binary = path.endsWith(".app") ? join(path, "Contents", "MacOS", "mythra-code") : path;
    if (!existsSync(binary) || !statSync(binary).isFile()) throw new Error(`Expected a Mythra Code app bundle or executable: ${path}`);
    return binary;
  }
  if (process.platform === "win32") {
    if (extname(path).toLowerCase() !== ".exe" || !statSync(path).isFile()) throw new Error("Windows requires a production .exe path.");
    return path;
  }
  throw new Error("Native capture supports macOS and Windows only.");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function command(program, args, timeout = 5000) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} probe failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 400)}`);
  return result.stdout.trim();
}

export function parseMacProcessSample(output) {
  const fields = output.trim().split(/\s+/);
  if (fields.length < 3) throw new Error("macOS ps returned no process metrics.");
  const rssKiB = Number(fields[0]);
  const cpuPercent = Number(fields[1]);
  const [daysPart, clockPart] = fields[2].includes("-") ? fields[2].split("-") : ["0", fields[2]];
  const duration = clockPart.split(":").map(Number);
  if (!Number.isFinite(rssKiB) || !Number.isFinite(cpuPercent) ||
    !Number.isFinite(Number(daysPart)) || duration.some((part) => !Number.isFinite(part))) {
    throw new Error("macOS ps returned invalid process metrics.");
  }
  const cpuSeconds = Number(daysPart) * 86400 + duration.reduce((sum, part) => sum * 60 + part, 0);
  return { mainResidentBytes: rssKiB * 1024, mainCpuPercent: cpuPercent, mainCpuMs: cpuSeconds * 1000 };
}

export function sampleErrorCode(error) {
  if (error?.code === "ENOENT") return "executable-not-found";
  if (error?.code === "EACCES") return "executable-not-permitted";
  const message = String(error?.message ?? "");
  if (message.startsWith("App exited before")) return "app-exited-before-window";
  if (message.startsWith("App exited during")) return "app-exited-during-idle";
  if (message.startsWith("Timed out")) return "window-timeout";
  return "native-probe-failed";
}

const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
$processId = __PID__
$p = Get-Process -Id $processId -ErrorAction Stop
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MythraWindowProbe {
  public delegate bool Callback(IntPtr handle, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
$script:visible = $false
$callback = [MythraWindowProbe+Callback] {
  param([IntPtr]$handle, [IntPtr]$extra)
  [uint32]$owner = 0
  [void][MythraWindowProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -eq $processId -and [MythraWindowProbe]::IsWindowVisible($handle)) { $script:visible = $true }
  return $true
}
[void][MythraWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
@{ visible = $script:visible; mainResidentBytes = [int64]$p.WorkingSet64; mainCpuMs = $p.TotalProcessorTime.TotalMilliseconds } | ConvertTo-Json -Compress
`;

function probe(pid) {
  const started = performance.now();
  if (process.platform === "darwin") {
    const metrics = parseMacProcessSample(command("ps", ["-p", String(pid), "-o", "rss=", "-o", "%cpu=", "-o", "time="]));
    const script = `tell application "System Events" to get count of (windows of (first process whose unix id is ${pid}) whose visible is true)`;
    const visible = Number(command("osascript", ["-e", script])) > 0;
    return { visible, ...metrics, probeMs: performance.now() - started };
  }
  const output = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProbe.replace("__PID__", String(pid))], 10_000);
  const value = JSON.parse(output);
  if (typeof value.visible !== "boolean" || !finiteNonnegative(value.mainResidentBytes) || !finiteNonnegative(value.mainCpuMs)) {
    throw new Error("Windows probe returned invalid metrics.");
  }
  return { visible: value.visible, mainResidentBytes: value.mainResidentBytes, mainCpuMs: value.mainCpuMs, mainCpuPercent: null, probeMs: performance.now() - started };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exited = await Promise.race([new Promise((done) => child.once("exit", () => done(true))), delay(3000).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function oneSample(binary, index, options) {
  const started = performance.now();
  const child = spawn(binary, [], { stdio: "ignore", windowsHide: false });
  let spawnError = null;
  child.on("error", (error) => { spawnError = error; });
  const result = { index, outcome: "unknown", windowVisibleMs: null, windowProbeMs: null, idle: [], error: null };
  try {
    const deadline = started + options.timeoutSeconds * 1000;
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`App exited before a visible window (status ${child.exitCode}).`);
      if (!child.pid) { await delay(10); continue; }
      const observation = probe(child.pid);
      if (observation.visible) {
        result.outcome = "window-visible";
        result.windowVisibleMs = Math.round((performance.now() - started) * 100) / 100;
        result.windowProbeMs = Math.round(observation.probeMs * 100) / 100;
        break;
      }
      await delay(options.pollMs);
    }
    if (result.outcome !== "window-visible") throw new Error("Timed out waiting for an accessible visible app window.");
    const idleStart = performance.now();
    while (performance.now() - idleStart < options.idleSeconds * 1000) {
      await delay(Math.min(1000, options.idleSeconds * 1000 - (performance.now() - idleStart)));
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`App exited during idle soak (status ${child.exitCode}).`);
      const observation = probe(child.pid);
      result.idle.push({
        elapsedMs: Math.round(performance.now() - idleStart),
        mainResidentBytes: observation.mainResidentBytes,
        mainCpuMs: observation.mainCpuMs,
        mainCpuPercent: observation.mainCpuPercent,
        probeMs: Math.round(observation.probeMs * 100) / 100,
      });
    }
  } catch (error) {
    result.outcome = "error";
    result.error = sampleErrorCode(error);
  } finally {
    await stopChild(child);
  }
  return result;
}

async function capture(options) {
  const binary = executablePath(options.app);
  const run = {
    schemaVersion: SCHEMA_VERSION,
    label: options.label,
    capturedAt: new Date().toISOString(),
    app: { executable: basename(binary), sha256: await hashFile(binary) },
    host: { platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model ?? null, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    options: { runs: options.runs, idleSeconds: options.idleSeconds, pollMs: options.pollMs, timeoutSeconds: options.timeoutSeconds },
    definitions: {
      firstLaunch: "First process launch in this invocation; OS cache may already be warm.",
      repeatLaunch: "Later process launches in this invocation; app processes are stopped between runs.",
      windowVisible: "Observer returns after finding a visible native top-level window; includes probe latency and is not first paint or interactive readiness.",
      idle: "Main process resident bytes and cumulative CPU time sampled after window visibility; WebView helper processes are excluded.",
    },
    samples: [],
  };
  for (let index = 0; index < options.runs; index++) {
    const sample = await oneSample(binary, index, options);
    run.samples.push(sample);
    writeFileSync(options.output, JSON.stringify(run, null, 2) + "\n");
    process.stderr.write(`Sample ${index + 1}/${options.runs}: ${sample.outcome}${sample.windowVisibleMs === null ? "" : `, window ${sample.windowVisibleMs} ms`}\n`);
    if (sample.outcome !== "window-visible") break;
    if (index + 1 < options.runs) await delay(1000);
  }
  return run;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.output && existsSync(options.output)) throw new Error(`Output already exists: ${options.output}`);
  if (options.command === "attach") {
    const run = attachDiagnostics(JSON.parse(readFileSync(options.capture, "utf8")), JSON.parse(readFileSync(options.diagnostics, "utf8")));
    writeFileSync(options.output, JSON.stringify(run, null, 2) + "\n");
    process.stdout.write(`Attached ${run.firstUse.sampleCount} thread-open samples.\n`);
    return;
  }
  if (options.command === "compare") {
    const report = compareRuns(JSON.parse(readFileSync(options.baseline, "utf8")), JSON.parse(readFileSync(options.candidate, "utf8")));
    const json = JSON.stringify(report, null, 2) + "\n";
    if (options.output) writeFileSync(options.output, json);
    else process.stdout.write(json);
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Native capture supports macOS and Windows only.");
  mkdirSync(dirname(options.output), { recursive: true });
  const run = await capture(options);
  process.stdout.write(JSON.stringify(summarizeRun(run), null, 2) + "\n");
  if (run.samples.some((sample) => sample.outcome !== "window-visible")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
