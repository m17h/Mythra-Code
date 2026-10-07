import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityDemoSnapshot, useActivityDemo, verifyActivityDemoProfile, type ActivityDemoEnvironment } from "./ActivityDemo";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: native.isTauri }));
const PROFILE = "9f9d17d0-d219-4e19-a17d-8fd8bc8b18d7";
function environment(overrides: Partial<ActivityDemoEnvironment> = {}): ActivityDemoEnvironment {
  return { dev: true, enabled: "1", native: vi.fn(() => true), readMarker: vi.fn(() => PROFILE), probe: vi.fn(async () => undefined), ...overrides };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); native.invoke.mockReset(); native.isTauri.mockReset(); });

describe("activity preview isolation", () => {
  it.each([{ dev: false }, { enabled: undefined }, { enabled: "true" }])("does no native or storage work without the exact development opt-in: %j", async (overrides) => {
    const options = environment(overrides);
    expect(await verifyActivityDemoProfile(options)).toBe(false);
    expect(options.native).not.toHaveBeenCalled();
    expect(options.readMarker).not.toHaveBeenCalled();
    expect(options.probe).not.toHaveBeenCalled();
  });
  it("requires both native execution and a valid QA UUID", async () => {
    const browser = environment({ native: () => false });
    expect(await verifyActivityDemoProfile(browser)).toBe(false);
    expect(browser.readMarker).not.toHaveBeenCalled();
    for (const marker of [null, "production", "9f9d17d0-d219-1e19-a17d-8fd8bc8b18d7"]) {
      const options = environment({ readMarker: () => marker });
      expect(await verifyActivityDemoProfile(options)).toBe(false);
      expect(options.probe).not.toHaveBeenCalled();
    }
  });
  it("fails closed when the backend rejects the marker", async () => {
    expect(await verifyActivityDemoProfile(environment({ probe: async () => { throw new Error("QA inactive"); } }))).toBe(false);
  });
  it("accepts only after the backend has checked the exact UUID", async () => {
    const options = environment();
    expect(await verifyActivityDemoProfile(options)).toBe(true);
    expect(options.probe).toHaveBeenCalledExactlyOnceWith(PROFILE);
  });
  it("replays all phases as pure props and never writes storage or invokes a model", () => {
    const before = localStorage.length;
    const frames = [0, 4000, 9000, 14000, 19000, 24000].map((elapsed) => activityDemoSnapshot(elapsed));
    expect(frames.map((frame) => frame.phase)).toEqual(["thinking", "exploring", "editing", "testing", "answering", "completed"]);
    expect(frames.slice(0, -1).every((frame) => frame.running)).toBe(true);
    expect(frames.at(-1)?.running).toBe(false);
    expect(frames.at(-1)?.messages.at(-1)?.streaming).toBe(false);
    expect(activityDemoSnapshot(20_000).messages.at(-1)).toMatchObject({ phase: "final", streaming: true, turnStatus: "inProgress" });
    expect(frames.at(-1)?.messages.at(-1)?.phase).toBe("final");
    expect(frames[0].activities).toHaveLength(15);
    expect(frames.at(-1)?.activities).toHaveLength(18);
    expect(frames.at(-1)?.activities.filter((activity) => activity.turnId === "activity-preview-live-turn").every((activity) => activity.turnStatus === "completed" && activity.status === "completed")).toBe(true);
    expect(frames.at(-1)?.workers[0]?.status).toBe("completed");
    expect(frames[2].workers[0]?.status).toBe("working");
    // Settled history must not masquerade as repeated transcript hydration.
    for (const frame of frames.slice(1)) {
      expect(frame.messages[0]).toBe(frames[0].messages[0]);
      expect(frame.messages[1]).toBe(frames[0].messages[1]);
    }
    expect(localStorage.length).toBe(before);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(activityDemoSnapshot(Number.NaN).elapsedMs).toBe(0);
  });
  it("keeps the normal hook inactive and only reads/probes an opted-in QA marker", async () => {
    vi.stubEnv("VITE_MYTHRA_ACTIVITY_DEMO", "0");
    const normal = renderHook(useActivityDemo);
    await waitFor(() => expect(normal.result.current.verifying).toBe(false));
    expect(normal.result.current.snapshot).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    normal.unmount();
    vi.stubEnv("VITE_MYTHRA_ACTIVITY_DEMO", "1");
    localStorage.setItem("mythra.releaseQa.profile", PROFILE);
    native.isTauri.mockReturnValue(true);
    native.invoke.mockResolvedValue(undefined);
    const write = vi.spyOn(localStorage, "setItem");
    const demo = renderHook(useActivityDemo);
    await waitFor(() => expect(demo.result.current.snapshot?.phase).toBe("thinking"));
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("release_qa_renderer_probe", { profileId: PROFILE, previous: PROFILE, error: null });
    act(() => demo.result.current.pause());
    expect(demo.result.current.paused).toBe(true);
    act(() => demo.result.current.replay());
    expect(demo.result.current.paused).toBe(false);
    expect(demo.result.current.snapshot?.elapsedMs).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });
  it("restarts after completion, preserves paused time, and removes its timer on unmount", async () => {
    vi.stubEnv("VITE_MYTHRA_ACTIVITY_DEMO", "1");
    localStorage.setItem("mythra.releaseQa.profile", PROFILE);
    native.isTauri.mockReturnValue(true);
    native.invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(0);
    const demo = renderHook(useActivityDemo);
    await act(async () => { await Promise.resolve(); });
    clock.mockReturnValue(25_000);
    act(() => vi.advanceTimersByTime(200));
    expect(demo.result.current.snapshot?.phase).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
    act(() => demo.result.current.replay());
    clock.mockReturnValue(30_000);
    act(() => vi.advanceTimersByTime(200));
    expect(demo.result.current.snapshot?.phase).toBe("exploring");
    act(() => demo.result.current.pause());
    clock.mockReturnValue(50_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(demo.result.current.snapshot?.elapsedMs).toBe(5000);
    act(() => demo.result.current.resume());
    clock.mockReturnValue(51_000);
    act(() => vi.advanceTimersByTime(200));
    expect(demo.result.current.snapshot?.elapsedMs).toBe(6000);
    demo.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
