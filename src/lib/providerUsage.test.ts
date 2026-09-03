import { describe, expect, it } from "vitest";
import {
  clampUsedPercent,
  compactResetLabel,
  displayedPercent,
  formatRateLimits,
  formatCreditAmount,
  formatResetTime,
  formatWindowLabel,
  parseCodexRateLimits,
  providerAccountUsage,
  providerHeaderUsage,
  sanitizeUsageDisplay,
  sanitizeHeaderUsageWindows,
  usagePercentLabel,
} from "./providerUsage";
import { DEFAULT_SETTINGS } from "./appConfig";
import type { AppSettings } from "../types";

const connectedClaude = {
  available: true,
  path: "/bin/claude",
  version: "2.1.238",
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

/** 2026-08-21T14:00:00Z, so "same local day" holds in every test timezone. */
const NOW = Date.UTC(2026, 7, 21, 14, 0, 0);
const resetAt = (offsetMinutes: number) => Math.floor(NOW / 1000) + offsetMinutes * 60;

describe("usage percentage normalization", () => {
  it("clamps provider percentages into 0–100", () => {
    expect(clampUsedPercent(42)).toBe(42);
    expect(clampUsedPercent(-3)).toBe(0);
    expect(clampUsedPercent(140)).toBe(100);
    expect(clampUsedPercent("42.5")).toBe(42.5);
  });

  it("treats unusable values as no consumption rather than throwing", () => {
    expect(clampUsedPercent(undefined)).toBe(0);
    expect(clampUsedPercent(null)).toBe(0);
    expect(clampUsedPercent("not a number")).toBe(0);
    expect(clampUsedPercent(Number.NaN)).toBe(0);
    expect(clampUsedPercent(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it("flips consumed into remaining", () => {
    expect(displayedPercent(42, "consumed")).toBe(42);
    expect(displayedPercent(42, "remaining")).toBe(58);
    expect(displayedPercent(0, "remaining")).toBe(100);
    expect(displayedPercent(100, "remaining")).toBe(0);
  });

  it("flips after clamping, so an over-range percentage cannot go negative", () => {
    expect(displayedPercent(140, "remaining")).toBe(0);
    expect(displayedPercent(-10, "remaining")).toBe(100);
    expect(displayedPercent(-10, "consumed")).toBe(0);
  });

  it("keeps both directions of one window adding up to 100", () => {
    for (const used of [0, 0.4, 12.5, 42.5, 66.6, 99.9, 100]) {
      expect(displayedPercent(used, "consumed") + displayedPercent(used, "remaining")).toBe(100);
    }
  });

  it("labels each direction with its own word", () => {
    expect(usagePercentLabel(42, "remaining")).toBe("58% left");
    expect(usagePercentLabel(42, "consumed")).toBe("42% used");
  });
});

describe("usage display preference persistence", () => {
  it("defaults to remaining", () => {
    expect(DEFAULT_SETTINGS.usageDisplay).toBe("remaining");
  });

  it("keeps settings saved before the preference existed on the default", () => {
    const legacy: Partial<AppSettings> = { theme: "kiwi", provider: "openai" };
    expect(sanitizeUsageDisplay(legacy.usageDisplay)).toBe("remaining");
  });

  it("restores an explicitly chosen direction", () => {
    expect(sanitizeUsageDisplay("consumed")).toBe("consumed");
    expect(sanitizeUsageDisplay("remaining")).toBe("remaining");
  });

  it("falls back to remaining for a corrupted stored value", () => {
    expect(sanitizeUsageDisplay("used")).toBe("remaining");
    expect(sanitizeUsageDisplay(7)).toBe("remaining");
    expect(sanitizeUsageDisplay(null)).toBe("remaining");
  });
});

describe("rate limit window formatting", () => {
  it("names windows from their length in minutes", () => {
    expect(formatWindowLabel(300)).toBe("5h");
    expect(formatWindowLabel(60)).toBe("1h");
    expect(formatWindowLabel(30)).toBe("30m");
    expect(formatWindowLabel(1440)).toBe("Daily");
    expect(formatWindowLabel(10080)).toBe("Weekly");
    expect(formatWindowLabel(20160)).toBe("2w");
  });

  it("has no name for a window the provider did not measure", () => {
    expect(formatWindowLabel(undefined)).toBe("");
    expect(formatWindowLabel(0)).toBe("");
    expect(formatWindowLabel(-5)).toBe("");
  });

  it("shows a same-day reset as a bare time and a later one with its weekday", () => {
    expect(formatResetTime(resetAt(60), NOW)).toMatch(/\d/);
    expect(formatResetTime(resetAt(60), NOW)).not.toMatch(/[A-Za-z]{3}/);
    expect(formatResetTime(resetAt(60 * 24 * 3), NOW)).toMatch(/[A-Za-z]{3}/);
  });

  it("omits a reset the provider did not report", () => {
    expect(formatResetTime(null, NOW)).toBe("");
    expect(formatResetTime(0, NOW)).toBe("");
    expect(formatResetTime(undefined, NOW)).toBe("");
  });

  it("uses a provider-local reset label when no numeric timestamp is available", () => {
    expect(formatRateLimits({
      windows: [{
        label: "5h",
        usedPercent: 42,
        resetsAt: null,
        resetLabel: "Aug 21 at 11:29pm (America/New_York)",
      }],
    }, "remaining", NOW)).toBe("58% left · resets Aug 21 at 11:29pm (America/New_York)");
  });

  it("compacts a provider-local reset label for the quota card", () => {
    expect(compactResetLabel("Aug 21 at 11:29pm (America/New_York)"))
      .toBe("Aug 21 · 11:29 PM");
    expect(compactResetLabel("Aug 21 at 11:29pm (America/Argentina/Buenos_Aires)"))
      .toBe("Aug 21 · 11:29 PM");
  });

  it("labels windows only when more than one is reported", () => {
    const single = { windows: [{ label: "5h", usedPercent: 42, resetsAt: null }] };
    expect(formatRateLimits(single, "remaining", NOW)).toBe("58% left");
    const both = {
      windows: [
        { label: "5h", usedPercent: 42, resetsAt: null },
        { label: "Weekly", usedPercent: 10, resetsAt: null },
      ],
    };
    expect(formatRateLimits(both, "remaining", NOW)).toBe("5h 58% left · Weekly 90% left");
    expect(formatRateLimits(both, "consumed", NOW)).toBe("5h 42% used · Weekly 10% used");
  });

  it("renders nothing when there is no window to describe", () => {
    expect(formatRateLimits(null, "remaining", NOW)).toBe("");
    expect(formatRateLimits({ windows: [] }, "remaining", NOW)).toBe("");
  });
});

describe("codex rate limit parsing", () => {
  it("reads both windows with their lengths and resets", () => {
    expect(parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 42.4, windowMinutes: 300, resetsAt: resetAt(90) },
        secondary: { usedPercent: 9, windowMinutes: 10080, resetsAt: resetAt(60 * 24 * 4) },
      },
    })).toEqual({
      windows: [
        { label: "5h", usedPercent: 42.4, resetsAt: resetAt(90) },
        { label: "Weekly", usedPercent: 9, resetsAt: resetAt(60 * 24 * 4) },
      ],
    });
  });

  it("keeps a window that reports no length or reset", () => {
    expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 0 } } })).toEqual({
      windows: [{ label: "", usedPercent: 0, resetsAt: null }],
    });
  });

  it("clamps an out-of-range percentage at the parse boundary", () => {
    expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 105 } } })).toEqual({
      windows: [{ label: "", usedPercent: 100, resetsAt: null }],
    });
  });

  it("returns null when the runtime reports no active window", () => {
    expect(parseCodexRateLimits({ rateLimits: {} })).toBeNull();
    expect(parseCodexRateLimits({ rateLimits: { primary: null } })).toBeNull();
    expect(parseCodexRateLimits({})).toBeNull();
    expect(parseCodexRateLimits(null)).toBeNull();
    expect(parseCodexRateLimits("nonsense")).toBeNull();
  });
});

describe("provider account usage", () => {
  const openAiLimits = { windows: [{ label: "5h", usedPercent: 42, resetsAt: null }] };

  it("shows OpenAI rate limits only for OpenAI", () => {
    expect(providerAccountUsage("openai", {
      openAiRateLimits: openAiLimits,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      now: NOW,
    })).toEqual({
      label: "OpenAI subscription",
      summary: "58% left",
      windows: [{ label: "5h", percent: 58, percentLabel: "58% left", resetLabel: "", resetsAt: null }],
    });
  });

  it("defaults to remaining when no preference is supplied", () => {
    expect(providerAccountUsage("openai", {
      openAiRateLimits: openAiLimits,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      now: NOW,
    }).summary).toBe("58% left");
  });

  it("applies the consumed preference to OpenAI limits", () => {
    expect(providerAccountUsage("openai", {
      openAiRateLimits: openAiLimits,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      usageDisplay: "consumed",
      now: NOW,
    })).toEqual({
      label: "OpenAI subscription",
      summary: "42% used",
      windows: [{ label: "5h", percent: 42, percentLabel: "42% used", resetLabel: "", resetsAt: null }],
    });
  });

  it("tells a failed limit read apart from an empty one", () => {
    expect(providerAccountUsage("openai", {
      openAiRateLimits: null,
      openAiRateLimitsRead: true,
      claudeStatus: connectedClaude,
      openRouterReady: true,
    }).summary).toBe("No active limit window");
    expect(providerAccountUsage("openai", {
      openAiRateLimits: null,
      openAiRateLimitsRead: false,
      claudeStatus: connectedClaude,
      openRouterReady: true,
    }).summary).toBe("Sign in to view live limits");
    expect(providerAccountUsage("openai", {
      openAiRateLimits: null,
      openAiRateLimitsRead: false,
      openAiConnected: true,
      claudeStatus: connectedClaude,
      openRouterReady: true,
    }).summary).toBe("Live usage is temporarily unavailable");
  });

  it("applies the same preference to Claude limits", () => {
    const claudeLimits = {
      windows: [
        { label: "5h", usedPercent: 42, resetsAt: null },
        { label: "Weekly", usedPercent: 10, resetsAt: null },
      ],
    };
    expect(providerAccountUsage("claude", {
      openAiRateLimits: null,
      claudeStatus: connectedClaude,
      claudeRateLimits: claudeLimits,
      openRouterReady: true,
      now: NOW,
    }).summary).toBe("Max plan · 5h 58% left · Weekly 90% left");
    expect(providerAccountUsage("claude", {
      openAiRateLimits: null,
      claudeStatus: connectedClaude,
      claudeRateLimits: claudeLimits,
      openRouterReady: true,
      usageDisplay: "consumed",
      now: NOW,
    }).summary).toBe("Max plan · 5h 42% used · Weekly 10% used");
  });

  it("never leaks OpenAI rate limits into a Claude thread", () => {
    const view = providerAccountUsage("claude", {
      openAiRateLimits: openAiLimits,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      usageDisplay: "consumed",
      now: NOW,
    });
    expect(view).toEqual({
      label: "Claude subscription",
      summary: "Max plan connected · live limits are managed by Claude Code",
    });
    expect(view.summary).not.toContain("42%");
    expect(view.summary).not.toContain("58%");
  });

  it("uses a neutral status while Claude Code is still being checked", () => {
    expect(providerAccountUsage("claude", {
      openAiRateLimits: openAiLimits,
      claudeStatus: null,
      openRouterReady: true,
    })).toEqual({
      label: "Claude subscription",
      summary: "Checking Claude Code…",
    });
  });

  it("describes OpenRouter as pay-as-you-go usage", () => {
    expect(providerAccountUsage("openrouter", {
      openAiRateLimits: openAiLimits,
      claudeStatus: connectedClaude,
      openRouterReady: true,
    })).toEqual({
      label: "OpenRouter usage",
      summary: "Pay as you go · tracked spend appears below",
    });
  });

  it("shows the connected Cursor subscription without OpenAI limits", () => {
    const view = providerAccountUsage("cursor", {
      openAiRateLimits: openAiLimits,
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

describe("chat header provider usage", () => {
  it("stays visible and points unauthenticated providers toward connection settings", () => {
    expect(providerHeaderUsage("openai", {
      label: "OpenAI subscription",
      summary: "Sign in to view live limits",
    })).toEqual({
      text: "Sign in for usage",
      title: "OpenAI subscription · Sign in to view live limits",
      needsConnection: true,
    });
    expect(providerHeaderUsage("claude", {
      label: "Claude subscription",
      summary: "Install Claude Code to view this account",
    })).toEqual({
      text: "Connect Claude",
      title: "Claude subscription · Install Claude Code to view this account",
      needsConnection: true,
    });
  });

  it("uses the already-normalized Codex and Claude quota direction", () => {
    const view = providerAccountUsage("openai", {
      openAiRateLimits: { windows: [
        { label: "5h", usedPercent: 42, resetsAt: null },
        { label: "Weekly", usedPercent: 10, resetsAt: null },
      ] },
      claudeStatus: connectedClaude,
      openRouterReady: true,
      usageDisplay: "consumed",
      now: NOW,
    });
    expect(providerHeaderUsage("openai", view)?.text).toBe("5h 42% used");
    expect(providerHeaderUsage("openai", view, { selectedWindow: "Weekly" })?.text).toBe("Weekly 10% used");
    expect(providerHeaderUsage("openai", view, { selectedWindow: "Removed limit" })?.text).toBe("5h 42% used");
  });

  it("sanitizes independent provider selections without persisting unknown providers", () => {
    expect(sanitizeHeaderUsageWindows(null)).toEqual({});
    expect(sanitizeHeaderUsageWindows(["Weekly"])).toEqual({});
    expect(sanitizeHeaderUsageWindows({ openai: " Weekly ", claude: "Weekly Fable", cursor: "5h" })).toEqual({ openai: "Weekly", claude: "Weekly Fable" });
    expect(sanitizeHeaderUsageWindows({ openai: 42, claude: "x".repeat(121) })).toEqual({});
  });

  it("makes equal-duration provider windows independently selectable", () => {
    const view = providerAccountUsage("openai", {
      openAiRateLimits: { windows: [{ label: "Weekly", usedPercent: 10, resetsAt: null }, { label: "Weekly", usedPercent: 70, resetsAt: null }] },
      claudeStatus: null, openRouterReady: false,
    });
    expect(view.windows?.map((window) => window.label)).toEqual(["Weekly", "Weekly (2)"]);
    expect(providerHeaderUsage("openai", view, { selectedWindow: "Weekly (2)" })?.text).toBe("Weekly (2) 30% left");
  });

  it("keeps every quota selectable even when provider labels collide with generated suffixes", () => {
    const view = providerAccountUsage("openai", {
      openAiRateLimits: { windows: ["Weekly", "Weekly", "Weekly (2)", "Weekly"].map((label, index) => ({ label, usedPercent: index * 10, resetsAt: null })) },
      claudeStatus: null, openRouterReady: false,
    });
    expect(new Set(view.windows?.map((window) => window.label)).size).toBe(4);
    view.windows?.forEach((window, index) => {
      expect(providerHeaderUsage("openai", view, { selectedWindow: window.label })?.text).toBe(`${window.label} ${100 - index * 10}% left`);
    });
  });

  it("shows authoritative OpenRouter account credits without calling estimates credits", () => {
    const balance = { remaining: 74.75, used: 25.75, source: "account" as const };
    const account = providerAccountUsage("openrouter", {
      openAiRateLimits: null,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      openRouterCredits: balance,
      openRouterCreditsRead: true,
    });
    expect(account).toEqual({ label: "OpenRouter credits", summary: "$74.75 credits left" });
    expect(providerHeaderUsage("openrouter", account, {
      openRouterReady: true,
      openRouterCredits: balance,
      openRouterCreditsRead: true,
    })).toEqual({
      text: "$74.75 credits left",
      title: "OpenRouter account · $74.75 credits left",
    });
  });

  it("labels a regular API key's cap as a key limit", () => {
    const account = { label: "OpenRouter usage", summary: "Pay as you go" };
    expect(providerHeaderUsage("openrouter", account, {
      openRouterReady: true,
      openRouterCredits: { remaining: 3.5, used: 1.5, source: "keyLimit" },
      openRouterCreditsRead: true,
    })?.text).toBe("$3.50 key limit left");
  });

  it("does not mistake an OpenRouter network failure for an unsupported key", () => {
    const account = providerAccountUsage("openrouter", {
      openAiRateLimits: null,
      claudeStatus: connectedClaude,
      openRouterReady: true,
      openRouterCreditsRead: true,
      openRouterCreditsError: "Could not reach OpenRouter usage: connection timed out",
    });
    expect(account.summary).toBe("Credits are temporarily unavailable · try refreshing usage");
    expect(providerHeaderUsage("openrouter", account, {
      openRouterReady: true,
      openRouterCreditsRead: true,
      openRouterCreditsError: "Could not reach OpenRouter usage: connection timed out",
    })?.title).toBe("OpenRouter credits are temporarily unavailable. Try refreshing usage.");
  });

  it("formats tiny balances without rounding them away", () => {
    expect(formatCreditAmount(0)).toBe("$0");
    expect(formatCreditAmount(0.0049)).toBe("$0.0049");
  });
});
