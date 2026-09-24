import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const rpcMock = vi.fn();
const gitInfoMock = vi.fn();
vi.mock("../lib/codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/codex")>()),
  rpc: (...args: unknown[]) => rpcMock(...args),
}));
vi.mock("../lib/worktrees", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/worktrees")>()),
  readWorkspaceGitInfo: (...args: unknown[]) => gitInfoMock(...args),
}));

import { useProjectChecks, type ProjectCheckScope } from "./useProjectChecks";

const base: ProjectCheckScope = {
  projectId: "project-a", threadId: "thread-a", cwd: "/project-a/worktree",
  command: "npm run verify", permission: "ask", additionalWritableRoots: ["/project-a/.git"],
};

beforeEach(() => {
  rpcMock.mockReset();
  gitInfoMock.mockReset();
  gitInfoMock.mockResolvedValue({ isRepo: true, head: "abc123" });
  rpcMock.mockResolvedValue({ exitCode: 0, stdout: "passed", stderr: "" });
});
afterEach(() => vi.useRealTimers());

describe("useProjectChecks", () => {
  it("runs a bounded one-shot check in the captured worktree", async () => {
    const { result } = renderHook(() => useProjectChecks(base));
    await act(async () => { await result.current.start(); });
    expect(gitInfoMock).toHaveBeenCalledWith(base.cwd);
    const [method, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("command/exec");
    expect(params).toEqual(expect.objectContaining({
      command: ["/bin/zsh", "-lc", "npm run verify"], cwd: base.cwd,
      timeoutMs: 300_000, outputBytesCap: 65_536,
      tty: false, streamStdoutStderr: false,
      sandboxPolicy: expect.objectContaining({ type: "workspaceWrite", writableRoots: [base.cwd, "/project-a/.git"] }),
    }));
    expect(typeof params.processId).toBe("string");
    expect(result.current.latest).toMatchObject({ status: "passed", exitCode: 0, head: "abc123", cwd: base.cwd });
  });

  it("preserves failed exit and bounded output, and does not start an agent", async () => {
    rpcMock.mockResolvedValue({ exitCode: 3, stdout: "x".repeat(50_000), stderr: "failure" });
    const { result } = renderHook(() => useProjectChecks(base));
    await act(async () => { await result.current.start(); });
    expect(result.current.latest).toMatchObject({ status: "failed", exitCode: 3, outputTruncated: true });
    expect(result.current.latest?.output.length).toBeLessThanOrEqual(12_000);
    expect(result.current.latest?.output).toContain("failure");
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(["command/exec"]);
  });

  it("stops during Git preflight without launching a check", async () => {
    let resolveGit: (value: unknown) => void = () => {};
    gitInfoMock.mockImplementation(() => new Promise((resolve) => { resolveGit = resolve; }));
    const { result } = renderHook(() => useProjectChecks(base));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = result.current.start(); });
    expect(result.current.running).toBe(true);
    expect(result.current.status).toBe("running");
    expect(result.current.startedAt).toEqual(expect.any(Number));
    await act(async () => { await result.current.stop(); await pending; });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.current.latest?.status).toBe("cancelled");
    expect(result.current.running).toBe(false);
    await act(async () => resolveGit({ isRepo: true, head: "abc123" }));
    expect(result.current.latest?.head).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("starts without a Git head after the bounded preflight and ignores late metadata", async () => {
    vi.useFakeTimers();
    let resolveGit: (value: unknown) => void = () => {};
    gitInfoMock.mockImplementation(() => new Promise((resolve) => { resolveGit = resolve; }));
    const { result } = renderHook(() => useProjectChecks(base));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = result.current.start(); });
    expect(rpcMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await pending; });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.current.latest).toMatchObject({ status: "passed", head: null });
    await act(async () => resolveGit({ isRepo: true, head: "late-head" }));
    expect(result.current.latest).toMatchObject({ status: "passed", head: null });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("terminates its process and never reports a cancelled success as green", async () => {
    let settle: (value: unknown) => void = () => {};
    rpcMock.mockImplementation((method: string) => method === "command/exec/terminate"
      ? Promise.resolve()
      : new Promise((resolve) => { settle = resolve; }));
    const { result } = renderHook(() => useProjectChecks(base));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = result.current.start(); await Promise.resolve(); });
    const processId = (rpcMock.mock.calls[0][1] as Record<string, string>).processId;
    await act(async () => { await result.current.stop(); });
    expect(rpcMock).toHaveBeenCalledWith("command/exec/terminate", { processId });
    await act(async () => { settle({ exitCode: 0, stdout: "passed", stderr: "" }); await pending; });
    expect(result.current.latest?.status).toBe("cancelled");
  });

  it("keeps Stop visible after check settings or thread change in the same cwd", async () => {
    let settle: (value: unknown) => void = () => {};
    rpcMock.mockImplementation((method: string) => method === "command/exec/terminate"
      ? Promise.resolve()
      : new Promise((resolve) => { settle = resolve; }));
    const { result, rerender } = renderHook((scope: ProjectCheckScope) => useProjectChecks(scope), { initialProps: base });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = result.current.start(); await Promise.resolve(); });
    rerender({ ...base, threadId: "thread-b", command: undefined });
    expect(result.current.latest).toBeNull();
    expect(result.current.running).toBe(true);
    expect(result.current.status).toBe("running");
    rerender({ ...base, threadId: "thread-b", command: "npm test" });
    await act(async () => { expect(await result.current.start()).toBeNull(); });
    rerender({ ...base, threadId: "thread-b", command: undefined });
    await act(async () => { await result.current.stop(); });
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(["command/exec", "command/exec/terminate"]);
    await act(async () => { settle({ exitCode: 0, stdout: "passed", stderr: "" }); await pending; });
    rerender(base);
    expect(result.current.latest?.status).toBe("cancelled");
  });

  it("keeps a failed terminate retryable while the command is still running", async () => {
    let settle: (value: unknown) => void = () => {};
    let terminateAttempts = 0;
    rpcMock.mockImplementation((method: string) => {
      if (method === "command/exec/terminate") {
        terminateAttempts += 1;
        return terminateAttempts === 1 ? Promise.reject(new Error("stop unavailable")) : Promise.resolve();
      }
      return new Promise((resolve) => { settle = resolve; });
    });
    const { result } = renderHook(() => useProjectChecks(base));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = result.current.start(); await Promise.resolve(); });
    await expect(act(async () => { await result.current.stop(); })).rejects.toThrow("stop unavailable");
    expect(result.current.running).toBe(true);
    await act(async () => { await result.current.stop(); });
    expect(terminateAttempts).toBe(2);
    await act(async () => { settle({ exitCode: 0, stdout: "passed", stderr: "" }); await pending; });
    expect(result.current.latest?.status).toBe("cancelled");
  });

  it("rechecks the start guard after Git preflight", async () => {
    let resolveGit: (value: unknown) => void = () => {};
    let allowed = true;
    gitInfoMock.mockImplementation(() => new Promise((resolve) => { resolveGit = resolve; }));
    const { result } = renderHook(() => useProjectChecks({ ...base, canStart: () => allowed }));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = result.current.start(); });
    allowed = false;
    await act(async () => { resolveGit({ isRepo: true, head: "abc123" }); await pending; });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.current.latest).toMatchObject({ status: "error", exitCode: null });
  });

  it("does not show a prior green result for another thread, cwd, or command", async () => {
    const { result, rerender } = renderHook((scope: ProjectCheckScope) => useProjectChecks(scope), { initialProps: base });
    await act(async () => { await result.current.start(); });
    expect(result.current.latest?.status).toBe("passed");
    rerender({ ...base, threadId: "thread-b" });
    expect(result.current.latest).toBeNull();
    rerender({ ...base, cwd: "/project-a/other" });
    expect(result.current.latest).toBeNull();
    rerender({ ...base, command: "npm test" });
    expect(result.current.latest).toBeNull();
    rerender({ ...base, checkUpdatedAt: 2 });
    expect(result.current.latest).toBeNull();
    rerender(base);
    expect(result.current.latest?.status).toBe("passed");
  });

  it("marks an unknown exit or RPC failure as an error", async () => {
    rpcMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const { result } = renderHook(() => useProjectChecks(base));
    await act(async () => { await result.current.start(); });
    expect(result.current.latest?.status).toBe("error");
    rpcMock.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => { await result.current.start(); });
    expect(result.current.latest).toMatchObject({ status: "error", exitCode: null });
    expect(result.current.latest?.error).toContain("too long");
  });
});
