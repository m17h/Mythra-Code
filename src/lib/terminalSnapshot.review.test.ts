import { describe, expect, it } from "vitest";
import { createTerminalSnapshotSanitizer, terminalSnapshotText } from "./terminalSnapshot";

describe("terminal snapshot interrupted instructions", () => {
  // Compared with the actual @xterm/xterm parser: each writes beforeafter.
  const inputs = [
    "before\u001b[31\u001b[0mafter",
    "before\u001b[31\u0018after",
    "before\u001b]52;c;private\u0018after",
    "before\u001bPprivate\u001aafter",
    "before\u001b]private\u001b[0mafter",
    "before\u001bPprivate\u001b[0mafter",
    "before\u001b]private\u001b\u001b[0mafter",
    "before\u001b[31\u009dprivate\u0007after",
    "before\u001b[31\u0090private\u009cafter",
  ];

  it.each(inputs)("recovers visible text from %j", (input) => {
    expect(terminalSnapshotText(input)).toBe("beforeafter");
    for (let split = 0; split <= input.length; split += 1) {
      const sanitize = createTerminalSnapshotSanitizer();
      expect(sanitize(input.slice(0, split)) + sanitize(input.slice(split))).toBe("beforeafter");
    }
    const sanitize = createTerminalSnapshotSanitizer();
    expect([...input].map((character) => sanitize(character)).join("")).toBe("beforeafter");
  });

  it.each([
    ["before\u001b]private\u009b0mafter\u0007tail", "beforeaftertail"],
    ["before\u001b\n[31mafter", "before\nafter"],
    ["before\u001b[31\nmafter", "before\nafter"],
    ["before\u001b(\nBafter", "before\nafter"],
    ["before\u001b[31\tmafter", "before\tafter"],
    ["before\u001b\u0007[31mafter", "beforeafter"],
    ["before\u001b\u007f[31mafter", "beforeafter"],
  ])("executes or strips embedded controls without abandoning %j", (input, expected) => {
    expect(terminalSnapshotText(input)).toBe(expected);
    for (let split = 0; split <= input.length; split += 1) {
      const sanitize = createTerminalSnapshotSanitizer();
      expect(sanitize(input.slice(0, split)) + sanitize(input.slice(split))).toBe(expected);
    }
  });
});
