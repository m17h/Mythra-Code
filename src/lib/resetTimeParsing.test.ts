import { describe, expect, it } from "vitest";
import { parseResetLabelToEpochSeconds as parse } from "./resetTimeParsing";

const now = Date.UTC(2026, 8, 3, 2, 14);
describe("Claude reset-label instants", () => {
  it.each([
    ["Sep 2 at 11:10pm (America/New_York)", Date.UTC(2026, 8, 3, 3, 10)],
    ["Sep 2 at 23:10 (America/New_York)", Date.UTC(2026, 8, 3, 3, 10)],
    ["Sep 2 at 11pm (America/New_York)", Date.UTC(2026, 8, 3, 3)],
    ["Sep 3 at 9:00am (Asia/Kolkata)", Date.UTC(2026, 8, 3, 3, 30)],
    ["Sep 3 at 12:00am (UTC)", Date.UTC(2026, 8, 3)],
    ["Sep 3, 2027 at 12:00pm (UTC)", Date.UTC(2027, 8, 3, 12)],
  ])("resolves %s without depending on the host timezone", (label, expected) => {
    expect(parse(label, now)).toBe(expected / 1000);
  });
  it("uses winter offsets and handles both directions of New Year", () => {
    expect(parse("Jan 5 at 6:00am (America/New_York)", Date.UTC(2026, 0, 5))).toBe(Date.UTC(2026, 0, 5, 11) / 1000);
    expect(parse("Jan 1 at 12:30am (America/New_York)", Date.UTC(2027, 0, 1, 4))).toBe(Date.UTC(2027, 0, 1, 5, 30) / 1000);
    expect(parse("Dec 31 at 11:50pm (America/New_York)", Date.UTC(2027, 0, 1, 5, 5))).toBe(Date.UTC(2027, 0, 1, 4, 50) / 1000);
  });
  it("rejects DST overlaps/gaps instead of choosing the wrong instant or year", () => {
    expect(parse("Nov 1 at 1:30am (America/New_York)", Date.UTC(2026, 10, 1))).toBeNull();
    expect(parse("Mar 8 at 2:30am (America/New_York)", Date.UTC(2026, 2, 8))).toBeNull();
    expect(parse("Apr 5 at 1:45am (Australia/Lord_Howe)", Date.UTC(2026, 3, 4))).toBeNull();
  });
  it.each([null, "", "tomorrow", "Sep 2 at 11pm", "Sep 2 at 11pm (Invalid/Zone)",
    "Feb 30 at 1pm (UTC)", "Sep 0 at 1pm (UTC)", "Sep 2 at 13pm (UTC)",
    "Sep 2 at 0am (UTC)", "Sep 2 at 24:00 (UTC)", "Sep 2 at 1:60pm (UTC)"])("retains the fallback for invalid input %s", label => {
    expect(parse(label, now)).toBeNull();
  });
  it("rejects an invalid read time", () => {
    expect(parse("Sep 2 at 11pm (UTC)", NaN)).toBeNull();
  });
});
