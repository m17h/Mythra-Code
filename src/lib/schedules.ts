import type { ScheduleIntervalUnit, ScheduledTask } from "../types";

const MINUTES_PER_UNIT: Record<ScheduleIntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

/** Convert the visible cadence to the scheduler's canonical minute value. */
export function scheduleIntervalMinutes(value: number, unit: ScheduleIntervalUnit): number {
  const minimum = unit === "minutes" ? 5 : 1;
  const normalized = Math.max(minimum, Math.floor(Number.isFinite(value) ? value : minimum));
  return normalized * MINUTES_PER_UNIT[unit];
}

/** Preserve the unit a user picked while keeping old minute-only schedules readable. */
export function scheduleIntervalParts(schedule: Pick<ScheduledTask, "intervalMinutes" | "intervalValue" | "intervalUnit">): {
  value: number;
  unit: ScheduleIntervalUnit;
} {
  if (schedule.intervalUnit && Number.isFinite(schedule.intervalValue)) {
    const minimum = schedule.intervalUnit === "minutes" ? 5 : 1;
    return {
      value: Math.max(minimum, Math.floor(schedule.intervalValue!)),
      unit: schedule.intervalUnit,
    };
  }
  return { value: Math.max(5, Math.floor(schedule.intervalMinutes) || 5), unit: "minutes" };
}

export function scheduleIntervalLabel(schedule: Pick<ScheduledTask, "intervalMinutes" | "intervalValue" | "intervalUnit">): string {
  const { value, unit } = scheduleIntervalParts(schedule);
  const singular = unit.slice(0, -1);
  return `Every ${value} ${value === 1 ? singular : unit}`;
}
