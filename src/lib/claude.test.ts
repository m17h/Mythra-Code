import { describe, expect, it } from "vitest";
import { parseClaudeUsageLimits } from "./claude";

describe("Claude subscription usage", () => {
  it("normalizes Claude's structured usage windows", () => {
    expect(parseClaudeUsageLimits({
      windows: [
        { label: "5h", usedPercent: 5, resetLabel: "Aug 21 at 11:29pm (America/New_York)" },
        { label: "Weekly", usedPercent: 29, resetLabel: "Aug 23 at 5:59pm (America/New_York)" },
      ],
    })).toEqual({
      windows: [
        { label: "5h", usedPercent: 5, resetsAt: null, resetLabel: "Aug 21 at 11:29pm (America/New_York)" },
        { label: "Weekly", usedPercent: 29, resetsAt: null, resetLabel: "Aug 23 at 5:59pm (America/New_York)" },
      ],
    });
  });

  it("drops malformed windows and invalid reset timestamps", () => {
    expect(parseClaudeUsageLimits({
      windows: [
        { label: "5h", usedPercent: 125, resetLabel: "" },
        { label: null, usedPercent: 10, resetLabel: null },
      ],
    })).toEqual({
      windows: [{ label: "5h", usedPercent: 100, resetsAt: null, resetLabel: null }],
    });
    expect(parseClaudeUsageLimits({ windows: [] })).toBeNull();
  });
});
