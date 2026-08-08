import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, attachTimelineScrollAnchor, readTimelineAnchor, timelineAnchorDrift } from "./ChatTimeline";
import type { Activity, ChatMessage } from "../types";
import { installResizeObservers, installVirtualLayout } from "../test/virtualLayout";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const VIEWPORT = 600;
const HEADER = 24;
const FOOTER = 72;

/** Extra height a row picked up after it was first measured, keyed by row index. */
const grown = new Map<number, number>();

/**
 * Row heights that swing by an order of magnitude between neighbours, the way
 * a real transcript does: a one-line activity row against a screen-tall
 * Markdown answer. Uniform rows cannot reproduce this bug at all — the
 * virtualizer's guess for an unmeasured row is only ever wrong when its
 * neighbours disagree about how tall a row is.
 */
const heightFor = (index: number) => (grown.get(index) ?? 0) + 60 + (index % 11) * 40;

/** Completed turns, so the timeline compacts each one into request / work / answer. */
function completedTurns(turns: number): { messages: ChatMessage[]; activities: Activity[] } {
  const messages: ChatMessage[] = [];
  const activities: Activity[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const stamp = { turnId: `turn-${turn}`, turnStatus: "completed" as const };
    const base = turn * 5;
    messages.push({ id: `u-${turn}`, role: "user", text: `Ask ${turn}`, timelineOrder: base + 1, ...stamp });
    activities.push({ id: `c-${turn}`, kind: "command", title: `npm test ${turn}`, detail: "ok", timelineOrder: base + 2, ...stamp });
    messages.push({ id: `p-${turn}`, role: "assistant", text: `Working ${turn}`, timelineOrder: base + 3, ...stamp });
    activities.push({ id: `f-${turn}`, kind: "file", title: `src/file-${turn}.ts`, timelineOrder: base + 4, ...stamp });
    messages.push({ id: `a-${turn}`, role: "assistant", text: `Answer ${turn}`, timelineOrder: base + 5, ...stamp });
  }
  return { activities, messages };
}

function transcript(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: "assistant" as const,
    text: `Answer ${index}`,
    timelineOrder: index + 1,
  }));
}

function harness() {
  const resize = installResizeObservers();
  const layout = installVirtualLayout({ viewportHeight: VIEWPORT, itemHeight: heightFor, headerHeight: HEADER, footerHeight: FOOTER });
  return {
    layout,
    /**
     * One browser frame in the order the browser runs it: queued scroll
     * events, then animation-frame work (the virtualizer measures and React
     * commits), then layout, then resize observers — which is the last point
     * anything can move before the frame is painted.
     */
    async frame(count = 1) {
      for (let index = 0; index < count; index += 1) {
        await act(async () => {
          layout.frame();
          await vi.advanceTimersByTimeAsync(20);
          resize.flush();
        });
      }
    },
    teardown() {
      layout.uninstall();
      resize.uninstall();
    },
  };
}

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-virtuoso-scroller]");
  if (!element) throw new Error("no scroller");
  return element;
}

function renderedIndices(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-item-index]")).map((row) => Number(row.dataset.itemIndex));
}

/** Where a row sits on screen, or null when it is not currently rendered. */
function rowTop(index: number): number | null {
  const row = document.querySelector<HTMLElement>(`[data-item-index="${index}"]`);
  if (!row) return null;
  return row.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
}

function topVisibleRow(): number | undefined {
  return renderedIndices().find((index) => {
    const top = rowTop(index);
    return top !== null && top + heightFor(index) > 0;
  });
}

describe("ChatTimeline scroll stability", () => {
  afterEach(() => {
    vi.useRealTimers();
    grown.clear();
  });

  it("holds the transcript still while the user scrolls up through rows it has never measured", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      render(<ChatTimeline messages={transcript(300)} activities={[]} running={false} thinkingLabel="Thinking" />);
      await kit.frame(20);

      let worstDrift = 0;
      let driftFrames = 0;
      for (let step = 0; step < 200; step += 1) {
        const probe = topVisibleRow();
        const before = probe === undefined ? null : rowTop(probe);
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
        scroller().scrollTop -= 50;
        await kit.frame();
        const after = probe === undefined ? null : rowTop(probe);
        if (before === null || after === null) continue;
        // Scrolling up by 50px moves the row 50px down the screen. Anything
        // else is the transcript lurching under the reader.
        const drift = Math.abs(after - (before + 50));
        if (drift >= 1) driftFrames += 1;
        worstDrift = Math.max(worstDrift, drift);
      }

      expect(driftFrames).toBe(0);
      expect(worstDrift).toBeLessThan(1);
    } finally {
      kit.teardown();
    }
  });

  it("holds still through a transcript of compacted turns", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const { activities, messages } = completedTurns(100);
      render(<ChatTimeline messages={messages} activities={activities} running={false} thinkingLabel="Thinking" />);
      await kit.frame(20);

      let worstDrift = 0;
      for (let step = 0; step < 150; step += 1) {
        const probe = topVisibleRow();
        const before = probe === undefined ? null : rowTop(probe);
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
        scroller().scrollTop -= 50;
        await kit.frame();
        const after = probe === undefined ? null : rowTop(probe);
        if (before === null || after === null) continue;
        worstDrift = Math.max(worstDrift, Math.abs(after - (before + 50)));
      }

      expect(worstDrift).toBeLessThan(1);
    } finally {
      kit.teardown();
    }
  });

  it("opens a long transcript at its newest entry", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      render(<ChatTimeline messages={transcript(300)} activities={[]} running={false} thinkingLabel="Thinking" />);
      await kit.frame(20);

      expect(renderedIndices()).toContain(299);
      const element = scroller();
      expect(element.scrollTop).toBe(element.scrollHeight - VIEWPORT);
    } finally {
      kit.teardown();
    }
  });

  it("moves to the newest entry when an asynchronously resumed transcript arrives", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const { rerender } = render(<ChatTimeline messages={[]} activities={[]} running={false} thinkingLabel="Thinking" />);
      await kit.frame(2);
      await act(async () => {
        rerender(<ChatTimeline messages={transcript(300)} activities={[]} running={false} thinkingLabel="Thinking" />);
      });
      await kit.frame(20);

      expect(renderedIndices()).toContain(299);
      const element = scroller();
      expect(element.scrollTop).toBe(element.scrollHeight - VIEWPORT);
    } finally {
      kit.teardown();
    }
  });

  it("stays stable when the reader scrolls as soon as a resumed transcript appears", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const { rerender } = render(<ChatTimeline messages={[]} activities={[]} running={false} thinkingLabel="Thinking" />);
      await kit.frame(2);
      await act(async () => {
        rerender(<ChatTimeline messages={transcript(300)} activities={[]} running={false} thinkingLabel="Thinking" />);
      });
      // Let Virtuoso render the bottom window, but deliberately begin reading
      // before the initial 300ms measurement-settle window has elapsed.
      await kit.frame(2);

      let worstDrift = 0;
      for (let step = 0; step < 80; step += 1) {
        const probe = topVisibleRow();
        const before = probe === undefined ? null : rowTop(probe);
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
        scroller().scrollTop -= 50;
        await kit.frame();
        const after = probe === undefined ? null : rowTop(probe);
        if (before === null || after === null) continue;
        worstDrift = Math.max(worstDrift, Math.abs(after - (before + 50)));
      }

      expect(worstDrift).toBeLessThan(1);
    } finally {
      kit.teardown();
    }
  });

  it("keeps following a streaming answer while the reader is at the bottom", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const { rerender } = render(<ChatTimeline messages={transcript(120)} activities={[]} running thinkingLabel="Thinking" />);
      await kit.frame(20);

      for (let appended = 1; appended <= 5; appended += 1) {
        await act(async () => {
          rerender(<ChatTimeline messages={transcript(120 + appended)} activities={[]} running thinkingLabel="Thinking" />);
        });
        await kit.frame(4);
      }

      expect(renderedIndices()).toContain(124);
      const element = scroller();
      expect(element.scrollTop).toBe(element.scrollHeight - VIEWPORT);
    } finally {
      kit.teardown();
    }
  });

  it("leaves a reader who scrolled up where they are when new output arrives", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const { rerender } = render(<ChatTimeline messages={transcript(120)} activities={[]} running thinkingLabel="Thinking" />);
      await kit.frame(20);

      for (let step = 0; step < 40; step += 1) {
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
        scroller().scrollTop -= 50;
        await kit.frame();
      }
      const probe = topVisibleRow()!;
      const before = rowTop(probe)!;
      const offsetBefore = scroller().scrollTop;

      for (let appended = 1; appended <= 5; appended += 1) {
        await act(async () => {
          rerender(<ChatTimeline messages={transcript(120 + appended)} activities={[]} running thinkingLabel="Thinking" />);
        });
        await kit.frame(4);
      }

      expect(rowTop(probe)).toBe(before);
      expect(scroller().scrollTop).toBe(offsetBefore);
    } finally {
      kit.teardown();
    }
  });

  it("does not move the reader when a row above them grows after it was measured", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      render(<ChatTimeline messages={transcript(300)} activities={[]} running={false} thinkingLabel="Thinking" />);
      await kit.frame(20);
      for (let step = 0; step < 40; step += 1) {
        scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
        scroller().scrollTop -= 50;
        await kit.frame();
      }

      const rendered = renderedIndices();
      const probe = topVisibleRow()!;
      const above = rendered.find((index) => index < probe);
      expect(above).toBeDefined();
      const before = rowTop(probe)!;

      // A late Markdown reflow, web font, or image finishing: a row that was
      // already measured is suddenly 200px taller.
      grown.set(above!, 200);
      await kit.frame(3);

      expect(rowTop(probe)).toBe(before);
    } finally {
      kit.teardown();
    }
  });

  it("brings a search match on screen and leaves it there", async () => {
    vi.useFakeTimers();
    const kit = harness();
    try {
      const messages = transcript(300);
      messages[40] = { ...messages[40], text: "the needle we are looking for" };
      const { rerender } = render(
        <ChatTimeline messages={messages} activities={[]} running={false} thinkingLabel="Thinking" />,
      );
      await kit.frame(20);

      await act(async () => {
        rerender(
          <ChatTimeline messages={messages} activities={[]} running={false} thinkingLabel="Thinking" searchQuery="needle" searchActiveMatch={0} />,
        );
      });
      await kit.frame(10);

      expect(renderedIndices()).toContain(40);
      const top = rowTop(40)!;
      expect(top).toBeGreaterThan(-heightFor(40));
      expect(top).toBeLessThan(VIEWPORT);

      // The anchor must not drag the match back off screen on later layout passes.
      await kit.frame(10);
      expect(rowTop(40)).toBe(top);
    } finally {
      kit.teardown();
    }
  });
});

describe("timeline scroll anchor", () => {
  function anchorFixture() {
    document.body.innerHTML = `
      <div data-virtuoso-scroller="true" id="scroller">
        <div data-testid="virtuoso-item-list">
          <div data-item-index="7" id="row7"></div>
        </div>
      </div>`;
    const element = document.getElementById("scroller") as HTMLElement;
    const row = document.getElementById("row7") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    element.getBoundingClientRect = () => ({ bottom: 600, height: 600, top: 0 }) as DOMRect;
    let rowTopValue = 100;
    let contentHeight = 4000;
    row.getBoundingClientRect = () => ({ bottom: rowTopValue + 40, height: 40, top: rowTopValue }) as DOMRect;
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => contentHeight });
    return {
      element,
      // A row growing moves everything below it and makes the content taller,
      // exactly as a late Markdown reflow or image does.
      growRowAbove: (by: number) => { rowTopValue += by; contentHeight += by; },
      moveRow: (top: number) => { rowTopValue = top; },
      row,
    };
  }

  it("anchors on the topmost row that is still on screen", () => {
    const { element } = anchorFixture();
    expect(readTimelineAnchor(element)).toEqual({ contentHeight: 4000, index: "7", top: 100 });
  });

  it("reports no drift when nothing moved, and the offset when it did", () => {
    const { element, moveRow } = anchorFixture();
    const anchor = readTimelineAnchor(element)!;
    expect(timelineAnchorDrift(element, anchor)).toBe(0);
    moveRow(340);
    expect(timelineAnchorDrift(element, anchor)).toBe(240);
  });

  it("reports no drift once the anchored row has been unmounted", () => {
    const { element, row } = anchorFixture();
    const anchor = readTimelineAnchor(element)!;
    row.remove();
    expect(timelineAnchorDrift(element, anchor)).toBe(0);
  });

  it("puts a row that moved without a scroll back where it was", () => {
    const resize = installResizeObservers();
    try {
      const { element, moveRow } = anchorFixture();
      const detach = attachTimelineScrollAnchor(element, () => true);
      element.dispatchEvent(new Event("scroll"));
      moveRow(340);
      resize.flush();
      expect(element.scrollTop).toBe(240);
      detach();
    } finally {
      resize.uninstall();
    }
  });

  it("accepts a scroll as the new resting position instead of correcting it away", () => {
    const resize = installResizeObservers();
    try {
      const { element, moveRow } = anchorFixture();
      const detach = attachTimelineScrollAnchor(element, () => true);
      element.dispatchEvent(new Event("scroll"));
      // The reader scrolls up: the row legitimately moves down the screen.
      element.scrollTop = -50;
      moveRow(150);
      element.dispatchEvent(new Event("scroll"));
      resize.flush();
      expect(element.scrollTop).toBe(-50);
      detach();
    } finally {
      resize.uninstall();
    }
  });

  it("does not adopt a shift as intended when a scroll lands in the same frame as it", () => {
    const resize = installResizeObservers();
    try {
      const { element, growRowAbove } = anchorFixture();
      const detach = attachTimelineScrollAnchor(element, () => true);
      element.dispatchEvent(new Event("scroll"));
      growRowAbove(240);
      // A scroll delivered after the resize but before the observer runs must
      // not quietly re-anchor on the moved position.
      element.dispatchEvent(new Event("scroll"));
      expect(element.scrollTop).toBe(240);
      resize.flush();
      expect(element.scrollTop).toBe(240);
      detach();
    } finally {
      resize.uninstall();
    }
  });

  it("stays out of the way while the transcript is pinned to its newest entry", () => {
    const resize = installResizeObservers();
    try {
      const { element, moveRow } = anchorFixture();
      const detach = attachTimelineScrollAnchor(element, () => false);
      element.dispatchEvent(new Event("scroll"));
      moveRow(340);
      resize.flush();
      expect(element.scrollTop).toBe(0);
      detach();
    } finally {
      resize.uninstall();
    }
  });

  it("stops correcting once detached", () => {
    const resize = installResizeObservers();
    try {
      const { element, moveRow } = anchorFixture();
      const detach = attachTimelineScrollAnchor(element, () => true);
      element.dispatchEvent(new Event("scroll"));
      detach();
      moveRow(340);
      resize.flush();
      expect(element.scrollTop).toBe(0);
    } finally {
      resize.uninstall();
    }
  });
});
