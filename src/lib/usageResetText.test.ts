import { describe, expect, it } from "vitest";
import { providerAccountUsage, usageResetText } from "./providerUsage";

const now = Date.UTC(2026, 8, 3, 2, 14);
const window = { label: "5h", percent: 17, percentLabel: "17% used", resetLabel: "11:10 PM" };
describe("usage reset countdown", () => {
  it.each([[134, "2h 14m"], [60, "1h 0m"], [56, "56m"], [0.5, "1m"]])("formats %s minutes without a zero/negative countdown", (minutes, expected) => {
    expect(usageResetText({ ...window, resetsAt: now / 1000 + Number(minutes) * 60 }, now)).toBe(`Resets in ${expected}`);
  });
  it("does not imply expired snapshot quotas have reset", () => {
    expect(usageResetText({ ...window, resetsAt: now / 1000 }, now)).toBe("Awaiting usage update");
    expect(usageResetText({ ...window, resetsAt: now / 1000 - 86_400 }, now)).toBe("Awaiting usage update");
  });
  it("keeps weekly limits absolute and missing/invalid deadlines honest", () => {
    const resetsAt = now / 1000 + 60;
    expect(usageResetText({ ...window, label: "Weekly", resetsAt }, now)).toBe("Resets 11:10 PM");
    expect(usageResetText({ ...window, label: "Weekly Fable", resetsAt }, now)).toBe("Resets 11:10 PM");
    for (const invalid of [undefined, null, NaN, Infinity, 1e20, -1, 0]) {
      expect(usageResetText({ ...window, resetsAt: invalid }, now)).toBe("Resets 11:10 PM");
    }
    expect(usageResetText({ ...window, resetLabel: "" }, now)).toBe("Reset time unavailable");
  });
  it("preserves the Codex timestamp through the account view and handles duplicate short windows", () => {
    const account = providerAccountUsage("openai", { openAiRateLimits: { windows: [
      { label: "5h", usedPercent: 17, resetsAt: now / 1000 + 60 },
      { label: "5h", usedPercent: 20, resetsAt: now / 1000 + 120 },
    ] }, claudeStatus: null, openRouterReady: false, now });
    expect(account.windows?.[0].resetsAt).toBe(now / 1000 + 60);
    expect(usageResetText(account.windows![1], now)).toBe("Resets in 2m");
  });
});
