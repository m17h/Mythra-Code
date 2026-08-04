import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistedState, usePersistedStateRef } from "./usePersistedState";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistedState", () => {
  it("loads the stored value and falls back to the default", () => {
    localStorage.setItem("kiwi.test", JSON.stringify(["stored"]));
    const { result } = renderHook(() => usePersistedState<string[]>("kiwi.test", []));
    expect(result.current[0]).toEqual(["stored"]);

    const { result: fallback } = renderHook(() => usePersistedState<string[]>("kiwi.missing", ["default"]));
    expect(fallback.current[0]).toEqual(["default"]);
  });

  it("normalizes the loaded value through init exactly once", () => {
    localStorage.setItem("kiwi.test", JSON.stringify([2, 1]));
    const { result } = renderHook(() =>
      usePersistedState<number[]>("kiwi.test", [], { init: (load) => [...load()].sort() }),
    );
    expect(result.current[0]).toEqual([1, 2]);
    // init only shapes state; nothing is written until the first set.
    expect(localStorage.getItem("kiwi.test")).toBe(JSON.stringify([2, 1]));
  });

  it("persists value-style and updater-style writes", () => {
    const { result } = renderHook(() => usePersistedState<number>("kiwi.test", 0));
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
    expect(localStorage.getItem("kiwi.test")).toBe("3");
    act(() => result.current[1]((current) => current + 1));
    expect(result.current[0]).toBe(4);
    expect(localStorage.getItem("kiwi.test")).toBe("4");
  });

  it("gives updaters the latest committed value even from stale closures", () => {
    const { result } = renderHook(() => usePersistedStateRef<number>("kiwi.test", 0));
    const [, setValue] = result.current;
    act(() => {
      setValue((current) => current + 1);
      setValue((current) => current + 1);
    });
    expect(result.current[0]).toBe(2);
    expect(result.current[2].current).toBe(2);
  });

  it("drops identity-equal updates without touching storage", () => {
    localStorage.setItem("kiwi.test", JSON.stringify({ keep: true }));
    const { result } = renderHook(() => usePersistedState<Record<string, boolean>>("kiwi.test", {}));
    localStorage.removeItem("kiwi.test");
    act(() => result.current[1]((current) => current));
    expect(localStorage.getItem("kiwi.test")).toBeNull();
  });

  it("writes the serialized form while state keeps the full value", () => {
    const { result } = renderHook(() =>
      usePersistedState<Array<{ id: string; heavy?: string }>>("kiwi.test", [], {
        serialize: (records) => records.map(({ id }) => ({ id })),
      }),
    );
    act(() => result.current[1]([{ id: "a", heavy: "payload" }]));
    expect(result.current[0]).toEqual([{ id: "a", heavy: "payload" }]);
    expect(JSON.parse(localStorage.getItem("kiwi.test") ?? "[]")).toEqual([{ id: "a" }]);
  });

  it("keeps the ref in sync for synchronous reads between renders", () => {
    const { result } = renderHook(() => usePersistedStateRef<string[]>("kiwi.test", []));
    act(() => {
      result.current[1](["first"]);
      // Ref reflects the write immediately, before React re-renders.
      expect(result.current[2].current).toEqual(["first"]);
    });
    expect(result.current[0]).toEqual(["first"]);
  });
});
