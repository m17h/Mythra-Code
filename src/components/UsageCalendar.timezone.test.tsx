import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageCalendarCard } from "./UsageCalendar";
import { previewUsageSource } from "./usageDashboardPreview";

afterEach(() => vi.unstubAllEnvs());

it("keeps cached day labels correct after the system timezone changes", () => {
  // The module's formatters were created before this simulated travel/clock
  // change. Calendar keys are local dates, not instants to shift between zones.
  vi.stubEnv("TZ", "Pacific/Kiritimati");
  const source = previewUsageSource(new Date(2026, 8, 29, 12).getTime());
  const view = render(<UsageCalendarCard source={source} revision={0} today="2026-09-29" range={null} providerLabel={(provider) => provider} modelLabel={(model) => model} />);
  expect(view.container.querySelector('[data-day="2026-09-29"]')).toHaveAttribute("aria-label", expect.stringContaining("Tuesday, September 29, 2026"));
  vi.stubEnv("TZ", "Pacific/Honolulu");
  view.rerender(<UsageCalendarCard source={source} revision={1} today="2026-09-30" range={null} providerLabel={(provider) => provider} modelLabel={(model) => model} />);
  expect(view.container.querySelector('[data-day="2026-09-30"]')).toHaveAttribute("aria-label", expect.stringContaining("Wednesday, September 30, 2026"));
});
