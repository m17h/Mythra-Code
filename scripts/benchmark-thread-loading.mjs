import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

export const DEFAULT_INITIAL_TURN_LIMIT = 10;
export const MAX_THREAD_PREVIEW_CHARACTERS = 320;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function parseArguments(argv) {
  const options = { codexHome: null, codexBin: process.env.MYTHRA_CODEX_BIN || "codex", metadataMethod: "thread/read", turnLimit: DEFAULT_INITIAL_TURN_LIMIT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex-home") options.codexHome = argv[index += 1] ?? null;
    else if (argument === "--codex-bin") options.codexBin = argv[index += 1] ?? options.codexBin;
    else if (argument === "--metadata-method") options.metadataMethod = argv[index += 1] ?? options.metadataMethod;
    else if (argument === "--turn-limit") options.turnLimit = Number(argv[index += 1]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.turnLimit) || options.turnLimit < 1 || options.turnLimit > 100) {
    throw new Error("--turn-limit must be an integer from 1 to 100");
  }
  if (options.metadataMethod !== "thread/resume" && options.metadataMethod !== "thread/read") {
    throw new Error("--metadata-method must be thread/resume or thread/read");
  }
  return options;
}

function defaultCodexHome() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "com.kiwi.harness", "codex-home");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "com.kiwi.harness", "codex-home");
  return null;
}

async function resolvedCodexBinary(configured) {
  if (process.platform !== "win32" || configured !== "codex") return configured;
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const target = architecture === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const candidates = [
    process.env.APPDATA && join(
      process.env.APPDATA,
      "npm", "node_modules", "@openai", "codex", "node_modules",
      `@openai/codex-win32-${architecture}`,
      "vendor", target, "bin", "codex.exe",
    ),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return configured;
}

async function rolloutFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rolloutFiles(path);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  }));
  return nested.flat();
}

function threadIdFromRollout(path) {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1] ?? null;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function projectThreadPreviews(method, result) {
  const copy = structuredClone(result);
  const threads = method === "thread/list"
    ? copy?.data
    : method === "thread/search" && Array.isArray(copy?.data)
      ? copy.data.map((match) => match?.thread)
    : copy?.thread ? [copy.thread] : [];
  if (!Array.isArray(threads)) return copy;
  for (const thread of threads) {
    if (typeof thread?.preview !== "string") continue;
    const characters = Array.from(graphemeSegmenter.segment(thread.preview), (part) => part.segment);
    if (characters.length > MAX_THREAD_PREVIEW_CHARACTERS) {
      thread.preview = characters.slice(0, MAX_THREAD_PREVIEW_CHARACTERS).join("");
    }
  }
  if (method === "thread/search" && Array.isArray(copy?.data)) {
    for (const match of copy.data) {
      if (match && typeof match === "object") delete match.snippet;
    }
  }
  return copy;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function summarizeMeasurements(measurements) {
  const sorted = [...measurements].sort((left, right) => left.initialProjectedBytes - right.initialProjectedBytes);
  const maximum = sorted.at(-1) ?? null;
  const byRawResultBytes = [...measurements].sort((left, right) => left.initialRawResultBytes - right.initialRawResultBytes);
  const byRolloutBytes = [...measurements].sort((left, right) => left.rolloutBytes - right.rolloutBytes);
  const byInitialLoad = [...measurements].sort((left, right) => left.initialLoadMs - right.initialLoadMs);
  const byWarmLoad = [...measurements].sort((left, right) => left.warmLoadMs - right.warmLoadMs);
  return {
    measuredThreads: sorted.length,
    p50InitialProjectedBytes: percentile(sorted, 0.5)?.initialProjectedBytes ?? null,
    p95InitialProjectedBytes: percentile(sorted, 0.95)?.initialProjectedBytes ?? null,
    maximumProjected: maximum,
    p95InitialRawResultBytes: percentile(byRawResultBytes, 0.95)?.initialRawResultBytes ?? null,
    maximumRawResult: byRawResultBytes.at(-1) ?? null,
    largestRollout: byRolloutBytes.at(-1) ?? null,
    p50InitialLoadMs: percentile(byInitialLoad, 0.5)?.initialLoadMs ?? null,
    p95InitialLoadMs: percentile(byInitialLoad, 0.95)?.initialLoadMs ?? null,
    maximumInitialLoad: byInitialLoad.at(-1) ?? null,
    p50WarmLoadMs: percentile(byWarmLoad, 0.5)?.warmLoadMs ?? null,
    p95WarmLoadMs: percentile(byWarmLoad, 0.95)?.warmLoadMs ?? null,
    maximumWarmLoad: byWarmLoad.at(-1) ?? null,
    threadsOver40KiB: sorted.filter((row) => row.initialProjectedBytes > 40 * 1024).length,
  };
}

function startAppServer(binary, codexHome) {
  const child = spawn(binary, ["app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let startupError = null;
  const rejectPending = (error) => {
    startupError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.once("error", rejectPending);
  child.stdin.on("error", rejectPending);
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    request.resolve({ message, lineBytes: Buffer.byteLength(line) });
  });
  child.once("exit", () => {
    rejectPending(startupError ?? new Error("Codex app-server exited before replying"));
  });
  return {
    child,
    request(method, params = {}) {
      return new Promise((resolveRequest, reject) => {
        if (startupError) {
          reject(startupError);
          return;
        }
        const id = nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after 30 seconds`));
        }, 30_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error && pending.delete(id)) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
  };
}

async function stopAppServer(child) {
  if (child.exitCode !== null) return;
  const waitForExit = (timeoutMs) => new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
  child.kill("SIGTERM");
  if (await waitForExit(2_000)) return;
  child.kill("SIGKILL");
  await waitForExit(2_000);
}

function throwRpcError(response) {
  if (response.message.error) throw new Error(response.message.error.message || "Unknown app-server error");
  return response.message.result;
}

async function benchmark(options) {
  const configuredHome = options.codexHome || defaultCodexHome();
  if (!configuredHome) throw new Error("Pass --codex-home on this platform");
  const sourceHome = resolve(configuredHome);
  const sourceSessions = join(sourceHome, "sessions");
  if ((await rolloutFiles(sourceSessions)).length === 0) throw new Error(`No active rollout files found in ${sourceSessions}`);

  // Never start a benchmark runtime against live application state. Only
  // rollouts are copied; credentials, config, queues, and mutable databases
  // remain behind.
  let scratchHome = null;
  let appServer = null;
  let operationError = null;
  const measurements = [];
  const skipped = {};
  try {
    scratchHome = await mkdtemp(join(tmpdir(), "mythra-thread-benchmark-"));
    await cp(sourceSessions, join(scratchHome, "sessions"), { recursive: true });
    const codexBinary = await resolvedCodexBinary(options.codexBin);
    const startupStartedAt = performance.now();
    appServer = startAppServer(codexBinary, scratchHome);
    throwRpcError(await appServer.request("initialize", {
      clientInfo: { name: "mythra-thread-benchmark", title: "Mythra Thread Benchmark", version: "1" },
      capabilities: { experimentalApi: true },
    }));
    appServer.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const startupMs = elapsedMilliseconds(startupStartedAt);

    const files = await rolloutFiles(join(scratchHome, "sessions"));
    for (const rolloutPath of files) {
      const threadId = threadIdFromRollout(rolloutPath);
      if (!threadId) continue;
      try {
        const metadataParams = options.metadataMethod === "thread/read"
          ? { threadId, includeTurns: false }
          : { threadId, path: rolloutPath, excludeTurns: true };
        const initialStartedAt = performance.now();
        const metadataStartedAt = performance.now();
        const resumeResponse = await appServer.request(options.metadataMethod, metadataParams);
        const resume = throwRpcError(resumeResponse);
        const metadataMs = elapsedMilliseconds(metadataStartedAt);
        const historyStartedAt = performance.now();
        const pageResponse = await appServer.request("thread/turns/list", {
          threadId,
          limit: options.turnLimit,
          sortDirection: "desc",
          itemsView: "summary",
        });
        const page = throwRpcError(pageResponse);
        const historyMs = elapsedMilliseconds(historyStartedAt);
        const initialLoadMs = elapsedMilliseconds(initialStartedAt);
        const warmStartedAt = performance.now();
        const warmMetadataStartedAt = performance.now();
        throwRpcError(await appServer.request(options.metadataMethod, metadataParams));
        const warmMetadataMs = elapsedMilliseconds(warmMetadataStartedAt);
        const warmHistoryStartedAt = performance.now();
        throwRpcError(await appServer.request("thread/turns/list", {
          threadId,
          limit: options.turnLimit,
          sortDirection: "desc",
          itemsView: "summary",
        }));
        const warmHistoryMs = elapsedMilliseconds(warmHistoryStartedAt);
        const warmLoadMs = elapsedMilliseconds(warmStartedAt);
        const projectedResume = projectThreadPreviews(options.metadataMethod, resume);
        measurements.push({
          threadId,
          rolloutBytes: (await stat(rolloutPath)).size,
          turnsLoaded: Array.isArray(page?.data) ? page.data.length : 0,
          hasMore: Boolean(page?.nextCursor),
          appServerEnvelopeBytes: resumeResponse.lineBytes + pageResponse.lineBytes,
          initialRawResultBytes: jsonBytes(resume) + jsonBytes(page),
          initialProjectedBytes: jsonBytes(projectedResume) + jsonBytes(page),
          metadataProjectedBytes: jsonBytes(projectedResume),
          firstPageBytes: jsonBytes(page),
          metadataMs,
          historyMs,
          initialLoadMs,
          warmMetadataMs,
          warmHistoryMs,
          warmLoadMs,
        });
      } catch (error) {
        const message = String(error?.message || error);
        if (/exclude[_ ]?turns/i.test(message) && /unknown|unsupported|invalid|unrecognized/i.test(message)) {
          throw new Error("The selected Codex runtime does not support metadata-only thread loading");
        }
        const category = /model provider .* not found/i.test(message)
          ? "provider-config-not-copied"
          : /no rollout found/i.test(message) ? "rollout-unavailable" : "other";
        skipped[category] = (skipped[category] ?? 0) + 1;
      }
    }

    const skippedThreads = Object.values(skipped).reduce((total, count) => total + count, 0);
    if (measurements.length === 0) throw new Error("No compatible threads could be measured");
    if (skippedThreads > measurements.length) {
      throw new Error(`Benchmark sample is biased: ${skippedThreads} threads skipped and only ${measurements.length} measured`);
    }

    const listResponse = await appServer.request("thread/list", { limit: 100 });
    const list = throwRpcError(listResponse);
    const projectedList = projectThreadPreviews("thread/list", list);
    return {
      schemaVersion: 1,
      metadataMethod: options.metadataMethod,
      turnLimit: options.turnLimit,
      previewCharacterLimit: MAX_THREAD_PREVIEW_CHARACTERS,
      startupMs,
      ...summarizeMeasurements(measurements),
      skipped,
      threadList: {
        threads: Array.isArray(list?.data) ? list.data.length : 0,
        appServerEnvelopeBytes: listResponse.lineBytes,
        rawResultBytes: jsonBytes(list),
        projectedBytes: jsonBytes(projectedList),
      },
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (appServer) await stopAppServer(appServer.child);
      if (scratchHome) {
        await rm(scratchHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch (cleanupError) {
      if (!operationError) throw cleanupError;
      console.error(`Benchmark cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run benchmark:threads -- [--codex-home PATH] [--codex-bin PATH] [--metadata-method thread/resume|thread/read] [--turn-limit N]");
    return;
  }
  console.log(JSON.stringify(await benchmark(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
