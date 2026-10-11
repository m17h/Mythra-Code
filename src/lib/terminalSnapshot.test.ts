import { describe, expect, it } from "vitest";
import { createTerminalSnapshotSanitizer, terminalSnapshotLimit, terminalSnapshotPrefix, terminalSnapshotTail, terminalSnapshotText } from "./terminalSnapshot";

describe("terminal snapshot sanitization", () => {
  it("removes ANSI color, string instructions and control bytes but preserves terminal text", () => {
    expect(terminalSnapshotText("\u001b[31mred\u001b[0m\tplain\n\r\u0000\u0007\u007f\u0085")).toBe("red\tplain\n\r");
    for (const prefix of ["]", "P", "_", "^", "X"]) {
      expect(terminalSnapshotText(`before\u001b${prefix}private\u001b\\after`)).toBe("beforeafter");
      expect(terminalSnapshotText(`before\u001b${prefix}private`)).toBe("before");
    }
    expect(terminalSnapshotText("before\u001b]clipboard\u0007after")).toBe("beforeafter");
    expect(terminalSnapshotText("\u009b31mred\u009b0m\u009dprivate\u009cend")).toBe("redend");
    expect(terminalSnapshotText("hello\u001b[32")).toBe("hello");
    expect(terminalSnapshotText("hello\u001b(Bworld")).toBe("helloworld");
  });

  it("bounds requested snapshot sizes without disabling bounds on malformed inputs", () => {
    expect(terminalSnapshotLimit()).toBe(12_000);
    expect(terminalSnapshotLimit(Infinity)).toBe(12_000);
    expect(terminalSnapshotLimit(NaN)).toBe(12_000);
    expect(terminalSnapshotLimit(90_000)).toBe(20_000);
    expect(terminalSnapshotLimit(-10)).toBe(1);
    expect(terminalSnapshotLimit(15.9)).toBe(15);
  });

  it("matches whole-text sanitation across every possible two-part chunk split", () => {
    const input = "a\u001b[31mred\u001b[0m\u001b]52;c;private\u0007b\u001bPpayload\u001b\\c\u009dhidden\u009cd\u001b(Bend";
    expect(terminalSnapshotText(input)).toBe("aredbcdend");
    for (let split = 0; split <= input.length; split += 1) {
      const sanitize = createTerminalSnapshotSanitizer();
      expect(sanitize(input.slice(0, split)) + sanitize(input.slice(split))).toBe("aredbcdend");
    }
    const sanitize = createTerminalSnapshotSanitizer();
    expect([...input].map((character) => sanitize(character)).join("")).toBe("aredbcdend");
  });

  it("keeps Unicode pairs intact while obeying UTF-16 bounds", () => {
    expect(terminalSnapshotTail("a😀", 1)).toBe("");
    expect(terminalSnapshotTail("a😀", 2)).toBe("😀");
    expect(terminalSnapshotTail("😀a", 2)).toBe("a");
    expect(terminalSnapshotPrefix("a😀z", 2)).toBe("a");
    expect(terminalSnapshotPrefix("a😀z", 3)).toBe("a😀");
  });
});
