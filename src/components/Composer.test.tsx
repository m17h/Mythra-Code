import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { COMPOSER_INPUT_MAX_HEIGHT, Composer, draftFor, resetDraftStoreForTests } from "./Composer";

function composerProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}): Parameters<typeof Composer>[0] {
  return {
    threadKey: "thread-a",
    running: false,
    queueing: false,
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
