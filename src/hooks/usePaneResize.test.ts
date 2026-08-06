import { act, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { usePaneResize } from "./usePaneResize";

describe("usePaneResize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("commits at most once per frame while dragging", () => {
    localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 300, dock: 500 }));
    const { result } = renderHook(() => usePaneResize(1));
    let frame: (() => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = () => callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frame = null;
    });

    act(() => {
      result.current.startPaneResize("dock")({
        clientX: 400,
        preventDefault: vi.fn(),
      } as unknown as ReactPointerEvent);
    });
    for (const clientX of [396, 390, 384, 378, 370]) {
      fireEvent.pointerMove(window, { clientX });
    }
    // The dock width feeds the whole App tree; five pointer events must not
    // produce five renders.
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(result.current.paneSizes.dock).toBe(500);
    act(() => frame?.());
    expect(result.current.paneSizes.dock).toBe(530);

    fireEvent.pointerMove(window, { clientX: 360 });
    fireEvent.pointerUp(window);
    // Release lands on the exact final position even though its move arrived
    // after the last committed frame.
    expect(result.current.paneSizes.dock).toBe(540);
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}").dock).toBe(540);
  });

  it("restores, scales, clamps, and persists pane sizes", () => {
    localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 300, dock: 500 }));
    const { result } = renderHook(() => usePaneResize(2));
    const preventDefault = vi.fn();

    act(() => {
      result.current.startPaneResize("sidebar")({
        clientX: 100,
        preventDefault,
      } as unknown as ReactPointerEvent);
    });
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.paneSizes).toEqual({ sidebar: 350, dock: 500 });
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}")).toEqual({
      sidebar: 350,
      dock: 500,
    });
  });
});
