import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

const { legendListProps, legendListState, scrollToEnd, scrollToIndex } = vi.hoisted(() => ({
  legendListProps: { current: null as Record<string, unknown> | null },
  legendListState: {
    current: { isAtEnd: true, contentLength: 3000, scroll: 2400, scrollLength: 600 },
  },
  scrollToEnd: vi.fn(() => Promise.resolve()),
  scrollToIndex: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: React.forwardRef(function MockLegendList(
      props: {
        data?: unknown[];
        renderItem?: (args: { item: unknown; index: number }) => React.ReactNode;
        keyExtractor?: (item: unknown, index: number) => string;
        onScroll?: () => void;
        ListHeaderComponent?: React.ReactNode;
        ListFooterComponent?: React.ReactNode;
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      const scrollerRef = React.useRef<HTMLDivElement>(null);
      React.useImperativeHandle(ref, () => ({
        getScrollableNode: () => scrollerRef.current,
        getState: () => legendListState.current,
        scrollToEnd,
        scrollToIndex,
      }));
      legendListProps.current = props;
      return (
        <div ref={scrollerRef} data-testid="timeline-scroller" onScroll={props.onScroll}>
          {props.ListHeaderComponent}
          {props.data?.map((entry, index) => (
            <div key={props.keyExtractor?.(entry, index) ?? index}>
              {props.renderItem?.({ item: entry, index })}
            </div>
          ))}
          {props.ListFooterComponent}
        </div>
      );
    }),
  };
});

import {
  ChatTimeline,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
  resolveTimelineIsAtEnd,
  shouldCancelTimelineFollowForWheel,
} from "./ChatTimeline";

function transcript(count: number, streaming = false): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    text: `Answer ${index}`,
    timelineOrder: index + 1,
    streaming: streaming && index === count - 1,
  }));
}

function renderTimeline(messages = transcript(60, true)) {
  return render(
    <ChatTimeline
      messages={messages}
      activities={[]}
      running
      thinkingLabel="Thinking"
    />,
  );
}

async function attachGestureListeners() {
  await vi.runAllTimersAsync();
  const scroller = screen.getByTestId("timeline-scroller");
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3000 },
  });
  return scroller;
}

describe("ChatTimeline streaming scroll state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    legendListProps.current = null;
    legendListState.current = {
      isAtEnd: true,
      contentLength: 3000,
      scroll: 2400,
      scrollLength: 600,
    };
    scrollToEnd.mockClear();
    scrollToIndex.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a strict pixel band to re-arm streaming follow", () => {
    expect(TIMELINE_FOLLOW_REARM_THRESHOLD_PX).toBe(40);
    expect(resolveTimelineIsAtEnd({
      isAtEnd: false,
      contentLength: 2000,
      scroll: 1160,
      scrollLength: 800,
    })).toBe(true);
    expect(resolveTimelineIsAtEnd({
      isAtEnd: false,
      contentLength: 2000,
      scroll: 900,
      scrollLength: 800,
    })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
  });

  it("only treats an upward wheel over scrollable content as leaving live follow", () => {
    expect(shouldCancelTimelineFollowForWheel(-1, true)).toBe(true);
    expect(shouldCancelTimelineFollowForWheel(1, true)).toBe(false);
    expect(shouldCancelTimelineFollowForWheel(-1, false)).toBe(false);
  });

  it("gives an upward wheel gesture authority over streaming follow", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();

    fireEvent.wheel(scroller, { deltaY: -120 });

    expect(legendListProps.current?.maintainScrollAtEnd).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("does not break follow for a downward wheel at the live edge", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();

    fireEvent.wheel(scroller, { deltaY: 120 });

    expect(legendListProps.current?.maintainScrollAtEnd).toEqual(expect.objectContaining({ animated: false }));
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });

  it("does not mistake a transient streaming layout gap for user navigation", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();
    legendListState.current = {
      isAtEnd: false,
      contentLength: 3050,
      scroll: 2400,
      scrollLength: 600,
    };

    fireEvent.scroll(scroller);

    expect(legendListProps.current?.maintainScrollAtEnd).toEqual(expect.objectContaining({ animated: false }));
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });

  it("re-arms follow only after a free-scrolling reader reaches the bottom band", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();
    fireEvent.wheel(scroller, { deltaY: -120 });

    legendListState.current = {
      isAtEnd: false,
      contentLength: 3000,
      scroll: 2365,
      scrollLength: 600,
    };
    fireEvent.scroll(scroller);

    expect(legendListProps.current?.maintainScrollAtEnd).toEqual(expect.objectContaining({ animated: false }));
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });

  it("supports Page Up as manual navigation and a deliberate jump back to latest", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();
    fireEvent.keyDown(scroller, { key: "PageUp" });

    expect(legendListProps.current?.maintainScrollAtEnd).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));
    await vi.runAllTimersAsync();

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    expect(legendListProps.current?.maintainScrollAtEnd).toEqual(expect.objectContaining({ animated: false }));
  });

  it("supports Shift+Space as manual upward navigation", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();

    fireEvent.keyDown(scroller, { key: " ", code: "Space", shiftKey: true });

    expect(legendListProps.current?.maintainScrollAtEnd).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("waits for pointer-driven scrolling before leaving live follow", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();

    fireEvent.pointerDown(scroller, { button: 0 });
    expect(legendListProps.current?.maintainScrollAtEnd).toEqual(expect.objectContaining({ animated: false }));
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();

    legendListState.current = {
      isAtEnd: false,
      contentLength: 3000,
      scroll: 2100,
      scrollLength: 600,
    };
    fireEvent.scroll(scroller);

    expect(legendListProps.current?.maintainScrollAtEnd).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("recognizes selection auto-scroll that starts on timeline content", async () => {
    renderTimeline();
    const scroller = await attachGestureListeners();

    fireEvent.pointerDown(screen.getByText("Answer 59"), { button: 0 });
    legendListState.current = {
      isAtEnd: false,
      contentLength: 3000,
      scroll: 2100,
      scrollLength: 600,
    };
    fireEvent.scroll(scroller);

    expect(legendListProps.current?.maintainScrollAtEnd).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("never writes raw scrollTop while streamed rows change", async () => {
    const messages = transcript(60, true);
    const { rerender } = renderTimeline(messages);
    const scroller = await attachGestureListeners();
    let scrollTop = 1200;
    const writes: number[] = [];
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        writes.push(value);
        scrollTop = value;
      },
    });
    fireEvent.wheel(scroller, { deltaY: -120 });

    rerender(
      <ChatTimeline
        messages={messages.map((message, index) => index === messages.length - 1
          ? { ...message, text: `${message.text} more streamed output` }
          : message)}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );
    fireEvent.scroll(scroller);

    expect(writes).toEqual([]);
    expect(scrollTop).toBe(1200);
  });
});
