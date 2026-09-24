import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { COMPOSER_INPUT_MAX_HEIGHT, Composer, draftFor, resetDraftStoreForTests, type ComposerHandle } from "./Composer";

function composerProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}): Parameters<typeof Composer>[0] {
  return {
    threadKey: "thread-a",
    chatFont: "system",
    running: false,
    queueing: false,
    canSteer: true,
    dropActive: false,
    placeholder: "Ask anything",
    attachments: [],
    controls: null,
    onRemoveAttachment: vi.fn(),
    onPasteImages: vi.fn(),
    onSend: vi.fn(async () => true),
    onSteer: vi.fn(async () => true),
    onStop: vi.fn(),
    ...overrides,
  };
}

describe("Composer", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDraftStoreForTests();
  });

  it("sends the trimmed draft and clears it on success", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "  hello  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello"));
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("restores the draft when delivery fails", async () => {
    const onSend = vi.fn(async () => false);
    render(<Composer {...composerProps({ onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "keep me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea).toHaveValue("keep me"));
  });

  it("sends feedback alone through the existing Send button", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ hasFeedback: true, feedbackTray: <div>One review note</div>, onSend })} />);
    expect(screen.getByText("One review note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("");
  });

  it("passes typed text once alongside pending feedback", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ hasFeedback: true, feedbackTray: <div>Review note</div>, onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "  Please fix the tests  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("Please fix the tests");
    expect(textarea).toHaveValue("");
  });

  it("queues feedback alone while a task is running", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ running: true, queueing: true, hasFeedback: true, onSend })} />);
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("");
  });

  it("keeps feedback and a typed draft on a failed or rejected send", async () => {
    const onSend = vi.fn(async () => false);
    const { rerender } = render(<Composer {...composerProps({ hasFeedback: true, feedbackTray: <div>Pending note</div>, onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
    await waitFor(() => expect(textarea).toHaveValue("Keep this draft"));
    expect(screen.getByText("Pending note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send feedback and optional prompt" })).toBeEnabled();
    const rejected = vi.fn(async () => { throw new Error("network unavailable"); });
    rerender(<Composer {...composerProps({ hasFeedback: true, feedbackTray: <div>Pending note</div>, onSend: rejected })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
    await waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textarea).toHaveValue("Keep this draft"));
    expect(screen.getByText("Pending note")).toBeInTheDocument();
  });

  it("ignores rapid duplicate feedback sends while delivery is pending", async () => {
    let resolveSend!: (value: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    render(<Composer {...composerProps({ hasFeedback: true, onSend })} />);
    const send = screen.getByRole("button", { name: "Send feedback and optional prompt" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
    await act(async () => resolveSend(true));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("allows another thread to send while preserving each thread's duplicate-send guard", async () => {
    let finishA!: (value: boolean) => void;
    let finishB!: (value: boolean) => void;
    const sendA = vi.fn(() => new Promise<boolean>((resolve) => { finishA = resolve; }));
    const sendB = vi.fn(() => new Promise<boolean>((resolve) => { finishB = resolve; }));
    const { rerender } = render(<Composer {...composerProps({ hasFeedback: true, onSend: sendA })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
    rerender(<Composer {...composerProps({ threadKey: "thread-b", hasFeedback: true, onSend: sendB })} />);
    const button = screen.getByRole("button", { name: "Send feedback and optional prompt" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(sendB).toHaveBeenCalledTimes(1);
    await act(async () => finishA(true));
    expect(button).toBeDisabled();
    await act(async () => finishB(true));
    expect(button).toBeEnabled();
    expect(sendA).toHaveBeenCalledTimes(1);
  });

  it("keeps drafts in both threads when a feedback send fails after navigation", async () => {
    let resolveSend!: (value: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    const props = composerProps({ hasFeedback: true, feedbackTray: <div>Pending note</div>, onSend });
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "A request" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
    fireEvent.change(textarea, { target: { value: "A newer draft" } });
    rerender(<Composer {...props} threadKey="thread-b" />);
    fireEvent.change(textarea, { target: { value: "B draft" } });
    await act(async () => resolveSend(false));
    expect(textarea).toHaveValue("B draft");
    expect(draftFor("thread-b")).toBe("B draft");
    expect(draftFor("thread-a")).toBe("A request\n\nA newer draft");
    rerender(<Composer {...props} threadKey="thread-a" />);
    expect(textarea).toHaveValue("A request\n\nA newer draft");
  });

  it("keeps both the failed text and a draft typed while the send was in flight", async () => {
    let resolveSend!: (value: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    render(<Composer {...composerProps({ onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "second draft" } });
    resolveSend(false);
    await waitFor(() => expect(textarea).toHaveValue("first message\n\nsecond draft"));
    expect(draftFor("thread-a")).toBe("first message\n\nsecond draft");
  });

  it("persists drafts per thread and restores them on switch", async () => {
    const props = composerProps();
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "draft for A" } });

    rerender(<Composer {...props} threadKey="thread-b" />);
    expect(screen.getByPlaceholderText("Ask anything")).toHaveValue("");

    rerender(<Composer {...props} threadKey="thread-a" />);
    expect(screen.getByPlaceholderText("Ask anything")).toHaveValue("draft for A");
    expect(draftFor("thread-a")).toBe("draft for A");
  });

  it("does not evict a main composer draft when an inline queue edit is typed", () => {
    const existing = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`thread-${index}`, `draft ${index}`]));
    localStorage.setItem("kiwi.drafts", JSON.stringify(existing));
    resetDraftStoreForTests();
    render(<Composer {...composerProps({
      queuedTurns: [{ ...QUEUED, editing: true }],
      onFinishEditQueued: vi.fn(() => true),
    })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit queued message 1" }), { target: { value: "Changed queue text" } });
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("kiwi.drafts")!)).toMatchObject(existing);
  });

  it("queues by default and offers explicit steering while a task runs", async () => {
    const onSend = vi.fn(async () => true);
    const onSteer = vi.fn(async () => true);
    render(<Composer {...composerProps({ running: true, queueing: true, onSend, onSteer })} />);
    expect(screen.getByText("Enter queues")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop the active task and its sub-agents")).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "next task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("next task"));
    expect(onSteer).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "change direction" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("change direction"));
  });

  it("offers stop but does not submit another message while a first turn is still starting", () => {
    // A draft thread has no turn to steer and nothing to queue behind yet, so
    // the running chrome must not promise either or start a second thread.
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ running: true, queueing: false, onSend })} />);
    expect(screen.getByLabelText("Stop the active task and its sub-agents")).toBeInTheDocument();
    expect(screen.queryByText("Enter queues")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "send after startup" } });
    expect(screen.getByTitle("Wait for the first turn to start")).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("send after startup");
  });

  const QUEUED = {
    id: "queued-1",
    threadId: "thread-a",
    text: "run the follow-up",
    attachments: [],
    createdAt: 0,
    status: "queued" as const,
  };

  it("keeps Queue available but disables every steering action while the response is being written", async () => {
    const onSend = vi.fn(async () => true);
    const onSteer = vi.fn(async () => true);
    const onSteerQueued = vi.fn();
    render(<Composer {...composerProps({
      running: true,
      queueing: true,
      canSteer: false,
      queuedTurns: [QUEUED],
      onSend,
      onSteer,
      onSteerQueued,
    })} />);

    expect(screen.getByText("Enter queues")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    expect(screen.queryByLabelText("Steer queued message 1 now")).not.toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "follow up after this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("follow up after this"));
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSteerQueued).not.toHaveBeenCalled();
  });

  it("says a queued turn runs next while a task is running", () => {
    render(<Composer {...composerProps({ running: true, queueing: true, queuedTurns: [QUEUED], onRetryQueued: vi.fn(), onSteerQueued: vi.fn() })} />);
    expect(screen.getByRole("list", { name: "Queued follow-up messages" })).toBeInTheDocument();
    expect(screen.getByText("Runs after the active turn")).toBeInTheDocument();
    expect(screen.getByLabelText("Steer queued message 1 now")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start queued message 1")).not.toBeInTheDocument();
  });

  it("lets a queued turn be started by hand once nothing is running", () => {
    const onRetryQueued = vi.fn();
    render(<Composer {...composerProps({ running: false, queueing: false, queuedTurns: [QUEUED], onRetryQueued, onSteerQueued: vi.fn() })} />);
    expect(screen.getByText("Waiting — start it now or remove it")).toBeInTheDocument();
    expect(screen.queryByLabelText("Steer queued message 1 now")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Start queued message 1"));
    expect(onRetryQueued).toHaveBeenCalledWith("queued-1");
  });

  it("only offers Start for the FIFO head while later messages wait behind it", () => {
    const onRetryQueued = vi.fn();
    const second = { ...QUEUED, id: "queued-2", text: "second follow-up" };
    render(<Composer {...composerProps({ running: false, queueing: false, queuedTurns: [QUEUED, second], onRetryQueued })} />);

    expect(screen.getByLabelText("Start queued message 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start queued message 2")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting behind an earlier message")).toBeInTheDocument();
  });

  it("grows with a long prompt until twice its base height, then scrolls", () => {
    render(<Composer {...composerProps()} />);
    const textarea = screen.getByPlaceholderText("Ask anything");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 118 });
    fireEvent.change(textarea, { target: { value: "A prompt long enough to wrap across several lines." } });
    expect(textarea).toHaveStyle({ height: "118px", overflowY: "hidden" });

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 260 });
    fireEvent.change(textarea, { target: { value: "An even longer prompt that needs more room than the expanded composer allows." } });
    expect(textarea).toHaveStyle({ height: `${COMPOSER_INPUT_MAX_HEIGHT}px`, overflowY: "auto" });
  });

  it("remeasures a wrapped draft when the live chat typeface changes", () => {
    const props = composerProps();
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 118 });

    rerender(<Composer {...props} chatFont="serif" />);

    expect(textarea).toHaveStyle({ height: "118px", overflowY: "hidden" });
  });

  it("mounts a long prompt's mention overlay at the textarea's current scroll position and width", () => {
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }] })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, value: 260 },
      offsetWidth: { configurable: true, value: 400 },
      clientWidth: { configurable: true, value: 390 },
    });
    textarea.scrollTop = 72;
    textarea.scrollLeft = 3;

    fireEvent.change(textarea, {
      target: { value: `${"A long prompt line. ".repeat(20)}Use @hatch-pet` },
    });

    const highlight = document.querySelector<HTMLDivElement>(".composer-input-highlight");
    expect(highlight).not.toBeNull();
    expect(highlight!.scrollTop).toBe(72);
    expect(highlight!.scrollLeft).toBe(3);
    expect(highlight!.style.getPropertyValue("--composer-scrollbar-gutter")).toBe("10px");
  });

  it("keeps the mention overlay synchronized when the textarea scrolls", () => {
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }] })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Use @hatch-pet in this long prompt" } });
    const highlight = document.querySelector<HTMLDivElement>(".composer-input-highlight");
    expect(highlight).not.toBeNull();

    textarea.scrollTop = 45;
    textarea.scrollLeft = 2;
    fireEvent.scroll(textarea);

    expect(highlight!.scrollTop).toBe(45);
    expect(highlight!.scrollLeft).toBe(2);
  });

  it("keeps the overlay's trailing empty line out of the submitted draft", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }], onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Use @hatch-pet\n" } });

    const highlight = document.querySelector<HTMLDivElement>(".composer-input-highlight");
    expect(highlight?.textContent?.endsWith("\u200b")).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Use @hatch-pet"));
  });

  it("opens enabled skills on @, filters them, and inserts a blue skill token", async () => {
    render(<Composer {...composerProps({
      skills: [
        { name: "release-check", description: "Verify a release" },
        { name: "hatch-pet", description: "Build an animated pet" },
      ],
    })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Use @" } });
    expect(screen.getByRole("listbox", { name: "Mention suggestions" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /release-check/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /hatch-pet/i })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "Use @hat" } });
    expect(screen.queryByRole("option", { name: /release-check/i })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("option", { name: /hatch-pet/i }));

    expect(textarea).toHaveValue("Use @hatch-pet ");
    expect(document.querySelector(".composer-skill-token")).toHaveTextContent("@hatch-pet");
    expect(textarea).toHaveClass("has-skill-mentions");
  });

  it("keeps @file autocomplete alongside skill suggestions after typing", async () => {
    const searchFiles = vi.fn(async () => ["src/hatch.ts"]);
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }], searchFiles })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Check @hat" } });
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith("hat"));
    await waitFor(() => expect(screen.getByRole("option", { name: /src\/hatch.ts/i })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /hatch-pet/i })).toBeInTheDocument();
  });

  it("treats @ as a mention only at the start of a word", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }], onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");

    fireEvent.change(textarea, { target: { value: "mail me at morgan@hat" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.querySelector(".composer-skill-token")).toBeNull();
    // Enter still sends rather than accepting a suggestion the user never saw.
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("mail me at morgan@hat"));
  });

  it("keeps a mention anchored to its leading space when accepted", () => {
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }] })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "please run @hat" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /hatch-pet/i }));
    expect(textarea).toHaveValue("please run @hatch-pet ");
  });

  it("announces the highlighted suggestion to assistive tech", () => {
    render(<Composer {...composerProps({ skills: [{ name: "release-check" }, { name: "hatch-pet" }] })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    expect(textarea).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(textarea, { target: { value: "Use @" } });
    const listbox = screen.getByRole("listbox", { name: "Mention suggestions" });
    expect(textarea).toHaveAttribute("aria-expanded", "true");
    expect(textarea).toHaveAttribute("aria-controls", listbox.id);
    const [first, second] = screen.getAllByRole("option");
    expect(textarea).toHaveAttribute("aria-activedescendant", first.id);

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute("aria-activedescendant", second.id);
  });

  it("keeps the menu closed when a dismissed query's file search lands late", async () => {
    // The debounced lookup from the last keystroke must not resurrect a menu
    // the user escaped, nor one that accepting a suggestion just closed.
    const searchFiles = vi.fn(async () => ["src/hatch.ts"]);
    render(<Composer {...composerProps({ skills: [{ name: "hatch-pet" }], searchFiles })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");

    fireEvent.change(textarea, { target: { value: "Check @hat" } });
    expect(screen.getByRole("listbox", { name: "Mention suggestions" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(searchFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("treats punctuation and whitespace around ! as literal draft text", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Composer {...composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow, onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Please review!" } });
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "Please review !" } });
    expect(screen.getByRole("listbox", { name: "Workflow suggestions" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Please review !"));
    expect(onWorkflow).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "! " } });
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    expect(textarea).toHaveValue("! ");
  });

  it("requires explicit navigation before Enter selects a workflow", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Composer {...composerProps({
      workflows: [{ id: "review", name: "Review" }, { id: "release", name: "Release" }],
      onWorkflow,
      onSend,
    })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!review" } });
    const first = screen.getByRole("option", { name: /Review/i });
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(screen.queryByRole("button", { name: "Remove workflow Review" })).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(screen.queryByRole("button", { name: "Remove workflow Review" })).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onWorkflow).toHaveBeenCalledWith("review", ""));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the selected chip and note after a canceled launch, then clears both on success", async () => {
    const onWorkflow = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Composer {...composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Inspect !rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    expect(textarea).toHaveValue("Inspect ");
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow Review" }));
    await waitFor(() => expect(onWorkflow).toHaveBeenCalledWith("review", "Inspect"));
    expect(textarea).toHaveValue("Inspect ");
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow Review" }));
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "Remove workflow Review" })).not.toBeInTheDocument();
  });

  it("keeps a review-pending selection visible and blocks duplicate launches", async () => {
    let finishReview!: (value: boolean) => void;
    const onWorkflow = vi.fn(() => new Promise<boolean>((resolve) => { finishReview = resolve; }));
    render(<Composer {...composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.change(textarea, { target: { value: "Preserve this note" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow Review" }));
    expect(onWorkflow).toHaveBeenCalledWith("review", "Preserve this note");
    expect(textarea).toHaveValue("Preserve this note");
    expect(textarea).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run workflow Review" })).toBeDisabled();
    await act(async () => finishReview(false));
    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue("Preserve this note");
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
    expect(onWorkflow).toHaveBeenCalledTimes(1);
  });

  it("preserves newer source and other-thread drafts when a pending workflow succeeds", async () => {
    let finishReview!: (value: boolean) => void;
    const onWorkflow = vi.fn(() => new Promise<boolean>((resolve) => { finishReview = resolve; }));
    const props = composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow });
    const ref = createRef<ComposerHandle>();
    const { rerender } = render(<Composer ref={ref} {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.change(textarea, { target: { value: "Submitted note" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow Review" }));
    act(() => ref.current?.setDraft("Newer source draft"));
    rerender(<Composer ref={ref} {...props} threadKey="thread-b" />);
    fireEvent.change(textarea, { target: { value: "Other thread draft" } });
    await act(async () => finishReview(true));
    expect(textarea).toHaveValue("Other thread draft");
    expect(draftFor("thread-a")).toBe("Newer source draft");
    expect(draftFor("thread-b")).toBe("Other thread draft");
    rerender(<Composer ref={ref} {...props} threadKey="thread-a" />);
    expect(textarea).toHaveValue("Newer source draft");
  });

  it("keeps each thread's explicit workflow selection separate", () => {
    const props = composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow: vi.fn(async () => false) });
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.change(textarea, { target: { value: "Thread A note" } });
    rerender(<Composer {...props} threadKey="thread-b" />);
    expect(screen.queryByRole("button", { name: "Remove workflow Review" })).not.toBeInTheDocument();
    expect(textarea).toHaveValue("");
    fireEvent.change(textarea, { target: { value: "Thread B draft" } });
    rerender(<Composer {...props} threadKey="thread-a" />);
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
    expect(textarea).toHaveValue("Thread A note");
  });

  it("removes a selected workflow without discarding its note", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Composer {...composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow, onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Write note !rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove workflow Review" }));
    expect(textarea).toHaveValue("Write note ");
    expect(screen.queryByRole("button", { name: "Run workflow Review" })).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Write note"));
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("does not turn a pasted exact workflow token into a launch", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Composer {...composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow, onSend })} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.paste(textarea, { clipboardData: { items: [] } });
    fireEvent.change(textarea, { target: { value: "!Review" } });
    expect(screen.getByRole("listbox", { name: "Workflow suggestions" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("!Review"));
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("does not offer or launch workflows with attachments, feedback, or a queued turn", () => {
    const onWorkflow = vi.fn(async () => true);
    const base = composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow });
    const { rerender } = render(<Composer {...base} attachments={[{ path: "/tmp/context", name: "context", kind: "file" }]} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!" } });
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    rerender(<Composer {...base} hasFeedback />);
    fireEvent.change(textarea, { target: { value: "!rev" } });
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    rerender(<Composer {...base} running queueing />);
    fireEvent.change(textarea, { target: { value: "!" } });
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("keeps a selected workflow and draft when attachments arrive before launch", () => {
    const onWorkflow = vi.fn(async () => true);
    const props = composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow });
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.change(textarea, { target: { value: "Keep this note" } });
    rerender(<Composer {...props} attachments={[{ path: "/tmp/context", name: "context", kind: "file" }]} />);
    const run = screen.getByRole("button", { name: "Run workflow Review" });
    expect(run).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onWorkflow).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Keep this note");
    expect(screen.getByRole("button", { name: "Remove workflow Review" })).toBeInTheDocument();
  });

  it("disables both launch and steering if the selected thread begins running", () => {
    const onWorkflow = vi.fn(async () => true);
    const props = composerProps({ workflows: [{ id: "review", name: "Review" }], onWorkflow });
    const { rerender } = render(<Composer {...props} />);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "!rev" } });
    fireEvent.click(screen.getByRole("option", { name: /Review/i }));
    fireEvent.change(textarea, { target: { value: "Keep this note" } });
    rerender(<Composer {...props} running queueing />);
    expect(screen.getByRole("button", { name: "Run workflow Review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    expect(textarea).toHaveValue("Keep this note");
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("keeps Stop available while children outlive their parent turn", () => {
    const onStop = vi.fn();
    render(<Composer {...composerProps({ running: false, childrenRunning: true, onStop })} />);
    const stop = screen.getByLabelText("Stop the sub-agents still running for this thread");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
    // Nothing is running here, so the composer still accepts a new message.
    expect(screen.queryByText("Enter queues")).not.toBeInTheDocument();
  });

  it("offers no Stop when neither the turn nor any child is live", () => {
    render(<Composer {...composerProps({ running: false, childrenRunning: false })} />);
    expect(screen.queryByRole("button", { name: /^Stop the/ })).not.toBeInTheDocument();
  });
});
