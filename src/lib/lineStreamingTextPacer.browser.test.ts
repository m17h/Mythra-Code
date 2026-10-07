import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createLineStreamingTextPacer } from "./lineStreamingTextPacer";

const cleanup: Array<() => void> = [];
function fixture(initial = "", width = 190) {
  const root = document.createElement("div");
  Object.assign(root.style, { width: `${width}px`, font: "16px/24px monospace", whiteSpace: "normal", overflowWrap: "anywhere" });
  root.textContent = initial; document.body.append(root);
  let now = 1200; let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++nextId, callback); return nextId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const publish = vi.fn((text: string) => { root.textContent = text; });
  const settled = vi.fn();
  const pacer = createLineStreamingTextPacer(root, initial, publish, settled);
  cleanup.push(() => { pacer.dispose(); root.remove(); });
  return { root, publish, settled, pacer, frames, advance(ms: number) {
    now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  } };
}

function actualWrapOffsets(text: string, root: HTMLElement) {
  const reference = root.cloneNode(false) as HTMLElement;
  reference.textContent = text; document.body.append(reference);
  const node = reference.firstChild!;
  const range = document.createRange();
  const offsets: number[] = [];
  let previousTop = -Infinity;
  for (const entry of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    range.setStart(node, entry.index); range.setEnd(node, entry.index + entry.segment.length);
    const top = range.getBoundingClientRect().top;
    if (top > previousTop + 0.5 && previousTop !== -Infinity) offsets.push(entry.index);
    previousTop = Math.max(previousTop, top);
  }
  reference.remove();
  return offsets;
}

afterEach(async () => {
  cleanup.splice(0).forEach(fn => fn());
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
});

describe("line batching inside the Work modal", () => {
  it("publishes genuine wrapped prose boundaries instead of character slices", () => {
    const f = fixture();
    const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
    const wraps = actualWrapOffsets(source, f.root);
    expect(wraps.length).toBeGreaterThan(3);
    f.pacer.update(source);
    for (let index = 0; index < 8; index++) f.advance(30);
    expect(f.publish).toHaveBeenCalled();
    for (const [text] of f.publish.mock.calls) {
      expect(source.startsWith(text)).toBe(true);
      expect(wraps).toContain(text.length);
    }
    expect(f.root.textContent).not.toBe(source);
    f.pacer.finish(); f.advance(240);
    expect(f.root.textContent).toBe(source);
    expect(f.frames.size).toBe(0); expect(f.settled).toHaveBeenCalledOnce();
  });

  it("uses grapheme-safe true wraps even for long tokens, and flushes the exact Unicode tail", () => {
    const f = fixture("", 110);
    const source = "👩‍💻e\u0301🇨🇦".repeat(28);
    const wraps = actualWrapOffsets(source, f.root);
    f.pacer.update(source);
    for (let index = 0; index < 7; index++) f.advance(35);
    for (const [text] of f.publish.mock.calls) expect(wraps).toContain(text.length);
    f.pacer.finish(); f.advance(240);
    expect(f.root.textContent).toBe(source);
  });

  it("wraps long complete paragraphs inside a newline-delimited burst too", () => {
    const f = fixture();
    const paragraph = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
    const source = paragraph + "\n\nsecond paragraph\n";
    const wraps = actualWrapOffsets(paragraph, f.root);
    f.pacer.update(source); f.advance(60);
    expect(wraps).toContain(f.root.textContent!.length);
    expect(f.root.textContent!.length).toBeGreaterThan(0);
    f.advance(180); expect(f.root.textContent).toBe(source);
  });

  it("does not animate mounted history and falls back if policy setup is unsupported", () => {
    const f = fixture("history already complete");
    expect(f.publish).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.pacer.finish(); f.pacer.finish(); expect(f.settled).toHaveBeenCalledOnce();
    vi.spyOn(window, "matchMedia").mockImplementation(() => { throw new Error("unsupported"); });
    const unsupported = fixture(); unsupported.pacer.update("complete text");
    expect(unsupported.root.textContent).toBe("complete text"); expect(unsupported.frames.size).toBe(0);
    unsupported.pacer.finish(); expect(unsupported.settled).toHaveBeenCalledOnce();
  });

  it("does not postpone sparse prose indefinitely when arrivals keep coming", () => {
    const f = fixture("", 2000);
    let source = "";
    for (let index = 0; index < 10; index++) {
      source += "word "; f.pacer.update(source); f.advance(100);
      if (index < 9) expect(f.publish).not.toHaveBeenCalled();
    }
    expect(f.root.textContent).toBe(source); expect(f.frames.size).toBe(0);
    f.pacer.update(source + "fresh"); f.advance(100);
    expect(f.root.textContent).toBe(source);
  });

  it("keeps GFM header+delimiter atomic and incomplete rows hidden even after max prose age", () => {
    const f = fixture();
    const header = "| Name | Result |\n";
    f.pacer.update(header); f.advance(1200);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.pacer.update(header + "| --- | :---"); f.advance(1200);
    expect(f.publish).not.toHaveBeenCalled();
    const table = header + "| --- | :---: |\n";
    f.pacer.update(table + "| first | pass"); f.advance(240);
    expect(f.root.textContent).toBe(table); expect(f.frames.size).toBe(0);
    const row = "| first | passed |\n";
    f.pacer.update(table + row + "| second | final"); f.advance(1200);
    expect(f.root.textContent).toBe(table + row); expect(f.frames.size).toBe(0);
    // finish must restart a stopped scheduler even without another source update.
    f.pacer.finish(); expect(f.frames.size).toBe(1); f.advance(240);
    expect(f.root.textContent).toBe(table + row + "| second | final");
    expect(f.settled).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
  });

  it("keeps headings, code, lists and unsupported/unclosed inline Markdown intact", () => {
    for (const source of ["# unfinished heading", "- unfinished list", "```ts\nconst x =", "**unfinished bold words keep going across many visual lines", "[unfinished link across many words"] ) {
      const f = fixture(); f.pacer.update(source); f.advance(240);
      expect(f.publish.mock.calls.every(([text]) => text.endsWith("\n"))).toBe(true);
      f.pacer.finish(); f.advance(240);
      expect(f.root.textContent).toBe(source); expect(f.settled).toHaveBeenCalledOnce();
      f.pacer.dispose();
    }
  });

  it("holds pipeless GFM rows and shows every complete row in order", () => {
    const f = fixture("", 110);
    const table = "| A | B |\n| - | - |\n";
    f.pacer.update(table + "plain row with words that would otherwise wrap"); f.advance(1200);
    expect(f.root.textContent).toBe(table);
    const source = table + "plain row with words that would otherwise wrap\n| next | row |\n";
    f.pacer.update(source); f.advance(240);
    expect(f.root.textContent).toBe(source);
    for (const [text] of f.publish.mock.calls) expect(text.endsWith("\n")).toBe(true);
  });

  it("coalesces matured arrival metadata without flashing a slowly completed table row", () => {
    const f = fixture();
    const table = "| A | B |\n| - | - |\n";
    for (let index = 1; index <= 300; index++) {
      f.pacer.update(table + "x".repeat(index)); f.advance(10);
      expect(f.root.textContent === "" || f.root.textContent === table).toBe(true);
    }
    f.pacer.update(table + "x".repeat(300) + "\n"); f.advance(240);
    expect(f.root.textContent).toBe(table + "x".repeat(300) + "\n");
  });

  it("drains '<3' prose by max age and keeps comparison or inline-HTML table rows intact", () => {
    const prose = fixture(); prose.pacer.update("<3 a short prose response"); prose.advance(1000);
    expect(prose.root.textContent).toBe("<3 a short prose response");
    prose.pacer.dispose();
    const table = "| A | B |\n| - | - |\n";
    for (const row of ["<3 a comparison row with many wrapping words", "<b>inline HTML</b> row with many wrapping words"]) {
      const f = fixture("", 110); f.pacer.update(table + row); f.advance(1200);
      expect(f.root.textContent).toBe(table);
      f.pacer.finish(); f.advance(240); expect(f.root.textContent).toBe(table + row);
      f.pacer.dispose();
    }
  });

  it("measures common closed bold words and links without publishing unfinished inline tokens", () => {
    const f = fixture("", 220);
    const source = "alpha bravo **bold** delta echo foxtrot [link](https://example.com) golf hotel india juliet kilo lima mike november oscar papa";
    f.pacer.update(source);
    for (let index = 0; index < 8; index++) f.advance(30);
    expect(f.publish).toHaveBeenCalled();
    expect(f.root.textContent!.length).toBeGreaterThan(source.indexOf("[link]"));
    for (const [text] of f.publish.mock.calls) {
      expect((text.match(/\*\*/g) ?? []).length % 2).toBe(0);
      expect(text.includes("[link]") === text.includes("(https://example.com)")).toBe(true);
      expect(source.startsWith(text)).toBe(true);
    }
    f.pacer.finish(); f.advance(240); expect(f.root.textContent).toBe(source);
  });

  it("caches unchanged layout between frames and invalidates it on resizing", () => {
    const f = fixture();
    const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect");
    const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november";
    f.pacer.update(source); f.advance(1);
    const calls = geometry.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    f.advance(1); f.advance(1); expect(geometry).toHaveBeenCalledTimes(calls);
    f.root.style.width = "120px"; f.advance(1);
    expect(geometry.mock.calls.length).toBeGreaterThan(calls);
    const wraps = actualWrapOffsets(source, f.root);
    f.advance(236);
    expect(wraps).toContain(f.root.textContent!.length);
  });

  it("shows corrections and resource overflows immediately, without stale queues", () => {
    const f = fixture("old "); f.pacer.update("old queued words");
    f.pacer.update("new correction"); expect(f.root.textContent).toBe("new correction"); expect(f.frames.size).toBe(0);
    const huge = "new correction" + "x".repeat(8193);
    f.pacer.update(huge); expect(f.root.textContent).toBe(huge); expect(f.frames.size).toBe(0);
    f.pacer.update("x".repeat(48001)); f.pacer.update("x".repeat(48002));
    expect(f.root.textContent!.length).toBe(48002); expect(f.frames.size).toBe(0);
    f.pacer.finish(); expect(f.settled).toHaveBeenCalledOnce();
  });

  it("falls back to full text after a measurement error and releases its probe", () => {
    const f = fixture();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(() => { throw new Error("layout unavailable"); });
    const source = "a paragraph with enough words to wrap over several visible lines";
    f.pacer.update(source); f.advance(60);
    expect(f.root.textContent).toBe(source); expect(f.frames.size).toBe(0);
    expect(document.querySelector("[data-mythra-line-probe]")).toBeNull();
    f.pacer.update(source + " immediately"); expect(f.root.textContent).toBe(source + " immediately");
  });

  it("flushes for selection, visibility, reduced motion and copy; disposal cancels scheduling", async () => {
    const f = fixture("old "); f.pacer.update("old pending prose");
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(f.root); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(f.root.textContent).toBe("old pending prose"); expect(f.frames.size).toBe(0);
    selection.removeAllRanges(); f.pacer.update("old pending prose next"); document.dispatchEvent(new Event("visibilitychange"));
    expect(f.root.textContent).toBe("old pending prose next");
    f.pacer.update("old pending prose next copied"); f.pacer.flush(); expect(f.root.textContent).toBe("old pending prose next copied");
    vi.restoreAllMocks(); await commands.setStreamTestReducedMotion(true);
    f.pacer.update("old pending prose next copied reduced"); expect(f.root.textContent).toBe("old pending prose next copied reduced");
    f.pacer.dispose(); const calls = f.publish.mock.calls.length;
    f.pacer.update("ignored"); f.pacer.finish(); expect(f.publish).toHaveBeenCalledTimes(calls);
    expect(document.querySelector("[data-mythra-line-probe]")).toBeNull();
  });
});
