/** Paint-only decoration. Never changes message text, Markdown nodes, or geometry. */
export interface StreamingTextFade {
  update(source: string): void;
  finish(): void;
  dispose(): void;
}

const NO_FADE: StreamingTextFade = { update() {}, finish() {}, dispose() {} };
const DURATION = 140;
const BUCKET_MS = 20;
const START_OPACITY = 30;
const MAX_COHORTS = 24;
const MAX_RANGES = 64;
const MAX_STYLE_READS = 64;
const MAX_SOURCE = 48_000;
const MAX_TEXT = 32_768;
let nextOwner = 0;

type TextPart = { node: Text; start: number; end: number };
type Snapshot = { text: string; parts: TextPart[] };
type Cohort = { start: number; end: number; born: number; slot: number; color: string; highlight: Highlight; sealed?: boolean };

function snapshot(root: HTMLElement): Snapshot | null {
  const parts: TextPart[] = [];
  let text = "";
  let visited = 0;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (/^(BUTTON|INPUT|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|TEXTAREA|SELECT|SVG)$/i.test(element.tagName)
          || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++visited > 512) return null;
    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
    const end = text.length + node.nodeValue.length;
    if (parts.length >= 256 || end > MAX_TEXT) return null;
    parts.push({ node: node as Text, start: text.length, end });
    text += node.nodeValue;
  }
  return { text, parts };
}

/**
 * Call update only after React commits the deferred Markdown. The first commit
 * establishes a baseline, including when revisiting an already-streaming row.
 * Unsupported browsers retain exactly the existing, fully visible rendering.
 */
export function createStreamingTextFade(root: HTMLElement): StreamingTextFade {
  try { return createSupportedFade(root); } catch { return NO_FADE; }
}

function createSupportedFade(root: HTMLElement): StreamingTextFade {
  const doc = root.ownerDocument;
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  if (!view?.CSS?.highlights || typeof view.Highlight !== "function" || typeof Intl.Segmenter !== "function"
    || !view.CSS.supports("selector(::highlight(mythra-stream-test))")
    || !view.CSS.supports("color", "color-mix(in srgb, currentColor 45%, transparent)")) return NO_FADE;

  const registry = view.CSS.highlights;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const policy = view.matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)");
  const owner = `mythra-stream-${++nextOwner}-`;
  let previous: { source: string; text: string } | null = null;
  let cohorts: Cohort[] = [];
  let frame: number | null = null;
  let stylesheet: HTMLStyleElement | null = null;
  let rules: CSSStyleRule[] = [];
  let disposed = false;
  let finishing = false;

  const remove = (cohort: Cohort) => {
    if (registry.get(owner + cohort.slot) === cohort.highlight) registry.delete(owner + cohort.slot);
    cohort.highlight.clear();
  };
  const clear = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    cohorts.forEach(remove);
    cohorts = [];
  };
  const reset = () => {
    clear();
    previous = null;
    if (finishing && !disposed) dispose();
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
  const onSelection = () => { if (selecting()) reset(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    reset();
    stylesheet?.remove();
    stylesheet = null;
    rules = [];
    policy.removeEventListener("change", reset);
    doc.removeEventListener("visibilitychange", reset);
    doc.removeEventListener("selectionchange", onSelection);
  };
  const ensureRules = () => {
    if (stylesheet) return;
    stylesheet = doc.createElement("style");
    stylesheet.dataset.mythraStreamFade = owner;
    doc.head.append(stylesheet);
    const sheet = stylesheet.sheet;
    if (!sheet) throw new Error("Streaming decoration stylesheet unavailable");
    for (let slot = 0; slot < MAX_COHORTS; slot++) {
      sheet.insertRule(`::highlight(${owner}${slot}) { color: currentColor; }`, slot);
      rules.push(sheet.cssRules[slot] as CSSStyleRule);
    }
  };
  const paint = (now: number) => {
    for (const cohort of cohorts) {
      const elapsed = Math.max(0, (now - cohort.born) / DURATION);
      if (elapsed >= 1) remove(cohort);
      // Highlight inheritance is separate from element inheritance. currentColor
      // here compounds alpha through ancestors and can also lose the text hue.
      else rules[cohort.slot].style.color = `color-mix(in srgb, ${cohort.color} ${START_OPACITY + (100 - START_OPACITY) * (1 - (1 - elapsed) ** 3)}%, transparent)`;
    }
    cohorts = cohorts.filter((cohort) => now - cohort.born < DURATION);
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed) return;
    try {
      if (blocked()) { reset(); return; }
      paint(now);
      if (cohorts.length) frame = view.requestAnimationFrame(tick);
      else if (finishing) dispose();
    } catch { dispose(); } // Cosmetic failures must never take down a transcript.
  };

  policy.addEventListener("change", reset);
  doc.addEventListener("visibilitychange", reset);
  doc.addEventListener("selectionchange", onSelection);

  return {
    dispose,
    finish() {
      if (disposed) return;
      finishing = true;
      if (!cohorts.length) dispose();
    },
    update(source) {
      if (disposed) return;
      // A later authoritative edit to a finished message is not a stream.
      // Show it normally rather than keeping ranges over a changed DOM.
      if (finishing) {
        if (previous?.source !== source) dispose();
        return;
      }
      try {
        if (blocked() || source.length > MAX_SOURCE) { reset(); return; }
        if (previous?.source === source) return;
        const current = snapshot(root);
        if (!current) { reset(); return; }
        const prior = previous;
        previous = { source, text: current.text };
        if (!prior || !source.startsWith(prior.source)
          || current.text.length - prior.text.length > 2048) { clear(); return; }

        const renderedAppend = current.text.startsWith(prior.text);
        if (!renderedAppend) {
          // Closing Markdown syntax can rewrite just the tail. Keep fading the
          // unchanged prefix rather than flashing every in-flight word bright.
          let shared = 0;
          while (shared < prior.text.length && shared < current.text.length && prior.text[shared] === current.text[shared]) shared++;
          cohorts = cohorts.filter((cohort) => {
            cohort.end = Math.min(cohort.end, shared);
            cohort.sealed = true;
            if (cohort.start < cohort.end) return true;
            remove(cohort);
            return false;
          });
        }

        const now = view.performance.now();
        paint(now);
        const previousCohorts = cohorts.map((cohort) => ({ ...cohort }));
        const colors = new Map<Element, string>();
        const colorOf = (node: Text) => {
          const parent = node.parentElement!;
          let color = colors.get(parent);
          if (color === undefined) {
            if (colors.size >= MAX_STYLE_READS) return null;
            color = view.getComputedStyle(parent).color;
            colors.set(parent, color);
          }
          return color;
        };
        // Spend the style budget on already-fading text before new arrivals.
        for (const part of current.parts) {
          if (cohorts.some((cohort) => part.start < cohort.end && part.end > cohort.start)
            && colorOf(part.node) === null) break;
        }
        if (renderedAppend && current.text.length > prior.text.length) {
          ensureRules();
          const newColors = new Set<string>();
          for (const part of current.parts) {
            if (part.end <= prior.text.length) continue;
            const color = colorOf(part.node);
            if (color === null) {
              newColors.clear();
              // Do not later extend a group across text shown without fading.
              cohorts.forEach((cohort) => { cohort.sealed = true; });
              break;
            }
            newColors.add(color);
          }
          for (const color of newColors) {
            // Bucket by time, not commit count: 120 Hz updates must not force
            // half-faded text to full opacity. Birth times never move backward.
            const reusable = cohorts.find((cohort) => !cohort.sealed && cohort.color === color
              && Math.floor(cohort.born / BUCKET_MS) === Math.floor(now / BUCKET_MS));
            if (reusable) { reusable.end = current.text.length; continue; }
            // Unusually colorful output may use ordinary rendering for new
            // text, but must not interrupt fades that are already in progress.
            if (cohorts.length >= MAX_COHORTS) continue;
            const slot = Array.from({ length: MAX_COHORTS }, (_, index) => index).find((index) => !cohorts.some((cohort) => cohort.slot === index))!;
            cohorts.push({ start: prior.text.length, end: current.text.length, born: now, slot, color, highlight: new view.Highlight() });
          }
        }

        // React may replace text nodes or reset Range offsets through nodeValue.
        // Rebuild from committed rendered-text offsets, never Markdown offsets.
        const segments = segmenter.segment(current.text);
        const planRanges = (candidates: Cohort[]) => {
          let rangeCount = 0;
          const plan: Array<{ cohort: Cohort; ranges: Array<{ node: Text; from: number; to: number }> }> = [];
          for (const cohort of candidates) {
            const ranges: Array<{ node: Text; from: number; to: number }> = [];
            const first = segments.containing(cohort.start);
            const last = cohort.end < current.text.length ? segments.containing(cohort.end) : undefined;
            const start = first && first.index < cohort.start ? first.index + first.segment.length : cohort.start;
            const end = last && last.index < cohort.end ? last.index : cohort.end;
            for (const part of current.parts) {
              const from = Math.max(start, part.start);
              const to = Math.min(end, part.end);
              if (from >= to) continue;
              // A semantic reparse can change a node's color. Leave that text fully
              // visible instead of recoloring links/code with a stale cohort hue.
              const color = colorOf(part.node);
              if (color === null) return null;
              if (color !== cohort.color) continue;
              if (++rangeCount > MAX_RANGES) return null;
              ranges.push({ node: part.node, from: from - part.start, to: to - part.start });
            }
            plan.push({ cohort, ranges });
          }
          return plan;
        };
        let plan = planRanges(cohorts);
        if (!plan) {
          // Roll back only the proposed append, not the in-flight fades. Plan
          // atomically so an overflow never leaves stale or partial DOM ranges.
          cohorts = previousCohorts.map((cohort) => ({ ...cohort, sealed: true }));
          plan = planRanges(cohorts);
          // A reparse that makes even the old ranges unrepresentable still
          // falls back to ordinary text within the same strict work limits.
          if (!plan) { clear(); return; }
        }
        cohorts.forEach((cohort) => cohort.highlight.clear());
        for (const { cohort, ranges } of plan) {
          for (const { node, from, to } of ranges) {
            const range = doc.createRange();
            range.setStart(node, from);
            range.setEnd(node, to);
            cohort.highlight.add(range);
          }
          registry.set(owner + cohort.slot, cohort.highlight);
        }
        cohorts = cohorts.filter((cohort) => {
          if (cohort.highlight.size) return true;
          remove(cohort);
          return false;
        });
        paint(now);
        if (cohorts.length && frame === null) frame = view.requestAnimationFrame(tick);
      } catch { dispose(); }
    },
  };
}
