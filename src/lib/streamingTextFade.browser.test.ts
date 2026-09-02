import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createStreamingTextFade } from "./streamingTextFade";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

const cleanups: Array<() => void> = [];
function fixture(initial: string) {
  const root = document.createElement("div");
  root.style.cssText = "width: 320px; color: rgb(20, 40, 60); font: 16px/24px sans-serif";
  const paragraph = document.createElement("p");
  paragraph.textContent = initial;
  root.append(paragraph);
  document.body.append(root);
  const controller = createStreamingTextFade(root);
  controller.update(initial);
  cleanups.push(() => { controller.dispose(); root.remove(); });
  return { root, paragraph, controller, append(text: string) { paragraph.textContent = text; controller.update(text); } };
}
const highlights = () => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("mythra-stream-"));
const highlightedText = () => highlights().flatMap(([, highlight]) => [...highlight].map((range) => (range as Range).toString())).join("");

function frameClock() {
  let now = 1200;
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { callbacks.delete(key); });
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(now));
    },
    pending: () => callbacks.size,
  };
}

function opacityOf(name: string, parent: Element) {
  return Number(getComputedStyle(parent, `::highlight(${name})`).color.match(/\/ ([\d.]+)\)/)?.[1] ?? 1);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
  expect(highlights()).toHaveLength(0);
  expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
});

describe("paint-only streaming text fade", () => {
  it("leaves the first snapshot untouched and fades only an append within the same paragraph", () => {
    const { root, paragraph, append } = fixture("Already visible. ");
    expect(highlights()).toHaveLength(0);
    const originalChildren = root.childElementCount;
    append("Already visible. Newly arrived words");
    expect(highlightedText()).toBe("Newly arrived words");
    expect(root.childElementCount).toBe(originalChildren);
    expect(paragraph.children).toHaveLength(0);
    expect(paragraph.textContent).toBe("Already visible. Newly arrived words");
    expect(getComputedStyle(paragraph).color).toBe("rgb(20, 40, 60)");
    const paint = getComputedStyle(paragraph, `::highlight(${highlights()[0][0]})`).color;
    expect(paint).toMatch(/0\.3/);
    expect(paint).toMatch(/0\.078431\d* 0\.156863 0\.235294/);
  });

  it("preserves independently colored nested text without multiplying alpha", () => {
    const { root, controller } = fixture("old ");
    root.innerHTML = '<p>old <strong style="color: rgb(255, 0, 0)"><em>red</em></strong><a style="color: rgb(0, 0, 255)">blue</a></p>';
    controller.update("old **red**blue");
    expect(highlights()).toHaveLength(2);
    for (const [name, highlight] of highlights()) {
      const range = [...highlight][0] as Range;
      const color = getComputedStyle(range.startContainer.parentElement!, `::highlight(${name})`).color;
      expect(color).toBe(range.toString() === "red" ? "color(srgb 1 0 0 / 0.3)" : "color(srgb 0 0 1 / 0.3)");
    }
  });

  it("rebuilds ranges after React-style text-node replacement without fading the old prefix", () => {
    const { append } = fixture("Old ");
    append("Old new ");
    append("Old new tail");
    expect(highlightedText()).toBe("new tail");
    for (const [, highlight] of highlights()) for (const range of highlight) expect((range as Range).startContainer.isConnected).toBe(true);
  });

  it("does not re-fade on repeated commits, source rewrites, or Markdown-visible rewrites", () => {
    const { paragraph, controller, append } = fixture("old");
    append("old new");
    const names = highlights().map(([name]) => name);
    controller.update("old new");
    expect(highlights().map(([name]) => name)).toEqual(names);
    append("replacement");
    expect(highlights()).toHaveLength(0);
    paragraph.innerHTML = "<strong>replacement</strong>";
    controller.update("replacement**");
    expect(highlights()).toHaveLength(0);
  });

  it("excludes controls from ranges while supporting nested formatting and code text", () => {
    const { root, controller } = fixture("old ");
    root.innerHTML = "<p>old <strong>bold</strong></p><div><button>Copy</button><pre><code>code &amp; text</code></pre></div>";
    controller.update("old **bold**\n\n```\ncode & text");
    expect(highlightedText()).toBe("boldcode & text");
    for (const [, highlight] of highlights()) for (const range of highlight) {
      expect((range as Range).startContainer.parentElement?.closest("button")).toBeNull();
      expect((range as Range).startContainer).toBe((range as Range).endContainer);
    }
  });

  it("never splits a surrogate pair, combining sequence, or joined emoji", () => {
    for (const [before, after] of [["prefix \ud83d", "prefix 😀 next"], ["prefix e", "prefix e\u0301 next"], ["prefix 👩", "prefix 👩‍💻 next"]]) {
      const { append, controller } = fixture(before);
      append(after);
      expect(highlightedText()).toBe(" next");
      controller.dispose();
    }
  });

  it("finishes promptly and leaves no animation frame or highlight behind", async () => {
    const { append, root } = fixture("old ");
    append("old new");
    const height = root.getBoundingClientRect().height;
    expect(highlights().length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(highlights()).toHaveLength(0), { timeout: 600 });
    expect(root.getBoundingClientRect().height).toBe(height);
  });

  it("bounds burst and large-message work and never queues hidden text", () => {
    const { append, paragraph } = fixture("old ");
    for (let index = 1; index < 40; index++) append(`old ${"word ".repeat(index)}`);
    expect(highlights().length).toBeLessThanOrEqual(24);
    const large = `old ${"x".repeat(60_000)}`;
    append(large);
    expect(highlights()).toHaveLength(0);
    expect(paragraph.textContent).toBe(large);
  });

  it("preserves real selection and immediately clears the cosmetic fade", () => {
    const { root, append } = fixture("old ");
    append("old new words");
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(selection.toString()).toBe("old new words");
    expect(highlights()).toHaveLength(0);
  });

  it("respects reduced motion at startup and when changed during a fade", async () => {
    await commands.setStreamTestReducedMotion(true);
    const { append } = fixture("old ");
    append("old new");
    expect(highlights()).toHaveLength(0);
    await commands.setStreamTestReducedMotion(false);
    append("old new next"); // fresh baseline after the policy change
    append("old new next tail");
    expect(highlights().length).toBeGreaterThan(0);
    await commands.setStreamTestReducedMotion(true);
    await vi.waitFor(() => expect(highlights()).toHaveLength(0));
  });

  it("cleans only its own highlights when two messages are mounted", () => {
    const one = fixture("one ");
    const two = fixture("two ");
    one.append("one fresh");
    two.append("two other");
    one.controller.dispose();
    expect(highlightedText()).toBe("other");
    two.controller.dispose();
    expect(highlights()).toHaveLength(0);
    two.controller.update("after unmount");
    expect(highlights()).toHaveLength(0);
  });

  it("falls back cleanly when the paint API is unsupported or throws", () => {
    const support = vi.spyOn(CSS, "supports").mockReturnValue(false);
    const unsupported = fixture("old ");
    unsupported.append("old readable");
    expect(highlights()).toHaveLength(0);
    expect(unsupported.paragraph.textContent).toBe("old readable");
    support.mockRestore();
    const broken = fixture("old ");
    vi.spyOn(CSS.highlights, "set").mockImplementation(() => { throw new Error("Decoration failed"); });
    expect(() => broken.append("old still readable")).not.toThrow();
    expect(broken.paragraph.textContent).toBe("old still readable");
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  });

  it("drops animation on a hidden tab and does not replay catch-up text", () => {
    const { append } = fixture("old ");
    append("old new");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(highlights()).toHaveLength(0);
    append("old new background");
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    append("old new background catch-up");
    expect(highlights()).toHaveLength(0);
    append("old new background catch-up live");
    expect(highlightedText()).toBe(" live");
  });

  it("skips large bursts and highly fragmented documents without modifying their DOM", () => {
    const { root, paragraph, controller, append } = fixture("old ");
    append(`old ${"x".repeat(2049)}`);
    expect(highlights()).toHaveLength(0);
    root.innerHTML = `<p>old ${"<em>x</em>".repeat(600)}</p>`;
    const original = root.innerHTML;
    controller.update(`old ${"**x**".repeat(600)}`);
    expect(root.innerHTML).toBe(original);
    expect(highlights()).toHaveLength(0);
    expect(paragraph.textContent?.length).toBe(2053);
  });

  it("releases pending frames, style rules and live ranges on disposal", () => {
    const { controller, append } = fixture("old ");
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    append("old new");
    const ranges = highlights().map(([, highlight]) => highlight);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(1);
    controller.dispose();
    controller.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ranges.every((highlight) => highlight.size === 0)).toBe(true);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  });

  it("recovers on a normal append after exceeding the per-commit style-read budget", () => {
    const { root, controller } = fixture("old ");
    root.innerHTML = `<p>old ${"<em>x</em>".repeat(65)}</p>`;
    const source = `old ${"x".repeat(65)}`;
    const styles = vi.spyOn(window, "getComputedStyle");
    controller.update(source);
    expect(styles).toHaveBeenCalledTimes(64);
    expect(highlights()).toHaveLength(0);
    root.querySelector("p")!.append(document.createTextNode(" normal tail"));
    controller.update(`${source} normal tail`);
    expect(highlightedText()).toBe(" normal tail");
  });

  it("does not apply a stale hue after the next themed commit", () => {
    const { root, append } = fixture("old ");
    append("old fresh");
    root.style.color = "rgb(255, 0, 0)";
    append("old fresh red");
    expect(highlightedText()).toBe(" red");
    const [name, highlight] = highlights()[0];
    const parent = ([...highlight][0] as Range).startContainer.parentElement!;
    expect(getComputedStyle(parent, `::highlight(${name})`).color).toBe("color(srgb 1 0 0 / 0.3)");
  });

  it("starts softly, follows a gentle monotonic curve, and reaches full opacity without a jump", () => {
    const clock = frameClock();
    const { append, paragraph } = fixture("old ");
    append("old new");
    const name = highlights()[0][0];
    expect(opacityOf(name, paragraph)).toBeCloseTo(0.3);
    clock.advance(20);
    expect(opacityOf(name, paragraph)).toBeGreaterThan(0.55);
    clock.advance(50);
    expect(opacityOf(name, paragraph)).toBeCloseTo(0.9125);
    clock.advance(69);
    expect(opacityOf(name, paragraph)).toBeGreaterThan(0.999);
    clock.advance(1);
    expect(highlights()).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  it.each([60, 120])("never evicts a plain-text fade early under sustained %i Hz updates", (hz) => {
    const clock = frameClock();
    const { append } = fixture("old ");
    const births = new Map<Highlight, number>();
    for (let index = 1; index <= hz; index++) {
      const before = highlights();
      clock.advance(1000 / hz);
      append(`old ${"x".repeat(index)}`);
      const after = highlights();
      for (const [name, highlight] of before) {
        if (CSS.highlights.get(name) !== highlight) expect(clock.now() - births.get(highlight)!).toBeGreaterThanOrEqual(140);
      }
      for (const [, highlight] of after) if (!births.has(highlight)) births.set(highlight, clock.now());
      expect(after.length).toBeLessThanOrEqual(8);
      expect(clock.pending()).toBe(1);
    }
  });

  it("reuses a time bucket without restarting older text or losing intervening colors", () => {
    const clock = frameClock();
    const { root, controller } = fixture("old ");
    root.innerHTML = '<p>old <em style="color:red">red</em></p>';
    controller.update("old red");
    const [name, red] = highlights()[0];
    clock.advance(5);
    root.querySelector("p")!.append(document.createTextNode(" plain"));
    controller.update("old red plain");
    clock.advance(5);
    const parent = document.createElement("em");
    parent.style.color = "red";
    parent.textContent = " red again";
    root.querySelector("p")!.append(parent);
    controller.update("old red plain red again");
    expect(highlights()).toHaveLength(2);
    expect(CSS.highlights.get(name)).toBe(red);
    expect([...red].map((range) => (range as Range).toString()).join("")).toBe("red red again");
    expect(opacityOf(name, parent)).toBeGreaterThan(0.3);
    expect(opacityOf(name, parent)).toBeLessThan(0.45);
  });

  it("keeps existing fades intact when unusual color variety exhausts the slot budget", () => {
    const clock = frameClock();
    const { root, controller } = fixture("old ");
    let first: Highlight | undefined;
    for (let index = 0; index < 25; index++) {
      const span = document.createElement("span");
      span.style.color = `rgb(${index}, 20, 30)`;
      span.textContent = "x";
      root.querySelector("p")!.append(span);
      controller.update(`old ${"x".repeat(index + 1)}`);
      first ??= highlights()[0][1];
    }
    expect(highlights()).toHaveLength(24);
    expect(highlights()[0][1]).toBe(first);
    clock.advance(100);
    expect(highlights()[0][1]).toBe(first);
  });

  it("settles after completion and releases listeners/styles even if the page is hidden", () => {
    const clock = frameClock();
    const { append, controller } = fixture("old ");
    append("old last words");
    controller.finish();
    expect(highlights().length).toBeGreaterThan(0);
    clock.advance(139);
    expect(highlights().length).toBeGreaterThan(0);
    clock.advance(1);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
    expect(clock.pending()).toBe(0);
    const second = fixture("next ");
    second.append("next tail");
    second.controller.finish();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  it.each(["ranges", "styles"])("preserves earlier fades on %s overflow without later re-fading skipped text", (budget) => {
    const clock = frameClock();
    const { paragraph, controller, append } = fixture("old ");
    append("old fresh");
    const [name, original] = highlights()[0];
    clock.advance(5);
    for (let index = 0; index < 65; index++) {
      const node = budget === "ranges" ? document.createTextNode("x") : document.createElement("em");
      node.textContent = "x";
      paragraph.append(node);
    }
    const burst = `old fresh${"x".repeat(65)}`;
    controller.update(burst);
    expect(CSS.highlights.get(name)).toBe(original);
    expect(highlightedText()).toBe("fresh");
    expect(opacityOf(name, paragraph)).toBeGreaterThan(0.3);
    // Returning to simple DOM in the same time bucket must not darken the
    // omitted burst retroactively when the earlier group could otherwise grow.
    paragraph.textContent = `${burst} tail`;
    controller.update(`${burst} tail`);
    expect(highlightedText()).toBe("fresh tail");
    expect(paragraph.textContent).toBe(`${burst} tail`);
    expect(highlights().flatMap(([, highlight]) => [...highlight]).length).toBeLessThanOrEqual(64);
  });

  it("keeps the unchanged fading prefix when closing Markdown rewrites only the tail", () => {
    const clock = frameClock();
    const { root, controller } = fixture("old ");
    root.innerHTML = "<p>old fresh **bold</p>";
    controller.update("old fresh **bold");
    const [name, original] = highlights()[0];
    clock.advance(30);
    root.innerHTML = "<p>old fresh <strong>bold</strong> tail</p>";
    controller.update("old fresh **bold** tail");
    expect(CSS.highlights.get(name)).toBe(original);
    expect(highlightedText()).toBe("fresh ");
    expect(opacityOf(name, root.querySelector("p")!)).toBeLessThan(1);
  });
});
