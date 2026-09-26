import { useEffect, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { parseDiffSections } from "../lib/gitDiff";
import { formatFeedbackPrompt, type FeedbackAnchor, type FeedbackNote } from "../lib/reviewFeedback";
import { ChatTimeline } from "./ChatTimeline";
import { Composer } from "./Composer";
import { DiffFileSections } from "./DiffView";
import { FeedbackProvider } from "./FeedbackProvider";
import { FeedbackTray } from "./FeedbackTray";
import "../styles.css";

const PATCH = [
  "diff --git a/src/view.ts b/src/view.ts",
  "--- a/src/view.ts",
  "+++ b/src/view.ts",
  "@@ -7,1 +7,2 @@",
  "-old line",
  "+added line",
  "+second line",
].join("\n");

function selectText(node: Text, start: number, end: number, pointerUp = true) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (pointerUp) node.parentElement?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

function MountSentinel({ onMount }: { onMount?: () => void }) {
  useEffect(() => { onMount?.(); }, [onMount]);
  return <div data-testid="mounted-child" />;
}

function BrowserFeedbackShell({ source, scopeKey = "browser-test", onAdded, onChildMount, showFocusDestination = false }: {
  source: "assistant" | "diff";
  scopeKey?: string;
  onAdded: (anchor: FeedbackAnchor, comment: string) => void;
  onChildMount?: () => void;
  showFocusDestination?: boolean;
}) {
  const [notes, setNotes] = useState<FeedbackNote[]>([]);
  return (
    <div className="app-shell" data-theme={source === "diff" ? "light-mythra" : "mythra"} data-color-scheme={source === "diff" ? "light" : "dark"} style={{ display: "block", width: 280, minHeight: 420, zoom: 1.5, padding: 8, boxSizing: "border-box" }}>
      <FeedbackProvider enabled scopeKey={scopeKey} onAdd={(anchor, comment) => {
        onAdded(anchor, comment);
        setNotes((current) => [...current, { id: String(current.length + 1), anchor, comment, createdAt: Date.now() }]);
        return true;
      }}>
        <MountSentinel onMount={onChildMount} />
        {showFocusDestination && <button type="button" data-testid="focus-after">Focus destination</button>}
        {source === "assistant" ? (
          <div style={{ height: 270, display: "flex", minHeight: 0 }}>
            <ChatTimeline
              messages={[{ id: "answer-1", role: "assistant", text: "The important paragraph has a targeted phrase for review.\n\nThe rest of the reply explains how the change works and what to verify." }]}
              activities={[]}
              running={false}
              thinkingLabel="Working"
              provider="openai"
            />
          </div>
        ) : (
          <DiffFileSections
            sections={parseDiffSections(PATCH)}
            readOnly
            feedbackDiff={{ source: "repository", baseline: "HEAD" }}
            onPathAction={() => {}}
          />
        )}
        <Composer
          threadKey={scopeKey}
          chatFont="system"
          running={false}
          queueing={false}
          canSteer={false}
          dropActive={false}
          placeholder="Add a message (optional)…"
          attachments={[]}
          controls={null}
          hasFeedback={notes.length > 0}
          feedbackTray={<FeedbackTray notes={notes} onUpdate={() => {}} onRemove={(id) => setNotes((current) => current.filter((note) => note.id !== id))} />}
          onRemoveAttachment={() => {}}
          onPasteImages={() => {}}
          onSend={async () => true}
          onSteer={async () => true}
          onStop={() => {}}
        />
      </FeedbackProvider>
    </div>
  );
}

function expectInsideViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(7);
  expect(rect.top).toBeGreaterThanOrEqual(7);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 7);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - 7);
}

async function waitForSelectionButtonToReceivePointer(button: HTMLElement) {
  // The button can enter the accessibility tree before its float reaches the
  // browser top layer. Wait for the actual hit target, not just DOM presence.
  await waitFor(() => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(hit && button.contains(hit)).toBe(true);
  });
}

async function waitForEditorPaint(dialog: Element) {
  await waitFor(() => expect(Number.parseFloat(getComputedStyle(dialog).opacity)).toBeGreaterThan(.99));
}

async function waitForTrayPaint() {
  await waitFor(() => expect(document.querySelector(".feedback-editor-float")).toBeNull());
  await new Promise((resolve) => window.setTimeout(resolve, 320));
}

describe("review feedback in a real browser", () => {
  afterEach(async () => {
    document.body.style.removeProperty("background");
    await page.viewport(1400, 900);
  });

  it("stages the selected assistant phrase and keeps the float within the viewport at 150% zoom", async () => {
    await page.viewport(420, 700);
    const added = vi.fn();
    render(<BrowserFeedbackShell source="assistant" onAdded={added} />);
    const paragraph = document.querySelector<HTMLElement>("[data-feedback-message='answer-1'] p");
    expect(paragraph).not.toBeNull();
    const text = paragraph!.firstChild as Text;
    const start = text.textContent!.indexOf("targeted phrase");
    expect(start).toBeGreaterThan(0);
    selectText(text, start, start + "targeted phrase".length);

    const selectionButton = await screen.findByRole("button", { name: "Add feedback on the selection" });
    expectInsideViewport(selectionButton);
    await waitForSelectionButtonToReceivePointer(selectionButton);
    await userEvent.click(selectionButton);
    const dialog = await screen.findByRole("dialog", { name: "Add feedback" });
    expectInsideViewport(dialog);
    expect(dialog).toHaveTextContent("targeted phrase");
    await waitForEditorPaint(dialog);
    await page.screenshot({ path: "../../test-results/feedback-assistant-note-editor-dark.png" });
    await userEvent.fill(screen.getByRole("textbox", { name: "Feedback note" }), "Make this clearer");
    // Inspect the synchronous close frame before the 180 ms exit animation
    // removes the float: the retained dialog must be inert and hidden to AT.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const exiting = document.querySelector<HTMLElement>(".feedback-editor-float");
    expect(exiting).not.toBeNull();
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    expect(exiting).toHaveAttribute("inert");
    await waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(added.mock.calls[0][0]).toMatchObject({ kind: "assistant", messageId: "answer-1", quote: "targeted phrase" });
    expect(screen.getByRole("listitem")).toHaveTextContent("Make this clearer");
    await waitForTrayPaint();
    await page.screenshot({ path: "../../test-results/feedback-assistant-tray-dark.png" });
  });

  it("stages a selected diff line with the new-side path and line number", async () => {
    await page.viewport(420, 700);
    document.body.style.background = "#f5f7f6";
    const added = vi.fn();
    render(<BrowserFeedbackShell source="diff" onAdded={added} />);
    const addedLine = Array.from(document.querySelectorAll<HTMLElement>("[data-feedback-diff] > span"))
      .find((line) => line.textContent?.startsWith("+added line"));
    expect(addedLine).toBeDefined();
    const diffView = addedLine!.parentElement!;
    expect(getComputedStyle(diffView).contentVisibility).toBe("auto");
    const text = addedLine!.firstChild as Text;
    selectText(text, 1, 6);
    const selectionButton = await screen.findByRole("button", { name: "Add feedback on the selection" });
    expect(getComputedStyle(diffView).contentVisibility).toBe("visible");
    await waitForSelectionButtonToReceivePointer(selectionButton);
    await userEvent.click(selectionButton);
    const dialog = await screen.findByRole("dialog", { name: "Add feedback" });
    expect(getComputedStyle(diffView).contentVisibility).toBe("auto");
    expectInsideViewport(dialog);
    expect(dialog).toHaveTextContent("added line");
    await waitForEditorPaint(dialog);
    await page.screenshot({ path: "../../test-results/feedback-diff-note-editor-light.png" });
    await userEvent.fill(screen.getByRole("textbox", { name: "Feedback note" }), "Handle the edge case");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(added.mock.calls[0][0]).toMatchObject({ kind: "diff", path: "src/view.ts", side: "new", newLine: 7, quote: "added line" });
    expect(screen.getByRole("listitem")).toHaveTextContent("Handle the edge case");
    await waitForTrayPaint();
    await page.screenshot({ path: "../../test-results/feedback-diff-tray-light.png" });
  });

  it("preserves patch markers when a selection spans removed and added lines", async () => {
    await page.viewport(420, 700);
    const added = vi.fn();
    render(<BrowserFeedbackShell source="diff" onAdded={added} />);
    const spans = Array.from(document.querySelectorAll<HTMLElement>("[data-feedback-diff] > span"));
    const removed = spans.find((line) => line.textContent?.startsWith("-old line"))!;
    const addedLine = spans.find((line) => line.textContent?.startsWith("+added line"))!;
    const range = document.createRange();
    range.setStart(removed.firstChild!, 0);
    range.setEnd(addedLine.firstChild!, "+added line".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    addedLine.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const selectionButton = await screen.findByRole("button", { name: "Add feedback on the selection" });
    await waitForSelectionButtonToReceivePointer(selectionButton);
    await userEvent.click(selectionButton);
    await userEvent.fill(screen.getByRole("textbox", { name: "Feedback note" }), "Review both sides");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    const anchor = added.mock.calls[0][0] as FeedbackAnchor;
    expect(anchor).toMatchObject({ kind: "diff", side: "old", oldLine: 7, quote: "-old line\n+added line" });
    const prompt = formatFeedbackPrompt("", [{ id: "1", anchor, comment: "Review both sides", createdAt: 1 }]);
    expect(prompt).toContain("starts on old side");
    expect(prompt).toContain("Selected patch:");
  });

  it("does not steal focus after Shift+Tab on an old selection, but offers feedback after Shift+Arrow selection", async () => {
    await page.viewport(420, 700);
    render(<BrowserFeedbackShell source="assistant" onAdded={vi.fn()} showFocusDestination />);
    const paragraph = document.querySelector<HTMLElement>("[data-feedback-message='answer-1'] p")!;
    const text = paragraph.firstChild as Text;
    const old = document.createRange();
    old.setStart(text, 0);
    old.setEnd(text, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(old);
    const destination = screen.getByTestId("focus-after");
    destination.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).not.toHaveAttribute("aria-label", "Add feedback on the selection");
    expect(screen.queryByRole("button", { name: "Add feedback on the selection" })).not.toBeInTheDocument();

    const collapsed = document.createRange();
    collapsed.setStart(text, 0);
    collapsed.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(collapsed);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    selectText(text, 0, 8, false);
    // Focus must follow the committed float. A frame can run before React
    // mounts it under load, so hold frame callbacks during this gesture.
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    try {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-label", "Add feedback on the selection"));
    } finally {
      frame.mockRestore();
    }
  });

  it("does not reopen an old selection action after clicking elsewhere", async () => {
    await page.viewport(420, 700);
    render(<BrowserFeedbackShell source="assistant" onAdded={vi.fn()} showFocusDestination />);
    const paragraph = document.querySelector<HTMLElement>("[data-feedback-message='answer-1'] p")!;
    selectText(paragraph.firstChild as Text, 0, 8);
    await screen.findByRole("button", { name: "Add feedback on the selection" });
    const destination = screen.getByTestId("focus-after");
    fireEvent.pointerDown(destination);
    fireEvent.pointerUp(destination);
    expect(window.getSelection()?.isCollapsed).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Add feedback on the selection" })).not.toBeInTheDocument();
  });

  it("closes an old scope editor without remounting children or sending its draft", async () => {
    await page.viewport(420, 700);
    const added = vi.fn();
    const mounted = vi.fn();
    const { rerender } = render(<BrowserFeedbackShell source="assistant" scopeKey="one" onAdded={added} onChildMount={mounted} />);
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Feedback note" }), "Old scope draft");
    const oldAdd = screen.getByRole("button", { name: "Add" });
    rerender(<BrowserFeedbackShell source="assistant" scopeKey="two" onAdded={added} onChildMount={mounted} />);
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(oldAdd);
    expect(added).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add feedback" })).not.toBeInTheDocument());
    const exiting = document.querySelector<HTMLElement>(".feedback-editor-float");
    if (exiting) {
      expect(exiting).toHaveAttribute("aria-hidden", "true");
      expect(exiting).toHaveAttribute("inert");
    }
  });
});
