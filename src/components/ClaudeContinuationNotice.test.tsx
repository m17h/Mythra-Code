import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeContinuationNotice } from "./ClaudeContinuationNotice";

describe("ClaudeContinuationNotice", () => {
  it("describes the capped wrap-up allowance without promising completion or a quota", () => {
    render(<ClaudeContinuationNotice variant="grace" rateLimitType="five_hour" />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Included wrap-up allowance in use");
    expect(notice).toHaveTextContent("Your five-hour limit was reached");
    expect(notice).toHaveTextContent("your plan's included wrap-up allowance, which counts toward your weekly usage");
    expect(notice).toHaveTextContent("capped by Anthropic and may end before the task is finished");
    expect(notice.textContent).not.toMatch(/charge|credit|unlimited|\d+ (?:times|left|remaining)/i);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([undefined, "seven_day", "seven_day_overage_included", "future_window"])("does not invent a five-hour limit for the %s window", (rateLimitType) => {
    render(<ClaudeContinuationNotice variant="grace" rateLimitType={rateLimitType} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Your Claude usage limit was reached.");
    expect(notice).toHaveTextContent("counts toward your weekly usage");
    expect(notice).toHaveTextContent("may end before the task is finished");
    expect(notice.textContent).not.toMatch(/five-hour/i);
  });

  it("reports paid usage credits separately and never offers to enable them", () => {
    const onOpenUsage = vi.fn();
    render(<ClaudeContinuationNotice variant="paid" onOpenUsage={onOpenUsage} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Claude Code reports that usage credits (extra usage) are being used");
    expect(notice).toHaveTextContent("Additional charges may apply");
    expect(notice.textContent).not.toMatch(/wrap-up|allowance|enable|turn on/i);
    fireEvent.click(screen.getByRole("button", { name: "View usage" }));
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });
});
