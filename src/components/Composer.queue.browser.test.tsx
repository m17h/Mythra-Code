import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, resetDraftStoreForTests } from "./Composer";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import "../styles.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

function Fixture({ threadId = "queue-a", narrow = false }: { threadId?: string; narrow?: boolean }) {
  const entries = useTaskStore((state) => state.tasks[threadId].queuedTurns);
  return <div className="app-shell" data-theme="mythra" style={{ width: narrow ? 340 : 750, height: "auto", display: "block" }}>
    <Composer threadKey={threadId} chatFont="system" running={false} queueing={false} canSteer={false}
      dropActive={false} placeholder="Main draft" attachments={[]} controls={null} queuedTurns={entries}
      onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => true} onSteer={async () => true} onStop={() => {}}
      onBeginEditQueued={(id) => useTaskStore.getState().beginQueuedTurnEdit(threadId, id)}
      onFinishEditQueued={(id, text) => useTaskStore.getState().finishQueuedTurnEdit(threadId, id, text)} />
  </div>;
}

beforeEach(() => {
  localStorage.clear();
  resetDraftStoreForTests();
  resetTaskStore();
  useTaskStore.getState().ensureTask("queue-a");
  useTaskStore.getState().ensureTask("queue-b");
  useTaskStore.getState().enqueueTurn("queue-a", "Original first prompt", [{ name: "reference.png", path: "/tmp/reference.png", kind: "image" }]);
  useTaskStore.getState().enqueueTurn("queue-a", "Original second prompt", []);
});

describe("editing queued prompts in the browser", () => {
  it("saves in place with attachments and preserves the main draft, keyboard focus and compact layout", async () => {
    render(<Fixture narrow />);
    const original = useTaskStore.getState().tasks["queue-a"].queuedTurns[0];
    await userEvent.fill(screen.getByPlaceholderText("Main draft"), "Unsent main draft");
    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    const input = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.fill(input, "Revised first prompt\nwith another line");
    expect(screen.getByText("Paused while editing · 1 attachment kept")).toBeInTheDocument();
    const row = input.closest<HTMLElement>(".queued-turn")!;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    const footer = row.querySelector<HTMLElement>(".queued-turn-edit-footer")!;
    expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
    await page.screenshot({ element: row.closest<HTMLElement>(".composer")!, path: "../../test-results/queued-prompt-editor.png" });
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit queued message 1" })).toHaveFocus());
    expect(useTaskStore.getState().tasks["queue-a"].queuedTurns[0]).toEqual({ ...original, text: "Revised first prompt\nwith another line", editing: undefined });
    expect(screen.getByPlaceholderText("Main draft")).toHaveValue("Unsent main draft");
    expect(JSON.parse(localStorage.getItem("kiwi.drafts")!)[`queued-edit:${original.id}`]).toBeUndefined();
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
  });

  it("retains an empty edit across navigation and reload and prevents blank saves", async () => {
    const view = render(<Fixture />);
    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit queued message 1" }), "");
    view.rerender(<Fixture threadId="queue-b" />);
    view.rerender(<Fixture />);
    expect(screen.getByRole("textbox", { name: "Edit queued message 1" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    view.unmount();
    resetDraftStoreForTests();
    render(<Fixture />);
    expect(screen.getByRole("textbox", { name: "Edit queued message 1" })).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit queued message 1" })).toHaveFocus());
    expect(screen.getByText("Original first prompt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    expect(screen.getByRole("textbox", { name: "Edit queued message 1" })).toHaveValue("Original first prompt");
  });

  it("keeps independent edits per item and supports cancel and the save shortcut", async () => {
    render(<Fixture />);
    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit queued message 1" }), "Discard this");
    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 2" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit queued message 2" }), "Save this");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByText("Save this")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useTaskStore.getState().tasks["queue-a"].queuedTurns.map((entry) => entry.text)).toEqual(["Original first prompt", "Save this"]);
  });
});
