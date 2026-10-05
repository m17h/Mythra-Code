import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { selectUsageRange, usageDetail } from "../lib/usageSummary";
import { flushUsageLedger, recordOpenRouterCharge, resetUsageLedgerCache } from "../lib/usageLedger";
import { seedUsageDashboard } from "../test/usageFixture";

vi.mock("../lib/usageSummary", async (original) => {
  const actual = await original<typeof import("../lib/usageSummary")>();
  return { ...actual, usageDetail: vi.fn(actual.usageDetail), selectUsageRange: vi.fn(actual.selectUsageRange) };
});

beforeEach(() => {
  resetUsageLedgerCache();
  localStorage.clear();
  seedUsageDashboard();
  vi.mocked(usageDetail).mockClear();
  vi.mocked(selectUsageRange).mockClear();
});

it("reuses usage summaries across view changes and parent renders, but refreshes on ledger changes", () => {
  const view = render(<UsageDashboard />);
  vi.mocked(usageDetail).mockClear();
  vi.mocked(selectUsageRange).mockClear();
  fireEvent.click(screen.getByRole("tab", { name: "Models" }));
  fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
  view.rerender(<UsageDashboard />);
  expect(usageDetail).not.toHaveBeenCalled();
  expect(selectUsageRange).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
  expect(usageDetail).not.toHaveBeenCalled();
  expect(selectUsageRange).toHaveBeenCalledTimes(1);
  vi.mocked(usageDetail).mockClear();
  act(() => { recordOpenRouterCharge("fresh-receipt", 0.25); flushUsageLedger(); });
  expect(usageDetail).toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "OpenRouter reported charges" })).toHaveTextContent("$0.67");
});
