import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ChatTimeline, TIMELINE_MOUNT_ROWS } from "./ChatTimeline";
import type { Activity, ChatMessage } from "../types";
import "../styles.css";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

const messages: ChatMessage[] = Array.from({ length: TIMELINE_MOUNT_ROWS * 2 + 3 }, (_, index) => ({
  id: `message-${index}`,
  role: "user",
  text: `Archived message ${String(index + 1).padStart(3, "0")}: a unique, copyable piece of the conversation.`,
  timelineOrder: index,
}));

function Shell({
  displayedMessages = messages,
  activities = [],
  searchQuery,
  onSearchMatches,
}: {
  displayedMessages?: ChatMessage[];
  activities?: Activity[];
  searchQuery?: string;
  onSearchMatches?: (count: number) => void;
}) {
  return <div className="app-shell" data-theme="kiwi" style={{ width: 760, height: 480 }}>
    <ChatTimeline messages={displayedMessages} activities={activities} running={false}
      thinkingLabel="Working" provider="claude" searchQuery={searchQuery} onSearchMatches={onSearchMatches} />
  </div>;
}

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
});

describe("performance UX contracts in a real browser", () => {
  it("keeps a long transcript bounded while keyboard, copy, and search still reach old content", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const matches = vi.fn();
    const view = render(<Shell onSearchMatches={matches} />);
    const mounted = () => view.container.querySelectorAll("[data-entry-index]");
    expect(mounted()).toHaveLength(TIMELINE_MOUNT_ROWS);
    expect(view.container.textContent).toContain("Archived message 083");
    expect(view.container.textContent).not.toContain("Archived message 001");

    // A small DOM is useful only if every loaded message remains reachable.
    let checkedDelayedRestore = false;
    while (screen.queryByTestId("reveal-earlier")) {
      const button = screen.getByTestId("reveal-earlier");
      button.focus();
      expect(button).toHaveFocus();
      expect(getComputedStyle(button).outlineStyle).not.toBe("none");
      const firstMounted = mounted()[0] as HTMLElement;
      const anchoredTop = firstMounted.getBoundingClientRect().top;
      const beforeCount = mounted().length;
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(mounted().length).toBeGreaterThan(beforeCount));
      const expandedCount = mounted().length;
      expect(Math.abs(firstMounted.getBoundingClientRect().top - anchoredTop)).toBeLessThanOrEqual(2);
      let scrollerToRearm: HTMLElement | null = null;
      if (!checkedDelayedRestore && beforeCount === TIMELINE_MOUNT_ROWS) {
        const scroller = view.container.querySelector<HTMLElement>("[data-testid=timeline-scroller]")!;
        // WebKit can deliver the scroll event from scrollTop restoration after
        // the synchronous prepend handler has finished. It must not look like
        // the reader manually reached the live edge and discard the new rows.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        fireEvent.pointerDown(firstMounted, { button: 0 });
        const restoredTop = scroller.scrollTop;
        fireEvent.wheel(scroller, { deltaY: -120 });
        expect(scroller.scrollTop).toBe(restoredTop);
        fireEvent.scroll(scroller);
        await waitFor(() => expect(mounted()).toHaveLength(expandedCount));
        expect(firstMounted.isConnected).toBe(true);
        fireEvent.pointerUp(document, { button: 0 });
        scroller.scrollTop = Math.max(0, restoredTop - 80);
        fireEvent.scroll(scroller);
        await waitFor(() => expect(mounted()).toHaveLength(expandedCount));
        expect(scroller.scrollTop).toBeLessThan(restoredTop);
        scrollerToRearm = scroller;
        checkedDelayedRestore = true;
      }
      if (scrollerToRearm) {
        // Once the gesture moved the reader, a real return to the end should
        // re-arm follow and restore the bounded suffix as before.
        scrollerToRearm.scrollTop = scrollerToRearm.scrollHeight;
        fireEvent.scroll(scrollerToRearm);
        await waitFor(() => expect(mounted()).toHaveLength(TIMELINE_MOUNT_ROWS));
      }
    }
    expect(mounted()).toHaveLength(messages.length);
    const oldest = view.container.querySelector<HTMLElement>('[data-entry-index="0"]')!;
    expect(oldest.textContent).toContain("Archived message 001");
    const copy = within(oldest).getByRole("button", { name: "Copy" });
    copy.focus();
    await userEvent.keyboard("{Enter}");
    expect(write).toHaveBeenCalledWith(messages[0].text);

    await userEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));
    await waitFor(() => expect(mounted()).toHaveLength(TIMELINE_MOUNT_ROWS));
    view.rerender(<Shell searchQuery="Archived message 001" onSearchMatches={matches} />);
    await waitFor(() => expect(matches).toHaveBeenLastCalledWith(1));
    expect(view.container.querySelector('[data-entry-index="0"]')?.textContent).toContain("Archived message 001");
    expect(view.container.querySelector('[data-entry-index="82"]')?.textContent).toContain("Archived message 083");
  });

  it("keeps completed work discoverable by keyboard and preserves motion preferences", async () => {
    await commands.setStreamTestReducedMotion(false);
    const displayedMessages: ChatMessage[] = [
      { id: "prompt", role: "user", text: "Review the change", timelineOrder: 1, turnId: "turn", turnStatus: "completed" },
      { id: "progress", role: "assistant", text: "The first pass found a dependency.", timelineOrder: 3, turnId: "turn", turnStatus: "completed" },
      { id: "answer", role: "assistant", text: "The review is complete.", timelineOrder: 5, turnId: "turn", turnStatus: "completed" },
    ];
    const activities: Activity[] = [{ id: "command", kind: "command", title: "npm run check", detail: "All checks passed", status: "completed", timelineOrder: 2, turnId: "turn", turnStatus: "completed" }];
    const view = render(<Shell displayedMessages={displayedMessages} activities={activities} />);
    const toggle = screen.getByRole("button", { name: /Show completed work/ });
    const chevron = toggle.querySelector<HTMLElement>(".reasoning-chevron")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(view.container.textContent).toContain("The review is complete.");
    expect(view.container.textContent).not.toContain("All checks passed");
    expect(parseFloat(getComputedStyle(chevron).transitionDuration)).toBeGreaterThan(0);

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.textContent).toContain("The first pass found a dependency.");
    const command = screen.getByRole("button", { name: "npm run check" });
    command.focus();
    await userEvent.keyboard("{Enter}");
    expect(command).toHaveAttribute("aria-expanded", "true");
    expect(view.container.textContent).toContain("All checks passed");
    await commands.setStreamTestReducedMotion(true);
    expect(getComputedStyle(chevron).transitionDuration).toBe("0s");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.textContent).toContain("The review is complete.");
  });
});
