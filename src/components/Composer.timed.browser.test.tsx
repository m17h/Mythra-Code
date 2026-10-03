import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, resetDraftStoreForTests } from "./Composer";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { dateInputValue } from "../lib/timedPrompts";
import { ClaudeContinuationNotice } from "./ClaudeContinuationNotice";
import type { QueuedTurn } from "../lib/taskStore";
import type { TimedPromptActions } from "./ScheduledPrompts";
import "../styles.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const THREAD = "timed-a";

function Fixture({ onRelease = () => true, continuation = false, newThreadPrompts, threadKey = THREAD }: {
  onRelease?: (id: string) => boolean;
  continuation?: boolean;
  newThreadPrompts?: { entries: QueuedTurn[]; actions: TimedPromptActions };
  threadKey?: string;
}) {
  const entries = useTaskStore((state) => state.tasks[THREAD].queuedTurns);
  return <div className="app-shell" data-theme="mythra" style={{ width: 640, height: "auto", display: "block", paddingTop: 360 }}>
    <button type="button" style={{ position: "absolute", top: 0, left: 0 }}>Outside</button>
    <Composer threadKey={threadKey} chatFont="system" running={false} queueing={false} canSteer={false}
      dropActive={false} placeholder="Main draft" attachments={[]} controls={null} queuedTurns={entries}
      onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => true} onSteer={async () => true} onStop={() => {}}
      onBeginEditQueued={(id) => useTaskStore.getState().beginQueuedTurnEdit(THREAD, id)}
      onFinishEditQueued={(id, text) => useTaskStore.getState().finishQueuedTurnEdit(THREAD, id, text)}
      onSchedule={async (text, deliverAt) => { useTaskStore.getState().enqueueTurn(THREAD, text, [], { deliverAt }); return true; }}
      scheduleContextLabel="Joins this thread's queue at that time."
      continuationNotice={continuation ? <ClaudeContinuationNotice variant="grace" onOpenUsage={() => {}} /> : undefined}
      newThreadPrompts={newThreadPrompts?.entries}
      newThreadActions={newThreadPrompts?.actions}
      newThreadPromptDetail={() => "new Claude conversation (claude-opus-5)"}
      timedActions={{
        onBeginEdit: (id) => useTaskStore.getState().beginQueuedTurnEdit(THREAD, id),
        onFinishEdit: (id, text) => useTaskStore.getState().finishQueuedTurnEdit(THREAD, id, text),
        onReschedule: (id, at) => useTaskStore.getState().rescheduleQueuedTurn(THREAD, id, at),
        onRelease,
        onRemove: (id) => useTaskStore.getState().removeQueuedTurn(THREAD, id),
      }} />
  </div>;
}

beforeEach(() => {
  localStorage.clear();
  resetDraftStoreForTests();
  resetTaskStore();
  useTaskStore.getState().ensureTask(THREAD);
});

describe("scheduling prompts in the composer", () => {
  it("schedules from an unclipped local-time picker and keeps timed prompts out of the FIFO", async () => {
    render(<Fixture />);
    await userEvent.fill(screen.getByPlaceholderText("Main draft"), "Summarise overnight CI");
    const trigger = screen.getByRole("button", { name: "Schedule this prompt" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Schedule prompt" });
    await waitFor(() => expect(within(dialog).getByLabelText("Date")).toHaveFocus());
    expect(dialog).toHaveTextContent("Mythra Code must be open and awake");
    expect(dialog).toHaveTextContent("never sent late");

    // Not clipped by the composer card and fully inside the viewport.
    const composerRect = trigger.closest(".composer")!.getBoundingClientRect();
    const rect = dialog.getBoundingClientRect();
    expect(rect.top).toBeLessThan(composerRect.top);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);

    const yesterday = dateInputValue(Date.now() - 86_400_000);
    await userEvent.fill(within(dialog).getByLabelText("Date"), yesterday);
    await userEvent.fill(within(dialog).getByLabelText("Time"), "09:00");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a time in the future.");
    expect(within(dialog).getByRole("button", { name: "Schedule" })).toBeDisabled();

    await userEvent.fill(within(dialog).getByLabelText("Date"), dateInputValue(Date.now() + 2 * 86_400_000));
    await page.screenshot({ element: trigger.closest<HTMLElement>(".app-shell")!, path: "../../test-results/timed-prompt-picker.png" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByPlaceholderText("Main draft")).toHaveValue("");
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 prompt");
    await userEvent.click(toggle);
    const scheduled = screen.getByRole("list", { name: "Scheduled for this thread" });
    expect(within(scheduled).getByText("Summarise overnight CI")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Queued follow-up messages" })).toBeNull();
    // A future timed prompt does not make Enter queue.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    await page.screenshot({ element: scheduled.closest<HTMLElement>(".composer")!, path: "../../test-results/timed-prompt-list.png" });
  });

  it("closes on Escape with focus restored, and on an outside click", async () => {
    render(<Fixture />);
    await userEvent.fill(screen.getByPlaceholderText("Main draft"), "Later");
    const trigger = screen.getByRole("button", { name: "Schedule this prompt" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByPlaceholderText("Main draft")).toHaveValue("Later");
  });

  it("presents a missed prompt honestly and requires an explicit action", async () => {
    const onRelease = vi.fn(() => true);
    const timed = useTaskStore.getState().enqueueTurn(THREAD, "Deploy at nine", [], { deliverAt: Date.now() + 1_000 });
    act(() => { useTaskStore.getState().markTimedTurnsMissed(THREAD, [timed.id], Date.now() + 2_000); });
    render(<Fixture onRelease={onRelease} />);
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 missed");
    await userEvent.click(toggle);
    const row = screen.getByText("Deploy at nine").closest<HTMLElement>(".queued-turn")!;
    expect(row).toHaveClass("is-missed");
    expect(row).toHaveTextContent("not sent automatically");
    await userEvent.click(within(row).getByRole("button", { name: "Queue now scheduled prompt 1" }));
    expect(onRelease).toHaveBeenCalledWith(timed.id);
    await userEvent.click(within(row).getByRole("button", { name: "Reschedule scheduled prompt 1" }));
    expect(await screen.findByRole("dialog", { name: "Reschedule prompt" })).toBeInTheDocument();
    expect(toggle).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await userEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Scheduled for this thread" })).toBeNull();
    expect(toggle).toHaveTextContent("1 missed");
  });

  it("releases future schedules only through an explicit action in either scope", async () => {
    const timed = useTaskStore.getState().enqueueTurn(THREAD, "Future thread follow-up", [], { deliverAt: Date.now() + 3_600_000 });
    const onRelease = vi.fn((id: string) => useTaskStore.getState().releaseTimedTurnNow(THREAD, id));
    const newConversation: QueuedTurn = { id: "future-new", threadId: "new:/p", text: "Future new audit", attachments: [], createdAt: Date.now(), status: "queued", deliverAt: Date.now() + 7_200_000 };
    const newRelease = vi.fn(() => true);
    render(<Fixture onRelease={onRelease} newThreadPrompts={{ entries: [newConversation], actions: { onReschedule: () => true, onRelease: newRelease, onRemove: () => {} } }} />);
    await userEvent.click(screen.getByRole("button", { name: /Scheduled · this thread/ }));
    await userEvent.click(screen.getByRole("button", { name: /Scheduled · new conversations/ }));
    expect(onRelease).not.toHaveBeenCalled();
    expect(newRelease).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Queue now scheduled prompt 1" }));
    expect(onRelease).toHaveBeenCalledExactlyOnceWith(timed.id);
    expect(screen.getByRole("list", { name: "Queued follow-up messages" })).toHaveTextContent("Future thread follow-up");
    expect(screen.queryByRole("list", { name: "Scheduled for this thread" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start now new conversation 1" }));
    expect(newRelease).toHaveBeenCalledExactlyOnceWith("future-new");
  });

  it("keeps this thread's schedule and scheduled new conversations distinct inside a thread", async () => {
    useTaskStore.getState().enqueueTurn(THREAD, "Follow up on CI here", [], { deliverAt: Date.now() + 3_600_000 });
    const newConversation: QueuedTurn = { id: "new-1", threadId: "new:/p", text: "Start the weekly audit", attachments: [], createdAt: 1, status: "queued", deliverAt: Date.now() + 7_200_000 };
    const actions = { onBeginEdit: vi.fn(() => true), onFinishEdit: vi.fn(() => true), onReschedule: vi.fn(() => true), onRelease: vi.fn(() => true), onRemove: vi.fn() };
    const view = render(<Fixture newThreadPrompts={{ entries: [newConversation], actions }} />);
    const threadToggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(threadToggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(threadToggle);
    expect(within(screen.getByRole("list", { name: "Scheduled for this thread" })).getByText("Follow up on CI here")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Scheduled · new conversations/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Scheduled new conversations" })).toBeNull();
    await page.screenshot({ element: toggle.closest<HTMLElement>(".composer")!, path: "../../test-results/timed-prompt-scopes-collapsed.png" });
    await userEvent.click(toggle);
    const list = screen.getByRole("list", { name: "Scheduled new conversations" });
    expect(list).toHaveTextContent("new Claude conversation (claude-opus-5)");
    await userEvent.click(within(list).getByRole("button", { name: "Edit new conversation 1" }));
    expect(actions.onBeginEdit).toHaveBeenCalledWith("new-1");
    await userEvent.click(within(list).getByRole("button", { name: "Remove new conversation 1" }));
    expect(actions.onRemove).toHaveBeenCalledWith("new-1");
    // Its rows never collide with the thread's own action names.
    expect(screen.getByRole("button", { name: "Remove scheduled prompt 1" })).toBeInTheDocument();
    await page.screenshot({ element: list.closest<HTMLElement>(".composer")!, path: "../../test-results/timed-prompt-scopes-expanded.png" });

    // A missed new conversation stays collapsible, with its status in the header.
    view.rerender(<Fixture newThreadPrompts={{ entries: [{ ...newConversation, missedAt: Date.now() }], actions }} />);
    expect(toggle).toHaveTextContent("1 missed");
    await userEvent.click(screen.getByRole("button", { name: "Start now new conversation 1" }));
    expect(actions.onRelease).toHaveBeenCalledWith("new-1");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 missed");
  });

  it("keeps new-conversation schedules compact beside a new draft", async () => {
    const newConversation: QueuedTurn = { id: "draft-1", threadId: "new:/p", text: "Later audit", attachments: [], createdAt: 1, status: "queued", deliverAt: Date.now() + 7_200_000 };
    const actions = { onReschedule: () => true, onRelease: () => true, onRemove: () => {} };
    render(<Fixture threadKey="new:/p" newThreadPrompts={{ entries: [newConversation], actions }} />);
    const toggle = screen.getByRole("button", { name: /Scheduled · new conversations/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 prompt");
    await userEvent.fill(screen.getByPlaceholderText("Main draft"), "Keep this draft");
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Scheduled new conversations" })).toHaveTextContent("Later audit");
    await userEvent.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByPlaceholderText("Main draft")).toHaveValue("Keep this draft");
    await page.screenshot({ element: toggle.closest<HTMLElement>(".composer")!, path: "../../test-results/timed-prompt-new-draft-collapsed.png" });
  });

  it("preserves scheduled edits and the composer draft across folding and reopening", async () => {
    useTaskStore.getState().enqueueTurn(THREAD, "Original schedule", [], { deliverAt: Date.now() + 3_600_000 });
    render(<Fixture />);
    const input = screen.getByPlaceholderText("Main draft");
    await userEvent.fill(input, "Separate immediate draft");
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Edit scheduled prompt 1" }));
    const editor = screen.getByRole("textbox", { name: "Edit scheduled prompt 1" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.fill(editor, "Revised schedule");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(toggle).not.toBeDisabled();
    expect(screen.getByText("Revised schedule")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Scheduled for this thread" })).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText("Revised schedule")).toBeInTheDocument();
    expect(input).toHaveValue("Separate immediate draft");
    expect(useTaskStore.getState().tasks[THREAD].queuedTurns[0].text).toBe("Revised schedule");
  });

  it("renders the continuation notice slot inside the composer", async () => {
    render(<Fixture continuation />);
    const notice = screen.getByRole("status");
    expect(notice.closest(".composer")).not.toBeNull();
    expect(notice).toHaveTextContent("Included wrap-up allowance in use");
    await page.screenshot({ element: notice.closest<HTMLElement>(".composer")!, path: "../../test-results/claude-continuation-notice.png" });
  });
});
