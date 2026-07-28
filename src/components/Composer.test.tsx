import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { COMPOSER_INPUT_MAX_HEIGHT, Composer, draftFor, resetDraftStoreForTests } from "./Composer";

function composerProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}): Parameters<typeof Composer>[0] {
  return {
    threadKey: "thread-a",
    running: false,
    steering: false,
    dropActive: false,
    placeholder: "Ask anything",
    attachments: [],
    controls: null,
    onRemoveAttachment: vi.fn(),
    onPasteImages: vi.fn(),
    onSend: vi.fn(async () => true),
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

  it("shows the steering hint while a task runs", () => {
    render(<Composer {...composerProps({ running: true, steering: true })} />);
    expect(screen.getByText("Steering active task")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop the active task")).toBeInTheDocument();
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
});
