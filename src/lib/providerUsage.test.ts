import { describe, expect, it } from "vitest";
import { providerAccountUsage } from "./providerUsage";

const connectedClaude = {
  available: true,
  path: "/bin/claude",
  version: "2.1.220",
  loggedIn: true,
  authMethod: "claude.ai",
  email: null,
  subscriptionType: "max",
  warning: null,
};

const connectedCursor = {
  available: true,
  path: "/bin/cursor-agent",
  version: "2026.07.23",
  loggedIn: true,
  email: "person@example.com",
  subscriptionType: "Pro",
  warning: null,
};

describe("provider account usage", () => {
  it("shows OpenAI rate limits only for OpenAI", () => {
    expect(providerAccountUsage("openai", {
      openAiRateSummary: "42% used",
      claudeStatus: connectedClaude,
      openRouterReady: true,
    })).toEqual({ label: "OpenAI subscription", summary: "42% used" });
  });

  it("never leaks OpenAI rate limits into a Claude thread", () => {
    const view = providerAccountUsage("claude", {
      openAiRateSummary: "42% used",
      claudeStatus: connectedClaude,
      openRouterReady: true,
    });
    expect(view).toEqual({
      label: "Claude subscription",
      summary: "Max plan connected · live limits are managed by Claude Code",
    });
    expect(view.summary).not.toContain("42%");
  });

  it("uses a neutral status while Claude Code is still being checked", () => {
    expect(providerAccountUsage("claude", {
      openAiRateSummary: "42% used",
      claudeStatus: null,
      openRouterReady: true,
    })).toEqual({
      label: "Claude subscription",
      summary: "Checking Claude Code…",
    });
  });

  it("describes OpenRouter as pay-as-you-go usage", () => {
    expect(providerAccountUsage("openrouter", {
      openAiRateSummary: "42% used",
      claudeStatus: connectedClaude,
      openRouterReady: true,
    })).toEqual({
      label: "OpenRouter usage",
      summary: "Pay as you go · tracked spend appears below",
    });
  });

  it("shows the connected Cursor subscription without OpenAI limits", () => {
    const view = providerAccountUsage("cursor", {
      openAiRateSummary: "42% used",
      claudeStatus: connectedClaude,
      cursorStatus: connectedCursor,
      openRouterReady: true,
    });
    expect(view).toEqual({
      label: "Cursor subscription",
      summary: "Pro connected · live usage and limits are managed by Cursor",
    });
    expect(view.summary).not.toContain("42%");
  });
});
