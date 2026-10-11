import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/codex")>()),
  rpc: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
}));

import { useTerminal } from "./useTerminal";

function terminal(scrollback = 500_000) {
  return renderHook(() => useTerminal({ scrollback, permission: "ask", scope: "/project", onError: () => {} }));
}

describe("terminal snapshot retained tail review", () => {
  it("isolates complete action records from earlier incomplete instructions", () => {
    const { result } = terminal();
    act(() => {
      result.current.append("stream-visible\u001b]stream-private");
      result.current.append("first-visible\u001b]action-private", "/project", { complete: true });
      result.current.append("$ next\nnext-visible\n", "/project", { complete: true });
      result.current.append("still-stream-private\u001b\\stream-tail");
    });
    expect(result.current.snapshot("/project").text).toBe("stream-visiblefirst-visible$ next\nnext-visible\nstream-tail");
    expect(result.current.outputStore.read(0).text).toContain("\u001b]action-private");
  });

  it.each([NaN, Infinity, -Infinity])("retains a finite default with malformed scrollback %s", (scrollback) => {
    const { result } = terminal(scrollback);
    act(() => result.current.append("x".repeat(200_000)));
    expect(result.current.outputStore.read(0).text).toHaveLength(100_000);
    expect(result.current.snapshot("/project")).toMatchObject({ retainedCharacters: 100_000, truncated: true });
  });

  it("caps oversized scrollback at the largest supported setting", () => {
    const { result } = terminal(10_000_000);
    act(() => result.current.append("x".repeat(600_000)));
    expect(result.current.outputStore.read(0).text).toHaveLength(500_000);
    expect(result.current.snapshot("/project").retainedCharacters).toBe(500_000);
  });

  it("reports truncation only when plain output was discarded", () => {
    const { result } = terminal(30);
    act(() => result.current.append(`ready\n\u001b]52;c;${"hidden".repeat(40)}\u0007`));
    expect(result.current.snapshot("/project")).toMatchObject({ text: "ready\n", retainedCharacters: 6, truncated: false });
    act(() => result.current.append("x".repeat(40)));
    expect(result.current.snapshot("/project")).toMatchObject({ text: "x".repeat(30), retainedCharacters: 30, truncated: true });
    act(() => result.current.clear());
    expect(result.current.snapshot("/project")).toMatchObject({ text: "", truncated: false });
  });

  it("reads a bounded newest tail across many chunks and Unicode boundaries", () => {
    const { result } = terminal();
    const chunks = Array.from({ length: 60 }, (_, index) => `${index}:` + "x".repeat(8_200));
    chunks.push("a".repeat(8_190) + "😀tail");
    act(() => { for (const chunk of chunks) result.current.append(chunk); });
    const all = chunks.join("");
    const retained = all.slice(-500_000);
    for (const size of [1, 2, 4, 5, 6, 7, 8_193, 12_000, 20_000]) {
      let expected = retained.slice(-size);
      if (/^[\udc00-\udfff]/u.test(expected)) expected = expected.slice(1);
      expect(result.current.snapshot("/project", size)).toMatchObject({ text: expected, retainedCharacters: retained.length, truncated: true });
    }
  });

  it("preserves a Unicode pair split between retained chunks", () => {
    const { result } = terminal();
    act(() => {
      result.current.append("x".repeat(8_191) + "\ud83d");
      result.current.append("\ude00tail");
    });
    expect(result.current.snapshot("/project", 6).text).toBe("😀tail");
    expect(result.current.snapshot("/project", 5).text).toBe("tail");
  });
});
