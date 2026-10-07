/**
 * One-shot, paint-only reveal of a complete answer that has just become
 * visible. The final Markdown is mounted whole and laid out normally; only a
 * mask over its own box changes, so text, links, selection, copy and geometry
 * are exactly those of the settled message from the first frame.
 */
export interface CompletionReveal {
  /** Show everything now (idempotent). */
  finish(): void;
  dispose(): void;
}

export interface CompletionRevealViewport { top: number; bottom: number }

const NONE: CompletionReveal = { finish() {}, dispose() {} };
const FADE_MS = 320;
const STAGGER_MS = 64;
// Later lines start sooner on long answers: the whole visible reveal stays
// within SPAN_MS + FADE_MS (1040ms) no matter how many lines are on screen.
const SPAN_MS = 720;
const SAFETY_MS = 2_500;
const MAX_TEXT_NODES = 1_500;
const MAX_MEDIA = 64;
const MAX_BANDS = 96;
// Text nodes at least this long are clipped to the viewport by binary search
// instead of listing every line box of an enormous paragraph.
const LONG_TEXT = 2_000;
// Revealed as one unit: every cell of a table row, every line of a heading.
const UNITS = "tr, h1, h2, h3, h4, h5, h6";
const HIDDEN = "linear-gradient(transparent, transparent)";

type Band = [top: number, bottom: number];

/**
 * Call from a layout effect right after the complete answer commits, before
 * the browser paints it. `viewport` bounds measurement to visible lines;
 * everything below them appears with the last visible line.
 */
export function createCompletionReveal(root: HTMLElement, viewport?: () => CompletionRevealViewport | null): CompletionReveal {
  try { return start(root, viewport); } catch { clearMask(root); return NONE; }
}

function setMask(root: HTMLElement, image: string) {
  root.style.setProperty("-webkit-mask-image", image);
  root.style.setProperty("mask-image", image);
}

function clearMask(root: HTMLElement) {
  for (const property of ["mask-image", "mask-size", "mask-repeat"]) {
    root.style.removeProperty(property);
    root.style.removeProperty(`-webkit-${property}`);
  }
}

/**
 * Screen pixels per root-local CSS pixel. Under CSS `zoom`, Chromium reports
 * zoomed client rects while WebKit reports them in the element's own units;
 * the border box's computed (always local) width tells the two apart.
 */
function screenScale(root: HTMLElement, origin: DOMRect): number {
  const style = root.ownerDocument.defaultView!.getComputedStyle(root);
  const sum = (...values: string[]) => values.reduce((total, value) => total + (parseFloat(value) || 0), 0);
  const width = style.boxSizing === "border-box" ? parseFloat(style.width)
    : sum(style.width, style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth);
  const scale = origin.width / width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Visual line bands within the viewport, in the root's own CSS pixels. */
function measureBands(root: HTMLElement, port: CompletionRevealViewport): Band[] {
  const doc = root.ownerDocument;
  const origin = root.getBoundingClientRect();
  const scale = screenScale(root, origin);
  const rects: Band[] = [];
  // Classify a screen-space box against the viewport; keep it in local units.
  const add = (box: DOMRect) => {
    if (box.height <= 0) return "empty";
    if (box.top >= port.bottom) return "below";
    if (box.bottom > port.top) rects.push([(box.top - origin.top) / scale, (box.bottom - origin.top) / scale]);
    return "kept";
  };
  const units = new Set<Element>();
  /** Adds an atomic row/heading once; false if `element` is not inside one. */
  const addUnit = (element: Element | null) => {
    const unit = element?.closest(UNITS);
    if (!unit || !root.contains(unit)) return null;
    if (units.has(unit)) return "kept";
    units.add(unit);
    return add(unit.getBoundingClientRect());
  };
  const range = doc.createRange();
  const charBox = (node: Text, offset: number) => {
    range.setStart(node, offset);
    range.setEnd(node, Math.min(node.length, offset + 1));
    return range.getBoundingClientRect();
  };
  /** First offset whose character box satisfies `past` (monotonic in a text node). */
  const firstOffset = (node: Text, past: (box: DOMRect) => boolean) => {
    let low = 0;
    let high = node.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (past(charBox(node, middle))) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  /** Line boxes of a text node, limited to the viewport for huge nodes. */
  const textBoxes = (node: Text): ArrayLike<DOMRect> => {
    range.selectNodeContents(node);
    if (node.length < LONG_TEXT) return range.getClientRects();
    const whole = range.getBoundingClientRect();
    if (whole.top >= port.bottom || whole.bottom <= port.top) return [whole];
    const start = firstOffset(node, (box) => box.bottom > port.top);
    const end = firstOffset(node, (box) => box.top >= port.bottom);
    if (start >= end) return [];
    range.setStart(node, start);
    range.setEnd(node, end);
    return range.getClientRects();
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visited = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.nodeValue?.trim()) continue;
    if (++visited > MAX_TEXT_NODES) break;
    const unit = addUnit(node.parentElement);
    if (unit === "below") break;
    if (unit) continue;
    const boxes = textBoxes(node);
    // Document order follows reading order here (rows are units), so the
    // first text wholly below the viewport ends the walk.
    let below = boxes.length > 0;
    for (let index = 0; index < boxes.length; index++) if (add(boxes[index]) !== "below") below = false;
    if (below) break;
  }
  const media = root.querySelectorAll("img, hr, svg, video, canvas");
  for (let index = 0; index < Math.min(media.length, MAX_MEDIA); index++) {
    // Media in a table row or heading reveal with that whole unit.
    if (!addUnit(media[index])) add(media[index].getBoundingClientRect());
  }

  rects.sort((a, b) => a[0] - b[0]);
  const bands: Band[] = [];
  for (const [top, bottom] of rects) {
    const last = bands.at(-1);
    // Inline runs on one visual line overlap; consecutive lines do not.
    if (last && top < last[1] - 1) last[1] = Math.max(last[1], bottom);
    else bands.push([top, bottom]);
  }
  while (bands.length > MAX_BANDS) {
    for (let index = 0; index + 1 < bands.length; index++) bands.splice(index, 2, [bands[index][0], bands[index + 1][1]]);
  }
  return bands;
}

function start(root: HTMLElement, viewport?: () => CompletionRevealViewport | null): CompletionReveal {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof view.requestAnimationFrame !== "function" || typeof view.matchMedia !== "function"
    || !(view.CSS?.supports("mask-image", HIDDEN) || view.CSS?.supports("-webkit-mask-image", HIDDEN))) return NONE;
  const policy = view.matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)");
  if (policy.matches || doc.hidden || !root.isConnected) return NONE;

  let done = false;
  let frame: number | null = null;
  let observer: ResizeObserver | null = null;
  let size: { width: number; height: number } | null = null;
  const selecting = () => {
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let index = 0; index < selection.rangeCount; index++) if (selection.getRangeAt(index).intersectsNode(root)) return true;
    return false;
  };
  const finish = () => {
    if (done) return;
    done = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    view.clearTimeout(safety);
    observer?.disconnect();
    observer = null;
    policy.removeEventListener("change", finish);
    doc.removeEventListener("visibilitychange", finish);
    doc.removeEventListener("selectionchange", onSelection);
    clearMask(root);
  };
  const onSelection = () => { if (selecting()) finish(); };
  const guarded = (step: (now: number) => void) => (now: number) => {
    frame = null;
    if (done) return;
    // A cosmetic failure must never leave a complete answer invisible.
    try {
      if (!root.isConnected || doc.hidden || policy.matches) { finish(); return; }
      step(now);
    } catch { finish(); }
  };

  let bands: Band[] = [];
  let boundaries: number[] = [];
  let began = 0;
  let stagger = 0;
  const paint = guarded((now) => {
    const stops: string[] = [];
    let settled = true;
    for (let index = 0; index < bands.length; index++) {
      const progress = Math.min(1, Math.max(0, (now - began - index * stagger) / FADE_MS));
      const alpha = 1 - (1 - progress) ** 3;
      if (alpha < 1) settled = false;
      const color = `rgba(0,0,0,${alpha.toFixed(3)})`;
      const end = index + 1 < bands.length ? `${boundaries[index + 1].toFixed(1)}px` : "100%";
      stops.push(`${color} ${boundaries[index].toFixed(1)}px`, `${color} ${end}`);
    }
    if (settled) { finish(); return; }
    setMask(root, `linear-gradient(to bottom, ${stops.join(", ")})`);
    frame = view.requestAnimationFrame(paint);
  });
  const measure = guarded((now) => {
    // Measured one frame later so the timeline has applied its scroll
    // position; until then the answer is simply not painted.
    const rect = root.getBoundingClientRect();
    bands = measureBands(root, viewport?.() ?? { top: 0, bottom: view.innerHeight });
    if (!bands.length) { finish(); return; }
    boundaries = bands.map((band, index) => index ? (bands[index - 1][1] + band[0]) / 2 : 0);
    stagger = bands.length > 1 ? Math.min(STAGGER_MS, SPAN_MS / (bands.length - 1)) : 0;
    began = now;
    size = { width: rect.width, height: rect.height };
    if (typeof ResizeObserver === "function") {
      // Any reflow (late image, font, width change) invalidates the bands.
      observer = new ResizeObserver(() => {
        const next = root.getBoundingClientRect();
        if (size && (Math.abs(next.width - size.width) > 0.5 || Math.abs(next.height - size.height) > 0.5)) finish();
      });
      observer.observe(root, { box: "border-box" });
    }
    paint(now);
  });

  root.style.setProperty("-webkit-mask-size", "100% 100%");
  root.style.setProperty("mask-size", "100% 100%");
  root.style.setProperty("-webkit-mask-repeat", "no-repeat");
  root.style.setProperty("mask-repeat", "no-repeat");
  setMask(root, HIDDEN);
  const safety = view.setTimeout(finish, SAFETY_MS);
  policy.addEventListener("change", finish);
  doc.addEventListener("visibilitychange", finish);
  doc.addEventListener("selectionchange", onSelection);
  frame = view.requestAnimationFrame(measure);
  return { finish, dispose: finish };
}
