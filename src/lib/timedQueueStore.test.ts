import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import { resetTaskStore, sanitizeStoredQueuedTurns, storedPendingTimedTurns, useTaskStore } from "./taskStore";
import {
  newThreadSnapshot,
  newThreadPromptsForWorkspace,
  resetNewThreadTimedPromptsForTests,
  sanitizeStoredNewThreadPrompts,
  useNewThreadTimedPrompts,
} from "./newThreadTimedPrompts";

const NOW = Date.UTC(2026, 9, 3, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetTaskStore();
  resetNewThreadTimedPromptsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe("timed entries in the durable queue", () => {
  it("holds previously released or interrupted sending timed entries for explicit approval after restore", () => {
    const restored = sanitizeStoredQueuedTurns({ t: [
      { id: "released", text: "waiting behind a turn", createdAt: NOW - 2_000, status: "queued", deliverAt: NOW - 1_000, releasedAt: NOW - 1_000 },
      { id: "sending", text: "delivery outcome unknown", createdAt: NOW - 2_000, status: "sending", deliverAt: NOW - 1_000, releasedAt: NOW - 1_000 },
    ] });
    for (const entry of restored.t) {
      expect(entry.releasedAt).toBeUndefined();
      expect(entry.missedAt).toBe(NOW);
      expect(entry.status).toBe("queued");
    }
  });

  it("restores delivery and missed times, holds releases, and drops damaged schedules entirely", () => {
    const restored = sanitizeStoredQueuedTurns({
      t: [
        { id: "a", text: "later", attachments: [{ path: "/tmp/a.png", name: "a.png", kind: "image" }], status: "queued", deliverAt: NOW + 60_000 },
        { id: "b", text: "missed", status: "queued", deliverAt: NOW - 1, missedAt: NOW },
        { id: "c", text: "released", status: "queued", deliverAt: NOW - 1, releasedAt: NOW - 1, missedAt: NOW },
        { id: "d", text: "bogus", status: "queued", deliverAt: "soon", releasedAt: NOW },
      ],
    });
    expect(restored.t.map(({ id, deliverAt, releasedAt, missedAt, attachments }) => ({ id, deliverAt, releasedAt, missedAt, attachments: attachments.length }))).toEqual([
      { id: "a", deliverAt: NOW + 60_000, releasedAt: undefined, missedAt: undefined, attachments: 1 },
      { id: "b", deliverAt: NOW - 1, releasedAt: undefined, missedAt: NOW, attachments: 0 },
      { id: "c", deliverAt: NOW - 1, releasedAt: undefined, missedAt: NOW, attachments: 0 },
    ]);
  });

  it("never marks a pending timed prompt as sending and releases only when due", () => {
    const store = useTaskStore.getState();
    store.ensureTask("t");
    const timed = store.enqueueTurn("t", "later", [], { deliverAt: NOW + 60_000 });
    store.setQueuedTurnStatus("t", timed.id, "sending");
    store.releaseTimedTurns("t", [timed.id]);
    expect(useTaskStore.getState().tasks.t.queuedTurns[0]).toMatchObject({ status: "queued" });
    expect(useTaskStore.getState().tasks.t.queuedTurns[0].releasedAt).toBeUndefined();
    vi.setSystemTime(NOW + 60_000);
    useTaskStore.getState().releaseTimedTurns("t", [timed.id]);
    expect(useTaskStore.getState().tasks.t.queuedTurns[0]).toMatchObject({ releasedAt: NOW + 60_000 });
  });

  it("marks restored prompts missed even before their thread is opened", () => {
    localStorage.setItem("kiwi.queuedTurns", JSON.stringify({ closed: [{ id: "x", text: "deploy", status: "queued", deliverAt: NOW - 5_000 }] }));
    // Simulate a fresh app session reading the persisted queue.
    vi.resetModules();
    return import("./taskStore").then(({ useTaskStore: freshStore, storedPendingTimedTurns: freshPending }) => {
      expect(freshPending().map((item) => item.id)).toEqual(["x"]);
      freshStore.getState().markTimedTurnsMissed("closed", ["x"], NOW);
      expect(JSON.parse(localStorage.getItem("kiwi.queuedTurns")!).closed[0]).toMatchObject({ missedAt: NOW });
      freshStore.getState().ensureTask("closed");
      expect(freshStore.getState().tasks.closed.queuedTurns[0]).toMatchObject({ missedAt: NOW, status: "queued" });
    });
  });

  it("reschedules and explicitly queues missed prompts, clearing the missed mark", () => {
    const store = useTaskStore.getState();
    store.ensureTask("t");
    const timed = store.enqueueTurn("t", "later", [], { deliverAt: NOW + 1_000 });
    vi.setSystemTime(NOW + 5_000);
    useTaskStore.getState().markTimedTurnsMissed("t", [timed.id]);
    expect(useTaskStore.getState().rescheduleQueuedTurn("t", timed.id, NOW)).toBe(false);
    expect(useTaskStore.getState().rescheduleQueuedTurn("t", timed.id, NOW + 60_000)).toBe(true);
    expect(useTaskStore.getState().tasks.t.queuedTurns[0]).toMatchObject({ deliverAt: NOW + 60_000 });
    expect(useTaskStore.getState().tasks.t.queuedTurns[0].missedAt).toBeUndefined();
    useTaskStore.getState().markTimedTurnsMissed("t", [timed.id]);
    expect(useTaskStore.getState().releaseTimedTurnNow("t", timed.id)).toBe(true);
    expect(useTaskStore.getState().tasks.t.queuedTurns[0]).toMatchObject({ releasedAt: NOW + 5_000 });
    expect(useTaskStore.getState().tasks.t.queuedTurns[0].missedAt).toBeUndefined();
    expect(storedPendingTimedTurns()).toEqual([]);
  });

  it("bumps the queue revision on queue mutations only", () => {
    const store = useTaskStore.getState();
    store.ensureTask("t");
    const before = useTaskStore.getState().queueRevision;
    store.queueAssistantDelta("t", "item", "streamed text");
    store.flushDeltas();
    expect(useTaskStore.getState().queueRevision).toBe(before);
    store.enqueueTurn("t", "later", [], { deliverAt: NOW + 1_000 });
    expect(useTaskStore.getState().queueRevision).toBe(before + 1);
  });
});

describe("new-thread timed prompts", () => {
  const snapshot = newThreadSnapshot({ ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5" }, true);

  it("exposes every normalized-equivalent workspace bucket without including other projects", () => {
    const store = useNewThreadTimedPrompts.getState();
    const a = store.add({ workspacePath: "C:\\project\\", workspaceName: "P", text: "First", attachments: [], deliverAt: NOW + 60_000, snapshot });
    const b = store.add({ workspacePath: "C:/project", workspaceName: "P", text: "Second", attachments: [], deliverAt: NOW + 120_000, snapshot });
    store.add({ workspacePath: "C:/different", workspaceName: "Other", text: "Other", attachments: [], deliverAt: NOW + 60_000, snapshot });
    const entries = newThreadPromptsForWorkspace(useNewThreadTimedPrompts.getState().prompts, "C:/project/");
    expect(entries.map((entry) => entry.id)).toEqual([a.id, b.id]);
    expect(useNewThreadTimedPrompts.getState().beginEdit(b.id)).toBe(true);
    expect(newThreadPromptsForWorkspace(useNewThreadTimedPrompts.getState().prompts, "C:/project/")[1].editing).toBe(true);
  });

  it("persists provider identity, isolation and attachments, never system prompts", () => {
    const prompt = useNewThreadTimedPrompts.getState().add({
      workspacePath: "/tmp/project", workspaceName: "Project", text: "first", deliverAt: NOW + 60_000,
      attachments: [{ path: "/tmp/a.txt", name: "a.txt", kind: "file" }], snapshot,
    });
    const stored = JSON.parse(localStorage.getItem("kiwi.newThreadTimedPrompts")!);
    expect(stored["/tmp/project"][0]).toMatchObject({ id: prompt.id, snapshot: { provider: "claude", model: "claude-opus-5", isolated: true } });
    expect(JSON.stringify(stored)).not.toContain("systemPrompt");
    const restored = sanitizeStoredNewThreadPrompts(stored);
    expect(restored["/tmp/project"][0]).toMatchObject({ text: "first", attachments: [{ path: "/tmp/a.txt" }], snapshot: { provider: "claude" } });
  });

  it("drops restored first prompts without a time or provider snapshot", () => {
    expect(sanitizeStoredNewThreadPrompts({
      "/p": [
        { id: "a", text: "no snapshot", status: "queued", deliverAt: NOW + 1 },
        { id: "b", text: "no time", status: "queued", snapshot },
        { id: "c", text: "bad provider", status: "queued", deliverAt: NOW + 1, snapshot: { ...snapshot, provider: "other" } },
      ],
    })).toEqual({});
  });

  it("marks missed, reschedules, and prepares an explicit start", () => {
    const store = useNewThreadTimedPrompts.getState();
    const prompt = store.add({ workspacePath: "/p", workspaceName: "P", text: "first", attachments: [], deliverAt: NOW + 1_000, snapshot });
    useNewThreadTimedPrompts.getState().markMissed([prompt.id], NOW + 2_000);
    expect(useNewThreadTimedPrompts.getState().prompts["/p"][0].missedAt).toBe(NOW + 2_000);
    expect(useNewThreadTimedPrompts.getState().reschedule(prompt.id, NOW + 120_000)).toBe(true);
    expect(useNewThreadTimedPrompts.getState().prompts["/p"][0]).toMatchObject({ deliverAt: NOW + 120_000 });
    expect(useNewThreadTimedPrompts.getState().prompts["/p"][0].missedAt).toBeUndefined();
    useNewThreadTimedPrompts.getState().markMissed([prompt.id]);
    expect(useNewThreadTimedPrompts.getState().prepareManualStart(prompt.id)).toBe(true);
    expect(useNewThreadTimedPrompts.getState().prompts["/p"][0]).toMatchObject({ status: "queued" });
    expect(useNewThreadTimedPrompts.getState().prompts["/p"][0].missedAt).toBeUndefined();
  });
});
