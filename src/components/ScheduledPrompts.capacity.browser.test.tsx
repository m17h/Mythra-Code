import type { CSSProperties } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, resetDraftStoreForTests } from "./Composer";
import type { QueuedTurn } from "../lib/taskStore";
import "../styles.css";
// Match main.tsx: Lumen's overrides load after the shared production stylesheet.
import "../styles/lumen/index.css";

function CapacityFixture({ count, onRemove }: { count: number; onRemove: (id: string) => void }) {
  const entries: QueuedTurn[] = Array.from({ length: count }, (_, index) => ({
    id: `capacity-${index}`, threadId: "capacity-thread", text: `Scheduled item ${index + 1}`,
    attachments: [], createdAt: Date.now(), deliverAt: Date.now() + 3_600_000 + index * 60_000, status: "queued",
  }));
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <main className="main-panel">
      <div className="topbar">Conversation header</div>
      <div style={{ flex: 1, minHeight: 0 }}>Conversation</div>
      <div className="composer-zone">
        <Composer threadKey="capacity-thread" chatFont="system" running={false} queueing={false} canSteer={false}
          dropActive={false} placeholder="Immediate message" attachments={[]} controls={null} queuedTurns={entries}
          onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => true} onSteer={async () => true} onStop={() => {}}
          onSchedule={async () => true}
          timedActions={{ onReschedule: () => true, onRelease: () => true, onRemove }} />
      </div>
    </main>
  </div>;
}

/** Both schedule groups at once, at the shell's UI-scale zoom. */
function DualGroupFixture({ count, scale }: { count: number; scale: number }) {
  const at = (index: number) => Date.now() + 3_600_000 + index * 60_000;
  const thread: QueuedTurn[] = Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`, threadId: "capacity-thread", text: `Thread schedule ${index + 1}`,
    attachments: [], createdAt: Date.now(), deliverAt: at(index), status: "queued",
    // An inline edit in progress near the end of the list.
    ...(index === count - 2 ? { editing: true } : {}),
  }));
  const newConversations: QueuedTurn[] = Array.from({ length: count }, (_, index) => ({
    id: `new-${index}`, threadId: "new:/capacity", text: `New conversation ${index + 1}`,
    attachments: [], createdAt: Date.now(), deliverAt: at(index), status: "queued",
    // Missed rows remain visible in the header while the group is folded.
    ...(index % 3 === 0 ? { missedAt: Date.now() } : {}),
  }));
  const actions = { onBeginEdit: () => true, onFinishEdit: () => true, onReschedule: () => true, onRelease: () => true, onRemove: () => {} };
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <main className="main-panel">
      <div className="topbar">Conversation header</div>
      <div style={{ flex: 1, minHeight: 0 }}>Conversation</div>
      <div className="composer-zone">
        <Composer threadKey="capacity-thread" chatFont="system" running={false} queueing={false} canSteer={false}
          dropActive={false} placeholder="Immediate message" attachments={[]} controls={null} queuedTurns={thread}
          onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => true} onSteer={async () => true} onStop={() => {}}
          onSchedule={async () => true} timedActions={actions} newThreadPrompts={newConversations} newThreadActions={actions} />
      </div>
    </main>
  </div>;
}

function expectInViewport(element: Element, label: string) {
  const rect = element.getBoundingClientRect();
  expect(rect.top, `${label}: top in viewport`).toBeGreaterThanOrEqual(0);
  expect(rect.bottom, `${label}: bottom in viewport`).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.height, `${label}: rendered`).toBeGreaterThan(0);
}

beforeEach(async () => {
  localStorage.clear();
  resetDraftStoreForTests();
  // The native app permits windows down to 980×680.
  await page.viewport(980, 680);
});
afterEach(async () => {
  localStorage.clear();
  await page.viewport(1400, 900);
});

describe("scheduled prompt capacity", () => {
  it.each([30, 250])("keeps the normal composer usable with %i independently accessible schedules", async (count) => {
    const onRemove = vi.fn();
    render(<CapacityFixture count={count} onRemove={onRemove} />);
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(`${count} prompts`);
    expect(screen.queryByRole("list", { name: "Scheduled for this thread" })).toBeNull();
    const collapsedHeight = toggle.closest<HTMLElement>(".scheduled-prompts")!.getBoundingClientRect().height;
    expect(collapsedHeight).toBeLessThan(50);
    await userEvent.click(toggle);
    const list = screen.getByRole("list", { name: /^Scheduled (prompts|for this thread)$/ });
    expect(within(list).getAllByRole("listitem")).toHaveLength(count);

    const input = screen.getByPlaceholderText("Immediate message");
    const send = screen.getByRole("button", { name: "Send" });
    for (const control of [input, send]) {
      const rect = control.getBoundingClientRect();
      expect(rect.top, `${control.tagName}: top in viewport`).toBeGreaterThanOrEqual(0);
      expect(rect.bottom, `${control.tagName}: bottom in viewport`).toBeLessThanOrEqual(window.innerHeight);
      expect(rect.width).toBeGreaterThan(0);
    }

    // A large durable collection must be scrollable locally, without relying
    // on document scrolling (the native shell deliberately hides body overflow).
    const scrollHost = [list, list.parentElement!].find((element) =>
      /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    expect(scrollHost, "a bounded schedule scroll area").toBeDefined();
    await userEvent.fill(input, "Run this immediately");
    await userEvent.click(send);
    expect(input).toHaveValue("");

    act(() => { scrollHost!.scrollTop = scrollHost!.scrollHeight; });
    const lastRemove = within(list).getByRole("button", { name: `Remove scheduled prompt ${count}` });
    const rect = lastRemove.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.click(lastRemove);
    expect(onRemove).toHaveBeenCalledWith(`capacity-${count - 1}`);
  });

  it.each([1, 1.5])("keeps both groups, an inline edit and Send usable at %sx UI scale", async (scale) => {
    const count = 120;
    render(<DualGroupFixture count={count} scale={scale} />);
    const threadToggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(threadToggle).toHaveAttribute("aria-expanded", "true");
    expect(threadToggle).toBeDisabled();
    const newToggle = screen.getByRole("button", { name: /Scheduled · new conversations/ });
    expect(newToggle).toHaveAttribute("aria-expanded", "false");
    expect(newToggle).toHaveTextContent("40 missed");
    await userEvent.click(newToggle);
    const threadList = screen.getByRole("list", { name: "Scheduled for this thread" });
    const newList = screen.getByRole("list", { name: "Scheduled new conversations" });
    expect(within(threadList).getAllByRole("listitem")).toHaveLength(count);
    expect(within(newList).getAllByRole("listitem")).toHaveLength(count);

    const input = screen.getByPlaceholderText("Immediate message");
    expectInViewport(input, "composer input");
    expectInViewport(screen.getByRole("button", { name: "Send" }), "Send");
    expectInViewport(screen.getByRole("button", { name: "Schedule this prompt" }), "Schedule");
    for (const list of [threadList, newList]) {
      expect(getComputedStyle(list).overflowY).toMatch(/^(auto|scroll)$/);
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    }

    // The inline editor is reachable inside its bounded list and stays typeable.
    const editor = within(threadList).getByRole("textbox", { name: `Edit scheduled prompt ${count - 1}` });
    act(() => { editor.scrollIntoView({ block: "nearest" }); });
    expectInViewport(editor, "inline editor");
    await userEvent.fill(editor, "Revised while bounded");
    expect(editor).toHaveValue("Revised while bounded");
    // Rows never overlap inside the bounded list (an editor squeezed below its
    // content would slide under the next row).
    const editingRow = editor.closest<HTMLElement>(".queued-turn")!;
    const nextRow = editingRow.nextElementSibling!;
    expect(nextRow.getBoundingClientRect().top).toBeGreaterThanOrEqual(editingRow.getBoundingClientRect().bottom - 0.5);
    expect(editingRow.scrollHeight).toBeLessThanOrEqual(editingRow.clientHeight + 1);
    const save = within(editingRow).getByRole("button", { name: "Save" });
    act(() => { save.scrollIntoView({ block: "nearest" }); });
    expectInViewport(save, "inline editor Save");

    // The last row of each group, including a missed row's explicit start, stays reachable.
    act(() => { newList.scrollTop = newList.scrollHeight; });
    expectInViewport(within(newList).getByRole("button", { name: `Remove new conversation ${count}` }), "last new conversation");
    act(() => { newList.scrollTop = 0; });
    expectInViewport(within(newList).getByRole("button", { name: "Start now new conversation 1" }), "missed start");
    act(() => { threadList.scrollTop = threadList.scrollHeight; });
    expectInViewport(within(threadList).getByRole("button", { name: `Remove scheduled prompt ${count}` }), "last thread schedule");
    expectInViewport(input, "composer input after scrolling");
    await page.screenshot({ element: input.closest<HTMLElement>(".composer")!, path: `../../test-results/timed-prompt-capacity-${scale}x.png` });
  });
});
