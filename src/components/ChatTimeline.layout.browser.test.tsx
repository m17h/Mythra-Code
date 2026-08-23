import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatTimeline } from "./ChatTimeline";
import type { Activity, ChatMessage } from "../types";
import "../styles.css";

/**
 * The only regression test in the suite that exercises real browser layout.
 *
 * jsdom has no layout engine, so it cannot observe row positions. OpenKiwi now
 * uses one ordinary-flow transcript for both hydrated history and live output;
 * these tests enforce that structural invariant and exercise real row geometry.
 *
 * The failure only appears once the transcript actually overflows its viewport,
 * so the shell below is deliberately short.
 */

const LONG_ANSWER = `Layout is zoned rather than scattered — big things pack the back wall, a rug centres the floor with the resident stood on it, odds and ends line the sides — and every placement is re-checked so nothing ever walls anything off. All 33 possible cottages are distinct and walkable, averaging 11 pieces. Press E on anything for a line about it.

Exteriors now match too: paint and roof pitch come from the resident's temperament instead of a blind roll, so a peppy neighbour is pink-and-red and a cranky one mint-and-slate. I kept exactly the same three RNG draws so no cottage moved position.

## One thing I had to add

**Neighbours were only ever indoors while asleep**, so "awake and at home" could never have happened. They now shut the door 1-2 hours before bed (varies by temperament) and take a slow hour over the morning — that's the window for calling round. It's deliberately short since every hour is an hour they're not out on the island, and the scene scheduler now avoids planning campfires across it. A host also won't walk out on you mid-visit.

## Verification

\`tools/verify_indoors.py\` now also builds all 33 cottages and checks each is walkable, has somewhere for its resident to stand, is different from every other, has a look-at line for every piece — and that the door returns the right one of its five open windows and never while asleep. Nothing offscreen ever changes: 3 fixed RNG draws, island is untouched, and the same seed produces the same island every time you load it.

**Worth knowing:** the cheat menu state is per-session and deliberately not saved, so a reload puts everything back to the honest values.`;

const FOLLOW_UP = "the reduce motion and controls and text speed stuff in the Esc menu should all be together in a button called Settings in the Esc menu. We should also add a Cheat Menu that will act as dev tools for me to test things so like changing the time of day, the season, setting how many clams I have, setting affinity and familiarity levels with any npc I want, giving myself any tools, and a toggle for increasing movement speed by 3x and that's all for now. Also I noticed that when knocking on doors, the hitbox so to speak for doors is slightly misaligned to the right of the door instead of being right on the door. this is the case fo any building I can enter I believe so that needs to be fixed.";

const COMPLETED_TURN: ChatMessage[] = [
  { id: "u1", role: "user", text: "make the cottages distinct", timelineOrder: 1, turnId: "t1", turnStatus: "completed" },
  { id: "a1", role: "assistant", text: LONG_ANSWER, timelineOrder: 3, turnId: "t1", turnStatus: "completed", turnDurationMs: 120_000 },
];

const COMPLETED_ACTIVITIES: Activity[] = [
  { id: "c1", kind: "command", title: "python tools/verify_indoors.py", detail: "ok", status: "completed", timelineOrder: 2, turnId: "t1", turnStatus: "completed" },
];

const FOLLOW_UP_TURN: ChatMessage[] = [
  ...COMPLETED_TURN,
  { id: "u2", role: "user", text: FOLLOW_UP, timelineOrder: 4, turnId: "t2", turnStatus: "inProgress" },
];

const VIEWPORT_HEIGHT = 900;
const COMPOSER_HEIGHT = 150;

function Shell({ messages, running, activities = COMPLETED_ACTIVITIES }: { messages: ChatMessage[]; running: boolean; activities?: Activity[] }) {
  return (
    <div className="app-shell" data-theme="kiwi" style={{ height: VIEWPORT_HEIGHT, display: "flex", flexDirection: "column" }}>
      <div className="main-panel" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatTimeline
            messages={messages}
            activities={activities}
            running={running}
            thinkingLabel="Working"
            provider="claude"
          />
        </div>
        <div className="composer-zone" style={{ height: COMPOSER_HEIGHT }} />
      </div>
    </div>
  );
}

type PositionedRow = { top: number; height: number; text: string };

/** Measure the visible row content in the real flow scroller. */
function positionedRows(): PositionedRow[] {
  const scroller = document.querySelector(".flow-timeline");
  if (!scroller) throw new Error("timeline scroller not found");
  return Array.from(scroller.querySelectorAll<HTMLElement>(".timeline-entry"))
    .map((element) => ({
      top: Math.round(element.getBoundingClientRect().top),
      height: Math.round(element.getBoundingClientRect().height),
      text: (element.textContent ?? "").trim().slice(0, 40),
    }))
    .sort((left, right) => left.top - right.top);
}

function overlaps(rows: PositionedRow[]): string[] {
  const found: string[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const bottom = previous.top + previous.height;
    // A row may sit flush against the previous one, never inside it.
    if (rows[index].top < bottom - 1) {
      found.push(
        `"${previous.text}" (top=${previous.top} height=${previous.height}) overlaps "${rows[index].text}" (top=${rows[index].top}) by ${bottom - rows[index].top}px`,
      );
    }
  }
  return found;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 600); });

describe("ChatTimeline browser layout", () => {
  it("keeps a sent image preview compact inside the user message bubble", async () => {
    const previewSource = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480'%3E%3Crect width='640' height='480' fill='%238fd6ff'/%3E%3C/svg%3E";
    render(<Shell messages={[{
      id: "image-prompt",
      role: "user",
      text: "Use this screenshot",
      attachments: [{ path: previewSource, name: "screenshot.png", kind: "image" }],
    }]} running={false} activities={[]} />);
    await settle();

    const preview = document.querySelector<HTMLImageElement>(".message-image-preview");
    const bubble = document.querySelector<HTMLElement>(".message.user .message-body");
    expect(preview).not.toBeNull();
    expect(bubble).not.toBeNull();
    expect(Math.round(preview!.getBoundingClientRect().width)).toBe(112);
    expect(Math.round(preview!.getBoundingClientRect().height)).toBe(76);
    expect(preview!.getBoundingClientRect().right).toBeLessThanOrEqual(bubble!.getBoundingClientRect().right + 1);
  });

  it("aligns a Relay card with neighbouring timeline activity and keeps its height stable", async () => {
    const relay: Activity = {
      id: "relay",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      status: "inProgress",
      timelineOrder: 2,
      turnId: "turn-relay",
      agent: { action: "spawn", provider: "claude", model: "claude-opus-5", task: "Audit the native bridge" },
    };
    const activities: Activity[] = [
      { id: "warning", kind: "warning", title: "Baseline checked", timelineOrder: 1, turnId: "turn-relay" },
      relay,
    ];
    const view = render(<Shell messages={[]} activities={activities} running={false} />);
    await settle();

    const ordinary = document.querySelector<HTMLElement>(".activity-row");
    const working = document.querySelector<HTMLElement>(".subagent-relay-card");
    expect(ordinary).not.toBeNull();
    expect(working).not.toBeNull();
    expect(Math.round(working!.getBoundingClientRect().left)).toBe(Math.round(ordinary!.getBoundingClientRect().left));
    const workingHeight = Math.round(working!.getBoundingClientRect().height);

    view.rerender(<Shell messages={[]} activities={[activities[0], { ...relay, status: "completed" }]} running={false} />);
    await settle();
    const completed = document.querySelector<HTMLElement>(".subagent-relay-card");
    expect(Math.round(completed!.getBoundingClientRect().height)).toBe(workingHeight);
  });

  it("never draws a row on top of the row above it after a prompt is appended", async () => {
    const view = render(<Shell messages={COMPLETED_TURN} running={false} />);
    await settle();

    const before = positionedRows();
    expect(before.length).toBeGreaterThan(1);
    expect(overlaps(before)).toEqual([]);

    // Submitting a follow-up appends the optimistic user message and starts the
    // turn, which is the exact transition that mispositioned the new row.
    view.rerender(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();

    const after = positionedRows();

    expect(document.querySelector("[data-flow-timeline='true']")).not.toBeNull();
    expect(after.length).toBeGreaterThan(before.length);
    expect(overlaps(after)).toEqual([]);
  });

  it("keeps the transcript overflowing so the regression can actually surface", async () => {
    render(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();

    const scroller = document.querySelector<HTMLElement>(".flow-timeline");
    expect(scroller).not.toBeNull();
    expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
  });

  it("repositions the following prompt when a streamed answer grows", async () => {
    const message = (text: string, streaming = false): ChatMessage[] => [
      COMPLETED_TURN[0],
      { ...COMPLETED_TURN[1], text, streaming, turnStatus: streaming ? "inProgress" : "completed" },
    ];
    const view = render(<Shell messages={message(LONG_ANSWER.slice(0, 240), true)} running />);
    await settle();
    for (const size of [500, 900, 1400, LONG_ANSWER.length]) {
      view.rerender(<Shell messages={message(LONG_ANSWER.slice(0, size), true)} running />);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    view.rerender(<Shell messages={message(LONG_ANSWER, false)} running={false} />);
    await settle();
    view.rerender(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();
    expect(overlaps(positionedRows())).toEqual([]);
  });

  it("keeps the next prompt below an answer when completion and insertion are batched", async () => {
    const partial: ChatMessage[] = [
      COMPLETED_TURN[0],
      {
        ...COMPLETED_TURN[1],
        text: LONG_ANSWER.slice(0, 240),
        streaming: true,
        turnStatus: "inProgress",
      },
    ];
    const view = render(<Shell messages={partial} running />);
    await settle();

    // The runtime can deliver the final Markdown, completed-turn compaction,
    // and the optimistic next prompt in one React update. There is no settled
    // completed-answer frame for the timeline to render in between.
    view.rerender(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();

    expect(overlaps(positionedRows())).toEqual([]);
  });

  it("uses normal flow throughout a contended stream and its batched follow-up", async () => {
    const streamed = (text: string): ChatMessage[] => [
      COMPLETED_TURN[0],
      { ...COMPLETED_TURN[1], text, streaming: true, turnStatus: "inProgress" },
      { ...FOLLOW_UP_TURN[2], turnStatus: "inProgress" },
    ];
    const view = render(<Shell messages={streamed(LONG_ANSWER.slice(0, 120))} running />);
    for (let size = 180; size < LONG_ANSWER.length; size += 80) {
      view.rerender(<Shell messages={streamed(LONG_ANSWER.slice(0, size))} running />);
      await new Promise(requestAnimationFrame);
    }
    view.rerender(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();

    expect(document.querySelector("[data-flow-timeline='true']")).not.toBeNull();
    expect(overlaps(positionedRows())).toEqual([]);
  });

  it("hydrates an idle existing thread without introducing absolute row coordinates", async () => {
    const view = render(<Shell messages={[]} running={false} />);
    await settle();

    // Existing threads hydrate in one store update after selection. This is
    // the exact path shown in the 1.7.4 regression screenshot.
    view.rerender(<Shell messages={FOLLOW_UP_TURN.map((message) => ({ ...message, turnStatus: "completed" }))} running={false} />);
    await settle();

    const scroller = document.querySelector<HTMLElement>(".flow-timeline");
    expect(scroller).not.toBeNull();
    expect(overlaps(positionedRows())).toEqual([]);
    for (const entry of scroller!.querySelectorAll<HTMLElement>(".timeline-entry")) {
      expect(getComputedStyle(entry).position).toBe("static");
    }
  });

  it("preserves the same flow scroller while the reader is above the live end", async () => {
    const view = render(<Shell messages={FOLLOW_UP_TURN} running />);
    await settle();
    const liveScroller = document.querySelector<HTMLElement>(".flow-timeline");
    expect(liveScroller).not.toBeNull();

    fireEvent.wheel(liveScroller!, { deltaY: -120 });
    liveScroller!.scrollTop = 0;
    fireEvent.scroll(liveScroller!);
    view.rerender(<Shell messages={FOLLOW_UP_TURN} running={false} />);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.querySelector("[data-flow-timeline='true']")).not.toBeNull();

    liveScroller!.scrollTop = liveScroller!.scrollHeight;
    fireEvent.scroll(liveScroller!);
    await settle();
    expect(document.querySelector(".flow-timeline")).not.toBeNull();
  });

  it("keeps a queued prompt below an answer while that answer grows", async () => {
    const queued = (text: string): ChatMessage[] => [
      COMPLETED_TURN[0],
      { ...COMPLETED_TURN[1], text, streaming: true, turnStatus: "inProgress" },
      { ...FOLLOW_UP_TURN[2], turnStatus: "inProgress" },
    ];
    const view = render(<Shell messages={queued(LONG_ANSWER.slice(0, 240))} running />);
    await settle();
    for (const size of [500, 900, 1400, LONG_ANSWER.length]) {
      view.rerender(<Shell messages={queued(LONG_ANSWER.slice(0, size))} running />);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await settle();
    expect(overlaps(positionedRows())).toEqual([]);
  });

  it("keeps the newest prompt below a long completed transcript", async () => {
    const messages: ChatMessage[] = [];
    const activities: Activity[] = [];
    for (let i = 0; i < 24; i += 1) {
      messages.push({ id: `u${i}`, role: "user", text: `request ${i}`, timelineOrder: i * 3 + 1, turnId: `t${i}`, turnStatus: "completed" });
      activities.push({ id: `c${i}`, kind: "command", title: `command ${i}`, detail: "ok", status: "completed", timelineOrder: i * 3 + 2, turnId: `t${i}`, turnStatus: "completed" });
      messages.push({ id: `a${i}`, role: "assistant", text: `${LONG_ANSWER}\n\nTurn ${i}`, timelineOrder: i * 3 + 3, turnId: `t${i}`, turnStatus: "completed", turnDurationMs: 120_000 });
    }
    const view = render(<Shell messages={messages} running={false} />);
    await settle();
    const followUp = [...messages, { id: "u-last", role: "user" as const, text: FOLLOW_UP, timelineOrder: 999, turnId: "t-last", turnStatus: "inProgress" as const }];
    view.rerender(<Shell messages={followUp} running />);
    await settle();
    expect(overlaps(positionedRows())).toEqual([]);
  });
});
