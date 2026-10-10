import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierPricingEntry, FrontierPricingProvider } from "../lib/frontierPricing";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn(), hook: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../hooks/useFrontierPricing", () => ({ useFrontierPricing: mocks.hook }));

import { FrontierPricingSettings, FrontierPricingView, longContextCondition } from "./FrontierPricingSettings";

const VERIFIED = Date.UTC(2026, 9, 8, 15, 30);
const DAY = "2026-10-08";

const HAIKU: FrontierPricingEntry = {
  id: "claude-haiku-5-5", provider: "anthropic", name: "Claude Haiku 5.5", asOf: DAY,
  inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1, cacheWriteInputPerMillion: 1.25, cacheWrite1hInputPerMillion: 2,
  longContext: { inputPerMillion: 2, outputPerMillion: 7.5, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5, cacheWrite1hInputPerMillion: 4 },
  longContextThresholdTokens: 100_000,
};
const OPUS: FrontierPricingEntry = {
  id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6", asOf: "2026-09-01", status: "retired",
  inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5, cacheWriteInputPerMillion: 6.25, cacheWrite1hInputPerMillion: 10,
};
const GPT: FrontierPricingEntry = {
  id: "gpt-5.6", provider: "openai", name: "gpt-5.6", asOf: DAY,
  inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125,
  longContext: { inputPerMillion: 2.5, outputPerMillion: 15 }, longContextThresholdTokens: 272_000,
};
const SPECIALIZED: FrontierPricingEntry = {
  id: "gpt-5.6-search", provider: "openai", name: "gpt-5.6-search", asOf: DAY,
  inputPerMillion: 2, outputPerMillion: 8, longContext: { inputPerMillion: 4, outputPerMillion: 16 },
};

const provider = (id: "openai" | "anthropic", overrides: Partial<FrontierPricingProvider> = {}): FrontierPricingProvider => ({
  provider: id, sourceUrl: id === "openai" ? "https://developers.openai.com/api/docs/pricing" : "https://platform.claude.com/docs/en/about-claude/pricing",
  checkedAt: VERIFIED, verifiedAt: VERIFIED, checking: false, models: id === "openai" ? 2 : 2, ...overrides,
});

function view(overrides: Partial<Parameters<typeof FrontierPricingView>[0]> = {}) {
  const props = {
    entries: [HAIKU, OPUS, GPT, SPECIALIZED], providers: [provider("anthropic"), provider("openai")],
    checking: false, onRefresh: vi.fn(async () => undefined), ...overrides,
  };
  render(<FrontierPricingView {...props} />);
  return props;
}

const table = (name: string) => screen.getByRole("table", { name });
/** A table row by its row header's text, which is what a reader scans for. */
const rowFor = (header: RegExp) => {
  const row = screen.getAllByRole("row").find((candidate) => header.test(candidate.querySelector("th[scope=row]")?.textContent ?? ""));
  if (!row) throw new Error(`No row whose header matches ${header}`);
  return row;
};

describe("Model pricing settings", () => {
  beforeEach(() => { mocks.openUrl.mockReset(); mocks.hook.mockReset(); });

  it("lists published standard rates per 1M tokens with Anthropic's 5-minute and 1-hour cache writes", () => {
    view();
    const haiku = rowFor(/^Claude Haiku 5\.5/);
    expect(within(haiku).getByText("$1.00")).toBeInTheDocument();
    expect(within(haiku).getByText("$0.10")).toBeInTheDocument();
    expect(within(haiku).getByText("$1.25")).toBeInTheDocument();
    expect(within(haiku).getByText("$2.00")).toBeInTheDocument();
    expect(within(haiku).getByText("$5.00")).toBeInTheDocument();
    expect(within(haiku).getByText("5m")).toBeInTheDocument();
    expect(within(haiku).getByText("1h")).toBeInTheDocument();
    expect(screen.getByText(/not Claude or ChatGPT subscription allowances/)).toBeInTheDocument();
    expect(screen.getByText(/nothing here changes your selected model/)).toBeInTheDocument();
  });

  it("shows unpublished rates as Not published, never $0", () => {
    view();
    const gpt = rowFor(/^gpt-5\.6\s*Standard context/);
    expect(within(gpt).getByText("Not published")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("keeps long-context rates as a labelled secondary row with the published threshold", () => {
    view();
    const long = rowFor(/^Long context for Claude Haiku 5\.5/);
    expect(within(long).getByText("Prompts over 100K tokens")).toBeInTheDocument();
    expect(within(long).getByText("$7.50")).toBeInTheDocument();
    expect(within(rowFor(/^Long context for gpt-5\.6\s*Prompts/)).getByText("Prompts over 272K tokens")).toBeInTheDocument();
    // A standard row never takes the long-context rate.
    expect(within(rowFor(/^Claude Haiku 5\.5/)).queryByText("$7.50")).not.toBeInTheDocument();
  });

  it("does not guess a long-context threshold the source did not publish", () => {
    expect(longContextCondition(SPECIALIZED)).toBeUndefined();
    expect(longContextCondition({ ...SPECIALIZED, longContextThresholdTokens: 0 })).toBeUndefined();
    expect(longContextCondition({ ...SPECIALIZED, longContextThresholdTokens: 1_000_000 })).toBe("Prompts over 1M tokens");
    view();
    expect(within(rowFor(/^Long context for gpt-5\.6-search/)).getByText("Applies above the threshold on the pricing page")).toBeInTheDocument();
  });

  it("filters by company and searches by name or id", () => {
    view();
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI" }));
    expect(screen.queryByRole("table", { name: "Anthropic" })).not.toBeInTheDocument();
    expect(table("OpenAI")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "haiku" } });
    expect(within(table("Anthropic")).queryByText("Claude Opus 4.6")).not.toBeInTheDocument();
    expect(within(table("Anthropic")).getByText("Claude Haiku 5.5")).toBeInTheDocument();
    expect(screen.getByText("No OpenAI models match “haiku”.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "claude-opus-4-6" } });
    expect(within(table("Anthropic")).getByText("Claude Opus 4.6")).toBeInTheDocument();
    expect(within(rowFor(/^Claude Opus 4\.6/)).getByText("Retired")).toBeInTheDocument();
    expect(within(rowFor(/^Claude Opus 4\.6/)).getByText(/^Last listed/)).toBeInTheDocument();
  });

  it("shows a refresh in progress and blocks a second press", async () => {
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    view({ onRefresh });
    fireEvent.click(screen.getByRole("button", { name: "Refresh prices" }));
    const busy = screen.getByRole("button", { name: "Checking…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    fireEvent.click(busy);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "Refresh prices" })).toBeEnabled();
  });

  it("keeps cached rates visible when a refresh fails, with honest timestamps", async () => {
    view({
      onRefresh: vi.fn(async () => { throw new Error("offline"); }),
      providers: [
        provider("anthropic", { checkedAt: VERIFIED + 3_600_000, error: "Could not reach the pricing page" }),
        provider("openai", { checkedAt: undefined, verifiedAt: undefined, models: 0 }),
      ],
    });
    expect(screen.getByText(/^Couldn’t verify .* · showing rates verified/)).toBeInTheDocument();
    expect(screen.getByText("Could not reach the pricing page")).toBeInTheDocument();
    expect(screen.getAllByText("Not checked yet")).toHaveLength(1);
    expect(screen.queryByText(/verified today/)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh prices" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t refresh pricing. Previously verified rates are still shown.");
    expect(table("Anthropic")).toBeInTheDocument();
  });

  it("says when no verified rates exist instead of showing an empty table", () => {
    view({ entries: [], providers: [provider("anthropic", { verifiedAt: undefined, error: "Claude's model pricing columns changed" }), provider("openai", { checking: true })], checking: false });
    expect(screen.getByText("No verified Anthropic rates saved yet. Refresh to read the official pricing page.")).toBeInTheDocument();
    expect(screen.getByText(/no verified rates saved yet$/)).toBeInTheDocument();
    expect(screen.getByText("Reading OpenAI’s pricing page…")).toBeInTheDocument();
  });

  it.each(["verificationTimeUncertain", "checkedTimeUncertain"] as const)("keeps saved rates readable without claiming a future verification when %s", (flag) => {
    const future = Date.UTC(2099, 0, 1, 12);
    view({ providers: [provider("anthropic", { checkedAt: future, verifiedAt: future, [flag]: true }), provider("openai")] });
    expect(screen.getByText("Saved rates · verification time is uncertain. Refresh to check the official page.")).toBeInTheDocument();
    expect(table("Anthropic")).toHaveTextContent("Claude Haiku 5.5");
    expect(table("Anthropic")).toHaveTextContent("$1.25");
    expect(screen.queryByText(/2099/)).not.toBeInTheDocument();
    expect(within(table("Anthropic")).queryByText(/^Last listed/)).not.toBeInTheDocument();
  });

  it("retains the source error and saved rates when verification time is uncertain", () => {
    const future = Date.UTC(2099, 0, 1, 12);
    view({ providers: [provider("anthropic", { checkedAt: future, verifiedAt: future, verificationTimeUncertain: true, checkedTimeUncertain: true, error: "Could not reach the official page" }), provider("openai")] });
    expect(screen.getByText("Couldn’t verify · showing saved rates; verification time is uncertain. Refresh to check the official page.")).toBeInTheDocument();
    expect(screen.getByText("Could not reach the official page")).toBeInTheDocument();
    expect(screen.queryByText(/2099/)).not.toBeInTheDocument();
    expect(table("Anthropic")).toHaveTextContent("Claude Haiku 5.5");
  });

  it("does not invent saved rates for an empty listing with uncertain time", () => {
    view({ entries: [], providers: [provider("anthropic", { models: 0, verificationTimeUncertain: true })] });
    expect(screen.getByText("No verified rates saved · verification time is uncertain. Refresh to check the official page.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("opens only https source pages through the app's link opener", () => {
    view({ providers: [provider("anthropic"), provider("openai", { sourceUrl: "javascript:alert(1)" })] });
    fireEvent.click(screen.getByRole("button", { name: "Anthropic pricing page" }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://platform.claude.com/docs/en/about-claude/pricing");
    expect(screen.queryByRole("button", { name: "OpenAI pricing page" })).not.toBeInTheDocument();
  });

  it("reads the hook without refreshing on mount; the button uses its shared forced refresh", () => {
    const refresh = vi.fn(async () => ({ checked: [], failed: [] }));
    mocks.hook.mockReturnValue({ entries: [GPT], providers: [provider("openai")], checking: false, refresh });
    render(<FrontierPricingSettings />);
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh prices" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the account model catalog only on click and reports its failure separately from successful prices", async () => {
    const refresh = vi.fn(async () => ({ checked: ["openai"], failed: [] }));
    const models = vi.fn(async () => { throw new Error("OpenAI: runtime is busy. Previous models retained."); });
    mocks.hook.mockReturnValue({ entries: [GPT], providers: [provider("openai")], checking: false, refresh });
    render(<FrontierPricingSettings onRefreshAvailableModels={models} />);
    expect(models).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh prices" })); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(models).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Available models could not be refreshed. OpenAI: runtime is busy.");
    expect(screen.queryByText(/Couldn’t refresh pricing/)).not.toBeInTheDocument();
    expect(table("OpenAI")).toHaveTextContent("gpt-5.6");
  });
});
