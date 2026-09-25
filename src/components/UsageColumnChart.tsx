import { useState } from "react";

export interface ChartSeries {
  label: string;
  /** One value per period; null where the value is unknown (not zero). */
  values: Array<number | null>;
}

/**
 * Compact column chart for one or two series over consecutive periods. It is
 * a visual summary only: every caller renders the same numbers as a table, so
 * the plot is hidden from assistive technology and the readout line above it
 * follows the pointer for sighted mouse users.
 */
export function UsageColumnChart({ periods, series, format, describe }: {
  /** Short label per period, e.g. "Sep 24". */
  periods: string[];
  series: ChartSeries[];
  format: (value: number) => string;
  /** Readout text for one period: the hovered one, else the highest. */
  describe: (index: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(0, ...series.flatMap((item) => item.values.map((value) => value ?? 0)));
  let peak = 0;
  periods.forEach((_, index) => {
    const total = (i: number) => series.reduce((sum, item) => sum + (item.values[i] ?? 0), 0);
    if (total(index) > total(peak)) peak = index;
  });
  const active = hovered ?? peak;
  const ticks = periods.length <= 2 ? periods.map((_, index) => index) : [0, Math.floor((periods.length - 1) / 2), periods.length - 1];
  return <div className="usage-chart" data-series={series.length}>
    <p className="usage-chart-readout" aria-hidden="true">{max > 0 ? `${hovered === null ? "Highest · " : ""}${describe(active)}` : "Nothing recorded in this range"}</p>
    <div className="usage-chart-plot" aria-hidden="true" onPointerLeave={() => setHovered(null)}>
      <span className="usage-chart-axis top">{format(max)}</span>
      <span className="usage-chart-axis bottom">0</span>
      <div className="usage-chart-columns">
        {periods.map((label, index) => <div key={label + index} className={`usage-chart-slot${hovered === index ? " hovered" : ""}`}
          onPointerEnter={() => setHovered(index)}>
          {series.map((item, seriesIndex) => {
            const value = item.values[index];
            const height = max > 0 && value ? Math.max(2, value / max * 100) : 0;
            return <span key={seriesIndex} className={`usage-chart-bar series-${seriesIndex + 1}${value === null ? " unknown" : ""}`}
              style={{ height: value === null ? "3px" : `${height}%` }} />;
          })}
        </div>)}
      </div>
    </div>
    <div className="usage-chart-ticks" aria-hidden="true">
      {ticks.map((index) => <span key={index} style={{ left: `${(index + 0.5) / periods.length * 100}%` }}>{periods[index]}</span>)}
    </div>
  </div>;
}
