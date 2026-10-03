import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClaudeContinuationStore } from "../lib/claudeContinuation";
import { useClaudeContinuation } from "./useClaudeContinuation";

describe("live Claude continuation notice lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    useClaudeContinuationStore.setState({ byThread: {} });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("never offers continuation for another thread, turn, or a stopped task", () => {
    useClaudeContinuationStore.getState().update("a", "one", { kind: "grace" });
    const hook = renderHook(({ thread, turn, running }) => useClaudeContinuation(thread, turn, running), {
      initialProps: { thread: "a", turn: "one", running: true },
    });
    expect(hook.result.current?.kind).toBe("grace");
    hook.rerender({ thread: "a", turn: "two", running: true });
    expect(hook.result.current).toBeNull();
    hook.rerender({ thread: "b", turn: "one", running: true });
    expect(hook.result.current).toBeNull();
    hook.rerender({ thread: "a", turn: "one", running: false });
    expect(hook.result.current).toBeNull();
  });

  it("expires at the reported reset without polling", () => {
    useClaudeContinuationStore.getState().update("a", "one", { kind: "grace", expiresAt: 2000 });
    const hook = renderHook(() => useClaudeContinuation("a", "one", true));
    expect(hook.result.current?.kind).toBe("grace");
    act(() => vi.advanceTimersByTime(1000));
    expect(hook.result.current).toBeNull();
    expect(useClaudeContinuationStore.getState().byThread.a).toBeUndefined();
  });

  it("rechecks the clock on wake and does not clear a newer turn", () => {
    useClaudeContinuationStore.getState().update("a", "one", { kind: "grace", expiresAt: 2000 });
    const hook = renderHook(() => useClaudeContinuation("a", "one", true));
    act(() => { vi.setSystemTime(3000); window.dispatchEvent(new Event("focus")); });
    expect(hook.result.current).toBeNull();
    act(() => useClaudeContinuationStore.getState().update("a", "two", { kind: "paid" }));
    expect(useClaudeContinuationStore.getState().byThread.a.turnId).toBe("two");
    expect(hook.result.current).toBeNull();
  });
});
