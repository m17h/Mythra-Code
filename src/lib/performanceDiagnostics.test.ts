import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  beginThreadOpen,
  failThreadOpen,
  markThreadHistoryHydrated,
  markThreadRuntimeReady,
  markThreadShellCommitted,
  markThreadTimelineCommitted,
  projectedJsonBytes,
  resetPerformanceDiagnostics,
} from "./performanceDiagnostics";

const PROCESS_MEMORY = {
  hostResidentBytes: 10,
  managedProcessTreeResidentBytes: 30,
  managedProcessCount: 2,
  appServerResidentBytes: 20,
};

function mockTimes(...values: number[]): void {
  const fallback = values.at(-1) ?? 0;
  const spy = vi.spyOn(performance, "now");
  for (const value of values) spy.mockReturnValueOnce(value);
  spy.mockReturnValue(fallback);
}

describe("performance diagnostics", () => {
  beforeEach(() => {
    resetPerformanceDiagnostics();
    vi.restoreAllMocks();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => command === "performance_snapshot" ? PROCESS_MEMORY : undefined);
  });

  it("records one privacy-safe completed thread-open sample", async () => {
    mockTimes(100, 105, 110, 115, 120, 125);

    beginThreadOpen("secret-thread-id", "openai", false);
    markThreadShellCommitted("secret-thread-id");
    markThreadHistoryHydrated("secret-thread-id", {
      projectedBytes: 12_345,
      messageCount: 4,
      activityCount: 3,
      paginated: true,
      hasMore: true,
    });
    markThreadTimelineCommitted("secret-thread-id", {
      renderedRowCount: 6,
      timelineDomNodeCount: 80,
      totalDomNodeCount: 300,
    });
    markThreadRuntimeReady("secret-thread-id");

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("audit_append", expect.anything()));
    const auditCall = invoke.mock.calls.find(([command]) => command === "audit_append");
    expect(auditCall?.[1]).toMatchObject({
      kind: "performance.threadOpen",
      threadId: null,
      payload: {
        schemaVersion: 1,
        provider: "openai",
        warm: false,
        outcome: "completed",
        durationMs: {
          shellCommit: 5,
          historyHydrated: 10,
          timelineCommit: 15,
          runtimeReady: 20,
          total: 25,
        },
        history: { projectedBytes: 12_345, messages: 4, activities: 3, paginated: true, hasMore: true },
        render: { rows: 6, timelineDomNodes: 80, totalDomNodes: 300 },
        processMemory: PROCESS_MEMORY,
      },
    });
    expect(JSON.stringify(auditCall?.[1])).not.toContain("secret-thread-id");
  });

  it("ignores stale commits after a newer selection supersedes a sample", async () => {
    mockTimes(0, 10, 20, 30, 40, 50, 60);
    beginThreadOpen("old", "openai", false);
    beginThreadOpen("new", "claude", true);
    markThreadHistoryHydrated("old", { projectedBytes: 1, messageCount: 1, activityCount: 0, paginated: false, hasMore: false });
    markThreadRuntimeReady("old");
    markThreadHistoryHydrated("new", { projectedBytes: null, messageCount: 2, activityCount: 1, paginated: false, hasMore: false });
    markThreadTimelineCommitted("new", { renderedRowCount: 2, timelineDomNodeCount: 10, totalDomNodeCount: 40 });
    markThreadRuntimeReady("new");

    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "audit_append")).toHaveLength(1));
    const payload = invoke.mock.calls.find(([command]) => command === "audit_append")?.[1]?.payload;
    expect(payload).toMatchObject({ provider: "claude", warm: true, history: { projectedBytes: null } });
  });

  it("records failures without waiting for timeline or runtime readiness", async () => {
    mockTimes(0, 12);
    beginThreadOpen("failed", "cursor", false);
    failThreadOpen("failed", "selection");

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("audit_append", expect.anything()));
    const payload = invoke.mock.calls.find(([command]) => command === "audit_append")?.[1]?.payload;
    expect(payload).toMatchObject({ provider: "cursor", outcome: "error", phase: "selection", durationMs: { total: 12 } });
  });

  it("measures projected UTF-8 JSON bytes and reports unavailable values honestly", () => {
    expect(projectedJsonBytes({ text: "🧠" })).toBe(15);
    expect(projectedJsonBytes(undefined)).toBeNull();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(projectedJsonBytes(cyclic)).toBeNull();
  });
});
