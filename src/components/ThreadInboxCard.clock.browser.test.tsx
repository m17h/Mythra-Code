import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { ThreadInboxCard } from "./ThreadInboxCard";

beforeEach(resetTaskStore);
afterEach(() => vi.restoreAllMocks());

it("uses real intersection geometry to suspend offscreen clocks and refreshes on reveal", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const store = useTaskStore.getState();
  store.setTaskStatus("clock", "running");
  useTaskStore.setState((state) => ({ tasks: {
    ...state.tasks, clock: { ...state.tasks.clock, workingStartedAt: 35_000 },
  } }));
  const timeouts = vi.spyOn(window, "setTimeout");
  const clears = vi.spyOn(window, "clearTimeout");
  const fixture = (active: boolean) => <div style={{ height: 140, width: 320, overflowY: "auto" }} data-clock-scroll>
    <div style={{ height: 300 }} />
    <ThreadInboxCard threadId="clock" title="Visible clock" workspaceName="Project"
      directory="/projects/app" provider="openai" providerName="OpenAI" pinned={false}
      active={active} onOpen={() => {}} />
    <div style={{ height: 300 }} />
  </div>;
  const view = render(fixture(true));
  const scroller = view.container.querySelector<HTMLElement>("[data-clock-scroll]")!;
  const duration = view.container.querySelector<HTMLElement>(".thread-card-duration")!;
  const schedules = () => timeouts.mock.calls.filter(([, delay]) => delay === 55_000).length;
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await frame();
  expect(duration.getBoundingClientRect().top).toBeGreaterThan(scroller.getBoundingClientRect().bottom);
  expect(schedules()).toBe(0);

  scroller.scrollTop = 300;
  await expect.poll(schedules).toBe(1);
  const firstClock = timeouts.mock.results[timeouts.mock.calls.findIndex(([, delay]) => delay === 55_000)].value;
  scroller.scrollTop = 0;
  await expect.poll(() => clears.mock.calls.some(([id]) => id === firstClock)).toBe(true);
  const pausedSchedules = schedules();
  now += 120_000;
  scroller.scrollTop = 300;
  await expect.poll(() => duration.textContent).toBe("3m");
  expect(schedules()).toBe(pausedSchedules + 1);

  const latestIndex = timeouts.mock.calls.map(([, delay], index) => delay === 55_000 ? index : -1).filter((index) => index >= 0).at(-1)!;
  const latestClock = timeouts.mock.results[latestIndex].value;
  view.rerender(fixture(false));
  expect(clears.mock.calls.some(([id]) => id === latestClock)).toBe(true);
  now += 120_000;
  const collapsedSchedules = schedules();
  await frame();
  expect(schedules()).toBe(collapsedSchedules);
  act(() => view.rerender(fixture(true)));
  await expect.poll(() => duration.textContent).toBe("5m");
  expect(schedules()).toBe(collapsedSchedules + 1);
  view.unmount();
});
