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

  it("keeps routing a long-running process after many later commands", async () => {
    // Regression: routes were trimmed strictly oldest-first, so a dev server
    // started under another project lost its route once enough later commands
    // had run, and its output began landing in whichever project was selected.
    let settleDev: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    const devId = "00000000-0000-4000-8000-00000000dev0";
    rpcMock.mockImplementation((_method: string, params: { processId?: string }) => {
      if (params.processId === devId) return new Promise((resolve) => { settleDev = resolve; });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    let nextId = 0;
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      nextId += 1;
      return nextId === 1 ? devId : `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    });
    try {
      const { result } = terminal(10_000, "/project");
      let dev: Promise<void> = Promise.resolve();
      act(() => { dev = result.current.run("npm run dev", [], "/elsewhere"); });
      for (let index = 0; index < 40; index += 1) {
        await act(async () => { await result.current.run(`echo ${index}`); });
      }

      act(() => result.current.appendProcess("dev output\n", devId));
      expect(result.current.outputStore.read(0).text).not.toContain("dev output\n");
      expect(result.current.tail("/elsewhere", 200)).toContain("dev output\n");

      await act(async () => {
        settleDev({ exitCode: 0, stdout: "", stderr: "" });
        await dev;
      });
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("never evicts the project on screen to make room for background output", () => {
    // Regression: idle eviction spared only the scope being created, so a burst
    // of output for other projects could discard the scrollback the panel was
    // showing, which then came back empty on the next render.
    const { result, rerender } = terminal(1_000, "/shown");
    act(() => result.current.append("shown output\n"));
    act(() => {
      for (let index = 0; index < 8; index += 1) result.current.append(`other ${index}\n`, `/other-${index}`);
    });
    rerender({ path: "/shown" });
    expect(result.current.outputStore.read(0).text).toBe("shown output\n");
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

describe("terminal command deadlines", () => {
  it("retains five minutes by default and sends custom whole minutes", async () => {
    const { result } = terminal(1_000);
    await act(async () => { await result.current.run("test-default"); });
    expect(rpcMock).toHaveBeenLastCalledWith("command/exec", expect.objectContaining({ timeoutMs: 300_000 }));
    const custom = renderHook(() => useTerminal({ scrollback: 1_000, permission: "ask", scope: "/custom", timeoutMinutes: 45, onError: () => {} }));
    await act(async () => { await custom.result.current.run("test-custom"); });
    expect(rpcMock).toHaveBeenLastCalledWith("command/exec", expect.objectContaining({ timeoutMs: 2_700_000 }));
  });

  it("explicitly disables the runtime deadline and keeps Stop targeting that process", async () => {
    let finish: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation((method) => method === "command/exec"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    const { result } = renderHook(() => useTerminal({ scrollback: 1_000, permission: "ask", scope: "/project", timeoutMinutes: 0, onError: () => {} }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run("dev-server"); });
    const [, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.disableTimeout).toBe(true);
    expect(params).not.toHaveProperty("timeoutMs");
    expect(result.current.running).toBe(true);
    await act(async () => { await result.current.stop(); });
    expect(rpcMock).toHaveBeenLastCalledWith("command/exec/terminate", { processId: params.processId });
    await act(async () => { finish({ exitCode: 130, stdout: "", stderr: "" }); await pending; });
    expect(result.current.running).toBe(false);
  });

  it("applies changed settings to the next launch without retiming the current command", async () => {
    let finish: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ timeoutMinutes }) => useTerminal({ scrollback: 1_000, permission: "ask", scope: "/project", timeoutMinutes, onError: () => {} }), { initialProps: { timeoutMinutes: 17 } });
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run("first"); });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ timeoutMs: 1_020_000 });
    rerender({ timeoutMinutes: 0 });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.current.running).toBe(true);
    await act(async () => { finish({ exitCode: 0, stdout: "", stderr: "" }); await pending; });
    rpcMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await act(async () => { await result.current.run("second"); });
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ disableTimeout: true });
    expect(rpcMock.mock.calls[1][1]).not.toHaveProperty("timeoutMs");
  });
});

describe("read-only terminal snapshots", () => {
  it("ignores explicitly unknown process routes instead of leaking them into the selected project", () => {
    const { result } = terminal(1_000, "/project-b");
    act(() => result.current.appendProcess("private project-a output", "unknown-project-a-process"));
    act(() => result.current.appendProcess("private no-owner output", ""));
    expect(result.current.outputStore.read(0).text).toBe("");
    expect(result.current.snapshot("/project-b").text).toBe("");
    // Missing runtime ownership is also ignored; direct output uses append().
    act(() => result.current.appendProcess("unlabelled output"));
    expect(result.current.snapshot("/project-b").text).toBe("");
    act(() => result.current.append("direct output"));
    expect(result.current.snapshot("/project-b").text).toBe("direct output");
  });

  it("strips split string payloads even after raw scrollback evicts their opener", () => {
    const { result } = terminal(30);
    act(() => result.current.append("ready\n\u001b"));
    act(() => result.current.append("]52;c;private-"));
    act(() => result.current.append("secret".repeat(30)));
    expect(result.current.outputStore.read(0).text).not.toContain("\u001b]");
    expect(result.current.snapshot("/project")).toMatchObject({ text: "ready\n", truncated: false });
    act(() => result.current.clear());
    // Clear must not reset the parser midway through a private string.
    act(() => result.current.append("still-private\u001b"));
    act(() => result.current.append("\\visible\n\u001bPother-private"));
    act(() => result.current.append("-payload\u001b\\tail"));
    expect(result.current.snapshot("/project")).toMatchObject({ text: "visible\ntail", generation: 1 });
  });

  it("keeps an incomplete escape owned by its process through exit, next launch and late output", async () => {
    const { result } = terminal(2_000);
    await act(async () => {
      await result.current.run("first");
    });
    const firstId = rpcMock.mock.calls[0][1].processId as string;
    act(() => result.current.appendProcess("old-visible\n\u001b]unterminated", firstId));
    let finish: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run("second"); });
    const secondId = rpcMock.mock.calls[1][1].processId as string;
    act(() => result.current.appendProcess("private-old-payload", firstId));
    act(() => result.current.appendProcess("new-visible\n", secondId));
    expect(result.current.snapshot("/project").text).toContain("$ second\nnew-visible\n");
    expect(result.current.snapshot("/project").text).not.toContain("private-old-payload");
    act(() => result.current.appendProcess("\u001bPunfinished", secondId));
    await act(async () => { finish({ exitCode: 0, stdout: "", stderr: "" }); await pending; });
    expect(result.current.snapshot("/project").text).toContain("[exit 0]");
  });

  it("never returns half a Unicode pair at tail, scrollback or command boundaries", async () => {
    const { result } = terminal(3);
    act(() => result.current.append("abc😀"));
    expect(result.current.snapshot("/project", 1).text).toBe("");
    expect(result.current.snapshot("/project", 2).text).toBe("😀");
    act(() => result.current.append("x"));
    expect(result.current.snapshot("/project", 2).text).toBe("x");
    let finish: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run(`${"x".repeat(1_999)}😀`); });
    expect(result.current.snapshot("/project").command).toBe("x".repeat(1_999));
    await act(async () => { finish({ exitCode: 0, stdout: "", stderr: "" }); await pending; });
  });

  it("reports an unseen scope without creating, selecting or evicting a session", () => {
    const { result } = terminal(1_000, "/shown");
    act(() => result.current.append("shown output"));
    const active = result.current.outputStore;
    const generation = active.generation();
    for (let index = 0; index < 50; index += 1) {
      expect(result.current.snapshot(`/unseen-${index}`)).toEqual({
        scope: `/unseen-${index}`, available: false, running: false, command: "", text: "", truncated: false, retainedCharacters: 0, generation: 0, lifetime: "app-session",
      });
    }
    expect(result.current.outputStore).toBe(active);
    expect(active.generation()).toBe(generation);
    expect(result.current.snapshot("/shown").text).toBe("shown output");
  });

  it("reads the original project's running command and sanitized retained tail after navigation", async () => {
    let finish: (value: { exitCode: number; stdout: string; stderr: string }) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = terminal(1_000, "/project-a");
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run("dev-server"); });
    act(() => result.current.append("\u001b[31mready\u001b[0m\n\u001b]52;c;secret-clipboard\u0007tail\u0000", "/project-a"));
    rerender({ path: "/project-b" });
    const snapshot = result.current.snapshot("/project-a", 10);
    expect(snapshot).toMatchObject({ scope: "/project-a", available: true, running: true, command: "dev-server", text: "ready\ntail", truncated: true });
    expect(result.current.outputStore.read(0).text).toBe("");
    // Taking a model snapshot must not strip xterm's live color/control stream.
    rerender({ path: "/project-a" });
    expect(result.current.outputStore.read(0).text).toContain("\u001b[31mready");
    await act(async () => { finish({ exitCode: 0, stdout: "", stderr: "" }); await pending; });
    expect(result.current.snapshot("/project-a").running).toBe(false);
  });

  it("bounds the tail, reports scrollback loss and retains clear generation", () => {
    const { result } = terminal(25_000);
    act(() => result.current.append("x".repeat(30_000)));
    expect(result.current.snapshot("/project", 40_000)).toMatchObject({ text: "x".repeat(20_000), truncated: true, retainedCharacters: 25_000 });
    expect(result.current.snapshot("/project", -10).text).toBe("x");
    act(() => result.current.clear());
    expect(result.current.snapshot("/project")).toMatchObject({ available: true, text: "", truncated: false, generation: 1 });
  });
});

describe("useTerminal scoped runs", () => {
  it("runs under an explicit scope and exposes its state and output to callers", async () => {
    let finish: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
    rpcMock.mockImplementation((method: string) => {
      if (method === "command/exec") return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve({});
    });
    const { result } = terminal(1_000, "/project");
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.run("npm run dev", [], "/elsewhere");
    });

    expect(rpcMock).toHaveBeenCalledWith("command/exec", expect.objectContaining({ cwd: "/elsewhere", tty: true }));
    expect(result.current.runningIn("/elsewhere")).toEqual({ running: true, command: "npm run dev" });
    expect(result.current.running).toBe(false);
    expect(result.current.tail("/elsewhere", 200)).toBe("$ npm run dev\n");
    expect(result.current.tail("/never", 200)).toBe("");

    await act(async () => {
      finish?.({ exitCode: 0, stdout: "ready\n", stderr: "" });
      await done;
    });
    expect(result.current.runningIn("/elsewhere").running).toBe(false);
    expect(result.current.tail("/elsewhere", 10)).toBe("\n[exit 0]\n");
  });
});
