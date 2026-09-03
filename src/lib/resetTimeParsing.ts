/** Claude CLI labels lack a year/offset. Resolve once at the provider read,
 * retaining the original label whenever its timezone or wall time is unclear. */
export function parseResetLabelToEpochSeconds(label: string | null, now: number): number | null {
  const match = label?.trim().match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:,? (\d{4}))? at (\d{1,2})(?::(\d{2}))?\s*(am|pm)? \(([^)]+)\)$/i);
  if (!match || !Number.isFinite(now)) return null;
  const month = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  let hour = Number(match[4]);
  const minute = Number(match[5] ?? 0);
  if (day < 1 || day > 31 || minute > 59 || hour > (match[6] ? 12 : 23) || (match[6] && hour < 1)) return null;
  if (match[6]) hour = hour % 12 + (match[6].toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: match[7], hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    // Treat a formatted wall clock as UTC only to compare its calendar fields;
    // it is never returned as the actual reset instant.
    const wallAt = (instant: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
    };
    const localNow = wallAt(now);
    const currentYear = new Date(localNow).getUTCFullYear();
    const years = match[3] ? [Number(match[3])] : [currentYear - 1, currentYear, currentYear + 1];
    const walls = years.map(year => Date.UTC(year, month, day, hour, minute))
      .filter((wall, index) => {
        const date = new Date(wall);
        return date.getUTCFullYear() === years[index] && date.getUTCMonth() === month && date.getUTCDate() === day;
      }).sort((a, b) => Math.abs(a - localNow) - Math.abs(b - localNow));
    const wall = walls[0];
    if (wall === undefined) return null;
    // Select the nearest calendar year BEFORE resolving DST: an invalid time
    // this year must not silently become a valid time in a different year.
    const candidates = new Set<number>();
    for (const offsetHours of [-36, 0, 36]) {
      const probe = wall + offsetHours * 3_600_000;
      const candidate = wall - (wallAt(probe) - probe);
      if (wallAt(candidate) === wall) candidates.add(candidate);
    }
    // Both a spring-forward gap and a fall-back overlap are ambiguous input.
    // Do not guess an instant (or claim quota has returned early).
    return candidates.size === 1 ? [...candidates][0] / 1000 : null;
  } catch { return null; }
}
