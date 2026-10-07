import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AssistantMessageMarkdown } from "../src/components/ChatTimeline";
import "../src/styles.css";
import { planLineTargets, observeLineTargets } from "./line-targets.mjs";

type Capture = { model: string; source: string; events: Array<{ at: number; text: string }> };
type Variant = "smooth" | "lines";
const host = document.querySelector<HTMLElement>("#lab")!;
host.style.cssText = "width:760px;margin:24px auto;";
const native = {
  raf: window.requestAnimationFrame.bind(window), cancelRaf: window.cancelAnimationFrame.bind(window),
  timeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
  interval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
};
const wait = (ms: number) => new Promise<void>((done) => native.timeout(done, ms));
const paint = () => new Promise<void>((done) => native.raf(() => native.raf(() => done())));

function instrumentScheduling() {
  const rafs = new Set<number>(), timers = new Set<number>(), intervals = new Set<number>();
  const callbacks = { raf: 0, timeout: 0, interval: 0 };
  window.requestAnimationFrame = (fn) => {
    const id = native.raf((now) => { rafs.delete(id); callbacks.raf++; fn(now); });
    rafs.add(id); return id;
  };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); native.cancelRaf(id); };
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = native.timeout(() => { timers.delete(id); callbacks.timeout++; if (typeof fn === "function") fn(...args); }, ms);
    timers.add(id); return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); native.clearTimeout(id); };
  window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = native.interval(() => { callbacks.interval++; if (typeof fn === "function") fn(...args); }, ms);
    intervals.add(id); return id;
  }) as typeof window.setInterval;
  window.clearInterval = (id) => { if (id !== undefined) intervals.delete(id); native.clearInterval(id); };
  return {
    snapshot: () => ({ pendingRaf: rafs.size, pendingTimeout: timers.size, pendingInterval: intervals.size, callbacks: { ...callbacks } }),
    restore() {
      // A failure is recorded before emergency cleanup; leave no stray lab work.
      rafs.forEach(native.cancelRaf); timers.forEach(native.clearTimeout); intervals.forEach(native.clearInterval);
      window.requestAnimationFrame = native.raf; window.cancelAnimationFrame = native.cancelRaf;
      window.setTimeout = native.timeout; window.clearTimeout = native.clearTimeout;
      window.setInterval = native.interval; window.clearInterval = native.clearInterval;
    },
  };
}

async function run(variant: Variant, capture: Capture, options: { idleMs: number; tailMs: number }) {
  const Component = AssistantMessageMarkdown;
  const expectedSource = capture.events.map((event) => event.text).join("");
  const root = createRoot(host);
  // Static final rendering defines the exact visible Markdown output. It is
  // captured before any timing starts and uses this same production component.
  flushSync(() => root.render(<Component text={expectedSource} streaming={false} presentation={variant} />));
  await paint();
  const expectedVisible = host.querySelector(".message-text")!.textContent;
  flushSync(() => root.render(null));
  await paint();
  const scheduler = instrumentScheduling();
  const linePlan = planLineTargets(capture, expectedVisible ?? "");
  const lines = linePlan.lines;
  const commits: Array<{ phase: string; actualDurationMs: number; baseDurationMs: number; commitAtMs: number }> = [];
  const frameIntervals: number[] = [];
  const inputLatenessMs: number[] = [];
  const inputTimingOffsetMs: number[] = [];
  const longTasks: Array<{ atMs: number; durationMs: number }> = [];
  let mutationRecords = 0, observerTimeMs = 0, frame = 0, lastFrame: number | null = null;
  let started = performance.now(), monitor = true;
  let receivedThroughAtMs = -1;
  const observeLines = () => {
    const start = performance.now();
    observeLineTargets(lines, host.querySelector(".message-text")?.textContent ?? "", performance.now() - started, receivedThroughAtMs);
    observerTimeMs += performance.now() - start;
  };
  const mutations = new MutationObserver((records) => { mutationRecords += records.length; observeLines(); });
  const supportedLongTasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const tasks = supportedLongTasks ? new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ atMs: entry.startTime - started, durationMs: entry.duration });
  }) : null;
  const tick = (now: number) => { if (!monitor) return; if (lastFrame !== null) frameIntervals.push(now - lastFrame); lastFrame = now; frame = native.raf(tick); };
  let source = "", streamEndMs = 0, finalVisibleAtMs: number | null = null;
  const boundary = (window as Window & { isolatedBoundary?: (phase: string) => Promise<unknown> }).isolatedBoundary;
  const render = (streaming: boolean) => root.render(<Profiler id={variant} onRender={(_id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
    commits.push({ phase, actualDurationMs: actualDuration, baseDurationMs: baseDuration, commitAtMs: commitTime - started });
    observeLines();
  }}><Component text={source} streaming={streaming} presentation={variant} /></Profiler>);
  try {
    await boundary?.("start");
    started = performance.now();
    mutations.observe(host, { subtree: true, childList: true, characterData: true });
    tasks?.observe({ type: "longtask", buffered: false });
    frame = native.raf(tick);
    render(true);
    for (const event of capture.events) {
      await wait(Math.max(0, started + event.at - performance.now()));
      const offset = performance.now() - started - event.at;
      inputTimingOffsetMs.push(offset);
      inputLatenessMs.push(Math.max(0, offset));
      source += event.text;
      receivedThroughAtMs = event.at;
      render(true);
    }
    streamEndMs = performance.now() - started;
    render(false);
    const tailDeadline = performance.now() + options.tailMs;
    while (performance.now() < tailDeadline) {
      await paint();
      if (host.querySelector(".message-text")?.textContent === expectedVisible) { finalVisibleAtMs = performance.now() - started; break; }
    }
    // Settle completion decoration, then observe an idle window separately.
    await wait(options.tailMs);
    monitor = false; native.cancelRaf(frame); tasks?.disconnect(); mutations.disconnect();
    const completeAtMs = performance.now() - started;
    await boundary?.("end");
    const completed = scheduler.snapshot();
    const exactVisibleTextAtFinish = finalVisibleAtMs !== null && host.querySelector(".message-text")?.textContent === expectedVisible;
    const retainedDomNodes = host.querySelectorAll("*").length;
    const highlightsAfterFinish = window.CSS?.highlights?.size ?? null;
    const lineProbesAfterFinish = document.querySelectorAll("[data-mythra-line-probe]").length;
    const fadeStylesAfterFinish = document.querySelectorAll("style[data-mythra-stream-fade]").length;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    await wait(options.idleMs);
    const idle = scheduler.snapshot();
    flushSync(() => root.unmount());
    await wait(options.idleMs);
    const unmounted = scheduler.snapshot();
    const idleCallbacks = { raf: idle.callbacks.raf - completed.callbacks.raf, timeout: idle.callbacks.timeout - completed.callbacks.timeout, interval: idle.callbacks.interval - completed.callbacks.interval };
    const unmountCallbacks = { raf: unmounted.callbacks.raf - idle.callbacks.raf, timeout: unmounted.callbacks.timeout - idle.callbacks.timeout, interval: unmounted.callbacks.interval - idle.callbacks.interval };
    return {
      variant, timelineMs: capture.events.at(-1)!.at, streamEndMs, completeAtMs, inputLatenessMs, inputTimingOffsetMs,
      exactSourceAtFinish: source === expectedSource, exactVisibleTextAtFinish,
      finalVisibleAtMs, finalVisibleTailMs: finalVisibleAtMs === null ? null : finalVisibleAtMs - streamEndMs,
      committedRenderCount: commits.length, commitCount: commits.length, commits,
      reactCommittedRenderDurationMs: commits.reduce((sum, commit) => sum + commit.actualDurationMs, 0),
      renderAttemptCount: null, renderAttemptCountReason: "React Profiler observes committed updates, not abandoned render attempts or individual Markdown parse calls.",
      frameIntervalsMs: frameIntervals, framesOver50Ms: frameIntervals.filter((ms) => ms > 50).length,
      longTasks: supportedLongTasks ? longTasks : null, lineLatency: lines.map((line) => ({ ...line, latencyMs: line.observedAtMs === null ? null : line.observedAtMs - line.sourceAtMs })),
      lineCoverage: "Completed plain source lines verified to occur exactly once in static Markdown output; syntax/entity/ambiguous lines and incomplete final lines excluded. Observation requires both scheduled and actually received arrival times.",
      lineTargetCount: lines.length, lineTargetExclusions: linePlan.excluded, completeNonemptySourceLines: linePlan.completeNonemptyLines,
      mutationRecords, measurementObserverTimeMs: observerTimeMs, retainedDomNodes, highlightsAfterFinish, lineProbesAfterFinish, fadeStylesAfterFinish,
      browserHeapSnapshot: heap ? { usedJSHeapBytes: heap.usedJSHeapSize, totalJSHeapBytes: heap.totalJSHeapSize, scope: "Browser performance.memory, approximate page heap; no forced GC; not native RSS or retained-object proof" } : null,
      cleanup: { completed, idle, unmounted, idleCallbacks, unmountCallbacks, domNodesAfterUnmount: host.querySelectorAll("*").length, highlightsAfterUnmount: window.CSS?.highlights?.size ?? null, lineProbesAfterUnmount: document.querySelectorAll("[data-mythra-line-probe]").length, fadeStylesAfterUnmount: document.querySelectorAll("style[data-mythra-stream-fade]").length },
    };
  } finally {
    monitor = false; native.cancelRaf(frame); tasks?.disconnect(); mutations.disconnect();
    try { root.unmount(); } catch { /* already unmounted */ }
    scheduler.restore();
  }
}

Object.assign(window, { isolatedPerformance: { run, ready: true } });
