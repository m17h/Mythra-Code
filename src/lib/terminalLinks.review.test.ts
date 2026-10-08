import { describe, expect, it } from "vitest";
import { findTerminalLinks, linksAtBufferRow, type TerminalBufferReader } from "./terminalLinks";

/** A fixed-column soft-wrapped buffer, including retained partial lines. */
function wrappedBuffer(text: string, columns: number, retainedContinuation = false): TerminalBufferReader {
  const rows = Array.from({ length: Math.ceil(text.length / columns) }, (_, index) => text.slice(index * columns, (index + 1) * columns));
  return {
    getLine: (row) => row < 0 || row >= rows.length ? undefined : {
      isWrapped: row > 0 || retainedContinuation,
      length: columns,
      getCell: (column) => ({ getChars: () => rows[row][column] ?? "", getWidth: () => 1 }),
    },
  };
}

describe("terminal link independent review", () => {
  it("never opens a shortened target when the bounded scan cuts its end", () => {
    const printed = `localhost:5173/${"a".repeat(2000)}?important=last`;
    expect(linksAtBufferRow(wrappedBuffer(printed, 40), 0)).toEqual([]);
  });

  it("does not treat a retained continuation as a new address", () => {
    // Scrollback trimming can discard the prefix of this same logical line.
    expect(linksAtBufferRow(wrappedBuffer("localhost:5173/path", 40, true), 0)).toEqual([]);
  });

  it("rejects a cut-off target even when its last scanned character is punctuation", () => {
    const firstWindow = `localhost:5173/${"a".repeat(984)}?`;
    expect(firstWindow).toHaveLength(1000);
    expect(linksAtBufferRow(wrappedBuffer(`${firstWindow}important=value`, 40), 0)).toEqual([]);
  });

  it("still detects complete URLs inside a long wrapped line", () => {
    const reader = wrappedBuffer(`localhost:5173/ ok ${"x".repeat(2000)}`, 40);
    expect(linksAtBufferRow(reader, 0).map((link) => link.url)).toEqual(["http://localhost:5173/"]);
  });

  it("handles long trailing bracket runs without changing a complete target", () => {
    expect(findTerminalLinks(`localhost:5173/${")".repeat(6000)}`).map((link) => link.url)).toEqual(["http://localhost:5173/"]);
  });
});
