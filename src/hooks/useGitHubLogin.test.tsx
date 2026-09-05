import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { getGitHubStatus } = vi.hoisted(() => ({ getGitHubStatus: vi.fn() }));
vi.mock("../lib/github", () => ({ getGitHubStatus }));
import { useGitHubLogin } from "./useGitHubLogin";
beforeEach(() => { vi.useFakeTimers(); getGitHubStatus.mockReset(); });
afterEach(() => vi.useRealTimers());
function setup() {
  const options = { pending: true, onStatus: vi.fn(), onDone: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() };
  const view = renderHook(() => useGitHubLogin(options));
  return { ...view, ...options };
}
it("never overlaps a slow probe and ends the login wait after ninety seconds", async () => {
  let resolve!: (status: unknown) => void;
  getGitHubStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = setup();
  await act(() => vi.advanceTimersByTimeAsync(90_000));
  expect(getGitHubStatus).toHaveBeenCalledTimes(1);
  expect(view.onDone).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ authenticated: true }); });
  expect(view.onSuccess).not.toHaveBeenCalled();
  view.unmount();
});
it("backs off failures and stops polling once sign-in succeeds", async () => {
  getGitHubStatus.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ authenticated: true, login: "test" });
  const view = setup();
  await act(() => vi.advanceTimersByTimeAsync(3_999));
  expect(getGitHubStatus).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(view.onSuccess).toHaveBeenCalledWith("GitHub connected as @test");
  await act(() => vi.advanceTimersByTimeAsync(90_000));
  expect(getGitHubStatus).toHaveBeenCalledTimes(2);
  expect(view.onError).not.toHaveBeenCalled();
  view.unmount();
});
