import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import type { ChatMessage } from "../types";
import { useTaskStore } from "../lib/taskStore";
import { EMPTY_THREAD_HISTORY } from "../lib/threadHistory";
// Match startApplication: global CSS, then Lumen, then the lazy timeline chunk.
import "../styles.css";
import "../styles/lumen/index.css";
import { ChatTimeline } from "./ChatTimeline";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

// 24 settled turns put the live run past the bounded mount window, so the
// completion commit also exercises the oldest-row unmount it must defer.
const HISTORY: ChatMessage[] = Array.from({ length: 24 }, (_, index): ChatMessage[] => [
  { id: `q${index}`, role: "user", text: `Question ${index}`, timelineOrder: index * 2 + 1, turnId: `t${index}`, turnStatus: "completed" },
  { id: `a${index}`, role: "assistant", phase: "final", text: `Answer ${index} with a little detail.`, timelineOrder: index * 2 + 2, turnId: `t${index}`, turnStatus: "completed" },
]).flat();
const LONG = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} of the final answer carries enough words to wrap across the transcript measure.`).join("\n\n");
const SHORT = "Short answer.\n\nA second line.";
const CODE = "Here is the change:\n\n```ts\nconst answer = 42;\nexport default answer;\n```\n\nThat is all.";

type Status = "inProgress" | "completed" | "failed" | "interrupted";
function turn(answer: string, status: Status): ChatMessage[] {
  return [...HISTORY,
    { id: "prompt", role: "user", text: "Explain the result", timelineOrder: 100, turnId: "turn", turnStatus: status },
    { id: "answer", role: "assistant", phase: "final", text: answer, streaming: status === "inProgress", timelineOrder: 101, turnId: "turn", turnStatus: status },
  ];
}
const NEXT: ChatMessage[] = [
  { id: "next", role: "user", text: "And a queued follow-up", timelineOrder: 200, turnId: "turn2", turnStatus: "inProgress" },
  { id: "next-answer", role: "assistant", phase: "final", text: "Working on it", streaming: true, timelineOrder: 201, turnId: "turn2", turnStatus: "inProgress" },
];

function Shell({ messages, running, activeTurnId = running ? "turn" : undefined, searchQuery }: {
  messages: ChatMessage[]; running: boolean; activeTurnId?: string; searchQuery?: string;
}) {
  return <StrictMode><div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 640 }}>
    <ChatTimeline messages={messages} activities={[]} running={running} activeTurnId={activeTurnId} searchQuery={searchQuery} thinkingLabel="Working" provider="claude" />
  </div></StrictMode>;
}
const live = (answer = "Drafting the answer") => <Shell messages={turn(answer, "inProgress")} running />;
const done = (answer: string, props: { searchQuery?: string; status?: Status } = {}) =>
  <Shell messages={turn(answer, props.status ?? "completed")} running={false} searchQuery={props.searchQuery} />;
const queued = (answer: string, next = NEXT) => <Shell messages={[...turn(answer, "completed"), ...next]} running activeTurnId="turn2" />;

const frames = async (count = 2) => {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const scroller = () => document.querySelector<HTMLElement>('[data-testid="timeline-scroller"]')!;
const row = (key: string) => document.querySelector<HTMLElement>(`[data-entry-key="${key}"]`);
const answerText = () => row("message-answer")!.querySelector<HTMLElement>(".rich-markdown")!;
const masked = (element: HTMLElement) => Boolean(element.style.getPropertyValue("mask-image") || element.style.getPropertyValue("-webkit-mask-image"));
const maskedCount = () => [...document.querySelectorAll<HTMLElement>(".flow-timeline .rich-markdown")].filter(masked).length;
const fromEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight;
const viewTop = (element: HTMLElement) => element.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
const latestButton = () => screen.queryByRole("button", { name: "Scroll to latest message" });

/** The reader's position: scroll offset plus a row they can currently see. */
function position() {
  const timeline = scroller();
  const anchor = [...timeline.querySelectorAll<HTMLElement>("[data-entry-key]")].find((element) => viewTop(element) >= 0)!;
  return { scrollTop: timeline.scrollTop, anchor, top: viewTop(anchor), prompt: viewTop(row("message-prompt")!) };
}
function expectUnmoved(before: ReturnType<typeof position>) {
  expect(Math.abs(scroller().scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
  expect(before.anchor.isConnected).toBe(true);
  expect(Math.abs(viewTop(before.anchor) - before.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewTop(row("message-prompt")!) - before.prompt)).toBeLessThanOrEqual(1);
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
});

describe("main chat completion keeps the reader where they were", () => {
  it.each([["long", LONG], ["short", SHORT]])("at the live edge, a %s answer moves nothing the reader sees", async (_, answer) => {
    const view = render(live());
    await frames();
    const timeline = scroller();
    expect(fromEnd(timeline)).toBeLessThanOrEqual(1);
    // Main chat shows only the working status until the answer is final.
    expect(row("message-answer")).toBeNull();
    expect(document.querySelector(".activity-status.live .pixel-working-mark.live")).not.toBeNull();
    const before = position();

    view.rerender(done(answer));
    expectUnmoved(before);
    expect(masked(answerText())).toBe(true);
    expect(maskedCount()).toBe(1);
    await frames(3);
    expectUnmoved(before);
    expect(latestButton()).not.toBeNull();

    // Late reflow below the reader (image, font) neither follows nor jumps.
    answerText().style.paddingBottom = "900px";
    await frames(3);
    expectUnmoved(before);

    // The explicit control still navigates to the very end.
    fireEvent.click(latestButton()!);
    await vi.waitFor(() => expect(fromEnd(timeline)).toBeLessThanOrEqual(1), { timeout: 3_000 });
    expect(latestButton()).toBeNull();
  });

  it("leaves a scrolled-up reader exactly where they were", async () => {
    const view = render(live());
    await frames();
    const timeline = scroller();
    fireEvent.wheel(timeline, { deltaY: -120 });
    timeline.scrollTop = 300;
    fireEvent.scroll(timeline);
    await frames();
    const before = position();
    view.rerender(done(LONG));
    await frames();
    expectUnmoved(before);
    expect(latestButton()).not.toBeNull();
  });

  it("does not follow a queued next turn, whether batched with completion or right after it", async () => {
    let view = render(live());
    await frames();
    let before = position();
    view.rerender(queued(LONG));
    expectUnmoved(before);
    // Only the newly completed answer reveals; nothing else replays.
    expect(masked(answerText())).toBe(true);
    expect(maskedCount()).toBe(1);
    expect(row("message-next")).not.toBeNull();
    view.rerender(queued(LONG, [NEXT[0], { ...NEXT[1], text: `${NEXT[1].text}\n\n${LONG}` }]));
    await frames(3);
    expectUnmoved(before);
    view.unmount();

    view = render(live());
    await frames();
    before = position();
    view.rerender(done(SHORT));
    view.rerender(queued(SHORT));
    await frames(3);
    expectUnmoved(before);

    // An intentional downward gesture to the end resumes following.
    const timeline = scroller();
    fireEvent.wheel(timeline, { deltaY: 120 });
    timeline.scrollTop = timeline.scrollHeight;
    fireEvent.scroll(timeline);
    view.rerender(queued(SHORT, [NEXT[0], { ...NEXT[1], text: LONG }]));
    await frames(3);
    expect(fromEnd(timeline)).toBeLessThanOrEqual(1);
  });

  it.each(["failed", "interrupted"] as const)("keeps the reader in place but does not reveal %s output", async (status) => {
    const view = render(live("Partial work"));
    await frames();
    const before = position();
    view.rerender(done("Partial work that stopped early.", { status }));
    expect(row("message-answer")).not.toBeNull();
    expect(masked(answerText())).toBe(false);
    expectUnmoved(before);
  });

  it("keeps the same geometry without any reveal under reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(live());
    await frames();
    const before = position();
    view.rerender(done(LONG));
    expect(masked(answerText())).toBe(false);
    expectUnmoved(before);
  });
});

describe("main chat completion reveal", () => {
  it("finishes within the 1040ms bound (plus frame/test slack) without replay", async () => {
    const view = render(live());
    await frames();
    const started = performance.now();
    view.rerender(done(LONG));
    expect(masked(answerText())).toBe(true);
    await frames(2);
    expect(masked(answerText())).toBe(true);
    await vi.waitFor(() => expect(masked(answerText())).toBe(false), { timeout: 2_000, interval: 16 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(1_600);
    view.rerender(done(LONG));
    view.rerender(done(LONG, { searchQuery: "Paragraph 3" }));
    view.rerender(done(LONG));
    await frames();
    expect(maskedCount()).toBe(0);
  });

  it("shows everything at once when search starts mid-reveal, and never restarts", async () => {
    const view = render(live());
    await frames();
    view.rerender(done(LONG));
    await frames(2);
    expect(masked(answerText())).toBe(true);
    view.rerender(done(LONG, { searchQuery: "Paragraph 39" }));
    expect(masked(answerText())).toBe(false);
    expect(answerText().textContent).toContain("Paragraph 39 of the final answer");
    view.rerender(done(LONG));
    await frames(3);
    expect(maskedCount()).toBe(0);
  });

  it("shows everything at once on whole-reply copy and code copy, copying complete text", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    let view = render(live());
    await frames();
    view.rerender(done(LONG));
    await frames(2);
    expect(masked(answerText())).toBe(true);
    fireEvent.click(row("message-answer")!.querySelector<HTMLButtonElement>('button[title="Copy message"]')!);
    expect(masked(answerText())).toBe(false);
    expect(write).toHaveBeenLastCalledWith(LONG);
    view.unmount();

    view = render(live());
    await frames();
    view.rerender(done(CODE));
    await frames(2);
    expect(masked(answerText())).toBe(true);
    await act(async () => { fireEvent.click(answerText().querySelector<HTMLButtonElement>(".code-copy")!); });
    expect(masked(answerText())).toBe(false);
    expect(write).toHaveBeenLastCalledWith("const answer = 42;\nexport default answer;");
  });

  it("shows an authoritative correction immediately without restarting", async () => {
    const view = render(live());
    await frames();
    view.rerender(done(LONG));
    await frames(2);
    expect(masked(answerText())).toBe(true);
    const element = answerText();
    view.rerender(done(`${LONG}\n\nCorrected closing line.`));
    expect(answerText()).toBe(element);
    expect(masked(element)).toBe(false);
    expect(element.textContent).toContain("Corrected closing line.");
    await frames(3);
    expect(maskedCount()).toBe(0);
  });

  it("never reveals idle history or a revisited thread", async () => {
    const view = render(done(LONG));
    await frames();
    expect(maskedCount()).toBe(0);
    expect(fromEnd(scroller())).toBeLessThanOrEqual(1);
    view.rerender(<StrictMode key="other"><Shell messages={turn(LONG, "completed")} running={false} /></StrictMode>);
    await frames();
    expect(maskedCount()).toBe(0);
  });
});

describe("store boundary: same-thread hydration is history, not a new answer", () => {
  const THREAD = "completion-reveal-thread";
  const EMPTY: ChatMessage[] = [];
  function StoreTimeline() {
    // Mirrors App's ConversationTimeline selectors.
    const messages = useTaskStore((state) => state.tasks[THREAD]?.messages ?? EMPTY);
    const history = useTaskStore((state) => state.tasks[THREAD]?.history);
    const activeTurnId = useTaskStore((state) => state.tasks[THREAD]?.activeTurnId);
    const status = useTaskStore((state) => state.statuses[THREAD]);
    return <StrictMode><div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 640 }}>
      <ChatTimeline key={THREAD} messages={messages} activities={[]} running={status === "running" || status === "starting"}
        activeTurnId={activeTurnId} history={history} thinkingLabel="Working" provider="openai" />
    </div></StrictMode>;
  }
  function startLiveTurn() {
    const store = useTaskStore.getState();
    store.removeTask(THREAD);
    store.ensureTask(THREAD);
    store.hydrateTask(THREAD, HISTORY, [], undefined, { ...EMPTY_THREAD_HISTORY, paginated: true });
    store.setActiveTurn(THREAD, "turn");
    store.appendUserMessage(THREAD, { id: "prompt", role: "user", text: "Explain the result", turnId: "turn" });
    store.setTaskStatus(THREAD, "running");
    store.startAssistantMessage(THREAD, { id: "answer", role: "assistant", phase: "final", text: "Drafting", streaming: true, turnId: "turn" });
  }
  afterEach(() => { useTaskStore.getState().removeTask(THREAD); });

  it("reveals a genuine completeTurn", async () => {
    act(startLiveTurn);
    render(<StoreTimeline />);
    await frames();
    act(() => {
      useTaskStore.getState().completeMessage(THREAD, { id: "answer", role: "assistant", phase: "final", text: LONG, turnId: "turn" });
      useTaskStore.getState().completeTurn(THREAD, "turn", "completed");
      useTaskStore.getState().setTaskStatus(THREAD, "completed");
    });
    expect(row("message-answer")).not.toBeNull();
    expect(masked(answerText())).toBe(true);
  });

  it("does not reveal an answer delivered by re-hydrating the same open thread", async () => {
    act(startLiveTurn);
    render(<StoreTimeline />);
    await frames();
    act(() => {
      // A full-read refresh of the open thread brings the finished turn.
      useTaskStore.getState().hydrateTask(THREAD, [...HISTORY,
        { id: "prompt", role: "user", text: "Explain the result", turnId: "turn", turnStatus: "completed" },
        { id: "answer", role: "assistant", phase: "final", text: LONG, turnId: "turn", turnStatus: "completed" },
      ], [], undefined, { ...EMPTY_THREAD_HISTORY, paginated: false });
    });
    act(() => {
      useTaskStore.getState().completeTurn(THREAD, "turn", "completed");
      useTaskStore.getState().setTaskStatus(THREAD, "completed");
    });
    expect(row("message-answer")).not.toBeNull();
    expect(maskedCount()).toBe(0);
  });
});
