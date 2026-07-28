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
