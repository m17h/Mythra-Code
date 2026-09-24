import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, draftFor, resetDraftStoreForTests } from "./Composer";
import "../styles.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const workflows = [
  { id: "review", name: "Review branch", description: "Review changes in a new thread" },
  { id: "release", name: "Release checks", description: "Check release readiness" },
];

function Fixture({
  onSend = vi.fn(async () => true),
  onWorkflow = vi.fn(async () => true),
  threadKey = "workflow-a",
  compact = false,
}: {
  onSend?: (text: string) => Promise<boolean>;
  onWorkflow?: (id: string, prompt: string) => Promise<boolean>;
  threadKey?: string;
  compact?: boolean;
}) {
  return <div className="app-shell" data-theme="mythra" style={compact
    ? { position: "fixed", bottom: 4, left: 4, width: 340, height: "auto", display: "block" }
    : { width: 650, height: "auto", display: "block" }}>
    <Composer threadKey={threadKey} chatFont="system" running={false} queueing={false} canSteer={false}
      dropActive={false} placeholder="Workflow draft" attachments={[]} controls={null}
      workflows={workflows} onWorkflow={onWorkflow}
      onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={onSend}
      onSteer={async () => true} onStop={() => {}} />
  </div>;
}

beforeEach(() => {
  localStorage.clear();
  resetDraftStoreForTests();
});

describe("workflow composer in a real browser", () => {
  it("sends a trailing ! literally without accepting the first suggested recipe", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Fixture onSend={onSend} onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!");
    expect(screen.getByRole("listbox", { name: "Workflow suggestions" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("!"));
    expect(onWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Remove workflow/ })).not.toBeInTheDocument();
  });

  it("lets Space dismiss ! suggestions and keeps the punctuation as ordinary text", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Fixture onSend={onSend} onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!");
    await userEvent.keyboard(" ");
    expect(input).toHaveValue("! ");
    expect(screen.queryByRole("listbox", { name: "Workflow suggestions" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("!"));
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("treats an exact typed or imported !name as prompt text until explicitly selected", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Fixture onSend={onSend} onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!Review branch");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("!Review branch"));
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it("selects with an arrow and Enter without sending, then keeps the chip and note after cancellation", async () => {
    let cancel!: (accepted: boolean) => void;
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(() => new Promise<boolean>((resolve) => { cancel = resolve; }));
    render(<Fixture onSend={onSend} onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!Review");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(onWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove workflow Review branch" })).toBeVisible();
    await userEvent.fill(input, "Please focus on the tests");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onWorkflow).toHaveBeenCalledWith("review", "Please focus on the tests"));
    expect(input).toHaveValue("Please focus on the tests");
    await act(async () => cancel(false));
    expect(input).toHaveValue("Please focus on the tests");
    expect(draftFor("workflow-a")).toBe("Please focus on the tests");
    expect(screen.getByRole("button", { name: "Remove workflow Review branch" })).toBeVisible();
  });

  it("clears the source selection after launch while preserving another thread's draft", async () => {
    let launch!: (accepted: boolean) => void;
    const onWorkflow = vi.fn(() => new Promise<boolean>((resolve) => { launch = resolve; }));
    const view = render(<Fixture onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!Review");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await userEvent.fill(input, "Focus on the test suite");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onWorkflow).toHaveBeenCalledWith("review", "Focus on the test suite"));
    view.rerender(<Fixture onWorkflow={onWorkflow} threadKey="workflow-b" />);
    await userEvent.fill(input, "Unrelated B draft");
    await act(async () => launch(true));
    expect(input).toHaveValue("Unrelated B draft");
    expect(draftFor("workflow-b")).toBe("Unrelated B draft");
    expect(draftFor("workflow-a")).toBe("");
    view.rerender(<Fixture onWorkflow={onWorkflow} />);
    expect(input).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Remove workflow/ })).not.toBeInTheDocument();
  });

  it("does not accept a suggestion during IME composition and inserts a line on Shift+Enter", async () => {
    const onSend = vi.fn(async () => true);
    const onWorkflow = vi.fn(async () => true);
    render(<Fixture onSend={onSend} onWorkflow={onWorkflow} />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!Review");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(screen.getByRole("listbox", { name: "Workflow suggestions" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Remove workflow/ })).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(onWorkflow).not.toHaveBeenCalled();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("!Review\n");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the ! suggestion popup within a short viewport", async () => {
    await page.viewport(420, 340);
    render(<Fixture compact />);
    const input = screen.getByPlaceholderText("Workflow draft");
    await userEvent.fill(input, "!");
    const popup = screen.getByRole("listbox", { name: "Workflow suggestions" });
    await waitFor(() => expect(popup).toBeVisible());
    const rect = popup.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});
