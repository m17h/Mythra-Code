import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const rpcMock = vi.fn();
vi.mock("../lib/codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/codex")>()),
  rpc: (...args: unknown[]) => rpcMock(...args),
}));

import { useTerminal } from "./useTerminal";

function terminal(scrollback: number, scope = "/project") {
  return renderHook(
    ({ path }: { path: string }) => useTerminal({ scrollback, permission: "ask", scope: path, onError: () => {} }),
    { initialProps: { path: scope } },
  );
}

/** Drains the store the way XtermPanel does: one cursor advanced per notify. */
function attachConsumer(store: ReturnType<typeof terminal>["result"]["current"]["outputStore"]) {
  let cursor = 0;
  let written = "";
  const unsubscribe = store.subscribe(() => {
    const next = store.read(cursor);
    cursor = next.cursor;
    written += next.text;
  });
  return { unsubscribe, written: () => written };
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "" });
});

describe("useTerminal output store", () => {
  it("delivers every appended chunk to a subscriber", () => {
    const { result } = terminal(1_000);
    const consumer = attachConsumer(result.current.outputStore);
    act(() => {
      result.current.append("first\n");
      result.current.append("second\n");
    });
    expect(consumer.written()).toBe("first\nsecond\n");
    expect(result.current.outputStore.appendedLength()).toBe(13);
    consumer.unsubscribe();
  });

  it("keeps delivering output after the retained buffer saturates", () => {
    // Regression: the buffer used to be one accumulated string trimmed to the
    // scrollback limit. Once saturated its length stopped changing, so the
    // delta the panel derived from that length was always empty and the
    // terminal froze while output kept arriving.
    const scrollback = 200;
    const { result } = terminal(scrollback);
    const consumer = attachConsumer(result.current.outputStore);
    const chunk = "x".repeat(50);
    act(() => {
      for (let index = 0; index < 40; index += 1) result.current.append(chunk);
    });
    expect(result.current.outputStore.appendedLength()).toBe(40 * 50);
    expect(consumer.written()).toBe(chunk.repeat(40));
    consumer.unsubscribe();
  });

  it("trims to the scrollback limit and replays only the retained tail", () => {
    const { result } = terminal(10);
    act(() => {
      result.current.append("abcdefg");
      result.current.append("hijklmn");
    });
    // A fresh consumer (a remounted panel) reads from cursor 0 and receives the
    // retained window, not the whole history.
    const replay = result.current.outputStore.read(0);
    expect(replay.text).toBe("efghijklmn");
    expect(replay.cursor).toBe(14);
    // A cursor already at the head reads nothing.
    expect(result.current.outputStore.read(replay.cursor)).toEqual({ text: "", cursor: 14 });
  });

  it("delivers character-at-a-time output without losing or reordering it", () => {
    // A PTY in raw mode can emit one character per event. Each must still reach
    // the subscriber exactly once and in order, even though small arrivals are
    // merged into one retained chunk.
    const { result } = terminal(64);
    const consumer = attachConsumer(result.current.outputStore);
    const source = "the quick brown fox jumps over the lazy dog and keeps on going";
    act(() => {
      for (const character of source) result.current.append(character);
    });
    expect(consumer.written()).toBe(source);
    expect(result.current.outputStore.appendedLength()).toBe(source.length);
    // The retained window still holds only the tail.
    expect(result.current.outputStore.read(0).text).toBe(source.slice(-64));
    consumer.unsubscribe();
  });

  it("ignores empty appends", () => {
    const { result } = terminal(100);
    const consumer = attachConsumer(result.current.outputStore);
    act(() => result.current.append(""));
    expect(result.current.outputStore.appendedLength()).toBe(0);
    expect(consumer.written()).toBe("");
    consumer.unsubscribe();
  });
});

describe("terminal scoping", () => {
  it("keeps each project's output and buffer separate", () => {
    const { result, rerender } = terminal(1_000, "/project-a");
    act(() => result.current.append("a output\n"));
    const storeA = result.current.outputStore;

    rerender({ path: "/project-b" });
    // Project B starts empty rather than inheriting A's scrollback.
    expect(result.current.outputStore).not.toBe(storeA);
    expect(result.current.outputStore.appendedLength()).toBe(0);
    act(() => result.current.append("b output\n"));
    expect(result.current.outputStore.read(0).text).toBe("b output\n");

    rerender({ path: "/project-a" });
    expect(result.current.outputStore).toBe(storeA);
    expect(result.current.outputStore.read(0).text).toBe("a output\n");
  });

  it("reports a run as running only under the project that owns it", async () => {
    let settle: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const { result, rerender } = terminal(1_000, "/project-a");

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run("npm test"); });
    expect(result.current.running).toBe(true);
    expect(result.current.runningCommand).toBe("npm test");

    rerender({ path: "/project-b" });
    // The other project's Terminal header must not claim this run.
    expect(result.current.running).toBe(false);
    expect(result.current.runningCommand).toBe("");
    expect(result.current.runningElsewhere).toEqual([{ scope: "/project-a", command: "npm test" }]);
    // Nor may its output land in this project's buffer.
    expect(result.current.outputStore.appendedLength()).toBe(0);

    await act(async () => {
      settle({ exitCode: 0, stdout: "ok", stderr: "" });
      await pending;
    });
    expect(result.current.runningElsewhere).toEqual([]);
  });

  it("runs the command through the platform shell in the selected project", async () => {
    const { result } = terminal(1_000, "/project-a");
    await act(async () => { await result.current.run("npm test"); });
    const [method, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("command/exec");
    expect(params.cwd).toBe("/project-a");
    expect(params.command).toEqual(["/bin/zsh", "-lc", "npm test"]);
  });

  it("hands the command to the Windows shell on a Windows install", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    try {
      const { result } = terminal(1_000, "C:\\project");
      await act(async () => { await result.current.run("npm test"); });
      const [, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(params.cwd).toBe("C:\\project");
      expect(params.command).toEqual(["cmd.exe", "/d", "/s", "/c", "npm test"]);
    } finally {
      platform.mockRestore();
    }
  });

  it("keeps a project action's output under the project it ran in", () => {
    const { result, rerender } = terminal(1_000, "/project-a");
    // A long action started in A finishes after the user opened B.
    rerender({ path: "/project-b" });
    act(() => result.current.append("action output\n", "/project-a"));

    expect(result.current.outputStore.read(0).text).toBe("");
    expect(result.current.appendedLength("/project-a")).toBe("action output\n".length);
    rerender({ path: "/project-a" });
    expect(result.current.outputStore.read(0).text).toBe("action output\n");
  });

  it("routes streamed output by process after the selected project changes", async () => {
    let settle: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const processId = "00000000-0000-4000-8000-000000000001";
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(processId);
    try {
      const { result, rerender } = terminal(1_000, "/project-a");
      let pending: Promise<void> = Promise.resolve();
      act(() => { pending = result.current.run("long-command"); });

      rerender({ path: "/project-b" });
      act(() => result.current.appendProcess("late output\n", processId));
      expect(result.current.outputStore.read(0).text).toBe("");

      await act(async () => {
        settle({ exitCode: 0, stdout: "", stderr: "" });
        await pending;
      });
      // The runtime may flush a final delta after the RPC has settled. The
      // completed process route is retained briefly for that event as well.
      act(() => result.current.appendProcess("final output\n", processId));
      expect(result.current.outputStore.read(0).text).toBe("");

      rerender({ path: "/project-a" });
      expect(result.current.outputStore.read(0).text).toContain("late output\n");
      expect(result.current.outputStore.read(0).text).toContain("final output\n");
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("clears only the selected project's buffer and asks consumers to repaint", () => {
    const { result, rerender } = terminal(1_000, "/project-a");
    act(() => result.current.append("a output\n"));
    rerender({ path: "/project-b" });
    act(() => result.current.append("b output\n"));

    const before = result.current.outputStore.generation();
    act(() => result.current.clear());
    expect(result.current.outputStore.appendedLength()).toBe(0);
    expect(result.current.outputStore.read(0).text).toBe("");
    expect(result.current.outputStore.generation()).toBe(before + 1);

    rerender({ path: "/project-a" });
    expect(result.current.outputStore.read(0).text).toBe("a output\n");
  });
});
