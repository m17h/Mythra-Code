import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createStreamingTextPacer } from "./streamingTextPacer";

const cleanup: Array<() => void> = [];
function fixture(initial = "old ") {
  const root = document.createElement("div"); root.textContent = initial; document.body.append(root);
  let now = 1200; let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++nextId, callback); return nextId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const publish = vi.fn((text: string) => { root.textContent = text; });
  const settled = vi.fn();
  const pacer = createStreamingTextPacer(root, initial, publish, settled);
  cleanup.push(() => { pacer.dispose(); root.remove(); });
  return { root, publish, settled, pacer, frames, advance(ms: number) {
    now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  } };
}

afterEach(async () => {
  cleanup.splice(0).forEach(fn => fn());
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
});

describe("bounded display-only streaming cadence", () => {
  it("falls back to immediate rendering when media-policy setup fails", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(() => { throw new Error("unavailable"); });
    const f = fixture(); f.pacer.update("complete text");
    expect(f.root.textContent).toBe("complete text"); expect(f.frames.size).toBe(0);
    f.pacer.finish(); expect(f.settled).toHaveBeenCalledTimes(1);
  });
  it("does not animate mounted history and drains a burst gradually by its deadline", () => {
    const f = fixture();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.pacer.update(`old ${"x".repeat(180)}`);
    expect(f.root.textContent).toBe("old ");
    f.advance(60); expect(f.root.textContent?.length).toBe(49);
    f.advance(60); expect(f.root.textContent?.length).toBe(94);
    f.advance(120); expect(f.root.textContent?.length).toBe(184); expect(f.frames.size).toBe(0);
  });

  it("never restarts old deadlines during sustained arrivals, and caps ordinary publishes at 30 Hz", () => {
    const f = fixture("");
    let text = "";
    for (let i = 0; i < 120; i++) {
      text += "hello "; f.pacer.update(text); f.advance(1000 / 120);
      if (i >= 30) expect(f.root.textContent!.length).toBeGreaterThanOrEqual((i - 29) * 6);
      expect(f.frames.size).toBeLessThanOrEqual(1);
    }
    expect(f.publish.mock.calls.length).toBeLessThanOrEqual(31);
    f.advance(240); expect(f.root.textContent).toBe(text); expect(f.frames.size).toBe(0);
  });

  it("keeps only a bounded visual tail after completion and releases all scheduling", () => {
    const f = fixture(); f.pacer.update("old final words"); f.pacer.finish();
    expect(f.settled).not.toHaveBeenCalled(); f.advance(120);
    expect(f.root.textContent!.length).toBeLessThan("old final words".length);
    f.advance(120); expect(f.root.textContent).toBe("old final words"); expect(f.settled).toHaveBeenCalledTimes(1);
    expect(f.frames.size).toBe(0); f.pacer.update("ignored after cleanup");
    expect(f.root.textContent).toBe("old final words");
  });

  it("never slices inside a grapheme cluster", () => {
    const f = fixture("");
    const text = "👩‍💻e\u0301🇨🇦"; const boundaries = new Set([0, ...[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(s => s.index + s.segment.length)]);
    f.pacer.update(text);
    for (let i = 0; i < 16; i++) { f.advance(16); expect(boundaries.has(f.root.textContent!.length)).toBe(true); }
    expect(f.root.textContent).toBe(text);
  });

  it("shows source replacements, huge bursts, and oversized messages without stale queues", () => {
    const f = fixture(); f.pacer.update("old pending"); f.pacer.update("new replacement");
    expect(f.root.textContent).toBe("new replacement"); expect(f.frames.size).toBe(0);
    const huge = `new replacement${"x".repeat(3000)}`; f.pacer.update(huge);
    expect(f.root.textContent).toBe(huge); expect(f.frames.size).toBe(0);
    f.pacer.update("x".repeat(48001)); f.pacer.update("x".repeat(48002));
    expect(f.root.textContent?.length).toBe(48002); expect(f.frames.size).toBe(0);
  });

  it("flushes on selection, hidden-page notification, and reduced motion; cancellation publishes nothing", async () => {
    const f = fixture(); f.pacer.update("old pending");
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(f.root); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange")); expect(f.root.textContent).toBe("old pending"); expect(f.frames.size).toBe(0);
    selection.removeAllRanges(); f.pacer.update("old pending next");
    document.dispatchEvent(new Event("visibilitychange")); expect(f.root.textContent).toBe("old pending next");
    // Restore real rAF before the browser command, which waits two real frames.
    vi.restoreAllMocks(); await commands.setStreamTestReducedMotion(true);
    f.pacer.update("old pending next reduced"); expect(f.root.textContent).toBe("old pending next reduced");
    f.pacer.dispose(); const calls = f.publish.mock.calls.length;
    f.pacer.update("must not publish"); f.pacer.finish(); expect(f.publish).toHaveBeenCalledTimes(calls);
  });
});
