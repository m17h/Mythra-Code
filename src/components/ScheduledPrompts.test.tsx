import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QueuedTurn } from "../lib/taskStore";
import { ScheduledPrompts, type ScheduledPromptScope } from "./ScheduledPrompts";

const actions = { onReschedule: vi.fn(() => true), onRelease: vi.fn(() => true), onRemove: vi.fn() };
function entry(id: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return { id, threadId: "thread", text: `Prompt ${id}`, attachments: [], createdAt: 1, deliverAt: Date.now() + 60_000, status: "queued", ...overrides };
}

describe("scheduled prompt disclosure", () => {
  it.each<[ScheduledPromptScope, string]>([["thread", "Scheduled for this thread"], ["new-thread", "Scheduled new conversations"]])("starts %s compact with its count and supports keyboard disclosure", async (scope, listName) => {
    const user = userEvent.setup();
    render(<ScheduledPrompts entries={[entry("one"), entry("two")]} scope={scope} actions={actions} />);
    const toggle = screen.getByRole("button", { name: /Scheduled ·/ });
    expect(toggle).toHaveTextContent("2 prompts");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: listName })).toBeNull();
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: listName })).getAllByRole("listitem")).toHaveLength(2);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps missed, failed and starting counts visible while folded", async () => {
    const user = userEvent.setup();
    render(<ScheduledPrompts entries={[entry("missed", { missedAt: 2 }), entry("failed", { status: "failed", error: "Offline" }), entry("sending", { status: "sending" })]} scope="thread" actions={actions} />);
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(toggle).toHaveTextContent("3 prompts · 1 missed · 1 failed · 1 starting");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Queue now scheduled prompt 1" })).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(actions.onRelease).not.toHaveBeenCalled();
  });

  it.each<[ScheduledPromptScope, string, number]>([
    ["thread", "Queue now scheduled prompt 1", 60_000],
    ["thread", "Queue now scheduled prompt 1", -1_000],
    ["new-thread", "Start now new conversation 1", 60_000],
    ["new-thread", "Start now new conversation 1", -1_000],
  ])("allows an explicit release in %s through %s at offset %i", async (scope, actionLabel, offset) => {
    const user = userEvent.setup();
    const onRelease = vi.fn(() => true);
    render(<ScheduledPrompts entries={[entry("ready", { deliverAt: Date.now() + offset })]} scope={scope} actions={{ ...actions, onRelease }} />);
    await user.click(screen.getByRole("button", { name: /Scheduled ·/ }));
    expect(onRelease).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: actionLabel }));
    expect(onRelease).toHaveBeenCalledExactlyOnceWith("ready");
  });

  it("keeps an active editor expanded until its edit finishes", async () => {
    const editActions = { ...actions, onFinishEdit: () => true };
    const editor = () => <textarea aria-label="Editing schedule" defaultValue="Unsaved revision" />;
    const view = render(<ScheduledPrompts entries={[entry("one", { editing: true })]} scope="thread" actions={editActions} renderEditor={editor} />);
    const toggle = screen.getByRole("button", { name: /Scheduled · this thread/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Editing schedule" })).toHaveValue("Unsaved revision");
    view.rerender(<ScheduledPrompts entries={[entry("one")]} scope="thread" actions={editActions} renderEditor={editor} />);
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
