import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import type { CSSProperties } from "react";
import { ChatTimeline } from "./ChatTimeline";
import { MessageImagePreview } from "./MessageImagePreview";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import type { ChatMessage } from "../types";

const landscape = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Crect width='1200' height='800' fill='%238fd6ff'/%3E%3C/svg%3E";
const portrait = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='1200'%3E%3Crect width='600' height='1200' fill='%23ffb38f'/%3E%3C/svg%3E";
const history: ChatMessage[] = [
  { id: "old-image-prompt", role: "user", text: "Compare these old references", timelineOrder: 1, turnStatus: "completed", attachments: [
    { path: landscape, name: "landscape.png", kind: "image" },
    { path: portrait, name: "portrait.png", kind: "image" },
  ] },
  ...Array.from({ length: 8 }, (_, index): ChatMessage => ({ id: `reply-${index}`, role: "assistant", text: "A later answer.\n".repeat(6), timelineOrder: index + 2 })),
];

function Transcript({ messages = history }: { messages?: ChatMessage[] }) {
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 760, height: 500 }}>
    <ChatTimeline messages={messages} activities={[]} running={false} thinkingLabel="Thinking" provider="claude" />
  </div>;
}

function RunningShortcuts({ onStop }: { onStop: () => void }) {
  useAppShortcuts({
    modalOpen: false, commandPaletteOpen: false, threadOpen: true, running: true, workspaceOpen: true, workspaceAvailable: true,
    toggleCommandPalette: () => {}, openConversationSearch: () => {}, newThread: () => {}, openSettings: () => {}, toggleWorkspace: () => {}, closeWorkspace: () => {}, stopTurn: onStop,
  });
  return null;
}

describe("historical sent image expansion", () => {
  it("opens each original image above the scrollable history and preserves its aspect ratio", async () => {
    const view = render(<Transcript />);
    const thumbnail = screen.getByRole("img", { name: "Attached image: landscape.png" });
    await userEvent.click(thumbnail);
    const dialog = await screen.findByRole("dialog", { name: "Image preview: landscape.png" });
    expect(dialog).toHaveAttribute("open");
    const expanded = screen.getByRole("img", { name: "Expanded image: landscape.png" }) as HTMLImageElement;
    await waitFor(() => expect(expanded.naturalWidth).toBe(1200));
    expect(expanded.src).toBe(landscape);
    const rect = expanded.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(thumbnail.getBoundingClientRect().width * 2);
    expect(Math.abs(rect.width / rect.height - 1200 / 800)).toBeLessThan(0.02);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(dialog.getBoundingClientRect().height).toBeGreaterThan(500);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(thumbnail.closest("button")).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Expand attached image: portrait.png" }));
    const portraitImage = screen.getByRole("img", { name: "Expanded image: portrait.png" }) as HTMLImageElement;
    await waitFor(() => expect(portraitImage.naturalHeight).toBe(1200));
    const portraitRect = portraitImage.getBoundingClientRect();
    expect(portraitImage.src).toBe(portrait);
    expect(Math.abs(portraitRect.width / portraitRect.height - 0.5)).toBeLessThan(0.02);
    await userEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    view.unmount();
    render(<Transcript />);
    await userEvent.click(screen.getByRole("button", { name: "Expand attached image: landscape.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview: landscape.png" })).toHaveAttribute("open");
  });

  it("supports keyboard activation, contains focus and closes a failed original gracefully", async () => {
    render(<Transcript messages={[history[0]]} />);
    const trigger = screen.getByRole("button", { name: "Expand attached image: landscape.png" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const close = screen.getByRole("button", { name: "Close image preview" });
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(trigger).not.toHaveFocus();
    fireEvent.error(screen.getByRole("img", { name: "Expanded image: landscape.png" }));
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent("This image is no longer available.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("img", { name: "Expanded image: landscape.png" })).toHaveAttribute("src", landscape);
  });

  it("keeps dismissal and app shortcuts inside the viewer while output continues", async () => {
    const messages = [...history.slice(0, 1), { id: "live", role: "assistant" as const, text: "Working", streaming: true, timelineOrder: 2 }];
    const stopTurn = vi.fn();
    render(<RunningShortcuts onStop={stopTurn} />);
    const view = render(<Transcript messages={messages} />);
    const shortcut = vi.fn();
    document.addEventListener("keydown", shortcut);
    try {
      await userEvent.click(screen.getByRole("button", { name: "Expand attached image: landscape.png" }));
      await userEvent.keyboard("{Control>}k{/Control}");
      expect(shortcut).not.toHaveBeenCalled();
      view.rerender(<Transcript messages={[messages[0], { ...messages[1], text: "Working some more" }]} />);
      expect(screen.getByRole("dialog", { name: "Image preview: landscape.png" })).toHaveAttribute("open");
      await userEvent.keyboard("{Escape}");
      expect(shortcut).not.toHaveBeenCalled();
      expect(stopTurn).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Expand attached image: portrait.png" }));
      view.rerender(<Transcript messages={[]} />);
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(document.querySelector(":modal")).toBeNull();
    } finally {
      document.removeEventListener("keydown", shortcut);
    }
  });

  it.each([1, 1.5])("keeps the full viewer and close button inside the viewport at scale %s, including a narrow window", async (scale) => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
      <MessageImagePreview path={landscape} name="zoom.png" />
    </div>);
    try {
      await userEvent.click(screen.getByRole("button", { name: "Expand attached image: zoom.png" }));
      for (const width of [1400, 380]) {
        await page.viewport(width, 900);
        const dialog = screen.getByRole("dialog");
        const bounds = dialog.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
        expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        const close = screen.getByRole("button", { name: "Close image preview" });
        const closeBounds = close.getBoundingClientRect();
        expect(closeBounds.right).toBeLessThanOrEqual(window.innerWidth);
        expect(closeBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        // Integer CSSOM dimensions can differ by one pixel at fractional zoom.
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      }
      await userEvent.click(screen.getByRole("button", { name: "Close image preview" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      view.unmount();
      await page.viewport(1400, 900);
      await commands.setStreamTestReducedMotion(false);
    }
  });

  it("does not offer a broken historical thumbnail as a working image", async () => {
    render(<Transcript messages={[history[0]]} />);
    fireEvent.error(screen.getByRole("img", { name: "Attached image: landscape.png" }));
    expect(screen.queryByRole("button", { name: "Expand attached image: landscape.png" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".message-image-preview.unavailable")).toHaveTextContent("landscape.png");
    await userEvent.click(screen.getByRole("button", { name: "Expand attached image: portrait.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview: portrait.png" })).toHaveAttribute("open");
  });

  it("closes stale viewers when the attachment changes or its thumbnail fails", async () => {
    const view = render(<MessageImagePreview path={landscape} name="original.png" />);
    await userEvent.click(screen.getByRole("button", { name: "Expand attached image: original.png" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("open");

    view.rerender(<MessageImagePreview path={portrait} name="replacement.png" />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(":modal")).toBeNull();
    const thumbnail = screen.getByRole("img", { name: "Attached image: replacement.png" });
    expect(thumbnail).toHaveAttribute("src", portrait);
    await userEvent.click(screen.getByRole("button", { name: "Expand attached image: replacement.png" }));
    expect(screen.getByRole("img", { name: "Expanded image: replacement.png" })).toHaveAttribute("src", portrait);

    fireEvent.error(thumbnail);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(":modal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand attached image: replacement.png" })).toBeNull();

    view.rerender(<MessageImagePreview path={landscape} name="recovered.png" />);
    await userEvent.click(await screen.findByRole("button", { name: "Expand attached image: recovered.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview: recovered.png" })).toHaveAttribute("open");
  });
});
