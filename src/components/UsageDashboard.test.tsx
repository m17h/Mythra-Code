import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { seedUsageDashboard } from "../test/usageFixture";
import { recordOpenRouterCharge, flushUsageLedger, resetUsageLedgerCache, recordUsageDelta } from "../lib/usageLedger";

describe("local usage dashboard", () => {
  beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

  it("distinguishes no data from zero-dollar receipts", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Your usage story starts here")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    act(() => { recordOpenRouterCharge("free", 0); flushUsageLedger(); });
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("1 captured request")).toBeInTheDocument();
  });

  it("shows source-specific costs, comparable provider totals and inclusive cache counts", () => {
    seedUsageDashboard();
    render(<UsageDashboard />);
    expect(screen.getByText("3,400,000")).toBeInTheDocument();
    const chart = screen.getByRole("region", { name: "Tokens by provider" });
    expect(within(chart).getByText("OpenAI / Codex")).toBeInTheDocument();
    expect(within(chart).getByText("2,200,000")).toBeInTheDocument();
    expect(screen.getByText("2 captured requests")).toBeInTheDocument();
    expect(screen.getByText(/200,000 input\/output tokens have no saved rate/)).toBeInTheDocument();
    expect(screen.getByText("128,000 reasoning tokens included in output.")).toBeInTheDocument();
    expect(screen.getByText(/not added to the estimate/)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("updates from background ledger writes without an App rerender", () => {
    render(<UsageDashboard />);
    act(() => {
      recordUsageDelta("background", { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0, contextWindow: null });
      flushUsageLedger();
    });
    expect(screen.getByText("1 tracked thread")).toBeInTheDocument();
    expect(screen.getByText(/no saved provider label/)).toBeInTheDocument();
  });

  it("prevents repeated refreshes and exposes refresh failure", async () => {
    let reject!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<UsageDashboard onRefreshPricing={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh pricing" }));
    const checking = screen.getByRole("button", { name: "Checking…" });
    expect(checking).toBeDisabled();
    fireEvent.click(checking);
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("offline")));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Last known rates remain in use"));
    expect(screen.getByRole("button", { name: "Refresh pricing" })).toBeEnabled();
  });
});
