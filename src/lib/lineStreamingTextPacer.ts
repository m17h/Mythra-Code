import type { StreamingTextPacer } from "./streamingTextPacer";

/** Work-modal presentation only. The store retains the complete source. */
const WINDOW_MS = 240;
const TAIL_MAX_AGE_MS = 1000;
const FRAME_MS = 1000 / 30;
const MAX_SOURCE = 48_000;
const MAX_BACKLOG = 8192;
const MAX_BATCHES = 128;

type BoundaryPlan = { ends: number[]; proseTail: boolean };
type ProseLine = { start: number; end: number };
type MeasuredGlyph = { node: Text; start: number; end: number; sourceOffset: number | null };
const BLOCK_HTML_NAMES = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul pre script style textarea".split(" "));

function htmlBlockLine(line: string): boolean {
  const trimmed = line.replace(/^ {0,3}/, "");
  if (/^<(?:!--|\?|![A-Z]|!\[CDATA\[)/.test(trimmed)) return true;
  const tag = /^<\/?([a-z][\w-]*)(?=[\s/>]|$)/i.exec(trimmed);
  if (tag && BLOCK_HTML_NAMES.has(tag[1].toLowerCase())) return true;
  // A standalone complete tag starts an HTML block, but inline tags followed
  // by text and ordinary '<3' prose can remain GFM table rows.
  return /^<\/?[a-z][\w-]*(?:\s+[^<>]*)?\s*\/?>\s*$/i.test(trimmed);
}

function blockLine(line: string): boolean {
  return /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$))/.test(line)
    || /^(?: {4}|\t)/.test(line)
    || /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)
    || htmlBlockLine(line);
}

/** Common closed inline formatting; each token remains indivisible in source. */
function measureInline(doc: Document, text: string, sourceStart: number, probe: HTMLElement, segmenter: Intl.Segmenter): MeasuredGlyph[] | null {
  const glyphs: MeasuredGlyph[] = [];
  const parts: Node[] = [];
  const append = (value: string, from: number, tag?: string) => {
    const node = doc.createTextNode(value);
    const wrapper = tag ? doc.createElement(tag) : null;
    if (wrapper) { wrapper.append(node); parts.push(wrapper); }
    else parts.push(node);
    for (const entry of segmenter.segment(value)) {
      glyphs.push({ node, start: entry.index, end: entry.index + entry.segment.length, sourceOffset: tag && entry.index ? null : sourceStart + from + entry.index });
    }
  };
  const syntax = /[`*_\[\]<>\\~&]/;
  const tokens = /(\*\*|\*)([^*\n]+?)\1|\[([^\[\]\n]+)\]\(([^()\s]+)\)|~~([^~\n]+)~~/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    const plain = text.slice(start, match.index);
    const label = match[2] ?? match[3] ?? match[5];
    if (syntax.test(plain) || syntax.test(label)) return null;
    append(plain, start);
    append(label, match.index, match[2] ? match[1] === "**" ? "strong" : "em" : match[3] ? "a" : "del");
    start = match.index + match[0].length;
  }
  const plain = text.slice(start);
  if (syntax.test(plain)) return null;
  append(plain, start);
  probe.replaceChildren(...parts);
  return glyphs;
}

// GFM splits every unescaped pipe, including pipes inside inline code spans.
function tableCells(line: string): string[] | null {
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\") { index++; continue; }
    if (line[index] === "|") {
      cells.push(line.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (!cells.length) return null;
  cells.push(line.slice(start).trim());
  if (!cells[0]) cells.shift();
  if (!cells[cells.length - 1]) cells.pop();
  return cells.length ? cells : null;
}

/** Source offsets only: do not insert temporary closing Markdown punctuation. */
export function streamingLinePlan(source: string, proseLines?: ProseLine[]): BoundaryPlan {
  const ends: number[] = [];
  let start = 0;
  let fence = "";
  let table = false;
  let header: { cells: number; end: number } | null = null;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const complete = newline !== -1;
    const end = complete ? newline + 1 : source.length;
    const line = source.slice(start, complete ? newline : end).replace(/\r$/, "");
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (complete) ends.push(end);
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = "";
      if (!complete) return { ends, proseTail: false };
    } else if (opening) {
      fence = opening[1];
      header = null; table = false;
      if (complete) ends.push(end);
      else return { ends, proseTail: false };
    } else {
      const cells = tableCells(line);
      if (header) {
        const delimiter = cells && cells.length === header.cells && cells.every(cell => /^:?-+:?$/.test(cell));
        if (delimiter) {
          if (!complete) return { ends, proseTail: false };
          ends.push(end); // Header and delimiter become visible together.
          table = true; header = null;
          start = end; continue;
        }
        // This unfinished source line could still become a table delimiter.
        if (!complete) return { ends, proseTail: false };
        ends.push(header.end);
        header = null;
      }
      const interruptsTable = !line.trim() || blockLine(line);
      if (table && !interruptsTable) {
        if (complete) ends.push(end);
        else return { ends, proseTail: false };
      } else {
        table = false;
        if (cells) {
          if (complete) header = { cells: cells.length, end };
          else return { ends, proseTail: false };
        } else if (complete) {
          ends.push(end);
          if (!blockLine(line)) proseLines?.push({ start, end: newline });
        }
        else {
          if (!blockLine(line)) proseLines?.push({ start, end });
          return { ends, proseTail: !blockLine(line) };
        }
      }
    }
    start = end;
  }
  return { ends, proseTail: false };
}

export function createLineStreamingTextPacer(root: HTMLElement, initial: string, publish: (text: string) => void, onSettled: () => void): StreamingTextPacer {
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
  let visualStart = initial.lastIndexOf("\n") + 1;
  let batches: Array<{ end: number; at: number }> = [];
  let frame: number | null = null;
  let lastPublish = -Infinity;
  let disposed = false;
  let finishing = false;
  let finishAt = Infinity;
  let failed = false;
  let planSource = "";
  let plan: BoundaryPlan = { ends: [], proseTail: false };
  let proseLines: ProseLine[] = [];
  let probe: HTMLDivElement | null = null;
  const measurements = new Map<string, number[]>();

  const clear = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    batches = [];
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    probe?.remove(); probe = null;
    measurements.clear();
    proseLines = [];
    policy.removeEventListener("change", flush);
    doc.removeEventListener("visibilitychange", flush);
    doc.removeEventListener("selectionchange", onSelection);
  };
  const flush = () => {
    if (disposed) return;
    clear();
    if (shown !== source.length) { shown = source.length; publish(source); }
    visualStart = source.lastIndexOf("\n") + 1;
    measurements.clear();
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
  const blocked = () => failed || policy.matches || doc.hidden || !root.isConnected || selecting();
  const onSelection = () => { try { if (selecting()) flush(); } catch { flush(); } };
  const coalesceMatured = (now: number) => {
    let count = 0;
    while (count < batches.length && now - batches[count].at >= WINDOW_MS) count++;
    if (count > 1) batches.splice(0, count, { end: batches[count - 1].end, at: batches[0].at });
  };

  const wrappedLineEnds = (line: ProseLine): number[] => {
    const from = Math.max(line.start, visualStart);
    const tail = source.slice(from, line.end).replace(/\r$/, "");
    if (!tail || tail.length > MAX_BACKLOG) return [];
    const paragraph = root.querySelector<HTMLElement>(":scope > p:last-child") ?? root;
    const style = view.getComputedStyle(paragraph);
    const width = paragraph.clientWidth || root.clientWidth;
    if (width <= 0) return [];
    const key = `${from}:${width}:${style.font}:${style.lineHeight}:${style.letterSpacing}:${style.wordSpacing}:${style.overflowWrap}:${style.wordBreak}:${tail}`;
    const cached = measurements.get(key);
    if (cached) return cached;
    if (measurements.size >= 8) measurements.delete(measurements.keys().next().value!);
    if (!probe) {
      probe = doc.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.dataset.mythraLineProbe = "";
      Object.assign(probe.style, { position: "fixed", left: "-100000px", top: "0", visibility: "hidden", pointerEvents: "none", contain: "layout style paint", margin: "0", padding: "0", border: "0" });
      doc.body.append(probe);
    }
    Object.assign(probe.style, { width: `${width}px`, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing, whiteSpace: "normal", overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, textIndent: "0" });
    // Unclosed or unsupported Markdown stays intact until a source newline,
    // completion, or max prose age. Common closed bold/emphasis/links are
    // measured as rendered inline elements, never as punctuation width.
    const glyphs = measureInline(doc, tail, from, probe, segmenter);
    if (!glyphs) { measurements.set(key, []); return []; }
    const range = doc.createRange();
    const topAt = (index: number) => {
      const glyph = glyphs[index];
      range.setStart(glyph.node, glyph.start);
      range.setEnd(glyph.node, glyph.end);
      return range.getBoundingClientRect().top;
    };
    const wrapped: number[] = [];
    let index = 0;
    // One binary search per visual line instead of a geometry read per glyph.
    while (index < glyphs.length - 1 && wrapped.length < 256) {
      const top = topAt(index);
      if (topAt(glyphs.length - 1) <= top + 0.5) break;
      let low = index + 1;
      let high = glyphs.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (topAt(middle) > top + 0.5) high = middle;
        else low = middle + 1;
      }
      const boundary = glyphs[low].sourceOffset;
      // If a visual wrap falls inside an inline token, coalesce those lines
      // until a safe source boundary rather than expose unfinished Markdown.
      if (boundary !== null) wrapped.push(boundary);
      index = low;
    }
    measurements.set(key, wrapped);
    return wrapped;
  };

  const tick = (now: number) => {
    frame = null;
    if (disposed) return;
    try {
      if (blocked()) { flush(); return; }
      if (finishing && now >= finishAt) { flush(); return; }
      if (now - lastPublish < FRAME_MS - 0.1) { frame = view.requestAnimationFrame(tick); return; }
      if (planSource !== source) { proseLines = []; plan = streamingLinePlan(source, proseLines); planSource = source; }
      coalesceMatured(now);
      let available = shown;
      let previous = shown;
      for (const batch of batches) {
        available += (batch.end - previous) * Math.max(0, Math.min(1, (now - batch.at) / WINDOW_MS));
        previous = batch.end;
      }
      // Keep geometry and retained measurement keys bounded even for a burst
      // containing thousands of tiny paragraphs; source-line ends remain safe.
      const wraps = proseLines.filter(line => line.end > shown).slice(0, 8).flatMap(wrappedLineEnds);
      const ends = [...plan.ends, ...wraps].filter(end => end > shown).sort((a, b) => a - b);
      let end = shown;
      for (const boundary of ends) if (boundary <= available) end = boundary;
      // Age belongs to the oldest still-unshown arrival. Appends cannot restart
      // this deadline. Short answers need not wait forever for a wrapping word.
      if (plan.proseTail && batches.length && now - batches[0].at >= TAIL_MAX_AGE_MS && !ends.length) end = source.length;
      if (end > shown) {
        shown = end;
        visualStart = end;
        lastPublish = now;
        publish(source.slice(0, end));
        while (batches.length && batches[0].end <= shown) batches.shift();
      }
      if (shown === source.length) {
        batches = [];
        if (finishing) { dispose(); onSettled(); }
      } else if (finishing || plan.proseTail || batches.some(batch => now - batch.at < WINDOW_MS)) frame = view.requestAnimationFrame(tick);
      // Incomplete rows/headings/code wait for an update without an idle rAF.
    } catch {
      // A presentation failure must never hide the provider's authoritative text.
      failed = true;
      probe?.remove(); probe = null;
      flush();
    }
  };
  policy.addEventListener("change", flush);
  doc.addEventListener("visibilitychange", flush);
  doc.addEventListener("selectionchange", onSelection);
  return {
    dispose,
    flush,
    finish() {
      if (disposed || finishing) return;
      finishing = true;
      finishAt = view.performance.now() + WINDOW_MS;
      if (shown === source.length) { dispose(); onSettled(); }
      else if (frame === null) frame = view.requestAnimationFrame(tick);
    },
    update(text) {
      if (disposed || text === source) return;
      const previous = source;
      source = text;
      if (!text.startsWith(previous)) { clear(); measurements.clear(); shown = text.length; visualStart = text.lastIndexOf("\n") + 1; publish(text); if (finishing) { dispose(); onSettled(); } return; }
      try {
        const now = view.performance.now();
        // Matured arrivals all have weight one. Combining their metadata keeps
        // exact availability and oldest age while a slow table row is pending.
        coalesceMatured(now);
        // Accessibility/copy/resource safety intentionally bypasses line pacing.
        if (blocked() || text.length > MAX_SOURCE || text.length - shown > MAX_BACKLOG || batches.length >= MAX_BATCHES) { flush(); return; }
        batches.push({ end: text.length, at: now });
        if (frame === null) frame = view.requestAnimationFrame(tick);
      } catch { failed = true; flush(); }
    },
  };
}
