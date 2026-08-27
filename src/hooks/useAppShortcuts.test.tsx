import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppShortcuts, type AppShortcutContext } from "./useAppShortcuts";

function context(overrides: Partial<AppShortcutContext> = {}): AppShortcutContext {
  return {
    modalOpen: false,
    commandPaletteOpen: false,
    threadOpen: true,
    running: true,
    workspaceOpen: false,
    workspaceAvailable: true,
    toggleCommandPalette: vi.fn(),
    openConversationSearch: vi.fn(),
    newThread: vi.fn(),
    openSettings: vi.fn(),
    toggleWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
    stopTurn: vi.fn(),
    ...overrides,
  };
}

describe("useAppShortcuts", () => {
  it("routes app commands through one document listener", () => {
    const deps = context();
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });

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

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(deps.toggleCommandPalette).not.toHaveBeenCalled();
    expect(deps.newThread).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.stopTurn).not.toHaveBeenCalled();
  });

  it("lets Ctrl-K close the command palette", () => {
    const deps = context({ modalOpen: true, commandPaletteOpen: true });
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(deps.toggleCommandPalette).toHaveBeenCalledOnce();
  });

  it("does not treat the Windows key as an app shortcut modifier", () => {
    const deps = context();
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });

    expect(deps.toggleCommandPalette).not.toHaveBeenCalled();
    expect(deps.newThread).not.toHaveBeenCalled();
  });

  it("toggles the Workspace dock with the primary modifier and B", () => {
    const deps = context();
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(deps.toggleWorkspace).toHaveBeenCalledOnce();
  });

  it("leaves the Workspace shortcut alone outside a project", () => {
    const deps = context({ workspaceAvailable: false });
    renderHook(() => useAppShortcuts(deps));

    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(deps.toggleWorkspace).not.toHaveBeenCalled();
  });

  it("closes the Workspace with Escape only once nothing is running", () => {
    const running = context({ running: true, workspaceOpen: true });
    const { unmount } = renderHook(() => useAppShortcuts(running));
    fireEvent.keyDown(document.body, { key: "Escape" });
    // Interrupting the turn remains Escape's first meaning.
    expect(running.stopTurn).toHaveBeenCalledOnce();
    expect(running.closeWorkspace).not.toHaveBeenCalled();
    unmount();

    const idle = context({ running: false, workspaceOpen: true });
    renderHook(() => useAppShortcuts(idle));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(idle.closeWorkspace).toHaveBeenCalledOnce();
  });

  it("does not swallow Escape while typing in the composer", () => {
    const deps = context({ running: false, workspaceOpen: true });
    renderHook(() => useAppShortcuts(deps));
    const textarea = document.createElement("textarea");
    document.body.append(textarea);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(deps.closeWorkspace).not.toHaveBeenCalled();
    textarea.remove();
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
