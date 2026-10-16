import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { providerEventTotal, setPerformanceOverlayEnabled } from "../lib/performanceOverlay";
import "./PerformanceOverlay.css";

interface Readout {
  fps: number | null;
  worstFrameMs: number | null;
  longTasks: number | null;
  longTaskMs: number | null;
  eventsPerSecond: number;
  heapMb: number | null;
  domNodes: number;
}

const WINDOW_MS = 5_000;
const UPDATE_MS = 500;

/**
 * A small live readout for spotting slowdowns in the real app: frame rate
 * and the slowest frame over the last five seconds, long main-thread tasks
 * (where the engine reports them), provider events per second, JS heap
 * (where available) and DOM size. Pointer events pass through it.
 */
export default function PerformanceOverlay() {
  const [readout, setReadout] = useState<Readout | null>(null);
  useEffect(() => {
    let frame = 0;
    const frames: number[] = [];
    const longTasks: Array<{ at: number; duration: number }> = [];
    let observer: PerformanceObserver | null = null;
    const longTaskSupported = typeof PerformanceObserver !== "undefined"
      && (PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false);
    if (longTaskSupported) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ at: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: false });
    }
    let lastEvents = providerEventTotal();
    let lastSample = performance.now();
    const tick = (now: number) => {
      frames.push(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const timer = window.setInterval(() => {
      const now = performance.now();
      while (frames.length && frames[0]! < now - WINDOW_MS) frames.shift();
      while (longTasks.length && longTasks[0]!.at < now - WINDOW_MS) longTasks.shift();
      let worst = 0;
      for (let index = 1; index < frames.length; index++) worst = Math.max(worst, frames[index]! - frames[index - 1]!);
      const recent = frames.filter((at) => at >= now - 1_000).length;
      const events = providerEventTotal();
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      setReadout({
        fps: document.hidden ? null : recent,
        worstFrameMs: frames.length > 1 ? worst : null,
        longTasks: longTaskSupported ? longTasks.length : null,
        longTaskMs: longTaskSupported ? longTasks.reduce((total, task) => total + task.duration, 0) : null,
        eventsPerSecond: Math.round(((events - lastEvents) * 1_000) / Math.max(1, now - lastSample)),
        heapMb: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize / 1_048_576 : null,
        domNodes: document.getElementsByTagName("*").length,
      });
      lastEvents = events;
      lastSample = now;
    }, UPDATE_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, []);
  const tone = (value: number | null, warn: number, bad: number, higherIsWorse = true) => value === null ? ""
    : (higherIsWorse ? value >= bad : value <= bad) ? " bad" : (higherIsWorse ? value >= warn : value <= warn) ? " warn" : "";
  return <aside className="performance-overlay" aria-label="Performance overlay">
    <button type="button" className="performance-overlay-close" aria-label="Hide performance overlay" title="Hide (Settings → Runtime)" onClick={() => setPerformanceOverlayEnabled(false)}><X size={11} /></button>
    <dl>
      <div className={tone(readout?.fps ?? null, 50, 30, false)}><dt>FPS</dt><dd>{readout?.fps ?? "—"}</dd></div>
      <div className={tone(readout?.worstFrameMs ?? null, 34, 100)}><dt>Worst frame</dt><dd>{readout?.worstFrameMs === null || !readout ? "—" : `${Math.round(readout.worstFrameMs)} ms`}</dd></div>
      <div className={tone(readout?.longTaskMs ?? null, 100, 400)}><dt>Long tasks 5s</dt><dd>{readout?.longTasks === null || !readout ? "n/a" : `${readout.longTasks} · ${Math.round(readout.longTaskMs ?? 0)} ms`}</dd></div>
      <div><dt>Events/s</dt><dd>{readout?.eventsPerSecond ?? "—"}</dd></div>
      <div><dt>Heap</dt><dd>{readout?.heapMb === null || !readout ? "n/a" : `${readout.heapMb.toFixed(0)} MB`}</dd></div>
      <div><dt>DOM nodes</dt><dd>{readout ? readout.domNodes.toLocaleString() : "—"}</dd></div>
    </dl>
  </aside>;
}
