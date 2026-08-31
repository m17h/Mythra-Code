import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import {
  ChatTimeline,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
  TIMELINE_MOUNT_ROWS,
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

  it("mounts only the latest bounded suffix and reveals older rows locally", () => {
    renderTimeline(transcript(100));
    const mounted = document.querySelectorAll<HTMLElement>("[data-entry-index]");
    expect(mounted).toHaveLength(TIMELINE_MOUNT_ROWS);
    expect(mounted[0]).toHaveAttribute("data-entry-index", "61");
    expect(screen.queryByText("Answer 0")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("reveal-earlier"));
    const expanded = document.querySelectorAll<HTMLElement>("[data-entry-index]");
    expect(expanded).toHaveLength(80);
    expect(expanded[0]).toHaveAttribute("data-entry-index", "21");
  });

  it("keeps the live suffix mounted while searching an older hidden row", () => {
    render(
      <ChatTimeline
        messages={transcript(100)}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        approval={{ id: 1, method: "execCommandApproval", params: { command: "npm test" }, threadId: "thread", receivedAt: 1 }}
        searchQuery="Answer 0"
        searchActiveMatch={0}
      />,
    );
    expect(screen.getByText("Answer 0")).toBeInTheDocument();
    expect(screen.getByText("Answer 99")).toBeInTheDocument();
    expect(document.querySelector('[data-entry-index="0"] .search-hit')).not.toBeNull();
    expect(document.querySelector(".timeline-entry-approval")).not.toBeNull();
    expect(screen.getByText(/entries between this result and the latest conversation/)).toBeInTheDocument();
  });

  it("does not expose server pagination until all loaded rows are revealed", () => {
    const onLoadEarlier = vi.fn();
    render(
      <ChatTimeline
        messages={transcript(60)}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        history={{ nextCursor: "older", hasMore: true, loading: false, paginated: true }}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    expect(screen.queryByTestId("load-earlier")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reveal-earlier"));
    fireEvent.click(screen.getByTestId("load-earlier"));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it("keeps a server-prepended page visible even when it crosses the mount limit", () => {
    const onLoadEarlier = vi.fn();
    const current = transcript(2);
    const view = render(
      <ChatTimeline
        messages={current}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        history={{ nextCursor: "older", hasMore: true, loading: false, paginated: true }}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    fireEvent.click(screen.getByTestId("load-earlier"));
    view.rerender(
      <ChatTimeline
        messages={current}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        history={{ nextCursor: "older", hasMore: true, loading: true, paginated: true }}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    const older = Array.from({ length: 50 }, (_, index): ChatMessage => ({
      id: `older-${index}`,
      role: "assistant",
      text: `Older answer ${index}`,
      timelineOrder: index - 50,
    }));
    view.rerender(
      <ChatTimeline
        messages={[...older, ...current]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
        history={{ nextCursor: null, hasMore: false, loading: false, paginated: true }}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    expect(document.querySelectorAll("[data-entry-index]")).toHaveLength(52);
    expect(screen.getByText("Older answer 0")).toBeInTheDocument();
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

  it("supports Page Up and a deliberate jump back to latest", async () => {
    renderTimeline();
    const { scroller, scrollTo } = configureScroller();
    fireEvent.keyDown(scroller, { key: "PageUp" });
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: "smooth" }));
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

  it("keeps the oldest mounted row stable when a manual reader receives a new entry", () => {
    const messages = transcript(100, true);
    const { rerender } = renderTimeline(messages);
    const { scroller } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(document.querySelector<HTMLElement>("[data-entry-index]")).toHaveAttribute("data-entry-index", "60");

    rerender(
      <ChatTimeline
        messages={[...messages, {
          id: "message-100",
          role: "assistant",
          text: "A newly appended entry",
          timelineOrder: 101,
          streaming: true,
        }]}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );

    expect(document.querySelector<HTMLElement>("[data-entry-index]")).toHaveAttribute("data-entry-index", "60");
    expect(screen.getByText("A newly appended entry")).toBeInTheDocument();
  });

  it("restores the bounded suffix after a manual reader reaches the live edge", () => {
    const messages = transcript(100, true);
    const { rerender } = renderTimeline(messages);
    const { scroller, setScrollTop } = configureScroller();
    fireEvent.wheel(scroller, { deltaY: -120 });
    setScrollTop(2365);
    fireEvent.scroll(scroller);

    rerender(
      <ChatTimeline
        messages={[...messages, {
          id: "message-100",
          role: "assistant",
          text: "Latest bounded entry",
          timelineOrder: 101,
          streaming: true,
        }]}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );

    expect(document.querySelectorAll("[data-entry-index]")).toHaveLength(TIMELINE_MOUNT_ROWS);
    expect(document.querySelector<HTMLElement>("[data-entry-index]")).toHaveAttribute("data-entry-index", "61");
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
