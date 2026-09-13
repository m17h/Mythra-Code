import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useRunCommandDiscovery } from "./useRunCommandDiscovery";
import { DEFAULT_RUN_DISCOVERY } from "../lib/runDiscovery";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
beforeEach(() => { native.mockReset(); });
it("starts one temporary request with the selected model and does not run/save the suggestion", async () => {
  let finish!: (value: unknown) => void;
  native.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useRunCommandDiscovery("/project"));
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
  expect(native).toHaveBeenCalledWith("run_discovery_start", { options: { ...DEFAULT_RUN_DISCOVERY, requestId: expect.any(String), cwd: "/project" } });
  expect(result.current.pending).toBe(true);
  const suggestion = { command: "npm run dev", label: "Dev server", explanation: "The package defines dev." };
  await act(async () => finish(suggestion));
  expect(result.current.suggestion).toEqual(suggestion);
  expect(result.current.pending).toBe(false);
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
});
it("cancels on project navigation and ignores late results for the old project", async () => {
  let finish!: (value: unknown) => void;
  native.mockImplementation((command) => command === "run_discovery_start" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
  const { result, rerender } = renderHook(({ cwd }) => useRunCommandDiscovery(cwd), { initialProps: { cwd: "/alpha" } });
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
  rerender({ cwd: "/beta" });
  await waitFor(() => expect(native).toHaveBeenCalledWith("run_discovery_cancel", { requestId: expect.any(String) }));
  await act(async () => finish({ command: "wrong-project", label: "", explanation: "" }));
  expect(result.current.suggestion).toBeNull();
  expect(result.current.pending).toBe(false);
});
it("keeps failed requests retryable and reports cancellation failures", async () => {
  native.mockRejectedValueOnce(new Error("Sign in first"));
  const { result } = renderHook(() => useRunCommandDiscovery("/project"));
  await act(async () => result.current.discover(DEFAULT_RUN_DISCOVERY));
  expect(result.current.error).toContain("Sign in first");
  native.mockImplementation((command) => command === "run_discovery_start" ? new Promise(() => {}) : Promise.reject(new Error("busy")));
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
  await act(async () => result.current.cancel());
  await waitFor(() => expect(result.current.error).toContain("Could not confirm discovery cleanup"));
  expect(result.current.pending).toBe(true);
});

it("does not present an intentional stop as a provider error", async () => {
  let reject!: (reason: Error) => void;
  native.mockImplementation((command) => {
    if (command === "run_discovery_start") return new Promise((_, fail) => { reject = fail; });
    reject(new Error("Run command discovery was cancelled."));
    return Promise.resolve();
  });
  const { result } = renderHook(() => useRunCommandDiscovery("/project"));
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
  await act(async () => result.current.cancel());
  expect(result.current.error).toBe("");
  expect(result.current.pending).toBe(false);
});


it("keeps a failed stop retryable and suppresses a late cancellation error", async () => {
  let reject!: (reason: Error) => void;
  native.mockImplementation((command) => command === "run_discovery_start" ? new Promise((_, fail) => { reject = fail; }) : Promise.reject(new Error("cleanup pending")));
  const { result } = renderHook(() => useRunCommandDiscovery("/project"));
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await act(async () => result.current.cancel());
  expect(result.current.pending).toBe(true);
  await act(async () => result.current.cancel());
  expect(native.mock.calls.filter(([command]) => command === "run_discovery_cancel")).toHaveLength(2);
  await act(async () => reject(new Error("Run command discovery was cancelled.")));
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toContain("Could not confirm discovery cleanup");
  expect(result.current.error).not.toContain("was cancelled");
});

it("clears the old stop error when a retry confirms cleanup", async () => {
  native.mockImplementation((command) => command === "run_discovery_start" ? new Promise(() => {}) : Promise.reject(new Error("busy")));
  const { result } = renderHook(() => useRunCommandDiscovery("/project"));
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY); });
  await act(async () => result.current.cancel());
  expect(result.current.error).toContain("Could not confirm");
  native.mockResolvedValueOnce(undefined);
  await act(async () => result.current.cancel());
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toBe("");
});
