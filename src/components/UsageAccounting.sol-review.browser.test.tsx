import { render, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { UsageDashboard } from "./UsageDashboard";
import { annotateThreadUsage, flushUsageLedger, recordUsageDelta, resetUsageLedgerCache } from "../lib/usageLedger";
import { recordBackgroundUsage } from "../lib/backgroundUsage";
import "../styles.css";

beforeEach(() => { resetUsageLedgerCache(); localStorage.clear(); });

function mixedTotalOnlyUsage() {
  annotateThreadUsage("observed-chat", { provider: "openai", model: "gpt-6-sol", requestedServiceTier: "standard" });
  recordUsageDelta("observed-chat", {
    inputTokens: 90, outputTokens: 10, totalTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0, cacheReadReported: true, cacheWriteReported: true,
  }, "chat-event", "chat-turn");
  recordBackgroundUsage({
    executionId: "30d6bf53-58b8-48bb-9f0c-e9a6369fb694", provider: "openai", model: "gpt-6-luna", modelSource: "requested",
    purpose: "thread-title", serviceTier: null, serviceTierSource: "unknown", requestedServiceTier: null,
    outcome: "completed", tokenAvailability: "partial", reportedCost: null,
    usage: { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, cacheWrite1hInputTokens: null,
      outputTokens: null, reasoningOutputTokens: null, totalTokens: 100 },
  });
  flushUsageLedger();
  resetUsageLedgerCache();
}

function mount() {
  return render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width: 928, padding: 16 }}><UsageDashboard /></div>);
}

describe("Sol review: real dashboard total-only receipts", () => {
  it("reports 50% coverage when one half of recorded tokens has no type or usable price", () => {
    mixedTotalOnlyUsage();
    const view = mount();
    const stats = view.getByRole("group", { name: /^Summary/ });
    expect(within(stats).getByText("Tokens").parentElement).toHaveTextContent("200");
    expect(within(stats).getByText("Estimated API cost").parentElement).toHaveTextContent("50% of tokens priced");
  });

  it("keeps the Models total equal to the recorded total when a receipt omitted its token split", async () => {
    mixedTotalOnlyUsage();
    const view = mount();
    await userEvent.click(view.getByRole("tab", { name: "Models" }));
    const table = view.getByRole("table", { name: "Tokens and estimated cost by type, all models" });
    const total = within(table).getByRole("rowheader", { name: "Total" }).closest("tr")!;
    expect(total.querySelector("td strong")).toHaveTextContent("200");
    expect(within(table).getByRole("rowheader", { name: /^Unclassified tokens/ }).closest("tr")).toHaveTextContent("100Unpriced0%");
  });

  it("does not hypothetically price a model's total-only receipt as a free request", async () => {
    mixedTotalOnlyUsage();
    const view = mount();
    await userEvent.click(view.getByRole("tab", { name: "Compare" }));
    const whatIf = view.getByText("Hypothetical: re-price at current standard rates").closest("details")!;
    await userEvent.click(whatIf.querySelector("summary")!);
    expect(view.getByRole("region", { name: "Compare models" })).toHaveTextContent("Some recorded tokens have no reported input/output type");
    expect(whatIf).not.toHaveTextContent("GPT-6 Luna’s usage at GPT-6 Sol rates");
  });
});
