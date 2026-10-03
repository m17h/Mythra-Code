import { describe, expect, it } from "vitest";
import { sanitizeStoredQueuedTurns } from "./taskStore";
import { sanitizeStoredNewThreadPrompts } from "./newThreadTimedPrompts";

describe("independent timed prompt restore safety review", () => {
  const entry = { id: "timed", text: "Only send this later", attachments: [], createdAt: 1000, status: "queued" };
  const snapshot = { provider: "claude", model: "opus", reasoningEffort: "high", permission: "ask" };

  it("never turns a damaged scheduled time into an immediate ordinary prompt", () => {
    for (const deliverAt of [null, "tomorrow", -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
      expect(sanitizeStoredQueuedTurns({ thread: [{ ...entry, deliverAt }] }).thread ?? []).toEqual([]);
    }
    expect(sanitizeStoredQueuedTurns({ thread: [entry] }).thread).toHaveLength(1);
    expect(sanitizeStoredQueuedTurns({ thread: [{ ...entry, releasedAt: 2000 }] }).thread ?? []).toEqual([]);
    expect(sanitizeStoredQueuedTurns({ thread: [{ ...entry, missedAt: 2000 }] }).thread ?? []).toEqual([]);
  });

  it("rejects unsupported permissions and effort levels in durable new-thread snapshots", () => {
    for (const changes of [{ permission: "dangerous" }, { reasoningEffort: "everything" }]) {
      const restored = sanitizeStoredNewThreadPrompts({ "/project": [{ ...entry, deliverAt: 2000, snapshot: { ...snapshot, ...changes } }] });
      expect(restored["/project"] ?? []).toEqual([]);
    }
  });
});
