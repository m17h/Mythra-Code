import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createCompletionReveal, type CompletionReveal } from "./completionReveal";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

const cleanups: Array<() => void> = [];

function frameClock() {
  let now = 5_000;
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { callbacks.delete(key); });
  return {
    advance(ms: number) {
      now += ms;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(now));
    },
    pending: () => callbacks.size,
  };
}

/** `zoom` wraps the answer the way the app shell's UI scale does. */
function answer(html: string, { width = 360, zoom }: { width?: number; zoom?: number } = {}) {
  const host = document.createElement("div");
  if (zoom) host.style.zoom = String(zoom);
  const root = document.createElement("div");
  root.style.cssText = `width: ${width}px; font: 16px/24px sans-serif; color: rgb(20, 40, 60)`;
  root.innerHTML = html;
  host.append(root);
  document.body.append(host);
  let reveal: CompletionReveal | undefined;
  cleanups.push(() => { reveal?.dispose(); host.remove(); });
  return {
    root,
    start(viewport?: () => { top: number; bottom: number }) {
      reveal = createCompletionReveal(root, viewport);
      return reveal;
    },
  };
}

const mask = (root: HTMLElement) => root.style.getPropertyValue("mask-image") || root.style.getPropertyValue("-webkit-mask-image");

/** Mask alpha at a vertical offset in the root's own CSS pixels (1 when unmasked). */
function alphaAt(root: HTMLElement, y: number): number {
  const image = mask(root);
  if (!image) return 1;
  const stops = [...image.matchAll(/rgba?\(0, ?0, ?0(?:, ?([\d.]+))?\) (-?[\d.]+)(px|%)/g)]
    .map((match) => ({ alpha: match[1] === undefined ? 1 : Number(match[1]), at: match[3] === "%" ? Infinity : Number(match[2]) }));
  if (!stops.length) return 0;
  for (let index = 0; index + 1 < stops.length; index += 2) if (y < stops[index + 1].at) return stops[index].alpha;
  return stops.at(-1)!.alpha;
}
const bandCount = (root: HTMLElement) => [...mask(root).matchAll(/rgba?\(0, ?0, ?0/g)].length / 2;
/** Number of visual lines a text node occupies (independent of zoom). */
const lineCount = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
};

/** Vertical center of each visual line of a text node, relative to an unzoomed root. */
function lineCenters(root: HTMLElement, node: Node): number[] {
  const range = document.createRange();
  range.selectNodeContents(node);
  const origin = root.getBoundingClientRect().top;
  return [...range.getClientRects()].map((rect) => (rect.top + rect.bottom) / 2 - origin);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await commands.setStreamTestReducedMotion(false);
});

describe("one-shot completion reveal", () => {
  it("hides the committed answer before paint, then reveals prose line by line and whole headings and table rows together", () => {
    const clock = frameClock();
    const { root, start } = answer(`<h2 style="margin:0;font-size:22px;line-height:28px">A heading long enough to wrap onto a second line</h2>
      <p style="margin:8px 0">First line<br>Second line<br>Third line</p>
      <table style="border-collapse:collapse"><tbody><tr><td>key</td><td>a cell long enough to wrap onto more lines here</td></tr>
      <tr><td>next</td><td>row</td></tr></tbody></table>`);
    const html = root.innerHTML;
    start();
    expect(mask(root)).toContain("transparent");
    clock.advance(16);
    expect(root.innerHTML).toBe(html);
    const heading = lineCenters(root, root.querySelector("h2")!.firstChild!);
    const paragraph = root.querySelector("p")!.childNodes;
    const [first, second] = [lineCenters(root, paragraph[0])[0], lineCenters(root, paragraph[2])[0]];
    const cells = root.querySelectorAll("td");
    const rowLines = [...lineCenters(root, cells[0].firstChild!), ...lineCenters(root, cells[1].firstChild!)];
    expect(heading.length).toBeGreaterThan(1);
    expect(rowLines.length).toBeGreaterThan(2);
    expect(alphaAt(root, heading[0])).toBe(0);

    clock.advance(140);
    expect(new Set(heading.map((y) => alphaAt(root, y))).size).toBe(1);
    expect(new Set(rowLines.map((y) => alphaAt(root, y))).size).toBe(1);
    expect(alphaAt(root, heading[0])).toBeGreaterThan(alphaAt(root, first));
    expect(alphaAt(root, first)).toBeGreaterThan(alphaAt(root, second));
    expect(alphaAt(root, second)).toBeGreaterThanOrEqual(alphaAt(root, rowLines[0]));

    clock.advance(900);
    expect(mask(root)).toBe("");
    expect(root.getAttribute("style")).not.toMatch(/mask/);
    expect(root.innerHTML).toBe(html);
    expect(clock.pending()).toBe(0);
  });

  it("spaces lines 64ms apart with a 320ms fade, and bounds a full screen of lines to 1040ms", () => {
    const clock = frameClock();
    const short = answer(`<p style="margin:0">One<br>Two<br>Three</p>`);
    short.start();
    clock.advance(16);
    clock.advance(64);
    // Line 1 is 64ms into its fade, line 2 just starting, line 3 not yet.
    expect(alphaAt(short.root, 12)).toBeCloseTo(1 - (1 - 64 / 320) ** 3, 2);
    expect(alphaAt(short.root, 36)).toBe(0);
    clock.advance(128 + 320 - 64 - 1);
    expect(mask(short.root)).not.toBe("");
    clock.advance(2);
    expect(mask(short.root)).toBe("");

    const lines = Array.from({ length: 400 }, (_, index) => `Line ${index}`).join("<br>");
    const { root, start } = answer(`<p style="margin:0">${lines}</p>`);
    const top = root.getBoundingClientRect().top;
    start(() => ({ top, bottom: top + 600 }));
    clock.advance(16);
    expect(bandCount(root)).toBe(25);
    // Text below the viewport shares the last visible line's alpha.
    expect(alphaAt(root, 2_000)).toBe(alphaAt(root, 590));
    clock.advance(1_035);
    expect(mask(root)).not.toBe("");
    expect(alphaAt(root, 12)).toBe(1);
    clock.advance(6);
    expect(mask(root)).toBe("");
  });

  it.each([0.8, 1.25, 1.5])("aligns line and row bands with the real layout under %sx app zoom", (zoom) => {
    const clock = frameClock();
    const { root, start } = answer(`<p style="margin:0">A paragraph of ordinary prose that wraps across several visual lines in this narrow answer column.</p>
      <table style="border-collapse:collapse;table-layout:fixed;width:200px"><tbody>
      <tr><td style="padding:0;width:60px;vertical-align:top">key</td><td style="padding:0">a long cell that wraps over lines</td></tr>
      <tr><td style="padding:0">next</td><td style="padding:0">row</td></tr></tbody></table>`, { width: 240, zoom });
    start();
    clock.advance(16);
    const prose = lineCount(root.querySelector("p")!.firstChild!);
    const rowLines = lineCount(root.querySelectorAll("td")[1].firstChild!);
    expect(prose).toBeGreaterThanOrEqual(3);
    expect(rowLines).toBeGreaterThanOrEqual(2);
    // Local CSS geometry by construction: 24px lines, no margins or padding.
    const proseCenters = Array.from({ length: prose }, (_, line) => 12 + 24 * line);
    const rowCenters = Array.from({ length: rowLines }, (_, line) => 24 * prose + 12 + 24 * line);
    const nextRow = 24 * (prose + rowLines) + 12;
    const steady = (y: number) => {
      expect(alphaAt(root, y - 8)).toBe(alphaAt(root, y));
      expect(alphaAt(root, y + 8)).toBe(alphaAt(root, y));
      return alphaAt(root, y);
    };
    expect(bandCount(root)).toBe(prose + 2);

    clock.advance(150);
    const early = proseCenters.slice(0, 3).map(steady);
    expect(early[0]).toBeGreaterThan(early[1]);
    expect(early[1]).toBeGreaterThan(early[2]);

    clock.advance(64 * prose - 50);
    const lastProse = steady(proseCenters.at(-1)!);
    const row = rowCenters.map(steady);
    expect(new Set(row).size).toBe(1);
    expect(lastProse).toBeGreaterThan(row[0]);
    expect(row[0]).toBeGreaterThan(steady(nextRow));
  });

  it("reveals a row of images as one unit, not one band per image", () => {
    const clock = frameClock();
    const image = (height: number) => `<img alt="" width="40" height="${height}" style="display:block" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
    const { root, start } = answer(`<table style="border-collapse:collapse"><tbody><tr><td style="padding:0">${image(20)}</td><td style="padding:0">${image(60)}</td></tr></tbody></table>`);
    start();
    clock.advance(16);
    expect(bandCount(root)).toBe(1);
    clock.advance(100);
    expect(alphaAt(root, 10)).toBe(alphaAt(root, 50));
  });

  it("clips an enormous paragraph to the viewport instead of listing every line", () => {
    const clock = frameClock();
    const { root, start } = answer(`<p style="margin:0">${"word ".repeat(40_000)}</p>`, { width: 200 });
    const top = root.getBoundingClientRect().top;
    const rects = vi.spyOn(Range.prototype, "getClientRects");
    start(() => ({ top, bottom: top + 300 }));
    clock.advance(16);
    expect(bandCount(root)).toBeGreaterThan(8);
    expect(bandCount(root)).toBeLessThanOrEqual(14);
    const listed = rects.mock.results.reduce((total, result) => total + (result.value as DOMRectList).length, 0);
    expect(listed).toBeLessThan(60);
    clock.advance(1_100);
    expect(mask(root)).toBe("");
  });

  it("is static under reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const { root, start } = answer("<p>Complete answer</p>");
    start();
    expect(mask(root)).toBe("");
  });

  it("shows everything at once on selection, reflow, explicit finish, or disposal", async () => {
    const clock = frameClock();
    const selected = answer("<p>Select me</p>");
    selected.start();
    clock.advance(16);
    expect(mask(selected.root)).not.toBe("");
    window.getSelection()!.selectAllChildren(selected.root.querySelector("p")!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(mask(selected.root)).toBe("");

    const reflow = answer("<p>Grows later</p>");
    reflow.start();
    clock.advance(16);
    expect(mask(reflow.root)).not.toBe("");
    reflow.root.style.paddingBottom = "80px";
    await vi.waitFor(() => expect(mask(reflow.root)).toBe(""));

    const finished = answer("<p>Searched</p>");
    const reveal = finished.start();
    clock.advance(16);
    reveal.finish();
    expect(mask(finished.root)).toBe("");
    clock.advance(16);
    expect(mask(finished.root)).toBe("");

    const disposed = answer("<p>Unmounted</p>");
    disposed.start().dispose();
    expect(mask(disposed.root)).toBe("");
    expect(clock.pending()).toBe(0);
  });

  it("never leaves an answer invisible when frames stop arriving", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { root, start } = answer("<p>Background tab</p>");
    start();
    expect(mask(root)).toContain("transparent");
    vi.advanceTimersByTime(2_500);
    expect(mask(root)).toBe("");
  });
});
