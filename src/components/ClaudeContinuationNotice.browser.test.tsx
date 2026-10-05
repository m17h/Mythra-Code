import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ClaudeContinuationNotice } from "./ClaudeContinuationNotice";

describe("Claude allowance notice real-browser review", () => {
  it.each(["mythra", "light-mythra", "atari"])("keeps the explanation and action contained in a narrow %s composer", async (theme) => {
    const onOpenUsage = vi.fn();
    const view = render(<div className="app-shell" data-theme={theme} style={{ width: 340, height: "auto", display: "block" }}>
      <ClaudeContinuationNotice variant="grace" rateLimitType="five_hour" onOpenUsage={onOpenUsage} />
    </div>);
    const notice = screen.getByRole("status");
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth + 1);
    expect(screen.getByText("Included wrap-up allowance in use")).toBeVisible();
    expect(screen.getByText(/counts toward your weekly usage/)).toBeVisible();
    expect(notice).toHaveTextContent("Your five-hour limit was reached.");
    const action = screen.getByRole("button", { name: "View usage" });
    const rect = notice.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    expect(actionRect.right).toBeLessThanOrEqual(rect.right + 1);
    expect(actionRect.bottom).toBeLessThanOrEqual(rect.bottom + 1);
    await userEvent.click(action);
    expect(onOpenUsage).toHaveBeenCalledOnce();
    view.rerender(<div className="app-shell" data-theme={theme} style={{ width: 340, height: "auto", display: "block" }}>
      <ClaudeContinuationNotice variant="grace" rateLimitType="seven_day" onOpenUsage={onOpenUsage} />
    </div>);
    expect(screen.getByRole("status")).toHaveTextContent("Your Claude usage limit was reached.");
    expect(screen.getByRole("status").textContent).not.toMatch(/five-hour/i);
    expect(screen.getByText(/counts toward your weekly usage/)).toBeVisible();
    expect(screen.getByRole("status").scrollWidth).toBeLessThanOrEqual(screen.getByRole("status").clientWidth + 1);
    view.rerender(<div className="app-shell" data-theme={theme} style={{ width: 340, height: "auto", display: "block" }}>
      <ClaudeContinuationNotice variant="paid" onOpenUsage={onOpenUsage} />
    </div>);
    expect(screen.getByText("Claude usage credits in use")).toBeVisible();
    expect(screen.getByText(/Additional charges may apply/)).toBeVisible();
    expect(screen.queryByText("Included wrap-up allowance in use")).not.toBeInTheDocument();
  });
});
