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

/** Canonical, unique wall-clock times; never treat a missing time as midnight. */
export function normalizedDailyTimes(times: readonly string[] | undefined): string[] {
  return [...new Set((times ?? []).filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
}

export function localScheduleTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function scheduleTimingLabel(schedule: ScheduledTask): string {
  if (schedule.scheduleMode !== "daily") return scheduleIntervalLabel(schedule);
  const times = normalizedDailyTimes(schedule.dailyTimes).map((time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
  return times.length ? `Daily at ${times.join(", ")} · local time` : "Choose a daily time";
}

/** Next occurrence strictly after now, without drifting with task duration.
 * Local Date construction follows daylight saving: nonexistent times move
 * forward by the clock change; repeated times run only once that day.
 */
export function nextScheduledRunAt(schedule: Pick<ScheduledTask, "scheduleMode" | "dailyTimes" | "intervalMinutes">, now = Date.now()): number {
  if (schedule.scheduleMode !== "daily") return now + Math.max(5, schedule.intervalMinutes) * 60_000;
  const times = normalizedDailyTimes(schedule.dailyTimes);
  if (!times.length) return Number.POSITIVE_INFINITY;
  const today = new Date(now);
  let next = Number.POSITIVE_INFINITY;
  for (let day = 0; day <= 1; day++) {
    for (const time of times) {
      const [hours, minutes] = time.split(":").map(Number);
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + day, hours, minutes).getTime();
      if (at > now && at < next) next = at;
    }
  }
  return next;
}
