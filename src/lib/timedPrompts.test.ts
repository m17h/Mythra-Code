import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueuedTurn } from "./taskStore";
import {
  eligibleQueueHead,
  eligibleQueuedTurns,
  hasEligibleQueuedTurns,
  nextTimedStateChangeDelay,
  parseLocalDateTime,
  pendingTimedTurns,
  TIMED_PROMPT_CONTINUITY_TOLERANCE_MS,
  TIMED_PROMPT_MAX_TIMER_MS,
  timedClockDecision,
  timedPromptState,
} from "./timedPrompts";

declare const process: { env: Record<string, string | undefined> };

// DST rules are only testable in a zone that observes them.
const originalTimeZone = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

function entry(id: string, patch: Partial<QueuedTurn> = {}): QueuedTurn {
  return { id, threadId: "t", text: id, attachments: [], createdAt: 0, status: "queued", ...patch };
}

describe("parseLocalDateTime", () => {
  const now = Date.UTC(2026, 9, 3, 12, 0); // Oct 3 2026, 08:00 in New York

  it("resolves a future local wall time to one instant", () => {
    const result = parseLocalDateTime("2026-10-04", "09:30", now);
    expect(result).toEqual({ ok: true, deliverAt: Date.UTC(2026, 9, 4, 13, 30) });
  });

  it("rejects past, current-minute, malformed and impossible dates", () => {
    expect(parseLocalDateTime("2026-10-03", "07:59", now)).toMatchObject({ ok: false, reason: "past" });
    expect(parseLocalDateTime("2026-10-03", "08:00", now)).toMatchObject({ ok: false, reason: "past" });
    expect(parseLocalDateTime("2026-02-30", "09:00", now)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseLocalDateTime("tomorrow", "09:00", now)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseLocalDateTime("2026-10-04", "25:00", now)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects a wall time skipped by the spring daylight-saving change", () => {
    // 2027-03-14 02:30 does not exist in New York.
    expect(parseLocalDateTime("2027-03-14", "02:30", now)).toMatchObject({ ok: false, reason: "nonexistent" });
    expect(parseLocalDateTime("2027-03-14", "03:30", now)).toMatchObject({ ok: true });
  });

  it("rejects a wall time repeated by the autumn daylight-saving change", () => {
    // 2026-11-01 01:30 happens twice in New York.
    expect(parseLocalDateTime("2026-11-01", "01:30", now)).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(parseLocalDateTime("2026-11-01", "02:30", now)).toEqual({ ok: true, deliverAt: Date.UTC(2026, 10, 1, 7, 30) });
  });
});

describe("eligible FIFO", () => {
  it("excludes pending timed prompts so regular prompts never wait behind them", () => {
    const entries = [entry("timed", { deliverAt: 5_000 }), entry("regular", { createdAt: 10 })];
    expect(eligibleQueuedTurns(entries).map((item) => item.id)).toEqual(["regular"]);
    expect(eligibleQueueHead(entries)?.id).toBe("regular");
    expect(hasEligibleQueuedTurns([entry("timed", { deliverAt: 5_000 })])).toBe(false);
    expect(pendingTimedTurns(entries).map((item) => item.id)).toEqual(["timed"]);
  });

  it("places a released prompt by when it became due, behind work already waiting", () => {
    const entries = [
      entry("timed", { createdAt: 1, deliverAt: 500, releasedAt: 500 }),
      entry("held-failed", { createdAt: 100, status: "failed" }),
      entry("later", { createdAt: 900 }),
    ];
    expect(eligibleQueuedTurns(entries).map((item) => item.id)).toEqual(["held-failed", "timed", "later"]);
    expect(eligibleQueueHead(entries)?.id).toBe("held-failed");
  });

  it("sorts pending prompts soonest first without a count cap", () => {
    const many = Array.from({ length: 250 }, (_, index) => entry(`t${index}`, { deliverAt: 10_000 - index }));
    expect(pendingTimedTurns(many)).toHaveLength(250);
    expect(pendingTimedTurns(many)[0].id).toBe("t249");
  });
});

describe("timedClockDecision", () => {
  const gap = TIMED_PROMPT_MAX_TIMER_MS + TIMED_PROMPT_CONTINUITY_TOLERANCE_MS;

  it("waits until the delivery time and never releases early", () => {
    expect(timedClockDecision(1_000, 999, 900)).toBe("wait");
  });

  it("misses a short sleep that crossed the deadline", () => {
    expect(timedClockDecision(10_000, 20_000, 0)).toBe("miss");
    expect(timedClockDecision(30_000, 85_000, 0)).toBe("miss");
  });

  it("releases when the time passed during a continuously awake interval, despite jitter", () => {
    expect(timedClockDecision(60_000, 60_007, 1)).toBe("release");
    expect(timedClockDecision(60_000, 61_000, 30_000)).toBe("release");
    expect(timedClockDecision(60_000, 61_001, 30_000)).toBe("miss");
  });

  it("misses anything already due at the first check after launch, even seconds late", () => {
    expect(timedClockDecision(10_000, 13_000, null)).toBe("miss");
  });

  it("misses a time that passed inside a suspended gap such as sleep", () => {
    expect(timedClockDecision(100_000, 99_000 + gap + 1, 99_000)).toBe("miss");
    expect(timedClockDecision(100_000, 99_000 + gap, 99_000)).toBe("miss");
    expect(timedClockDecision(100_000, 3_600_000, 50_000)).toBe("miss");
  });

  it("holds even a barely overdue prompt when the monotonic clock reveals suspension", () => {
    expect(timedClockDecision(10_000, 10_005, 0, undefined, 5)).toBe("miss");
    expect(timedClockDecision(10_000, 10_005, 0, undefined, 10_005)).toBe("release");
  });

  it("misses an entry that was already due at the previous check but could not be released", () => {
    expect(timedClockDecision(10_000, 40_000, 20_000)).toBe("miss");
  });
});

describe("row state", () => {
  it("reports scheduled, transient due, and persisted missed states", () => {
    expect(timedPromptState({ deliverAt: 2_000 }, 1_000)).toBe("scheduled");
    expect(timedPromptState({ deliverAt: 2_000 }, 3_000)).toBe("due");
    expect(timedPromptState({ deliverAt: 2_000, missedAt: 3_000 }, 2_500)).toBe("missed");
  });

  it("schedules a repaint only for future rows, capped to one minute", () => {
    expect(nextTimedStateChangeDelay([{ deliverAt: 5_000 }], 1_000)).toBe(4_005);
    expect(nextTimedStateChangeDelay([{ deliverAt: 10_000_000 }], 0)).toBe(TIMED_PROMPT_MAX_TIMER_MS);
    expect(nextTimedStateChangeDelay([{ deliverAt: 500, missedAt: 600 }], 1_000)).toBeNull();
  });
});
