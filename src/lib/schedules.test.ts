import { describe, expect, it } from "vitest";
import { scheduleIntervalLabel, scheduleIntervalMinutes, scheduleIntervalParts } from "./schedules";

describe("scheduled task intervals", () => {
  it("converts explicit units into canonical minutes", () => {
    expect(scheduleIntervalMinutes(15, "minutes")).toBe(15);
    expect(scheduleIntervalMinutes(2, "hours")).toBe(120);
    expect(scheduleIntervalMinutes(3, "days")).toBe(4_320);
  });

  it("enforces a five-minute floor without making hours or days confusing", () => {
    expect(scheduleIntervalMinutes(1, "minutes")).toBe(5);
    expect(scheduleIntervalMinutes(0, "hours")).toBe(60);
    expect(scheduleIntervalMinutes(Number.NaN, "days")).toBe(1_440);
  });

  it("keeps the selected unit for new schedules and reads legacy schedules as minutes", () => {
    expect(scheduleIntervalParts({ intervalMinutes: 120, intervalValue: 2, intervalUnit: "hours" })).toEqual({ value: 2, unit: "hours" });
    expect(scheduleIntervalLabel({ intervalMinutes: 120, intervalValue: 2, intervalUnit: "hours" })).toBe("Every 2 hours");
    expect(scheduleIntervalLabel({ intervalMinutes: 60 })).toBe("Every 60 minutes");
    expect(scheduleIntervalLabel({ intervalMinutes: 5, intervalValue: 1, intervalUnit: "hours" })).toBe("Every 1 hour");
  });
});
