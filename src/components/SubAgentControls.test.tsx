import { StrictMode, useContext } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubAgentControls, SubAgentControlsProvider } from "./SubAgentControls";
import type { SubAgentWorker } from "../lib/subAgentActivity";

const worker: SubAgentWorker = { id: "child", kind: "cross-provider", status: "working", title: "Review", detail: "Claude", createdAt: 1 };
function Clock() {
  return <output data-testid="clock">{useContext(SubAgentControls)?.now}</output>;
}
function view(workers: SubAgentWorker[] = [worker]) {
  return <StrictMode><SubAgentControlsProvider workers={workers} onOpen={vi.fn()} onStop={vi.fn()}><Clock /></SubAgentControlsProvider></StrictMode>;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("stops display ticks while hidden and catches up immediately when shown", () => {
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const mounted = render(view());
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByTestId("clock")).toHaveTextContent("2000");
  act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByTestId("clock")).toHaveTextContent("2000");
  act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  expect(screen.getByTestId("clock")).toHaveTextContent("62000");
  expect(vi.getTimerCount()).toBe(1);
  mounted.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("starts hidden without a timer and has no timer for finished workers", () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const mounted = render(view());
  expect(vi.getTimerCount()).toBe(0);
  mounted.rerender(view([{ ...worker, status: "completed", finishedAt: 2000 }]));
  expect(vi.getTimerCount()).toBe(0);
  mounted.unmount();
});
