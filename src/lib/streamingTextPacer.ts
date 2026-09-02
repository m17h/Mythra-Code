/** Presentation only: the store always owns the complete, unpaced response. */
export interface StreamingTextPacer {
  update(text: string): void;
  flush(): void;
  finish(): void;
  dispose(): void;
}

const WINDOW_MS = 240;
const FRAME_MS = 1000 / 30;
const MAX_SOURCE = 48_000;
const MAX_BACKLOG = 2048;
const MAX_BATCHES = 64;

export function createStreamingTextPacer(root: HTMLElement, initial: string, publish: (text: string) => void, onSettled: () => void): StreamingTextPacer {
  try { return createSupportedPacer(root, initial, publish, onSettled); }
  catch { return passthrough(publish, onSettled); }
}

function passthrough(publish: (text: string) => void, onSettled: () => void): StreamingTextPacer {
  let disposed = false;
  return { update(text) { if (!disposed) publish(text); }, flush() {}, finish() { if (!disposed) { disposed = true; onSettled(); } }, dispose() { disposed = true; } };
}

function createSupportedPacer(root: HTMLElement, initial: string, publish: (text: string) => void, onSettled: () => void): StreamingTextPacer {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof view.requestAnimationFrame !== "function" || typeof view.matchMedia !== "function" || typeof Intl.Segmenter !== "function") return passthrough(publish, onSettled);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const policy = view.matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)");
  let source = initial;
  let shown = initial.length;
  let settled = shown;
  let batches: Array<{ size: number; at: number }> = [];
  let frame: number | null = null;
  let lastPublish = -Infinity;
  let disposed = false;
  let finishing = false;

  const clear = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    batches = [];
  };
  const flush = () => {
    if (disposed) return;
    clear();
    settled = source.length;
    if (shown !== source.length) { shown = source.length; publish(source); }
    if (finishing) { dispose(); onSettled(); }
  };
  const selecting = () => {
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let index = 0; index < selection.rangeCount; index++) {
      if (selection.getRangeAt(index).intersectsNode(root)) return true;
    }
    return false;
  };
  const blocked = () => policy.matches || doc.hidden || !root.isConnected || selecting();
  const onSelection = () => { if (selecting()) flush(); };
  const tick = (now: number) => {
    frame = null;
    if (disposed) return;
    if (blocked()) { flush(); return; }
    // Each arrival has its own deadline. Frequent updates cannot restart a
    // timer and postpone older text indefinitely; this is not an easing queue.
    while (batches.length && now - batches[0].at >= WINDOW_MS) settled += batches.shift()!.size;
    let available = settled;
    for (const batch of batches) available += batch.size * Math.max(0, Math.min(1, (now - batch.at) / WINDOW_MS));
    const candidate = Math.min(source.length, Math.max(shown, Math.floor(available)));
    if (now - lastPublish >= FRAME_MS - 0.1 || !batches.length) {
      const grapheme = candidate < source.length ? segmenter.segment(source).containing(candidate) : undefined;
      const end = grapheme ? grapheme.index : candidate;
      if (end > shown) {
        shown = end;
        lastPublish = now;
        publish(source.slice(0, end));
      }
    }
    if (batches.length || shown < source.length) frame = view.requestAnimationFrame(tick);
    else if (finishing) { dispose(); onSettled(); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    policy.removeEventListener("change", flush);
    doc.removeEventListener("visibilitychange", flush);
    doc.removeEventListener("selectionchange", onSelection);
  };
  policy.addEventListener("change", flush);
  doc.addEventListener("visibilitychange", flush);
  doc.addEventListener("selectionchange", onSelection);
  return {
    dispose,
    flush,
    finish() {
      if (disposed) return;
      finishing = true;
      if (!batches.length) { dispose(); onSettled(); }
    },
    update(text) {
      if (disposed || text === source) return;
      const previous = source;
      source = text;
      if (!text.startsWith(previous)) {
        clear(); settled = shown = text.length; publish(text); return;
      }
      if (blocked() || text.length > MAX_SOURCE || text.length - shown > MAX_BACKLOG || batches.length >= MAX_BATCHES) {
        flush(); return;
      }
      batches.push({ size: text.length - previous.length, at: view.performance.now() });
      if (frame === null) frame = view.requestAnimationFrame(tick);
    },
  };
}
