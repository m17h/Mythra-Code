import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";
import { useAutomaticThreadTitles } from "./useAutomaticThreadTitles";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const thread = (id = "one"): Thread => ({ id, cwd: "/project", preview: "fix it", name: null, modelProvider: "claude", updatedAt: 1 });
function options(overrides: Partial<Parameters<typeof useAutomaticThreadTitles>[0]> = {}) {
  return { enabled: true, provider: "openai" as const, model: "", catalogs: {}, lmStudioBaseUrl: "http://127.0.0.1:1234/v1",
    getThread: (id: string) => thread(id), applyTitle: vi.fn().mockResolvedValue(undefined), ...overrides };
}
beforeEach(() => { invoke.mockReset().mockResolvedValue("Fix sidebar scrolling"); });
describe("automatic thread titles", () => {
  it("does no work on mount or when disabled", async () => {
    const view = renderHook(() => useAutomaticThreadTitles(options({ enabled: false })));
    act(() => view.result.current.requestTitle("one", "Fix sidebar scrolling"));
    expect(invoke).not.toHaveBeenCalled();
  });
  it("uses one bounded normal-tier Luna call, even for a Claude thread, without awaiting the main turn", async () => {
    const opts = options();
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => { view.result.current.requestTitle("one", "x".repeat(9000)); view.result.current.requestTitle("one", "again"); });
    await waitFor(() => expect(opts.applyTitle).toHaveBeenCalledWith("one", "Fix sidebar scrolling"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("generate_thread_title", expect.objectContaining({
      options: expect.objectContaining({ provider: "openai", model: "gpt-5.6-luna", effort: "low", fast: false, cwd: "" }), prompt: "x".repeat(2000),
    }));
  });
  it.each(["claude", "cursor", "openrouter", "lmstudio"] as const)("routes an explicit %s model without an OpenAI fallback", async (provider) => {
    const opts = options({ provider, model: "chosen-model" });
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => view.result.current.requestTitle("one", "Name this task"));
    await waitFor(() => expect(opts.applyTitle).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("generate_thread_title", expect.objectContaining({ options: expect.objectContaining({ provider, model: "chosen-model" }) }));
  });
  it("serializes jobs and leaves existing titles alone on failure", async () => {
    let finish!: (title: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("offline"));
    const opts = options();
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => { view.result.current.requestTitle("one", "first"); view.result.current.requestTitle("two", "second"); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => finish("First task title"));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(opts.applyTitle).toHaveBeenCalledExactlyOnceWith("one", "First task title");
  });
  it("keeps a manual title and never resurrects a deleted thread", async () => {
    let finish!: (title: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let present: Thread | undefined = thread();
    const opts = options({ getThread: () => present });
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => view.result.current.requestTitle("one", "first"));
    present = { ...thread(), name: "My own title" };
    await act(async () => finish("AI title"));
    expect(opts.applyTitle).not.toHaveBeenCalled();
    present = undefined;
    act(() => view.result.current.requestTitle("two", "gone"));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("cancels when disabled, discards the late result, and does not start queued work", async () => {
    let finish!: (title: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const opts = options();
    const view = renderHook((props) => useAutomaticThreadTitles(props), { initialProps: opts });
    act(() => { view.result.current.requestTitle("one", "first"); view.result.current.requestTitle("two", "second"); });
    view.rerender({ ...opts, enabled: false });
    expect(invoke).toHaveBeenCalledWith("run_discovery_cancel", expect.objectContaining({ requestId: expect.any(String) }));
    await act(async () => finish("Late title"));
    expect(opts.applyTitle).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("orders a manual rename after an in-flight title write", async () => {
    let finishWrite!: () => void;
    const opts = options({ applyTitle: vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; })) });
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => view.result.current.requestTitle("one", "first"));
    await waitFor(() => expect(opts.applyTitle).toHaveBeenCalled());
    let cancelled = false;
    const pending = view.result.current.cancel("one").then(() => { cancelled = true; });
    expect(cancelled).toBe(false);
    await act(async () => { finishWrite(); await pending; });
    expect(cancelled).toBe(true);
  });
});

describe("title pending lifecycle", () => {
  it("reserves before delivery without spending a request, and stays hidden through the name write", async () => {
    let finish!: (title: string) => void;
    let finishWrite!: () => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const opts = options({ applyTitle: vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; })) });
    const view = renderHook(() => useAutomaticThreadTitles(opts));
    act(() => view.result.current.prepareTitle("one", "first"));
    expect(view.result.current.pendingIds.has("one")).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    act(() => view.result.current.requestTitle("one", "first"));
    await act(async () => finish("A generated title"));
    expect(view.result.current.pendingIds.has("one")).toBe(true);
    await act(async () => finishWrite());
    expect(view.result.current.pendingIds.size).toBe(0);
  });
  it("clears failed starts and cancelled queued titles independently", async () => {
    let finish!: (title: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useAutomaticThreadTitles(options()));
    act(() => {
      view.result.current.prepareTitle("failed", "failed send");
      view.result.current.requestTitle("one", "first");
      view.result.current.requestTitle("two", "second");
    });
    await act(async () => { await view.result.current.cancel("failed"); await view.result.current.cancel("two"); });
    expect([...view.result.current.pendingIds]).toEqual(["one"]);
    await act(async () => finish("A generated title"));
    expect(view.result.current.pendingIds.size).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("reveals fallback on provider failure and clears all pending titles when disabled", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    const opts = options();
    const view = renderHook((props) => useAutomaticThreadTitles(props), { initialProps: opts });
    await act(async () => view.result.current.requestTitle("one", "first"));
    expect(view.result.current.pendingIds.size).toBe(0);
    act(() => view.result.current.prepareTitle("two", "second"));
    view.rerender({ ...opts, enabled: false });
    expect(view.result.current.pendingIds.size).toBe(0);
  });
});
