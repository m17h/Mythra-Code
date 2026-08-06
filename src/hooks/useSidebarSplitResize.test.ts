import { act, fireEvent, renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useSidebarSplitResize } from "./useSidebarSplitResize";

describe("useSidebarSplitResize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores, clamps, drags, and persists the split ratio", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.4));
    const { result } = renderHook(() => useSidebarSplitResize());
    const preventDefault = vi.fn();
    const separator = {
      parentElement: {
        getBoundingClientRect: () => ({ top: 100, height: 500 }),
      },
    };

    act(() => {
      result.current.startSidebarSplitResize({
        currentTarget: separator,
        preventDefault,
      } as unknown as ReactPointerEvent<HTMLDivElement>);
    });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerUp(window);

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.splitRatio).toBe(0.6);
    expect(JSON.parse(localStorage.getItem("kiwi.sidebarSplitRatio") ?? "0")).toBe(0.6);
  });

  it("commits at most once per frame and measures the container once", () => {
    const { result } = renderHook(() => useSidebarSplitResize());
    let frame: (() => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = () => callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frame = null;
    });
    const getBoundingClientRect = vi.fn(() => ({ top: 100, height: 500 }));
    const separator = { parentElement: { getBoundingClientRect } };

    act(() => {
      result.current.startSidebarSplitResize({
        currentTarget: separator,
        clientY: 250,
        preventDefault: vi.fn(),
      } as unknown as ReactPointerEvent<HTMLDivElement>);
    });
    for (const clientY of [260, 280, 300, 320, 340]) {
      fireEvent.pointerMove(window, { clientY });
    }
    // Five pointer events, one scheduled frame: the ratio only reaches React
    // once, at the latest position.
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(result.current.splitRatio).toBe(0.3);
    act(() => frame?.());
    expect(result.current.splitRatio).toBeCloseTo(0.48);

    fireEvent.pointerMove(window, { clientY: 350 });
    fireEvent.pointerUp(window);
    expect(result.current.splitRatio).toBeCloseTo(0.5);
    // The container box is read once for the whole gesture, never per event.
    expect(getBoundingClientRect).toHaveBeenCalledTimes(1);
  });

  it("leaves the ratio untouched when the separator is pressed without moving", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.42));
    const { result } = renderHook(() => useSidebarSplitResize());
    const separator = { parentElement: { getBoundingClientRect: () => ({ top: 100, height: 500 }) } };

    act(() => {
      result.current.startSidebarSplitResize({
        currentTarget: separator,
        clientY: 260,
        preventDefault: vi.fn(),
      } as unknown as ReactPointerEvent<HTMLDivElement>);
    });
    fireEvent.pointerUp(window);

    expect(result.current.splitRatio).toBeCloseTo(0.42);
  });

  it("supports keyboard resizing", () => {
    const { result } = renderHook(() => useSidebarSplitResize());
    const preventDefault = vi.fn();
    const separator = {
      parentElement: {
        getBoundingClientRect: () => ({ height: 500 }),
      },
    };

    act(() => {
      result.current.resizeSidebarSplitWithKeyboard({
        key: "ArrowDown",
        currentTarget: separator,
        preventDefault,
      } as unknown as ReactKeyboardEvent<HTMLDivElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.splitRatio).toBeCloseTo(0.335);
    expect(JSON.parse(localStorage.getItem("kiwi.sidebarSplitRatio") ?? "0")).toBeCloseTo(0.335);
  });
});
