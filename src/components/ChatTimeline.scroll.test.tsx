import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import {
  ChatTimeline,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
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

function configureScroller() {
  const scroller = screen.getByTestId("timeline-scroller");
  let scrollTop = 2400;
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollTop = options.top;
  });
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    },
    scrollTo: { configurable: true, value: scrollTo },
  });
  return {
    scroller,
    scrollTo,
    setScrollTop: (value: number) => { scrollTop = value; },
  };
}

describe("ChatTimeline flow scroll state", () => {
  it("uses a strict pixel band to re-arm streaming follow", () => {
    expect(TIMELINE_FOLLOW_REARM_THRESHOLD_PX).toBe(40);
  });

  it("only treats an upward wheel over scrollable content as leaving live follow", () => {
    expect(shouldCancelTimelineFollowForWheel(-1, true)).toBe(true);
    expect(shouldCancelTimelineFollowForWheel(1, true)).toBe(false);
    expect(shouldCancelTimelineFollowForWheel(-1, false)).toBe(false);
  });

  it("offers older history only when the active page has more turns", () => {
    const onLoadEarlier = vi.fn();
    render(
      <ChatTimeline
        messages={transcript(2)}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        history={{ nextCursor: "older", hasMore: true, loading: false, paginated: true }}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    fireEvent.click(screen.getByTestId("load-earlier"));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("gives an upward wheel gesture authority over streaming follow", () => {
    renderTimeline();
    const { scroller } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("does not break follow for a downward wheel at the live edge", () => {
    renderTimeline();
    const { scroller } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: 120 });
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });

  it("supports Page Up and a deliberate jump back to latest", () => {
    renderTimeline();
    const { scroller, scrollTo } = configureScroller();
    fireEvent.keyDown(scroller, { key: "PageUp" });
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });

  it("supports Shift+Space as manual upward navigation", () => {
    renderTimeline();
    const { scroller } = configureScroller();
    fireEvent.keyDown(scroller, { key: " ", code: "Space", shiftKey: true });
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("recognizes pointer-driven scrolling as manual navigation", () => {
    renderTimeline();
    const { scroller, setScrollTop } = configureScroller();
    fireEvent.pointerDown(screen.getByText("Answer 59"), { button: 0 });
    setScrollTop(1800);
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
  });

  it("does not yank a reader back down when streamed content changes", () => {
    const messages = transcript(60, true);
    const { rerender } = renderTimeline(messages);
    const { scroller, scrollTo, setScrollTop } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: -120 });
    setScrollTop(1200);
    scrollTo.mockClear();

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

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1200);
  });

  it("re-arms follow when a free-scrolling reader reaches the bottom band", () => {
    renderTimeline();
    const { scroller, setScrollTop } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
    setScrollTop(2365);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).not.toBeInTheDocument();
  });
});
