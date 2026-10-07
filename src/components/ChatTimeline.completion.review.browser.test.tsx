import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import type { ChatMessage } from "../types";
import type { ThreadHistoryState } from "../lib/threadHistory";
// Exercise the production cascade, including Lumen's timeline geometry.
import "../styles.css";
import "../styles/lumen/index.css";
import { ChatTimeline } from "./ChatTimeline";

const HISTORY: ChatMessage[] = Array.from({ length: 24 }, (_, index): ChatMessage[] => [
  { id: `review-q${index}`, role: "user", text: `Earlier question ${index}`, timelineOrder: index * 2 + 1, turnId: `review-t${index}`, turnStatus: "completed" },
  { id: `review-a${index}`, role: "assistant", phase: "final", text: `Earlier answer ${index}, with enough detail to occupy a transcript row.`, timelineOrder: index * 2 + 2, turnId: `review-t${index}`, turnStatus: "completed" },
]).flat();
const SHORT = "The final result is ready.\n\nA second short paragraph.";
const LONG = Array.from({ length: 40 }, (_, index) => `Final paragraph ${index} contains enough words to wrap at the normal transcript measure without changing the canonical Markdown source.`).join("\n\n");
const REVEAL_TEXT = "First revealed paragraph.\n\nSecond revealed paragraph.\n\nThird revealed paragraph.";

function messages(text: string, status: ChatMessage["turnStatus"] = "inProgress"): ChatMessage[] {
  return [...HISTORY,
    { id: "review-prompt", role: "user", text: "Explain the final result", timelineOrder: 100, turnId: "review-turn", turnStatus: status },
    { id: "review-answer", role: "assistant", phase: "final", text, streaming: status === "inProgress", timelineOrder: 101, turnId: "review-turn", turnStatus: status },
  ];
}

function Shell({ entries, running, activeTurnId = running ? "review-turn" : undefined, searchQuery, history }: {
  entries: ChatMessage[]; running: boolean; activeTurnId?: string; searchQuery?: string; history?: ThreadHistoryState;
}) {
  return <StrictMode><div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 640 }}>
    <ChatTimeline messages={entries} activities={[]} running={running} activeTurnId={activeTurnId} history={history}
      searchQuery={searchQuery} thinkingLabel="Working" provider="claude" />
  </div></StrictMode>;
}
const live = () => <Shell entries={messages("Drafting the final result")} running />;
const done = (text: string, searchQuery?: string) => <Shell entries={messages(text, "completed")} running={false} searchQuery={searchQuery} />;
const frames = async (count = 3) => {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const scroller = () => document.querySelector<HTMLElement>('[data-testid="timeline-scroller"]')!;
const row = (key: string) => document.querySelector<HTMLElement>(`[data-entry-key="message-${key}"]`)!;
const answer = () => row("review-answer").querySelector<HTMLElement>(".rich-markdown")!;
const masked = () => Boolean(answer().style.getPropertyValue("mask-image") || answer().style.getPropertyValue("-webkit-mask-image"));
const fromEnd = () => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight;

// Check both the scroll offset and an existing visible row. Equal scrollTop
// alone can conceal a virtualization rebase that moves everything on screen.
function readingPosition() {
  const viewport = scroller().getBoundingClientRect();
  const anchor = [...scroller().querySelectorAll<HTMLElement>("[data-entry-key]")].find((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  expect(anchor).toBeDefined();
  return { top: scroller().scrollTop, anchor: anchor!, anchorTop: anchor!.getBoundingClientRect().top - viewport.top };
}
function expectRetained(before: ReturnType<typeof readingPosition>) {
  expect(before.anchor.isConnected).toBe(true);
  expect(Math.abs(scroller().scrollTop - before.top)).toBeLessThanOrEqual(1);
  const relativeTop = before.anchor.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  expect(Math.abs(relativeTop - before.anchorTop)).toBeLessThanOrEqual(1);
}
function queued(text: string): ChatMessage[] {
  return [...messages(text, "completed"),
    { id: "review-queued", role: "user", text: "Automatically queued follow-up", timelineOrder: 200, turnId: "review-next", turnStatus: "inProgress" },
    { id: "review-next-answer", role: "assistant", phase: "final", text: "Working on the queued follow-up", streaming: true, timelineOrder: 201, turnId: "review-next", turnStatus: "inProgress" },
  ];
}

afterEach(async () => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
});

describe("independent completion review: exact reading position and reveal cancellation", () => {
  it.each([["short", SHORT], ["long", LONG]])("retains the exact live-edge reading position for a %s answer", async (_label, text) => {
    const view = render(live());
    await frames();
    expect(fromEnd()).toBeLessThanOrEqual(1);
    const before = readingPosition();
    view.rerender(done(text));
    expectRetained(before);
    expect(answer().textContent).toContain(text === SHORT ? "A second short paragraph" : "Final paragraph 39");
    await frames();
    expectRetained(before);
    await vi.waitFor(() => expect(masked()).toBe(false), { timeout: 2_000, interval: 16 });
    expectRetained(before);
    expect(fromEnd()).toBeGreaterThan(1);
    const latest = screen.getByRole("button", { name: "Scroll to latest message" });
    fireEvent.click(latest);
    await vi.waitFor(() => expect(fromEnd()).toBeLessThanOrEqual(1), { timeout: 3_000 });
  });

  it.each(["later", "same commit"])("does not rearm following for an automatic queued turn arriving %s", async (timing) => {
    const view = render(live());
    await frames();
    const before = readingPosition();
    if (timing === "later") {
      view.rerender(done(LONG));
      await frames();
      expectRetained(before);
    }
    view.rerender(<Shell entries={queued(LONG)} running activeTurnId="review-next" />);
    expectRetained(before);
    await frames();
    expectRetained(before);
    expect(answer().textContent).toContain("Final paragraph 39");
    expect(document.querySelector('[data-entry-key="message-review-next-answer"]')).toBeNull();
    expect(fromEnd()).toBeGreaterThan(600);
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeDefined();
  });

  it("retains a scrolled-up visible anchor, including after later answer reflow", async () => {
    const view = render(live());
    await frames();
    fireEvent.wheel(scroller(), { deltaY: -120 });
    scroller().scrollTop = 300;
    fireEvent.scroll(scroller());
    await frames();
    const before = readingPosition();
    view.rerender(done(LONG));
    await frames();
    expectRetained(before);
    answer().style.paddingBottom = "900px";
    await frames();
    expectRetained(before);
  });

  it("does not classify a same-thread loading snapshot followed by history hydration as a fresh answer", async () => {
    const history = { nextCursor: null, hasMore: false, paginated: true, loading: true };
    const view = render(<Shell entries={messages("Hydrating live snapshot")} running history={history} />);
    await frames();
    expect(fromEnd()).toBeLessThanOrEqual(1);
    const before = readingPosition();
    view.rerender(<Shell entries={messages(REVEAL_TEXT, "completed")} running={false} history={{ ...history, loading: false }} />);
    expect(masked()).toBe(false);
    expectRetained(before);
    await frames();
    expect(masked()).toBe(false);
    expectRetained(before);
    view.unmount();
    render(done(REVEAL_TEXT));
    await frames();
    expect(masked()).toBe(false);
  });

  it.each(["failed", "interrupted"] as const)("does not animate an answer exposed by a %s turn", async (status) => {
    const view = render(live());
    await frames();
    view.rerender(<Shell entries={messages(REVEAL_TEXT, status)} running={false} />);
    expect(masked()).toBe(false);
    await frames();
    expect(masked()).toBe(false);
  });

  it.each(["search", "copy", "authoritative correction"])("finishes an active reveal on %s and never replays it", async (action) => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(live());
    await frames();
    view.rerender(done(REVEAL_TEXT));
    await frames(2);
    expect(masked()).toBe(true);
    let finalText = REVEAL_TEXT;
    if (action === "search") {
      view.rerender(done(REVEAL_TEXT, "Third revealed paragraph"));
    } else if (action === "copy") {
      fireEvent.click(row("review-answer").querySelector<HTMLButtonElement>('[title="Copy message"]')!);
      await vi.waitFor(() => expect(write).toHaveBeenCalledWith(REVEAL_TEXT));
    } else {
      // Same shape/length: a ResizeObserver height change cannot be relied on.
      finalText = REVEAL_TEXT.replace("First", "Fixed");
      view.rerender(done(finalText));
      expect(answer().textContent).toContain("Fixed revealed paragraph");
    }
    expect(masked()).toBe(false);
    view.rerender(done(finalText));
    await frames();
    expect(masked()).toBe(false);
  });
});
