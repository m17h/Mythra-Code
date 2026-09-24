import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useCheckCommandDiscovery } from "./useCheckCommandDiscovery";
import { resetRunCommandDiscoveries, useRunCommandDiscovery } from "./useRunCommandDiscovery";
import { DEFAULT_RUN_DISCOVERY } from "../lib/runDiscovery";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
beforeEach(() => { native.mockReset(); resetRunCommandDiscoveries(); });

it("starts checks only on request and saves a discovered command to the captured project", async () => {
  let finish!: (value: unknown) => void;
  native.mockImplementation((command) => command === "run_discovery_start" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
  const onFound = vi.fn();
  const { result, rerender } = renderHook(({ cwd }) => useCheckCommandDiscovery(cwd), { initialProps: { cwd: "/alpha" } });
  expect(native).not.toHaveBeenCalled();
  act(() => { void result.current.discover(DEFAULT_RUN_DISCOVERY, onFound); });
  await waitFor(() => expect(native).toHaveBeenCalledWith("run_discovery_start", { options: expect.objectContaining({ cwd: "/alpha", purpose: "checks", provider: "openai" }) }));
  rerender({ cwd: "/beta" });
  const suggestion = { command: "npm run verify", label: "Verify", explanation: "package.json defines verify." };
  await act(async () => finish(suggestion));
  expect(onFound).toHaveBeenCalledExactlyOnceWith(suggestion);
  expect(result.current.suggestion).toBeNull();
  rerender({ cwd: "/alpha" });
  expect(result.current.suggestion).toEqual(suggestion);
  expect(result.current.pending).toBe(false);
});

it("keeps checks separate from run discovery and does not save an unavailable result", async () => {
  native.mockResolvedValue({ command: "", label: "No checks", explanation: "No test configuration was found." });
  const checks = renderHook(() => useCheckCommandDiscovery("/project"));
  const run = renderHook(() => useRunCommandDiscovery("/project"));
  const onFound = vi.fn();
  await act(async () => checks.result.current.discover(DEFAULT_RUN_DISCOVERY, onFound));
  expect(onFound).not.toHaveBeenCalled();
  expect(checks.result.current.unavailable).toBe("No test configuration was found.");
  expect(run.result.current.suggestion).toBeNull();
  expect(run.result.current.error).toBe("");
});
