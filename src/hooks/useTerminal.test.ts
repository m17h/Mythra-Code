import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useTerminal } from "./useTerminal";

function terminal(scrollback: number) {
  return renderHook(() => useTerminal({ scrollback, permission: "ask", onError: () => {} }));
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
