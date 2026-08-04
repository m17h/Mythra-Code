import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppShortcuts, type AppShortcutContext } from "./useAppShortcuts";

function context(overrides: Partial<AppShortcutContext> = {}): AppShortcutContext {
  return {
    modalOpen: false,
    commandPaletteOpen: false,
    threadOpen: true,
    running: true,
    toggleCommandPalette: vi.fn(),
    openConversationSearch: vi.fn(),
    newThread: vi.fn(),
    openSettings: vi.fn(),
    stopTurn: vi.fn(),
    ...overrides,
  };
}

describe("useAppShortcuts", () => {
  it("routes app commands through one document listener", () => {
    const deps = context();
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });

    expect(deps.toggleCommandPalette).toHaveBeenCalledOnce();
    expect(deps.openConversationSearch).toHaveBeenCalledOnce();
    expect(deps.newThread).toHaveBeenCalledOnce();
    expect(deps.openSettings).toHaveBeenCalledOnce();
  });

  it("never turns Escape in an editor into a stop request", () => {
    const deps = context();
    renderHook(() => useAppShortcuts(deps));
    const input = document.createElement("input");
    document.body.appendChild(input);

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(deps.stopTurn).toHaveBeenCalledOnce();
    input.remove();
  });

  it("does not open app-level commands over a blocking modal", () => {
    const deps = context({ modalOpen: true });
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(deps.toggleCommandPalette).not.toHaveBeenCalled();
    expect(deps.newThread).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.stopTurn).not.toHaveBeenCalled();
  });

  it("lets Command-K close the command palette", () => {
    const deps = context({ modalOpen: true, commandPaletteOpen: true });
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(deps.toggleCommandPalette).toHaveBeenCalledOnce();
  });

  it("uses fresh state and yields to a component that already handled the key", () => {
    const first = context({ running: false });
    const second = context({ running: true });
    const { rerender } = renderHook(({ deps }) => useAppShortcuts(deps), { initialProps: { deps: first } });
    rerender({ deps: second });

    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(second.stopTurn).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(second.stopTurn).toHaveBeenCalledOnce();
  });
});
