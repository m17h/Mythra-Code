import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPublishSnapshot } from "../lib/gitPublishing";
import { useGitAutoPublish, type GitAutoPublishOptions } from "./useGitAutoPublish";

const native = vi.hoisted(() => ({ snapshot: vi.fn(), publish: vi.fn() }));

vi.mock("../lib/gitPublishing", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/gitPublishing")>();
  return { ...original, getGitPublishSnapshot: native.snapshot, publishGitCommit: native.publish };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const binding = { repository: "m17h/Mythra-Code", remote: "origin", remoteUrl: "git@github.com:m17h/Mythra-Code.git", commonDir: "/repo/.git" };
const snapshot = (headOid = "a", checkedOut = true): GitPublishSnapshot => ({
  binding,
  branches: [{ name: "main", headOid, remoteBranch: "main", checkedOut }],
});
const options = (overrides: Partial<GitAutoPublishOptions> = {}): GitAutoPublishOptions => ({
  projects: [{ id: "project", path: "/repo" }],
  blocked: () => false,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  native.snapshot.mockReset().mockResolvedValue(snapshot());
  native.publish.mockReset().mockImplementation((_cwd, _binding, _branch, oid) => Promise.resolve({ publishedOid: oid }));
});

describe("useGitAutoPublish", () => {
  it("baselines historical branches and initially publishes only checked-out branches", async () => {
    native.snapshot.mockResolvedValue({
      binding,
      branches: [
        { name: "main", headOid: "main-a", remoteBranch: "main", checkedOut: true },
        { name: "old", headOid: "old-a", remoteBranch: "old", checkedOut: false },
      ],
    });
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(1));
    expect(native.publish.mock.calls[0].slice(2, 5)).toEqual(["main", "main-a", "main"]);
    expect(view.result.current.configs.project.branches.old.observedOid).toBe("old-a");
    expect(view.result.current.configs.project.branches.old).not.toHaveProperty("pendingOid");
  });

  it("does not let an in-flight result resurrect a disabled project", async () => {
    let finish!: (value: { publishedOid: string }) => void;
    native.publish.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    await waitFor(() => expect(native.publish).toHaveBeenCalled());
    act(() => view.result.current.disable("project"));
    await act(async () => { finish({ publishedOid: "a" }); await Promise.resolve(); });
    expect(view.result.current.configs.project.enabled).toBe(false);
    expect(view.result.current.configs.project.status).toBe("idle");
  });

  it("keeps an in-flight publication scoped to its project across navigation", async () => {
    let finish!: (value: { publishedOid: string }) => void;
    native.publish.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(({ value }) => useGitAutoPublish(value), { initialProps: { value: options() } });
    await act(() => view.result.current.enable("project", "/repo"));
    await waitFor(() => expect(native.publish).toHaveBeenCalled());
    view.rerender({ value: options({ projects: [{ id: "other", path: "/other" }, { id: "project", path: "/repo" }] }) });
    await act(async () => { finish({ publishedOid: "a" }); await Promise.resolve(); });
    await waitFor(() => expect(view.result.current.configs.project.branches.main.publishedOid).toBe("a"));
    expect(view.result.current.configs.other).toBeUndefined();
  });

  it("re-enable pins a fresh identity and ignores the old enable promise", async () => {
    let finishFirst!: (value: GitPublishSnapshot) => void;
    native.snapshot
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ ...snapshot("b"), binding: { ...binding, repository: "m17h/new", remoteUrl: "git@github.com:m17h/new.git" } });
    const view = renderHook(() => useGitAutoPublish(options()));
    let first!: Promise<void>;
    act(() => { first = view.result.current.enable("project", "/repo"); });
    act(() => view.result.current.disable("project"));
    await act(() => view.result.current.enable("project", "/repo"));
    await act(async () => { finishFirst(snapshot("a")); await first; });
    expect(view.result.current.configs.project.binding.repository).toBe("m17h/new");
  });

  it("coalesces a changed tip and supplies the previous observed tip as its ancestry floor", async () => {
    native.snapshot.mockResolvedValueOnce(snapshot("a", false));
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    expect(native.publish).not.toHaveBeenCalled();
    native.snapshot.mockResolvedValue(snapshot("b", false));
    act(() => view.result.current.refresh());
    await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(1));
    expect(native.publish.mock.calls[0].slice(2)).toEqual(["main", "b", "main", "a", undefined]);
  });

  it("uses only a confirmed prior publication as the expected remote tip", async () => {
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(1));
    expect(native.publish.mock.calls[0].slice(2)).toEqual(["main", "a", "main", undefined, undefined]);

    native.snapshot.mockResolvedValue(snapshot("b"));
    act(() => view.result.current.refresh());
    await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(2));
    expect(native.publish.mock.calls[1].slice(2)).toEqual(["main", "b", "main", "a", "a"]);
  });

  it("keeps rewritten history pending and paused when native ancestry validation rejects it", async () => {
    native.snapshot.mockResolvedValueOnce(snapshot("a", false));
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    native.snapshot.mockResolvedValue(snapshot("rewritten", false));
    native.publish.mockRejectedValue(new Error("PAUSED: main was rewritten"));
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.configs.project.status).toBe("paused"));
    expect(view.result.current.configs.project.branches.main).toMatchObject({ observedOid: "a", pendingOid: "rewritten" });
    expect(native.publish.mock.calls[0].slice(2)).toEqual(["main", "rewritten", "main", "a", undefined]);
  });

  it("persists retryable pending work and resumes it after remount", async () => {
    native.publish.mockRejectedValueOnce(new Error("RETRY: Network is offline"));
    const first = renderHook(() => useGitAutoPublish(options()));
    await act(() => first.result.current.enable("project", "/repo"));
    await waitFor(() => expect(first.result.current.configs.project.status).toBe("waiting"));
    expect(first.result.current.configs.project.branches.main.pendingOid).toBe("a");
    first.unmount();

    const stored = JSON.parse(localStorage.getItem("kiwi.gitAutoPublish") ?? "{}");
    const durableOid = "a".repeat(40);
    stored.project.branches.main.observedOid = durableOid;
    stored.project.branches.main.pendingOid = durableOid;
    stored.project.retryAt = 0;
    localStorage.setItem("kiwi.gitAutoPublish", JSON.stringify(stored));
    native.snapshot.mockResolvedValue(snapshot(durableOid));
    native.publish.mockResolvedValue({ publishedOid: durableOid });
    const second = renderHook(() => useGitAutoPublish(options()));
    await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.configs.project.branches.main.pendingOid).toBeUndefined());
  });

  it("sanitizes corrupt durable state and safely resumes an interrupted publication", async () => {
    const oid = "b".repeat(40);
    const stored = JSON.stringify({
      broken: null,
      partial: { enabled: true },
      badSha: { enabled: true, binding, branches: { main: { observedOid: "nope", remoteBranch: "main" } }, status: "idle", message: "", updatedAt: 1 },
      valid: {
        enabled: true,
        binding,
        branches: { main: { observedOid: oid, pendingOid: oid, remoteBranch: "main" } },
        status: "publishing",
        message: "Publishing main…",
        updatedAt: 1,
        retryAt: 999,
      },
    });
    localStorage.setItem("kiwi.gitAutoPublish", stored.replace("{", "{\"__proto__\":{\"enabled\":true},"));
    native.snapshot.mockResolvedValue(snapshot(oid));
    native.publish.mockResolvedValue({ publishedOid: oid });
    const view = renderHook(() => useGitAutoPublish(options({ projects: [{ id: "valid", path: "/repo" }] })));
    expect(Object.keys(view.result.current.configs)).toEqual(["valid"]);
    expect(view.result.current.configs.valid.status).toBe("waiting");
    expect(view.result.current.configs.valid.retryAt).toBeUndefined();
    await waitFor(() => expect(native.publish).toHaveBeenCalled());
    await waitFor(() => expect(view.result.current.configs.valid.branches.main.publishedOid).toBe(oid));
  });

  it("pauses on binding changes and requires disable/re-enable instead of retrying", async () => {
    native.snapshot.mockResolvedValueOnce(snapshot("a", false));
    const view = renderHook(() => useGitAutoPublish(options()));
    await act(() => view.result.current.enable("project", "/repo"));
    native.snapshot.mockResolvedValue({ ...snapshot("a", false), binding: { ...binding, remoteUrl: "git@github.com:m17h/other.git" } });
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.configs.project.status).toBe("paused"));
    act(() => view.result.current.retry("project"));
    expect(view.result.current.configs.project.status).toBe("paused");
    expect(native.publish).not.toHaveBeenCalled();
  });
});
